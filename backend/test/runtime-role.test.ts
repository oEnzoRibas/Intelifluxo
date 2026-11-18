import { afterEach, describe, expect, it, vi } from "vitest";
import { runRole, type RoleOptions } from "../src/runtime-role.js";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function setup() {
  const events: string[] = [];
  const stop = new AbortController();
  const force = new AbortController();
  let lose: (error: unknown) => void = () => {};
  const options: RoleOptions<AbortSignal> = {
    role: "relay",
    mode: "one-shot",
    signal: stop.signal,
    forceSignal: force.signal,
    acquireLock: async (cb) => {
      events.push("lock");
      lose = cb;
      return {
        release: async () => {
          events.push("release");
        },
      };
    },
    createScope: (s) => {
      events.push("create");
      return s;
    },
    sweep: async () => {
      events.push("sweep");
    },
    disposeScope: async () => {
      events.push("dispose");
    },
    wait: async () => {
      stop.abort();
    },
    classify: () => "retryable",
    log: vi.fn(),
    onOutcome: vi.fn(),
    random: () => 0,
  };
  return { options, events, stop, force, lose: (e: unknown = {}) => lose(e) };
}
afterEach(() => vi.useRealTimers());
describe("role lifecycle", () => {
  it.each(["one-shot", "daemon"] as const)(
    "returns safe acquisition failure in %s without retry",
    async (mode) => {
      const t = setup();
      t.options.mode = mode;
      t.options.acquireLock = vi.fn(async () => {
        throw new Error("secret");
      });
      t.options.wait = vi.fn();
      expect(await runRole(t.options)).toEqual({
        code: "retryable_failure",
        sweeps: 0,
        requiresProcessTermination: false,
      });
      expect(t.options.acquireLock).toHaveBeenCalledOnce();
      expect(t.options.wait).not.toHaveBeenCalled();
      expect(t.events).toEqual([]);
    },
  );
  it("prioritizes stuck release over simultaneous loss and fatal sweep", async () => {
    const t = setup();
    t.options.acquireLock = async (onLost) => ({
      release: async () => {
        onLost({ code: "SESSION_LOST" });
        throw new Error("secret");
      },
    });
    t.options.sweep = async () => {
      throw { fatal: true };
    };
    expect(await runRole(t.options)).toEqual({
      code: "cleanup_stuck",
      sweeps: 0,
      requiresProcessTermination: true,
    });
  });
  it("locks before one sweep and releases last", async () => {
    const t = setup();
    expect(await runRole(t.options)).toEqual({ code: "success", sweeps: 1 });
    expect(t.events).toEqual(["lock", "create", "sweep", "dispose", "release"]);
  });
  it("does no work when busy", async () => {
    const t = setup();
    t.options.acquireLock = async () => null;
    expect((await runRole(t.options)).code).toBe("busy");
    expect(t.events).toEqual([]);
  });
  it("does not retry one-shot failure or expose secrets", async () => {
    const t = setup();
    t.options.sweep = async () => {
      throw Error("secret token");
    };
    const result = await runRole(t.options);
    expect(result.code).toBe("retryable_failure");
    expect(
      JSON.stringify([
        result,
        vi.mocked(t.options.log).mock.calls,
        vi.mocked(t.options.onOutcome!).mock.calls,
      ]),
    ).not.toContain("secret");
    expect(t.events).toEqual(["lock", "create", "dispose", "release"]);
  });
  it("serializes disposal and resets backoff", async () => {
    const t = setup();
    t.options.mode = "daemon";
    const disposal = deferred();
    let n = 0;
    const delays: number[] = [];
    t.options.sweep = async () => {
      n++;
      if ([1, 2, 4].includes(n)) throw Error();
    };
    t.options.disposeScope = async () => {
      t.events.push(`dispose${n}`);
      if (n === 1) await disposal.promise;
    };
    t.options.wait = async (ms) => {
      delays.push(ms);
      if (n === 4) t.stop.abort();
    };
    const run = runRole(t.options);
    await vi.waitFor(() => expect(t.events).toContain("dispose1"));
    expect(n).toBe(1);
    disposal.resolve();
    expect((await run).code).toBe("stopped");
    expect(delays).toEqual([250, 500, 1000, 250]);
    expect(t.events.at(-1)).toBe("release");
  });
  it.each(["fatal", "cleanup_stuck", "mismatch"])(
    "stops on %s",
    async (kind) => {
      const t = setup();
      t.options.mode = "daemon";
      t.options.sweep = async () => {
        throw kind === "cleanup_stuck"
          ? { code: "CLEANUP_STUCK" }
          : kind === "mismatch"
            ? { code: "ADAPTER_MISMATCH" }
            : { fatal: true };
      };
      expect((await runRole(t.options)).code).toBe(
        kind === "cleanup_stuck" ? kind : "fatal",
      );
      expect(t.events).toEqual(
        kind === "cleanup_stuck"
          ? ["lock", "create", "dispose"]
          : ["lock", "create", "dispose", "release"],
      );
    },
  );
  it.each(["abort", "loss"])("cancels idle on %s", async (how) => {
    const t = setup();
    t.options.mode = "daemon";
    t.options.wait = async (_, signal) =>
      new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(Error()), { once: true }),
      );
    const run = runRole(t.options);
    await vi.waitFor(() => expect(t.events).toContain("dispose"));
    if (how === "loss") t.lose();
    else t.stop.abort();
    expect((await run).code).toBe(how === "loss" ? "lock_lost" : "stopped");
  });
  it("drains active work", async () => {
    const t = setup();
    const pending = deferred();
    let signal!: AbortSignal;
    t.options.sweep = async (s) => {
      signal = s;
      await pending.promise;
    };
    const run = runRole(t.options);
    await vi.waitFor(() => expect(signal).toBeDefined());
    t.stop.abort();
    expect(signal.aborted).toBe(false);
    expect(t.events).not.toContain("release");
    pending.resolve();
    expect((await run).code).toBe("stopped");
    expect(t.events.slice(-2)).toEqual(["dispose", "release"]);
  });
  it.each(["deadline", "force", "loss"])(
    "aborts active work on %s",
    async (how) => {
      vi.useFakeTimers();
      const t = setup();
      let signal!: AbortSignal;
      t.options.sweep = async (s) => {
        signal = s;
        await new Promise<void>((resolve) =>
          s.addEventListener("abort", () => resolve(), { once: true }),
        );
      };
      const run = runRole(t.options);
      await Promise.resolve();
      await Promise.resolve();
      expect(signal).toBeDefined();
      if (how === "loss") t.lose();
      else {
        t.stop.abort();
        if (how === "force") t.force.abort();
        else await vi.advanceTimersByTimeAsync(10000);
      }
      expect(signal.aborted).toBe(true);
      expect((await run).code).toBe(how === "loss" ? "lock_lost" : "stopped");
      expect(vi.getTimerCount()).toBe(0);
      expect(t.events.at(-1)).toBe("release");
    },
  );
  it("preserves fatal during shutdown and cleanup stuck on release", async () => {
    const t = setup();
    t.options.sweep = async () => {
      t.stop.abort();
      throw { fatal: true };
    };
    expect((await runRole(t.options)).code).toBe("fatal");
    const u = setup();
    const release = vi.fn(async () => {
      throw { code: "CLEANUP_STUCK" };
    });
    u.options.acquireLock = async () => ({ release });
    expect(await runRole(u.options)).toEqual({
      code: "cleanup_stuck",
      sweeps: 1,
      requiresProcessTermination: true,
    });
    expect(release).toHaveBeenCalledTimes(1);
  });
  it.each(["abort", "force", "loss"])(
    "retains the lock when disposal sticks during %s",
    async (how) => {
      const t = setup();
      t.options.mode = "daemon";
      const unresolved = deferred();
      const started = deferred();
      let work: Promise<void> | undefined;
      t.options.sweep = async () => {
        // The adapter has returned, but its underlying work is still alive.
        work = unresolved.promise;
        started.resolve();
      };
      t.options.disposeScope = async () => {
        await started.promise;
        if (how === "abort") t.stop.abort();
        else if (how === "force") t.force.abort();
        else t.lose();
        throw { code: "CLEANUP_STUCK", secret: "do not report" };
      };
      const result = await runRole(t.options);
      expect(work).toBe(unresolved.promise);
      expect(result).toEqual({
        code: "cleanup_stuck",
        sweeps: 1,
        requiresProcessTermination: true,
      });
      expect(t.events).toEqual(["lock", "create"]);
      expect(t.options.onOutcome).toHaveBeenCalledOnce();
      expect(t.options.onOutcome).toHaveBeenCalledWith(result);
      expect(JSON.stringify(result)).not.toContain("secret");
      unresolved.resolve();
      await work;
    },
  );
  it("retains the lock if sweep sticks even when disposal fails differently", async () => {
    const t = setup();
    t.options.mode = "daemon";
    t.options.sweep = async () => {
      throw { code: "CLEANUP_STUCK" };
    };
    t.options.disposeScope = async () => {
      throw Error("other");
    };
    expect(await runRole(t.options)).toEqual({
      code: "cleanup_stuck",
      sweeps: 0,
      requiresProcessTermination: true,
    });
    expect(t.events).toEqual(["lock", "create"]);
    expect(t.options.onOutcome).toHaveBeenCalledOnce();
  });
  it("releases after a fatal sweep when disposal succeeds", async () => {
    const t = setup();
    t.options.sweep = async () => {
      throw { fatal: true };
    };
    expect((await runRole(t.options)).code).toBe("fatal");
    expect(t.events).toEqual(["lock", "create", "dispose", "release"]);
  });
  it("does not acquire if already aborted, and releases an acquisition completed after abort", async () => {
    const t = setup();
    t.stop.abort();
    expect((await runRole(t.options)).code).toBe("stopped");
    expect(t.events).toEqual([]);
    const u = setup();
    const acquired = deferred();
    const release = vi.fn(async () => {});
    u.options.acquireLock = async () => {
      await acquired.promise;
      return { release };
    };
    const run = runRole(u.options);
    u.stop.abort();
    acquired.resolve();
    expect((await run).code).toBe("stopped");
    expect(release).toHaveBeenCalledOnce();
    expect(u.events).toEqual([]);
  });
  it("settles once when loss, force and sweep completion coincide", async () => {
    const t = setup();
    const pending = deferred();
    t.options.sweep = async () => {
      await pending.promise;
    };
    const run = runRole(t.options);
    await vi.waitFor(() => expect(t.events).toContain("create"));
    t.lose();
    t.force.abort();
    pending.resolve();
    expect((await run).code).toBe("lock_lost");
    expect(t.events).toEqual(["lock", "create", "dispose", "release"]);
    expect(t.options.onOutcome).toHaveBeenCalledOnce();
  });
  it("retains the session when the loss callback reports stuck cleanup", async () => {
    const t = setup();
    t.options.sweep = async () => {
      t.lose({ code: "CLEANUP_STUCK" });
    };
    expect(await runRole(t.options)).toEqual({
      code: "cleanup_stuck",
      sweeps: 1,
      requiresProcessTermination: true,
    });
    expect(t.events).toEqual(["lock", "create", "dispose"]);
    expect(t.options.onOutcome).toHaveBeenCalledOnce();
  });
  it("removes external listeners", async () => {
    const t = setup();
    const add = vi.spyOn(t.stop.signal, "addEventListener");
    const remove = vi.spyOn(t.stop.signal, "removeEventListener");
    await runRole(t.options);
    expect(add.mock.calls[0][1]).toBe(remove.mock.calls[0][1]);
  });
});
