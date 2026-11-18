import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRuntimeScheduler,
  createSchedulerSweep,
} from "../src/runtime-scheduler.js";
import { RuntimeResourceError, SweepScope } from "../src/runtime-resources.js";
import { runRole } from "../src/runtime-role.js";

function setup() {
  const scope = new SweepScope(30);
  const client = {
    connection: { stream: { destroy: vi.fn() } },
    connect: vi.fn().mockResolvedValue(undefined),
    end: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    query: vi.fn(async (sql: string, values?: unknown[]): Promise<unknown> => {
      void values;
      if (sql.startsWith("SELECT e.id"))
        return { rows: [{ id: "a" }, { id: "b" }] };
      if (sql.startsWith("UPDATE"))
        return { rowCount: 1, rows: [{ generation: 2 }] };
      return { rows: [], rowCount: 0 };
    }),
  };
  const create = vi.fn(() => client);
  const sweep = createSchedulerSweep({
    connectionString: "secret",
    limit: 2,
    eventId: "id",
    createClient: create,
  });
  const statements = () => client.query.mock.calls.map(([sql]) => sql);
  return { scope, client, create, sweep, statements };
}
afterEach(() => vi.useRealTimers());
describe("owned scheduler sweep", () => {
  it("creates one dedicated client, rechecks each candidate, commits, and leaves disposal to the lifecycle", async () => {
    const f = setup();
    await expect(f.sweep(f.scope)).resolves.toBe(2);
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.client.connect).toHaveBeenCalledOnce();
    const sql = f.statements();
    expect(sql[0]).toBe("SET statement_timeout = 5000");
    expect(sql[1]).toBe("BEGIN");
    expect(sql[2]).toContain("FOR UPDATE OF e SKIP LOCKED");
    expect(sql[2]).toContain("ORDER BY d.next_eligible_at,e.id");
    expect(f.client.query.mock.calls[2][1]).toEqual([2, "id"]);
    expect(sql[3]).toContain("next_eligible_at <= clock_timestamp()");
    expect(sql[3]).toContain(
      "generation < 2147483647 AND attempt < 2147483647",
    );
    expect(sql[4]).toContain("INSERT INTO retry_publications");
    expect(sql[7]).toBe("COMMIT");
    expect(f.client.end).not.toHaveBeenCalled();
    await f.scope.dispose();
    expect(f.client.end).toHaveBeenCalledOnce();
  });
  it("rejects already-aborted scopes before creating or querying", async () => {
    const f = setup();
    f.scope.abort();
    await expect(f.sweep(f.scope)).rejects.toMatchObject({ code: "ABORTED" });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.client.query).not.toHaveBeenCalled();
    await f.scope.dispose();
  });
  it.each([0, 101, 1.5, NaN, Infinity])(
    "rejects invalid limit %s as fatal",
    async (limit) => {
      const f = setup();
      await expect(
        createSchedulerSweep({
          connectionString: "url",
          limit,
          createClient: f.create,
        })(f.scope),
      ).rejects.toMatchObject({ code: "CONFIG", fatal: true });
      expect(f.create).not.toHaveBeenCalled();
      await f.scope.dispose();
    },
  );
  it("skips insertion when eligibility recheck updates zero rows", async () => {
    const f = setup();
    f.client.query.mockImplementation(async (sql) => {
      if (sql.startsWith("SELECT")) return { rows: [{ id: "a" }] };
      if (sql.startsWith("UPDATE")) return { rowCount: 0, rows: [] };
      return { rows: [], rowCount: 0 };
    });
    await expect(f.sweep(f.scope)).resolves.toBe(0);
    expect(f.statements().some((s) => s.startsWith("INSERT"))).toBe(false);
    await f.scope.dispose();
  });
  it.each(["BEGIN", "SELECT", "UPDATE", "INSERT", "COMMIT"])(
    "abort during %s admits no further SQL",
    async (phase) => {
      const f = setup();
      const original = f.client.query.getMockImplementation()!;
      f.client.query.mockImplementation(async (sql, values) => {
        if (sql.startsWith(phase)) {
          f.scope.abort();
          return { rows: [], rowCount: 0 };
        }
        return original(sql, values);
      });
      await expect(f.sweep(f.scope)).rejects.toMatchObject({ code: "ABORTED" });
      expect(f.statements().at(-1)?.startsWith(phase)).toBe(true);
      expect(f.client.connection.stream.destroy).toHaveBeenCalled();
      await f.scope.dispose();
    },
  );
  it("rolls back a query failure without exposing the driver error", async () => {
    const f = setup();
    const original = f.client.query.getMockImplementation()!;
    f.client.query.mockImplementation(async (sql, values) => {
      if (sql.startsWith("INSERT")) throw new Error("secret sql payload");
      return original(sql, values);
    });
    const error = await f.sweep(f.scope).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "QUERY", fatal: false });
    expect(String(error)).not.toContain("secret");
    expect(f.statements().at(-1)).toBe("ROLLBACK");
    await f.scope.dispose();
  });
  it("destroys transport when rollback fails while preserving the primary failure", async () => {
    const f = setup();
    const original = f.client.query.getMockImplementation()!;
    f.client.query.mockImplementation(async (sql, values) => {
      if (sql.startsWith("INSERT") || sql === "ROLLBACK")
        throw new Error("secret");
      return original(sql, values);
    });
    await expect(f.sweep(f.scope)).rejects.toMatchObject({ code: "QUERY" });
    expect(f.client.connection.stream.destroy).toHaveBeenCalled();
    await f.scope.dispose();
  });
  it("does not mask CLEANUP_STUCK from rollback", async () => {
    const f = setup();
    const original = f.client.query.getMockImplementation()!;
    f.client.query.mockImplementation(async (sql, values) => {
      if (sql.startsWith("INSERT")) throw new Error("secret");
      if (sql === "ROLLBACK") throw new RuntimeResourceError("CLEANUP_STUCK");
      return original(sql, values);
    });
    await expect(f.sweep(f.scope)).rejects.toMatchObject({
      code: "CLEANUP_STUCK",
      fatal: true,
    });
    await f.scope.dispose();
  });
  it("treats a timed out COMMIT as uncertain, destroys transport and never reports success", async () => {
    vi.useFakeTimers();
    const f = setup();
    const original = f.client.query.getMockImplementation()!;
    let rejectCommit!: (error: Error) => void;
    f.client.query.mockImplementation((sql, values) =>
      sql === "COMMIT"
        ? new Promise((_resolve, reject) => {
            rejectCommit = reject;
          })
        : original(sql, values),
    );
    const result = f.sweep(f.scope);
    const rejected = expect(result).rejects.toMatchObject({
      code: "QUERY",
      fatal: false,
    });
    await vi.advanceTimersByTimeAsync(6000);
    await rejected;
    expect(f.client.connection.stream.destroy).toHaveBeenCalled();
    expect(f.statements().at(-1)).toBe("COMMIT");
    rejectCommit(new Error("closed"));
    await f.scope.dispose();
  });
});

