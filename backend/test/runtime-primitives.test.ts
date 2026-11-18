import { describe, expect, it, vi } from "vitest";
import {
  acquireRuntimeLock,
  RuntimeLockError,
  type LockClient,
} from "../src/runtime-lock.js";
import { retryDelay, runSerialLoop } from "../src/runtime-loop.js";
import { RuntimeResourceError } from "../src/runtime-resources.js";

class FakeClient implements LockClient {
  listeners: Partial<Record<"error" | "end", () => void>> = {};
  acquired = true;
  connect = vi.fn(async () => {});
  query = vi.fn(async (sql: string, values: number[]) => {
    expect(sql).toContain("pg_try_advisory_lock");
    expect(values).toHaveLength(2);
    return { rows: [{ acquired: this.acquired }] };
  });
  end = vi.fn(async () => this.listeners.end?.());
  on(event: "error" | "end", listener: () => void) {
    this.listeners[event] = listener;
  }
}

describe("runtime role lock primitive", () => {
  it("closes a contended dedicated session and reports busy", async () => {
    const client = new FakeClient();
    client.acquired = false;
    const lost = vi.fn();
    expect(await acquireRuntimeLock("relay", lost, client)).toBeNull();
    expect(client.end).toHaveBeenCalledOnce();
    expect(lost).not.toHaveBeenCalled();
  });

  it("reports unexpected loss once and never reports intentional close", async () => {
    const client = new FakeClient();
    const lost = vi.fn();
    const lock = await acquireRuntimeLock("scheduler", lost, client);
    client.listeners.error?.();
    client.listeners.end?.();
    expect(lost).toHaveBeenCalledOnce();
    await lock?.release();
    await lock?.release();
    expect(client.end).toHaveBeenCalledOnce();
    expect(client.query.mock.calls[0][1]).toEqual([1229342284, 2]);
  });

  it("closes the session after acquisition failure", async () => {
    const client = new FakeClient();
    client.connect.mockRejectedValueOnce(new Error("unavailable"));
    await expect(
      acquireRuntimeLock("relay", vi.fn(), client),
    ).rejects.toThrow();
    expect(client.end).toHaveBeenCalledOnce();
  });

  it.each(["connect", "query"] as const)(
    "reports terminal cleanup when %s failure is followed by rejected close",
    async (phase) => {
      const client = new FakeClient();
      client[phase].mockRejectedValueOnce(new Error("secret acquisition"));
      client.end.mockRejectedValueOnce(new Error("secret close"));
      const error = await acquireRuntimeLock("relay", vi.fn(), client).catch(
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({ code: "CLEANUP_STUCK" });
      expect(String((error as Error).stack)).not.toContain("secret");
    },
  );

  it.each(["connect", "query", "contention", "release"] as const)(
    "classifies secret-bearing %s failures safely",
    async (phase) => {
      const client = new FakeClient();
      const lost = vi.fn();
      const secret = "secret-password-url-query";
      const failure = new Error(secret);
      if (phase === "connect") client.connect.mockRejectedValueOnce(failure);
      if (phase === "query") client.query.mockRejectedValueOnce(failure);
      if (phase === "contention") client.acquired = false;
      if (phase === "contention" || phase === "release")
        client.end.mockRejectedValueOnce(failure);
      let error: unknown;
      try {
        const lock = await acquireRuntimeLock("relay", lost, client);
        if (phase === "release") await lock?.release();
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        code: {
          connect: "CONNECT",
          query: "QUERY",
          contention: "CLEANUP_STUCK",
          release: "CLEANUP_STUCK",
        }[phase],
      });
      expect(
        `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack}`,
      ).not.toContain(secret);
      expect(lost).not.toHaveBeenCalled();
      expect(client.end).toHaveBeenCalledOnce();
    },
  );

  it("stops a lifecycle caller rather than treating failed contention cleanup as busy", async () => {
    const client = new FakeClient();
    client.acquired = false;
    client.end.mockRejectedValueOnce(new Error("secret close"));
    const sweep = vi.fn(async () => {
      const lock = await acquireRuntimeLock("relay", vi.fn(), client);
      if (!lock) return; // Normal contention may be retried by the caller.
      await lock.release();
    });
    const wait = vi.fn(async () => {});
    await expect(
      runSerialLoop({
        signal: new AbortController().signal,
        sweep,
        wait,
        fatal: (error) =>
          error instanceof RuntimeLockError && error.code === "CLEANUP_STUCK",
        onError: () => {},
      }),
    ).rejects.toMatchObject({ code: "CLEANUP_STUCK" });
    expect(sweep).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it("classifies session loss once and ignores intentional release events", async () => {
    const client = new FakeClient();
    const lost = vi.fn();
    client.query.mockImplementationOnce(async () => {
      client.listeners.error?.();
      client.listeners.end?.();
      throw new Error("secret driver failure");
    });
    const error = await acquireRuntimeLock("relay", lost, client).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "SESSION_LOST" });
    expect(lost).toHaveBeenCalledOnce();
    expect(lost.mock.calls[0][0]).toMatchObject({ code: "SESSION_LOST" });
    expect(
      `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack}`,
    ).not.toContain("secret");
    const second = new FakeClient();
    const intentional = vi.fn();
    const lock = await acquireRuntimeLock("relay", intentional, second);
    await lock?.release();
    expect(intentional).not.toHaveBeenCalled();
  });
});

