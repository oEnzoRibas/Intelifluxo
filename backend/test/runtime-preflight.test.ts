import { EventEmitter } from "node:events";
import type amqp from "amqplib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPreflight } from "../src/runtime-preflight.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture() {
  const pg = {
    connection: { stream: { destroy: vi.fn() } },
    on: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({}),
    end: vi.fn().mockResolvedValue(undefined),
  };
  const channel = Object.assign(new EventEmitter(), {
    close: vi.fn().mockResolvedValue(undefined),
    assertQueue: vi.fn().mockImplementation(async (queue: string) => ({
      queue,
      messageCount: 0,
      consumerCount: 0,
    })),
    deleteQueue: vi.fn().mockResolvedValue({ messageCount: 0 }),
    publish: vi
      .fn()
      .mockImplementation(
        (
          _exchange,
          _queue,
          _content,
          _options,
          callback: (error: null) => void,
        ) => {
          callback(null);
          return true;
        },
      ),
  });
  const connection = Object.assign(new EventEmitter(), {
    connection: { stream: { destroy: vi.fn() } },
    close: vi.fn().mockResolvedValue(undefined),
    createConfirmChannel: vi
      .fn()
      .mockResolvedValue(channel as unknown as amqp.ConfirmChannel),
  });
  const controller = new AbortController();
  const options = {
    databaseUrl: "postgres://user:secret@localhost/db",
    amqpUrl: "amqp://user:secret@localhost",
    signal: controller.signal,
    probeDeadlineMs: 500,
    factories: { pg: vi.fn(() => pg), amqp: vi.fn(async () => connection) },
  };
  return { pg, channel, connection, controller, options };
}
afterEach(() => vi.useRealTimers());
describe("dependency preflight", () => {
  it("checks both dependencies and deletes a unique exclusive queue before ordered disposal", async () => {
    const f = fixture();
    const first = await runPreflight(f.options);
    expect(first.state).toBe("ready");
    expect(f.pg.query).toHaveBeenCalledWith("SELECT 1", undefined);
    const queue = f.channel.assertQueue.mock.calls[0][0];
    expect(queue).toMatch(/^intelifluxo-preflight-/);
    expect(f.channel.assertQueue).toHaveBeenCalledWith(queue, {
      exclusive: true,
      autoDelete: true,
      durable: false,
    });
    expect(f.channel.publish.mock.calls[0][1]).toBe(queue);
    expect(f.channel.publish.mock.calls[0][3]).toMatchObject({
      mandatory: true,
      persistent: true,
    });
    expect(f.channel.deleteQueue).toHaveBeenCalledWith(queue, undefined);
    expect(f.channel.close.mock.invocationCallOrder[0]).toBeLessThan(
      f.connection.close.mock.invocationCallOrder[0],
    );
    await runPreflight(f.options);
    expect(f.channel.assertQueue.mock.calls[1][0]).not.toBe(queue);
  });
  it.each(["pg", "amqp"] as const)(
    "reports %s failure without raw error or secrets",
    async (kind) => {
      const f = fixture();
      if (kind === "pg")
        f.pg.connect.mockRejectedValue(new Error("secret raw error"));
      else
        f.options.factories.amqp.mockRejectedValue(
          new Error("secret raw error"),
        );
      const value = await runPreflight(f.options);
      expect(value.state).toBe("unavailable");
      expect(
        value.dependencies[kind === "pg" ? "postgres" : "rabbitmq"].reasonCode,
      ).toBe("DEPENDENCY_UNAVAILABLE");
      expect(
        value.dependencies[kind === "pg" ? "rabbitmq" : "postgres"].state,
      ).toBe("ready");
      expect(JSON.stringify(value)).not.toMatch(
        /secret|raw error|localhost|preflight-/,
      );
    },
  );
  it("does not create resources when already aborted", async () => {
    const f = fixture();
    f.controller.abort();
    expect((await runPreflight(f.options)).state).toBe("aborted");
    expect(f.options.factories.pg).not.toHaveBeenCalled();
    expect(f.options.factories.amqp).not.toHaveBeenCalled();
  });
  it("aborts in-flight work and disposes", async () => {
    const f = fixture();
    const pending = deferred();
    f.pg.connect.mockReturnValue(pending.promise);
    const operation = runPreflight(f.options);
    f.controller.abort();
    pending.resolve();
    expect((await operation).state).toBe("aborted");
    expect(f.pg.end).toHaveBeenCalled();
  });
  it("requires confirm and disposal before ready", async () => {
    const f = fixture();
    const close = deferred();
    let confirm!: (error: null) => void;
    f.channel.publish.mockImplementation(
      (_a, _b, _c, _d, cb: (error: null) => void) => {
        confirm = cb;
        return true;
      },
    );
    f.pg.end.mockReturnValue(close.promise);
    let finished = false;
    const operation = runPreflight(f.options).then((v) => {
      finished = true;
      return v;
    });
    await vi.waitFor(() => expect(confirm).toBeDefined());
    expect(finished).toBe(false);
    confirm(null);
    await vi.waitFor(() => expect(f.channel.deleteQueue).toHaveBeenCalled());
    expect(finished).toBe(false);
    close.resolve();
    expect((await operation).state).toBe("ready");
  });
  it("gives cleanup stuck precedence and allows cleanup beyond the probe deadline", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.options.probeDeadlineMs = 10;
    f.pg.end.mockReturnValue(new Promise(() => {}));
    f.options.factories.amqp.mockRejectedValue(new Error("failure"));
    const operation = runPreflight(f.options);
    await vi.advanceTimersByTimeAsync(11);
    let done = false;
    void operation.then(() => {
      done = true;
    });
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2100);
    expect((await operation).state).toBe("cleanup_stuck");
  });
  it("reports invalid configuration without leaking it", async () => {
    const f = fixture();
    f.options.databaseUrl = "secret";
    const value = await runPreflight(f.options);
    expect(value.dependencies.postgres).toEqual({
      state: "unavailable",
      reasonCode: "CONFIG",
    });
    expect(f.options.factories.pg).not.toHaveBeenCalled();
  });
  it("treats a cleanup failure as unavailable", async () => {
    const f = fixture();
    f.pg.end.mockRejectedValue(new Error("secret"));
    const value = await runPreflight(f.options);
    expect(value.dependencies.postgres.state).toBe("unavailable");
    expect(JSON.stringify(value)).not.toContain("secret");
  });
  it("closes admission on deadline and waits for in-flight settlement", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.options.probeDeadlineMs = 10;
    const pending = deferred();
    f.pg.connect.mockReturnValue(pending.promise);
    const operation = runPreflight(f.options);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.pg.connection.stream.destroy).toHaveBeenCalled();
    pending.resolve();
    const value = await operation;
    expect(value.dependencies.postgres.state).toBe("unavailable");
    expect(f.pg.query).not.toHaveBeenCalled();
  });
});