describe("scheduler role lifecycle", () => {
  function roleSetup() {
    const f = setup();
    const scheduler = createRuntimeScheduler({
      connectionString: "secret",
      postForceSettlementMs: 30,
      createClient: f.create,
    });
    const release = vi.fn().mockResolvedValue(undefined);
    let lose!: (error: unknown) => void;
    const controller = new AbortController();
    const options = {
      role: "scheduler" as const,
      mode: "one-shot" as const,
      signal: controller.signal,
      acquireLock: async (onLost: (error: unknown) => void) => {
        lose = onLost;
        return { release };
      },
      ...scheduler,
      wait: async () => {},
      classify: () => "retryable" as const,
      log: vi.fn(),
    };
    return {
      f,
      scheduler,
      release,
      options,
      lose: () => lose(new Error("lost")),
    };
  }

  it("runs one owned transaction and disposes before releasing the lock", async () => {
    const f = roleSetup();
    expect(await runRole(f.options)).toEqual({ code: "success", sweeps: 1 });
    expect(f.f.statements().at(-1)).toBe("COMMIT");
    expect(f.f.client.end).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.f.client.end.mock.invocationCallOrder[0]).toBeLessThan(
      f.release.mock.invocationCallOrder[0],
    );
    await f.f.scope.dispose();
  });

  it("binds an already aborted signal synchronously and admits zero SQL through runRole", async () => {
    const f = roleSetup();
    const aborted = new AbortController();
    aborted.abort("untrusted reason");
    let scope!: SweepScope;
    const result = await runRole({
      ...f.options,
      createScope: () => (scope = f.scheduler.createScope(aborted.signal)),
    });
    expect(result).toEqual({ code: "retryable_failure", sweeps: 0 });
    expect(() => scope.check()).toThrow("runtime resource: ABORTED");
    expect(f.f.create).not.toHaveBeenCalled();
    expect(f.f.client.query).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
    await f.f.scope.dispose();
  });

  it("aborts the scope on lock loss and sends no later SQL", async () => {
    const f = roleSetup();
    const original = f.f.client.query.getMockImplementation()!;
    let scope!: SweepScope;
    f.f.client.query.mockImplementation(async (sql, values) => {
      if (sql.startsWith("SELECT")) f.lose();
      return original(sql, values);
    });
    const result = await runRole({
      ...f.options,
      createScope: (signal) => (scope = f.scheduler.createScope(signal)),
    });
    expect(result).toEqual({ code: "lock_lost", sweeps: 0 });
    expect(scope.signal.aborted).toBe(true);
    expect(f.f.statements().at(-1)).toMatch(/^SELECT/);
    expect(f.f.client.connection.stream.destroy).toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
    await f.f.scope.dispose();
  });

  it("propagates the strongest cleanup error and retains the lock", async () => {
    const f = roleSetup();
    const result = await runRole({
      ...f.options,
      createScope: (signal) => {
        const scope = f.scheduler.createScope(signal);
        const dispose = scope.dispose.bind(scope);
        vi.spyOn(scope, "dispose").mockImplementation(async () => {
          await dispose();
          return [
            new RuntimeResourceError("CLOSE"),
            new RuntimeResourceError("CLEANUP_STUCK"),
          ];
        });
        return scope;
      },
    });
    expect(result).toEqual({
      code: "cleanup_stuck",
      sweeps: 1,
      requiresProcessTermination: true,
    });
    expect(f.release).not.toHaveBeenCalled();
    await f.f.scope.dispose();
  });

  it("removes its listener once and shares concurrent and repeated disposal failures", async () => {
    const f = roleSetup();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const scope = f.scheduler.createScope(controller.signal);
    const dispose = scope.dispose.bind(scope);
    const spy = vi.spyOn(scope, "dispose").mockImplementation(async () => {
      await dispose();
      return [
        new RuntimeResourceError("CLOSE"),
        new RuntimeResourceError("ADAPTER_MISMATCH"),
      ];
    });
    const first = f.scheduler.disposeScope(scope);
    const second = f.scheduler.disposeScope(scope);
    expect(first).toBe(second);
    await expect(first).rejects.toMatchObject({ code: "ADAPTER_MISMATCH" });
    await expect(f.scheduler.disposeScope(scope)).rejects.toMatchObject({
      code: "ADAPTER_MISMATCH",
    });
    expect(spy).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    controller.abort();
    expect(spy).toHaveBeenCalledOnce();
    await f.f.scope.dispose();
  });

  it("shares successful disposal and removes the abort listener", async () => {
    const f = roleSetup();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const scope = f.scheduler.createScope(controller.signal);
    const dispose = vi.spyOn(scope, "dispose");
    await Promise.all([
      f.scheduler.disposeScope(scope),
      f.scheduler.disposeScope(scope),
    ]);
    await f.scheduler.disposeScope(scope);
    controller.abort("untrusted reason");
    expect(dispose).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    await f.f.scope.dispose();
  });
});
