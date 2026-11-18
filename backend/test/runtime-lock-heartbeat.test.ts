import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { acquireRuntimeLock, type LockClient } from "../src/runtime-lock.js";
const row = { rows: [{ acquired: true }] };
function deferred() {
  let resolve!: (value: typeof row) => void;
  const promise = new Promise<typeof row>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class Client implements LockClient {
  listeners = new Map<string, Set<() => void>>();
  connect = vi.fn(async () => {});
  query = vi.fn(async (sql: string, values: number[]): Promise<typeof row> => {
    void sql;
    void values;
    return row;
  });
  end = vi.fn(async () => {
    this.emit("end");
  });
  on(event: "error" | "end", listener: () => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
  }
  removeListener(event: "error" | "end", listener: () => void) {
    this.listeners.get(event)?.delete(listener);
  }
  emit(event: string) {
    for (const fn of this.listeners.get(event) ?? []) fn();
  }
}
describe("ownership heartbeat", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("is periodic and serial and release removes timers and listeners", async () => {
    const c = new Client(),
      pending = deferred();
    c.query
      .mockResolvedValueOnce(row)
      .mockImplementationOnce(() => pending.promise);
    const lock = (await acquireRuntimeLock("relay", vi.fn(), c))!;
    await vi.advanceTimersByTimeAsync(4000);
    expect(c.query).toHaveBeenCalledTimes(2);
    pending.resolve(row);
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.query).toHaveBeenCalledTimes(3);
    expect(c.query.mock.calls[1]).toEqual(["SELECT 1", []]);
    await lock.release();
    expect(vi.getTimerCount()).toBe(0);
    expect(c.listeners.get("error")?.size).toBe(0);
    expect(c.listeners.get("end")?.size).toBe(0);
  });
  it("normalizes rejection and signals error plus end once", async () => {
    const c = new Client(),
      lost = vi.fn();
    c.query
      .mockResolvedValueOnce(row)
      .mockRejectedValueOnce(new Error("secret-url-query"));
    const lock = (await acquireRuntimeLock("relay", lost, c))!;
    await vi.advanceTimersByTimeAsync(2000);
    c.emit("error");
    c.emit("end");
    expect(lost).toHaveBeenCalledOnce();
    expect(lost.mock.calls[0][0]).toMatchObject({ code: "SESSION_LOST" });
    expect(String(lost.mock.calls[0][0].stack)).not.toContain("secret");
    await lock.release();
  });
  it("destroys before timeout signal and never schedules after late settlement", async () => {
    const c = new Client(),
      pending = deferred(),
      dispose = vi.fn();
    c.query
      .mockResolvedValueOnce(row)
      .mockImplementationOnce(() => pending.promise);
    const lost = vi.fn((error: unknown) => {
      void error;
      expect(dispose).toHaveBeenCalledOnce();
    });
    const lock = (await acquireRuntimeLock("relay", lost, c, { dispose }))!;
    await vi.advanceTimersByTimeAsync(7000);
    expect(lost).toHaveBeenCalledOnce();
    expect(lost.mock.calls[0][0]).toMatchObject({ code: "HEARTBEAT_TIMEOUT" });
    pending.resolve(row);
    await lock.release();
    await vi.advanceTimersByTimeAsync(10000);
    expect(c.query).toHaveBeenCalledTimes(2);
  });
  it.each([false, true])(
    "release joins heartbeat, forcing if stuck: %s",
    async (stuck) => {
      const c = new Client(),
        pending = deferred(),
        dispose = vi.fn(),
        lost = vi.fn();
      c.query
        .mockResolvedValueOnce(row)
        .mockImplementationOnce(() => pending.promise);
      const lock = (await acquireRuntimeLock("relay", lost, c, { dispose }))!;
      await vi.advanceTimersByTimeAsync(2000);
      const release = lock.release();
      const outcome = release.catch((error: unknown) => error);
      expect(lock.release()).toBe(release);
      expect(c.end).not.toHaveBeenCalled();
      if (stuck) await vi.advanceTimersByTimeAsync(5000);
      else pending.resolve(row);
      if (stuck) expect(await outcome).toMatchObject({ code: "CLEANUP_STUCK" });
      else await release;
      expect(c.end).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledTimes(stuck ? 1 : 0);
      expect(lost).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("does not monitor contention", async () => {
    const c = new Client();
    const lost = vi.fn();
    c.query.mockResolvedValueOnce({ rows: [{ acquired: false }] });
    expect(await acquireRuntimeLock("scheduler", lost, c)).toBeNull();
    expect(c.listeners.get("error")?.size).toBe(0);
    expect(c.listeners.get("end")?.size).toBe(0);
    expect(lost).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10000);
    expect(c.query).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["reject", "timeout", "disposer throws"] as const)(
    "contention close %s is terminal and retains a late error sink",
    async (mode) => {
      class EmitterClient extends EventEmitter implements LockClient {
        connect = async () => {};
        query = async () => ({ rows: [{ acquired: false }] });
        end = vi.fn(() =>
          mode === "reject"
            ? Promise.reject(new Error("secret pg://url query"))
            : new Promise<void>(() => {}),
        );
      }
      const c = new EmitterClient();
      const lost = vi.fn();
      const dispose = vi.fn(() => {
        if (mode === "disposer throws") throw new Error("secret disposer");
      });
      const outcome = acquireRuntimeLock("relay", lost, c, { dispose }).catch(
        (error: unknown) => error,
      );
      if (mode !== "reject") await vi.advanceTimersByTimeAsync(5000);
      const error = await outcome;
      expect(error).toMatchObject({ code: "CLEANUP_STUCK" });
      expect(
        `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack}`,
      ).not.toContain("secret");
      expect((error as Error).cause).toBeUndefined();
      expect(c.end).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledTimes(mode === "reject" ? 0 : 1);
      expect(c.listenerCount("error")).toBeGreaterThan(0);
      expect(() =>
        c.emit("error", new Error("secret late error")),
      ).not.toThrow();
      expect(lost).not.toHaveBeenCalled();
    },
  );
  it("destroys timed-out acquisition before safe failure", async () => {
    const c = new Client(),
      pending = deferred(),
      dispose = vi.fn();
    c.query.mockImplementationOnce(() => pending.promise);
    const outcome = acquireRuntimeLock("relay", vi.fn(), c, { dispose }).catch(
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(await outcome).toMatchObject({ code: "ACQUIRE_TIMEOUT" });
    expect(dispose).toHaveBeenCalledOnce();
    expect(c.end).toHaveBeenCalledOnce();
    pending.resolve(row);
    await vi.advanceTimersByTimeAsync(10000);
    expect(c.query).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds stuck end with consistent safe cleanup failure", async () => {
    const c = new Client(),
      dispose = vi.fn();
    c.end.mockImplementation(() => new Promise<void>(() => {}));
    const lock = (await acquireRuntimeLock("relay", vi.fn(), c, { dispose }))!;
    const release = lock.release(),
      outcome = release.catch((e: unknown) => e);
    expect(lock.release()).toBe(release);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await outcome).toMatchObject({ code: "CLEANUP_STUCK" });
    expect(dispose).toHaveBeenCalledOnce();
  });
  it.each([false, true])(
    "release rejects for unsettled heartbeat even when end succeeds; disposer throws: %s",
    async (throws) => {
      const c = new Client(),
        pending = deferred(),
        lost = vi.fn();
      const dispose = vi.fn(() => {
        if (throws) throw new Error("secret disposer");
      });
      c.query
        .mockResolvedValueOnce(row)
        .mockImplementationOnce(() => pending.promise);
      const lock = (await acquireRuntimeLock("relay", lost, c, { dispose }))!;
      await vi.advanceTimersByTimeAsync(2000);
      const release = lock.release();
      const outcome = release.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await outcome).toMatchObject({ code: "CLEANUP_STUCK" });
      expect(lock.release()).toBe(release);
      expect(c.end).toHaveBeenCalledOnce();
      expect(lost).not.toHaveBeenCalled();
      pending.resolve(row);
      await expect(lock.release()).rejects.toMatchObject({
        code: "CLEANUP_STUCK",
      });
    },
  );
  it("retains failed disposal even if heartbeat eventually settles", async () => {
    const c = new Client(),
      pending = deferred(),
      lost = vi.fn();
    c.query
      .mockResolvedValueOnce(row)
      .mockImplementationOnce(() => pending.promise);
    const lock = (await acquireRuntimeLock("relay", lost, c, {
      dispose: () => {
        throw new Error("secret");
      },
    }))!;
    await vi.advanceTimersByTimeAsync(7000);
    expect(lost).toHaveBeenCalledOnce();
    expect(lost.mock.calls[0][0]).toMatchObject({ code: "CLEANUP_STUCK" });
    pending.resolve(row);
    await Promise.resolve();
    await expect(lock.release()).rejects.toMatchObject({
      code: "CLEANUP_STUCK",
    });
  });
  it.each(["connect", "query", "contention"] as const)(
    "stuck cleanup takes precedence over %s failure",
    async (phase) => {
      const c = new Client();
      if (phase === "connect")
        c.connect.mockRejectedValueOnce(new Error("secret"));
      if (phase === "query") c.query.mockRejectedValueOnce(new Error("secret"));
      if (phase === "contention")
        c.query.mockResolvedValueOnce({ rows: [{ acquired: false }] });
      c.end.mockImplementation(() => new Promise<void>(() => {}));
      const outcome = acquireRuntimeLock("relay", vi.fn(), c, {
        dispose: () => {
          throw new Error("secret disposal");
        },
      }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5000);
      const error = await outcome;
      expect(error).toMatchObject({ code: "CLEANUP_STUCK" });
      expect(String((error as Error).stack)).not.toContain("secret");
    },
  );
  it.each(["reject", "timeout", "disposer"] as const)(
    "keeps a late error sink after end %s",
    async (mode) => {
      class EmitterClient extends EventEmitter implements LockClient {
        connect = async () => {};
        query = async () => row;
        end = () =>
          mode === "reject"
            ? Promise.reject(new Error("secret"))
            : new Promise<void>(() => {});
      }
      const c = new EmitterClient(),
        lost = vi.fn();
      const lock = (await acquireRuntimeLock("relay", lost, c, {
        dispose: () => {
          if (mode === "disposer") throw new Error("secret");
        },
      }))!;
      const release = lock.release();
      const outcome = release.catch((error: unknown) => error);
      if (mode !== "reject") await vi.advanceTimersByTimeAsync(5000);
      const error = await outcome;
      expect(error).toMatchObject({ code: "CLEANUP_STUCK" });
      expect(lock.release()).toBe(release);
      expect(String((error as Error).stack)).not.toContain("secret");
      expect((error as Error).cause).toBeUndefined();
      expect(c.listenerCount("error")).toBeGreaterThan(0);
      expect(() =>
        c.emit("error", new Error("secret late error")),
      ).not.toThrow();
      expect(lost).not.toHaveBeenCalled();
    },
  );
});