describe("serial loop primitive", () => {
  it("propagates terminal cleanup failure even when shutdown was requested", async () => {
    const controller = new AbortController();
    const failure = new RuntimeResourceError("CLEANUP_STUCK");
    const sweep = vi.fn(async () => {
      controller.abort();
      throw failure;
    });
    const wait = vi.fn(async () => {});
    const onError = vi.fn();
    await expect(
      runSerialLoop({
        signal: controller.signal,
        sweep,
        wait,
        fatal: (error) => error instanceof RuntimeResourceError && error.fatal,
        onError,
      }),
    ).rejects.toBe(failure);
    expect(sweep).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("waits for each sweep and stops without starting another after abort", async () => {
    const controller = new AbortController();
    let finish!: () => void;
    const sweep = vi.fn(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const wait = vi.fn(async (_milliseconds: number, _signal: AbortSignal) => {
      void _milliseconds;
      void _signal;
    });
    const running = runSerialLoop({
      signal: controller.signal,
      sweep,
      wait,
      fatal: () => false,
      onError: () => {},
    });
    await Promise.resolve();
    expect(sweep).toHaveBeenCalledOnce();
    controller.abort();
    finish();
    await running;
    expect(sweep).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it("backs off after failures, resets after success and exits on fatal error", async () => {
    const sweep = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("temporary"))
      .mockRejectedValueOnce(new Error("fatal"));
    const wait = vi.fn(async (milliseconds: number, signal: AbortSignal) => {
      void milliseconds;
      void signal;
    });
    await expect(
      runSerialLoop({
        signal: new AbortController().signal,
        sweep,
        wait,
        fatal: (error) => error instanceof Error && error.message === "fatal",
        onError: () => {},
        random: () => 0,
      }),
    ).rejects.toThrow("fatal");
    expect(wait.mock.calls.map((call) => call[0])).toEqual([250, 1000, 250]);
  });

  it("caps exponential jitter", () => {
    expect(retryDelay(100, () => 0)).toBe(15000);
    expect(retryDelay(100, () => 0.999)).toBeLessThan(30000);
  });

  it("treats a cancelled wait as shutdown without admitting another sweep", async () => {
    const controller = new AbortController();
    const sweep = vi.fn(async () => {});
    const wait = vi.fn(async () => {
      controller.abort();
      throw new Error("wait cancelled");
    });
    await runSerialLoop({
      signal: controller.signal,
      sweep,
      wait,
      fatal: () => false,
      onError: () => {},
    });
    expect(sweep).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledOnce();
  });

  it("propagates wait failures that are not shutdown", async () => {
    await expect(
      runSerialLoop({
        signal: new AbortController().signal,
        sweep: async () => {},
        wait: async () => {
          throw new Error("wait failed");
        },
        fatal: () => false,
        onError: () => {},
      }),
    ).rejects.toThrow("wait failed");
  });
});
