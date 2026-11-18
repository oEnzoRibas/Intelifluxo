import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  classifyRuntimeError,
  parseMode,
  runEntrypoint,
  type EntrypointOptions,
} from "../src/runtime-entrypoint.js";
import { RuntimeResourceError } from "../src/runtime-resources.js";
import { RuntimeLockError } from "../src/runtime-lock.js";
type Scope = { signal: AbortSignal };
function setup(role: "relay" | "scheduler" = "relay", args: string[] = []) {
  const signals = new EventEmitter(),
    log = vi.fn(),
    hardExit = vi.fn(),
    release = vi.fn(async () => {});
  const adapter = {
    createScope: vi.fn((signal: AbortSignal) => ({ signal })),
    sweep: vi.fn(async (scope: Scope) => {
      void scope;
    }),
    disposeScope: vi.fn(async (scope: Scope) => {
      void scope;
    }),
  };
  const options: EntrypointOptions<Scope> = {
    role,
    args,
    signals,
    acquireLock: vi.fn(async () => ({ release })),
    createAdapter: vi.fn(() => adapter),
    wait: vi.fn(async () => {}),
    log,
    hardExit,
  };
  return { signals, log, hardExit, release, adapter, options };
}
describe("runtime entrypoint", () => {
  it.each([[[]], [["--daemon"]]])(
    "returns exit 3 on transient acquisition in mode %j",
    async (args) => {
      const t = setup("relay", args);
      t.options.acquireLock = vi.fn(async () => {
        throw new RuntimeLockError("CONNECT");
      });
      expect(await runEntrypoint(t.options)).toBe(3);
      expect(t.options.acquireLock).toHaveBeenCalledOnce();
      expect(t.options.createAdapter).not.toHaveBeenCalled();
      expect(t.options.wait).not.toHaveBeenCalled();
      expect(t.signals.listenerCount("SIGINT")).toBe(0);
      expect(t.signals.listenerCount("SIGTERM")).toBe(0);
    },
  );
  it("hard exits once on unproven release", async () => {
    const t = setup();
    t.release.mockRejectedValue(new RuntimeLockError("CLEANUP_STUCK"));
    expect(await runEntrypoint(t.options)).toBeUndefined();
    expect(t.hardExit).toHaveBeenCalledExactlyOnceWith(6);
  });
  it("handles a second signal during acquisition without duplicate exit", async () => {
    const t = setup();
    t.options.acquireLock = async () => {
      t.signals.emit("SIGINT");
      t.signals.emit("SIGTERM");
      return { release: t.release };
    };
    expect(await runEntrypoint(t.options)).toBe(0);
    expect(t.release).toHaveBeenCalledOnce();
    expect(t.hardExit).not.toHaveBeenCalled();
    expect(t.signals.listenerCount("SIGINT")).toBe(0);
    expect(t.signals.listenerCount("SIGTERM")).toBe(0);
  });
  it.each(["relay", "scheduler"] as const)(
    "runs legacy %s once and releases",
    async (role) => {
      const t = setup(role);
      expect(await runEntrypoint(t.options)).toBe(0);
      expect(t.options.createAdapter).toHaveBeenCalledWith(role);
      expect(t.options.acquireLock).toHaveBeenCalledWith(
        role,
        expect.any(Function),
      );
      expect(t.adapter.sweep).toHaveBeenCalledOnce();
      expect(t.release).toHaveBeenCalledOnce();
      expect(t.signals.listenerCount("SIGINT")).toBe(0);
      expect(t.signals.listenerCount("SIGTERM")).toBe(0);
      expect(t.log).toHaveBeenCalledWith({
        event: "runtime_terminal",
        role,
        mode: "one-shot",
        outcome: "success",
        sweeps: 1,
      });
    },
  );
  it("delegates serial daemon sweeps and graceful shutdown", async () => {
    const t = setup("scheduler", ["--daemon"]);
    let active = false;
    t.adapter.sweep.mockImplementation(async () => {
      expect(active).toBe(false);
      active = true;
      await Promise.resolve();
      active = false;
    });
    t.options.wait = vi.fn(async () => {
      if (t.adapter.sweep.mock.calls.length === 2) t.signals.emit("SIGTERM");
    });
    expect(await runEntrypoint(t.options)).toBe(0);
    expect(t.adapter.sweep).toHaveBeenCalledTimes(2);
    expect(t.log.mock.calls[0][0]).toMatchObject({
      mode: "daemon",
      outcome: "stopped",
      sweeps: 2,
    });
  });
  it("returns busy without creating resources", async () => {
    const t = setup();
    t.options.acquireLock = vi.fn(async () => null);
    expect(await runEntrypoint(t.options)).toBe(2);
    expect(t.options.createAdapter).not.toHaveBeenCalled();
  });
  it("first signal drains, second forces active scope", async () => {
    const t = setup("relay", ["--daemon"]);
    t.adapter.sweep.mockImplementation(async (scope) => {
      t.signals.emit("SIGINT");
      expect(scope.signal.aborted).toBe(false);
      t.signals.emit("SIGTERM");
      expect(scope.signal.aborted).toBe(true);
    });
    expect(await runEntrypoint(t.options)).toBe(0);
  });
  it("OS then IPC shutdown stays graceful", async () => {
    const t = setup("relay", ["--daemon"]);
    const graceful = new AbortController(),
      force = new AbortController();
    t.options.controls = {
      signal: graceful.signal,
      forceSignal: force.signal,
      requestShutdown: () => graceful.abort(),
      requestForce: () => force.abort(),
    };
    t.adapter.sweep.mockImplementation(async (scope) => {
      t.signals.emit("SIGTERM");
      t.options.controls!.requestShutdown();
      expect(scope.signal.aborted).toBe(false);
    });
    expect(await runEntrypoint(t.options)).toBe(0);
  });
  it("IPC shutdown does not count as an OS signal; the second OS signal forces", async () => {
    const t = setup("relay", ["--daemon"]);
    const graceful = new AbortController(),
      force = new AbortController();
    t.options.controls = {
      signal: graceful.signal,
      forceSignal: force.signal,
      requestShutdown: () => graceful.abort(),
      requestForce: () => force.abort(),
    };
    t.adapter.sweep.mockImplementation(async (scope) => {
      t.options.controls!.requestShutdown();
      t.signals.emit("SIGINT");
      expect(scope.signal.aborted).toBe(false);
      t.signals.emit("SIGTERM");
      expect(scope.signal.aborted).toBe(true);
    });
    expect(await runEntrypoint(t.options)).toBe(0);
  });
  it("does not create a scope after a signal during acquisition", async () => {
    const t = setup();
    t.options.acquireLock = async () => {
      t.signals.emit("SIGTERM");
      return { release: t.release };
    };
    expect(await runEntrypoint(t.options)).toBe(0);
    expect(t.options.createAdapter).not.toHaveBeenCalled();
    expect(t.release).toHaveBeenCalledOnce();
  });
  it("does not retry one-shot transient failure and sanitizes errors", async () => {
    const t = setup();
    const error = new RuntimeResourceError("QUERY");
    error.message = "secret://password SQL payload";
    t.adapter.sweep.mockRejectedValue(error);
    expect(await runEntrypoint(t.options)).toBe(3);
    expect(t.adapter.sweep).toHaveBeenCalledOnce();
    expect(t.options.wait).not.toHaveBeenCalled();
    expect(JSON.stringify(t.log.mock.calls)).not.toContain("secret");
  });
  it("fails closed on unknown errors", async () => {
    const t = setup();
    t.adapter.sweep.mockRejectedValue(new Error("secret://password"));
    expect(await runEntrypoint(t.options)).toBe(4);
    expect(JSON.stringify(t.log.mock.calls)).not.toContain("secret");
  });
  it("hard exits once on stuck cleanup, retaining lock", async () => {
    const t = setup("relay", ["--daemon"]);
    t.adapter.disposeScope.mockRejectedValue(
      new RuntimeResourceError("CLEANUP_STUCK"),
    );
    expect(await runEntrypoint(t.options)).toBeUndefined();
    expect(t.hardExit).toHaveBeenCalledExactlyOnceWith(6);
    expect(t.adapter.sweep).toHaveBeenCalledOnce();
    expect(t.release).not.toHaveBeenCalled();
    expect(t.log).toHaveBeenCalledExactlyOnceWith({
      event: "runtime_terminal",
      role: "relay",
      mode: "daemon",
      outcome: "cleanup_stuck",
      sweeps: 1,
    });
  });
  it("validates mode without exposing arguments", async () => {
    expect(parseMode(["--one-shot"])).toBe("one-shot");
    expect(parseMode(["--daemon"])).toBe("daemon");
    const t = setup("relay", ["secret"]);
    expect(await runEntrypoint(t.options)).toBe(4);
    expect(t.options.acquireLock).not.toHaveBeenCalled();
    expect(JSON.stringify(t.log.mock.calls)).not.toContain("secret");
  });
  it("retries normalized daemon failures serially", async () => {
    const t = setup("relay", ["--daemon"]);
    t.adapter.sweep.mockRejectedValueOnce(
      new RuntimeResourceError("AMQP_CONFIRM_LOST"),
    );
    t.options.wait = vi.fn(async () => {
      if (t.adapter.sweep.mock.calls.length === 2) t.signals.emit("SIGTERM");
    });
    expect(await runEntrypoint(t.options)).toBe(0);
    expect(t.adapter.sweep).toHaveBeenCalledTimes(2);
  });
  it("reports lock loss as nonzero and safely drains", async () => {
    const t = setup();
    let lose: (error: unknown) => void = () => {};
    t.options.acquireLock = async (_role, onLost) => {
      lose = onLost;
      return { release: t.release };
    };
    t.adapter.sweep.mockImplementation(async () => {
      lose(new RuntimeLockError("SESSION_LOST"));
    });
    expect(await runEntrypoint(t.options)).toBe(5);
    expect(t.release).toHaveBeenCalledOnce();
  });
  it("hard exits on stuck lock acquisition cleanup", async () => {
    const t = setup();
    t.options.acquireLock = async () => {
      throw new RuntimeLockError("CLEANUP_STUCK");
    };
    expect(await runEntrypoint(t.options)).toBeUndefined();
    expect(t.hardExit).toHaveBeenCalledExactlyOnceWith(6);
    expect(t.options.createAdapter).not.toHaveBeenCalled();
  });
  it("classifies only normalized known errors", () => {
    for (const code of [
      "QUERY",
      "AMQP_CONFIRM_LOST",
      "AMQP_DNS_TEMPORARY",
    ] as const)
      expect(classifyRuntimeError(new RuntimeResourceError(code))).toBe(
        "retryable",
      );
    for (const code of [
      "CONFIG",
      "ADAPTER_MISMATCH",
      "AMQP_REPLY_TERMINAL",
      "AMQP_CONFORMANCE_MISMATCH",
      "AMQP_UNKNOWN",
      "CLEANUP_STUCK",
    ] as const)
      expect(classifyRuntimeError(new RuntimeResourceError(code))).toBe(
        "fatal",
      );
    expect(classifyRuntimeError(new RuntimeLockError("QUERY"))).toBe(
      "retryable",
    );
    expect(classifyRuntimeError(new RuntimeLockError("CLEANUP_STUCK"))).toBe(
      "fatal",
    );
    expect(classifyRuntimeError({ code: "QUERY", message: "secret" })).toBe(
      "fatal",
    );
  });
});
