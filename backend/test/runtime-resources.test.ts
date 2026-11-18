import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type amqp from "amqplib";
import {
  ownedAmqp,
  ownedPg,
  RuntimeResourceError,
  SweepScope,
} from "../src/runtime-resources.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function pgFake() {
  const stream = { destroy: vi.fn() };
  return {
    connection: { stream },
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({}),
    end: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  };
}
function amqpFake() {
  const stream = { destroy: vi.fn() };
  const channel = { close: vi.fn().mockResolvedValue(undefined), on: vi.fn() };
  const connection = {
    connection: { stream },
    close: vi.fn().mockResolvedValue(undefined),
    createChannel: vi.fn().mockResolvedValue(channel),
    createConfirmChannel: vi
      .fn()
      .mockResolvedValue(channel as unknown as amqp.ConfirmChannel),
    on: vi.fn(),
  };
  return { connection, channel, stream };
}

describe("owned sweep resources", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it.each(["pg", "connection", "channel"])(
    "force destroys late %s without graceful work",
    async (kind) => {
      const scope = new SweepScope(50);
      const client = pgFake();
      const f = amqpFake();
      const pgPending = deferred<void>();
      const connectionPending = deferred<typeof f.connection>();
      const channelPending = deferred<amqp.ConfirmChannel>();
      let operation: Promise<unknown>;
      if (kind === "pg") {
        client.connect.mockReturnValue(pgPending.promise);
        operation = ownedPg(scope, "url", () => client);
      } else if (kind === "connection") {
        operation = ownedAmqp(scope, "url", () => connectionPending.promise);
      } else {
        f.connection.createConfirmChannel.mockReturnValue(
          channelPending.promise,
        );
        const owner = await ownedAmqp(scope, "url", async () => f.connection);
        operation = owner.createConfirmChannel();
      }
      const rejectedOperation = expect(operation).rejects.toMatchObject({
        code: "ABORTED",
      });
      scope.abort();
      await rejectedOperation;
      const disposal = expect(scope.dispose()).rejects.toMatchObject({
        code: "CLEANUP_STUCK",
      });
      await vi.advanceTimersByTimeAsync(2050);
      await disposal;
      client.connection.stream.destroy.mockClear();
      f.stream.destroy.mockClear();
      client.end.mockClear();
      f.connection.close.mockClear();
      f.channel.close.mockClear();
      if (kind === "pg") pgPending.resolve();
      else if (kind === "connection") connectionPending.resolve(f.connection);
      else channelPending.resolve(f.channel as unknown as amqp.ConfirmChannel);
      await Promise.resolve();
      await Promise.resolve();
      expect(
        kind === "pg" ? client.connection.stream.destroy : f.stream.destroy,
      ).toHaveBeenCalledOnce();
      expect(client.end).not.toHaveBeenCalled();
      expect(f.connection.close).not.toHaveBeenCalled();
      expect(f.channel.close).not.toHaveBeenCalled();
      expect(client.query).not.toHaveBeenCalled();
      expect(() => scope.check()).toThrow();
      const on =
        kind === "pg"
          ? client.on
          : kind === "connection"
            ? f.connection.on
            : f.channel.on;
      const listener = on.mock.calls.find(
        ([event]) => event === "error",
      )?.[1] as ((error: Error) => void) | undefined;
      expect(listener).toBeDefined();
      expect(() => listener?.(new Error("secret"))).not.toThrow();
    },
  );
  it.each([false, true])(
    "handles stalled connection close, permanent=%s",
    async (permanent) => {
      const scope = new SweepScope(50);
      const f = amqpFake();
      const pending = deferred<void>();
      f.connection.close.mockReturnValue(pending.promise);
      await ownedAmqp(scope, "url", async () => f.connection);
      const result = scope.dispose();
      const outcome = permanent
        ? expect(result).rejects.toMatchObject({
            code: "CLEANUP_STUCK",
            cleanupPhases: ["AMQP_CONNECTION_CLOSE"],
          })
        : expect(result).resolves.toEqual([
            expect.objectContaining({ code: "CLOSE" }),
          ]);
      await vi.advanceTimersByTimeAsync(2000);
      expect(f.stream.destroy).toHaveBeenCalledOnce();
      if (permanent) await vi.advanceTimersByTimeAsync(50);
      else pending.resolve();
      await outcome;
      pending.resolve();
      await Promise.resolve();
      expect(f.connection.close).toHaveBeenCalledOnce();
    },
  );
  it.each(["pg", "amqp"])(
    "waits independently for stalled %s close",
    async (stalled) => {
      const scope = new SweepScope(50);
      const client = pgFake();
      const f = amqpFake();
      const pending = deferred<void>();
      if (stalled === "pg") client.end.mockReturnValue(pending.promise);
      else f.connection.close.mockReturnValue(pending.promise);
      await ownedPg(scope, "url", () => client);
      await ownedAmqp(scope, "url", async () => f.connection);
      let settled = false;
      const disposal = scope.dispose().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(client.end).toHaveBeenCalledOnce();
      expect(f.connection.close).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      pending.resolve();
      await disposal;
    },
  );
  it("normalizes synchronous close throws and proceeds independently", async () => {
    const scope = new SweepScope(50);
    const client = pgFake();
    const f = amqpFake();
    client.end.mockImplementation(() => {
      throw new Error("secret");
    });
    f.channel.close.mockImplementation(() => {
      throw new Error("secret");
    });
    await ownedPg(scope, "url", () => client);
    const owner = await ownedAmqp(scope, "url", async () => f.connection);
    await owner.createConfirmChannel();
    const errors = await scope.dispose();
    expect(errors.map((e) => e.code)).toEqual(["CLOSE", "CLOSE"]);
    expect(String(errors)).not.toContain("secret");
    expect(f.connection.close).toHaveBeenCalledOnce();
  });
  it("does not settle disposal until an aborted operation and late cleanup settle", async () => {
    const scope = new SweepScope(5000);
    const fake = amqpFake();
    const pending = deferred<typeof fake.connection>();
    const result = ownedAmqp(scope, "url", () => pending.promise);
    const rejected = expect(result).rejects.toMatchObject({ code: "ABORTED" });
    scope.abort();
    await rejected;
    let settled = false;
    const disposal = scope.dispose().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(settled).toBe(false);
    pending.resolve(fake.connection);
    await disposal;
    expect(fake.connection.close).not.toHaveBeenCalled();
  });
  it("disposes a PG connection resolving after abort", async () => {
    const scope = new SweepScope(5000);
    const client = pgFake();
    const pending = deferred<void>();
    client.connect.mockReturnValue(pending.promise);
    const result = ownedPg(scope, "secret", () => client);
    const rejected = expect(result).rejects.toMatchObject({ code: "ABORTED" });
    scope.abort();
    await rejected;
    pending.resolve();
    await vi.runAllTimersAsync();
    expect(client.end).toHaveBeenCalled();
    expect(client.connection.stream.destroy).toHaveBeenCalled();
  });
  it("destroys a stalled query and refuses further admission", async () => {
    const scope = new SweepScope(5000);
    const client = pgFake();
    const owned = await ownedPg(scope, "url", () => client);
    client.query.mockReturnValue(new Promise(() => {}));
    const result = owned.query("SELECT 1");
    const rejected = expect(result).rejects.toMatchObject({ code: "QUERY" });
    await vi.advanceTimersByTimeAsync(6000);
    await rejected;
    expect(client.connection.stream.destroy).toHaveBeenCalled();
    await expect(owned.query("SELECT 1")).rejects.toMatchObject({
      code: "QUERY",
    });
  });
  it("normally ends PG and disposal is idempotent", async () => {
    const scope = new SweepScope(5000);
    const client = pgFake();
    await ownedPg(scope, "url", () => client);
    const first = scope.dispose();
    expect(scope.dispose()).toBe(first);
    expect(await first).toEqual([]);
    expect(client.end).toHaveBeenCalledOnce();
    expect(client.connection.stream.destroy).not.toHaveBeenCalled();
  });
  it("aborts a stalled AMQP connect", async () => {
    const scope = new SweepScope(5000);
    let signal!: AbortSignal;
    const result = ownedAmqp(scope, "url", (_url, options) => {
      signal = options.signal;
      return new Promise(() => {});
    });
    const rejected = expect(result).rejects.toMatchObject({
      code: "AMQP_CONNECT_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(signal.aborted).toBe(true);
  });
  it("destroys the connection on stalled RPC", async () => {
    const scope = new SweepScope(5000);
    const fake = amqpFake();
    const owned = await ownedAmqp(scope, "url", async () => fake.connection);
    const result = owned.operation(() => new Promise(() => {}), 10_000);
    const rejected = expect(result).rejects.toMatchObject({ code: "RPC" });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(fake.stream.destroy).toHaveBeenCalled();
  });
  it("closes a late AMQP connection", async () => {
    const scope = new SweepScope(5000);
    const fake = amqpFake();
    const pending = deferred<typeof fake.connection>();
    const result = ownedAmqp(scope, "url", () => pending.promise);
    const rejected = expect(result).rejects.toMatchObject({ code: "ABORTED" });
    scope.abort();
    await rejected;
    pending.resolve(fake.connection);
    await vi.runAllTimersAsync();
    expect(fake.connection.close).toHaveBeenCalled();
    expect(fake.stream.destroy).toHaveBeenCalled();
  });
  it("enforces the scope deadline", async () => {
    const scope = new SweepScope(5000);
    const client = pgFake();
    await ownedPg(scope, "url", () => client);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scope.signal.aborted).toBe(true);
    expect(() => scope.check()).toThrowError(
      expect.objectContaining({ code: "DEADLINE" }),
    );
    expect(client.connection.stream.destroy).toHaveBeenCalled();
  });
  it("waits for a late close after force without touching resources after return", async () => {
    const scope = new SweepScope(5000);
    const fake = amqpFake();
    const client = pgFake();
    const pending = deferred<void>();
    fake.channel.close.mockReturnValue(pending.promise);
    await ownedPg(scope, "url", () => client);
    const owned = await ownedAmqp(scope, "url", async () => fake.connection);
    await owned.createConfirmChannel();
    let settled = false;
    const result = scope.dispose().then((errors) => {
      settled = true;
      return errors;
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(settled).toBe(false);
    expect(fake.stream.destroy).toHaveBeenCalledOnce();
    expect(client.connection.stream.destroy).toHaveBeenCalledOnce();
    expect(fake.connection.close).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledOnce();
    pending.resolve();
    expect((await result).map((error) => error.code)).toContain("CLOSE");
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.connection.close).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledOnce();
  });
  it("fails terminally when cleanup never settles after force", async () => {
    const scope = new SweepScope(5000);
    const client = pgFake();
    client.end.mockReturnValue(new Promise(() => {}));
    await ownedPg(scope, "url", () => client);
    const result = scope.dispose();
    const rejected = expect(result).rejects.toMatchObject({
      code: "CLEANUP_STUCK",
      fatal: true,
      cleanupPhases: ["PG_END"],
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.connection.stream.destroy).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(scope.dispose()).toBe(result);
  });
  it("serializes channel and connection close as required by amqplib", async () => {
    const scope = new SweepScope(50);
    const fake = amqpFake();
    const handshake = deferred<void>();
    let channelPending = false;
    let lostAcknowledgement = false;
    fake.channel.close.mockImplementation(() => {
      channelPending = true;
      return handshake.promise.then(() => {
        channelPending = false;
        return lostAcknowledgement ? new Promise<void>(() => {}) : undefined;
      });
    });
    // Models the driver losing the close acknowledgement if the connection
    // starts closing while the channel handshake is still in flight.
    fake.connection.close.mockImplementation(() => {
      if (channelPending) lostAcknowledgement = true;
      return Promise.resolve();
    });
    const owned = await ownedAmqp(scope, "url", async () => fake.connection);
    await owned.createConfirmChannel();
    const disposal = scope.dispose();
    await Promise.resolve();
    expect(fake.channel.close).toHaveBeenCalledOnce();
    expect(fake.connection.close).not.toHaveBeenCalled();
    handshake.resolve();
    expect(await disposal).toEqual([]);
    expect(fake.connection.close).toHaveBeenCalledOnce();
  });
  it("reports close rejection and still closes the connection", async () => {
    const scope = new SweepScope(50);
    const fake = amqpFake();
    fake.channel.close.mockRejectedValue(new Error("secret"));
    const owned = await ownedAmqp(scope, "url", async () => fake.connection);
    await owned.createConfirmChannel();
    const errors = await scope.dispose();
    expect(errors.map((error) => error.code)).toEqual(["CLOSE"]);
    expect(String(errors[0])).not.toContain("secret");
    expect(fake.connection.close).toHaveBeenCalledOnce();
  });
  it("reports a connection close rejection without exposing driver details", async () => {
    const scope = new SweepScope(50);
    const fake = amqpFake();
    fake.connection.close.mockRejectedValue(new Error("secret"));
    const owned = await ownedAmqp(scope, "url", async () => fake.connection);
    await owned.createConfirmChannel();
    const errors = await scope.dispose();
    expect(errors.map((error) => error.code)).toEqual(["CLOSE"]);
    expect(String(errors[0])).not.toContain("secret");
    expect(fake.channel.close).toHaveBeenCalledOnce();
    expect(fake.connection.close).toHaveBeenCalledOnce();
  });
  it("reports a stuck channel and never starts connection close after return", async () => {
    const scope = new SweepScope(50);
    const fake = amqpFake();
    const handshake = deferred<void>();
    fake.channel.close.mockReturnValue(handshake.promise);
    const owned = await ownedAmqp(scope, "url", async () => fake.connection);
    await owned.createConfirmChannel();
    const result = scope.dispose();
    const rejected = expect(result).rejects.toMatchObject({
      code: "CLEANUP_STUCK",
      cleanupPhases: ["AMQP_CHANNEL_CLOSE"],
    });
    await vi.advanceTimersByTimeAsync(2050);
    await rejected;
    expect(fake.stream.destroy).toHaveBeenCalledOnce();
    handshake.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.connection.close).not.toHaveBeenCalled();
  });
  it("fails closed on an unknown adapter shape", async () => {
    const scope = new SweepScope(5000);
    const client = pgFake();
    client.connection = {} as typeof client.connection;
    await expect(ownedPg(scope, "url", () => client)).rejects.toMatchObject({
      code: "ADAPTER_MISMATCH",
      fatal: true,
    });
  });
  it("normalizes secret-bearing driver errors", async () => {
    const scope = new SweepScope(5000);
    const client = pgFake();
    client.connect.mockRejectedValue(new Error("secret url sql payload"));
    const error = await ownedPg(scope, "secret", () => client).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RuntimeResourceError);
    expect(String(error)).not.toContain("secret");
    expect(error).toMatchObject({ code: "CONNECT" });
  });
});

describe("owned confirm channels", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it.each([
    ["ETIMEDOUT", "AMQP_CONNECT_TIMEOUT"],
    ["ECONNREFUSED", "AMQP_CONNECT_REFUSED"],
    ["EAI_AGAIN", "AMQP_DNS_TEMPORARY"],
  ])("normalizes connect %s", async (driverCode, code) => {
    const scope = new SweepScope(50);
    await expect(
      ownedAmqp(scope, "secret", async () => {
        throw { code: driverCode, message: "secret" };
      }),
    ).rejects.toMatchObject({ code, fatal: false });
    await scope.dispose();
  });
  function fake() {
    const stream = { destroy: vi.fn() };
    const channel = Object.assign(new EventEmitter(), {
      close: vi.fn().mockResolvedValue(undefined),
      publish: vi.fn(),
      assertQueue: vi
        .fn()
        .mockResolvedValue({ queue: "q", messageCount: 0, consumerCount: 0 }),
      deleteQueue: vi.fn().mockResolvedValue({ messageCount: 0 }),
    });
    const connection = Object.assign(new EventEmitter(), {
      connection: { stream },
      close: vi.fn().mockResolvedValue(undefined),
      createChannel: vi.fn(),
      createConfirmChannel: vi
        .fn()
        .mockResolvedValue(channel as unknown as amqp.ConfirmChannel),
    });
    return { stream, channel, connection };
  }
  async function setup() {
    const scope = new SweepScope(50);
    const f = fake();
    const owner = await ownedAmqp(scope, "secret", async () => f.connection);
    const channel = await owner.createConfirmChannel();
    return { ...f, scope, owner, owned: channel };
  }
  it("exposes only a frozen topology and guarded publish facade", async () => {
    const f = await setup();
    expect(Object.isFrozen(f.owned)).toBe(true);
    expect(Object.keys(f.owned).sort()).toEqual([
      "assertQueue",
      "deleteQueue",
      "publish",
    ]);
    for (const key of [
      "rpc",
      "sendToQueue",
      "waitForConfirms",
      "on",
      "off",
      "close",
      "channel",
    ]) {
      expect(Reflect.get(f.owned, key)).toBeUndefined();
    }
    await expect(f.owned.assertQueue("q", { durable: true })).resolves.toEqual({
      queue: "q",
      messageCount: 0,
      consumerCount: 0,
    });
    await expect(f.owned.deleteQueue("q")).resolves.toEqual({
      messageCount: 0,
    });
    expect(f.channel.assertQueue).toHaveBeenCalledWith("q", { durable: true });
    await f.scope.dispose();
    await expect(f.owned.assertQueue("q")).rejects.toMatchObject({
      code: "ABORTED",
    });
  });
  it("rejects overlapping topology and publish operations in both directions", async () => {
    const f = await setup();
    const pending = deferred<{
      queue: string;
      messageCount: number;
      consumerCount: number;
    }>();
    f.channel.assertQueue.mockReturnValue(pending.promise);
    const topology = f.owned.assertQueue("q");
    await expect(
      f.owned.publish("", "q", Buffer.alloc(0)),
    ).rejects.toMatchObject({ code: "PROGRAMMING" });
    await expect(f.owned.deleteQueue("q")).rejects.toMatchObject({
      code: "PROGRAMMING",
    });
    pending.resolve({ queue: "q", messageCount: 0, consumerCount: 0 });
    await topology;
    let confirm!: (error: Error | null) => void;
    f.channel.publish.mockImplementation((_e, _r, _b, _o, cb) => {
      confirm = cb;
      return true;
    });
    const publication = f.owned.publish("", "q", Buffer.alloc(0));
    await expect(
      f.owned.publish("", "q", Buffer.alloc(0)),
    ).rejects.toMatchObject({ code: "PROGRAMMING" });
    await expect(f.owned.deleteQueue("q")).rejects.toMatchObject({
      code: "PROGRAMMING",
    });
    confirm(null);
    await publication;
    await f.scope.dispose();
  });
  it("bounds topology work and closes admission on timeout", async () => {
    const f = await setup();
    const pending = deferred<{ messageCount: number }>();
    f.channel.deleteQueue.mockReturnValue(pending.promise);
    const operation = f.owned.deleteQueue("q", undefined, 10);
    const rejected = expect(operation).rejects.toMatchObject({
      code: "AMQP_OPERATION_DEADLINE",
    });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(f.stream.destroy).toHaveBeenCalled();
    await expect(f.owned.assertQueue("q")).rejects.toMatchObject({
      code: "AMQP_OPERATION_DEADLINE",
    });
    pending.resolve({ messageCount: 0 });
    await f.scope.dispose();
  });
  it("ignores mismatched and late returns without contaminating the next publication", async () => {
    const f = await setup();
    let confirm!: (error: Error | null) => void;
    let id = "";
    f.channel.publish.mockImplementation((_e, _r, _b, options, cb) => {
      id = options.messageId;
      confirm = cb;
      return true;
    });
    const first = f.owned.publish("", "q", Buffer.alloc(0));
    f.channel.emit("return", { properties: { messageId: "unrelated" } });
    const oldId = id;
    confirm(null);
    await expect(first).resolves.toEqual({ confirmed: true, routed: true });
    const second = f.owned.publish("", "q", Buffer.alloc(0));
    f.channel.emit("return", { properties: { messageId: oldId } });
    confirm(null);
    await expect(second).resolves.toEqual({ confirmed: true, routed: true });
    expect(f.channel.listenerCount("return")).toBe(0);
    await f.scope.dispose();
  });
  it.each(["success", "return", "timeout", "abort"])(
    "removes publication listeners on %s",
    async (kind) => {
      const f = await setup();
      const initialClose = f.channel.listenerCount("close");
      let confirm!: (error: Error | null) => void;
      let id = "";
      f.channel.publish.mockImplementation((_e, _r, _b, options, cb) => {
        id = options.messageId;
        confirm = cb;
        return true;
      });
      const result = f.owned.publish("", "q", Buffer.alloc(0), 10);
      const settled = result.catch(() => undefined);
      if (kind === "return")
        f.channel.emit("return", { properties: { messageId: id } });
      if (kind === "success" || kind === "return") confirm(null);
      if (kind === "abort") f.scope.abort();
      if (kind === "timeout") await vi.advanceTimersByTimeAsync(10);
      await settled;
      expect(f.channel.listenerCount("return")).toBe(0);
      expect(f.channel.listenerCount("nack")).toBe(0);
      expect(f.channel.listenerCount("close")).toBe(initialClose);
      await f.scope.dispose();
    },
  );
  it("registers and cleans up a confirm channel", async () => {
    const f = await setup();
    await f.scope.dispose();
    expect(f.channel.close).toHaveBeenCalledOnce();
    expect(f.connection.close).toHaveBeenCalledOnce();
  });
  it("reserves before creation, rejects concurrent and repeated attempts, and exposes no ordinary channel", async () => {
    const f = fake();
    const scope = new SweepScope(5000);
    const pending = deferred<amqp.ConfirmChannel>();
    f.connection.createConfirmChannel.mockReturnValue(pending.promise);
    const owner = await ownedAmqp(scope, "secret", async () => f.connection);
    expect(Reflect.get(owner, "createChannel")).toBeUndefined();
    const first = owner.createConfirmChannel();
    await expect(owner.createConfirmChannel()).rejects.toMatchObject({
      code: "PROGRAMMING",
    });
    expect(f.connection.createConfirmChannel).toHaveBeenCalledOnce();
    expect(f.connection.createChannel).not.toHaveBeenCalled();
    pending.resolve(f.channel as unknown as amqp.ConfirmChannel);
    const facade = await first;
    expect(facade).not.toBe(f.channel);
    await expect(owner.createConfirmChannel()).rejects.toMatchObject({
      code: "PROGRAMMING",
    });
    expect(f.connection.createConfirmChannel).toHaveBeenCalledOnce();
    await scope.dispose();
    expect(f.channel.close).toHaveBeenCalledOnce();
    expect(f.connection.close).toHaveBeenCalledOnce();
  });
  it("fails closed on channel creation failure without leaking driver details", async () => {
    const f = fake();
    const scope = new SweepScope(5000);
    f.connection.createConfirmChannel.mockRejectedValue(new Error("secret"));
    const owner = await ownedAmqp(scope, "secret", async () => f.connection);
    const error = await owner.createConfirmChannel().catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "AMQP_UNKNOWN" });
    expect(String(error)).not.toContain("secret");
    expect(scope.signal.aborted).toBe(true);
    await expect(owner.createConfirmChannel()).rejects.toMatchObject({
      code: "AMQP_UNKNOWN",
    });
    expect(f.connection.createConfirmChannel).toHaveBeenCalledOnce();
    await scope.dispose();
    expect(f.connection.close).toHaveBeenCalledOnce();
    expect(f.stream.destroy).toHaveBeenCalled();
  });
  it("cleans a confirm channel arriving after abort", async () => {
    const f = fake();
    const scope = new SweepScope(5000);
    const pending = deferred<amqp.ConfirmChannel>();
    f.connection.createConfirmChannel.mockReturnValue(pending.promise);
    const owner = await ownedAmqp(scope, "url", async () => f.connection);
    const result = owner.createConfirmChannel();
    const rejected = expect(result).rejects.toMatchObject({ code: "ABORTED" });
    scope.abort();
    await rejected;
    pending.resolve(f.channel as unknown as amqp.ConfirmChannel);
    await scope.dispose();
    expect(f.channel.close).toHaveBeenCalledOnce();
    expect(f.channel.listenerCount("error")).toBeGreaterThan(0);
    expect(f.connection.close).toHaveBeenCalledOnce();
  });
  it("confirms only a persistent mandatory publication with routing evidence", async () => {
    const f = await setup();
    f.channel.publish.mockImplementation((_e, _r, _b, options, cb) => {
      expect(options).toMatchObject({
        mandatory: true,
        persistent: true,
        messageId: expect.any(String),
      });
      cb(null);
      return true;
    });
    await expect(
      f.owned.publish("", "q", Buffer.from("secret")),
    ).resolves.toEqual({ confirmed: true, routed: true });
    await f.scope.dispose();
  });
  it.each(["nack", "return", "close"])("does not confirm %s", async (kind) => {
    const f = await setup();
    f.channel.publish.mockImplementation((_e, _r, _b, options, cb) => {
      if (kind === "return")
        f.channel.emit("return", {
          properties: { messageId: options.messageId },
        });
      if (kind === "close") f.channel.emit("close");
      else cb(kind === "nack" ? new Error("secret") : null);
      return true;
    });
    await expect(
      f.owned.publish("", "q", Buffer.from("secret")),
    ).rejects.toMatchObject({
      code:
        kind === "return"
          ? "AMQP_MANDATORY_RETURN"
          : kind === "close"
            ? "AMQP_UNEXPECTED_CLOSE"
            : "AMQP_CONFIRM_LOST",
    });
    await f.scope.dispose();
  });
  it("destroys the stream before timeout rejects and stops admission", async () => {
    const f = await setup();
    const result = f.owned.publish("", "q", Buffer.alloc(0), 10);
    const rejected = result.catch((error: RuntimeResourceError) => {
      expect(f.stream.destroy).toHaveBeenCalled();
      expect(error.code).toBe("AMQP_CONFIRM_TIMEOUT");
    });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    await expect(
      f.owned.publish("", "q", Buffer.alloc(0)),
    ).rejects.toMatchObject({ code: "AMQP_CONFIRM_TIMEOUT" });
    await f.scope.dispose();
  });
  it("identifies a broker nack by the driver event, not its error text", async () => {
    const f = await setup();
    f.channel.publish.mockImplementation((_e, _r, _b, _options, cb) => {
      f.channel.on("nack", () => cb(new Error("secret")));
      f.channel.emit("nack", {});
      return true;
    });
    await expect(
      f.owned.publish("", "q", Buffer.alloc(0)),
    ).rejects.toMatchObject({ code: "AMQP_CONFIRM_NACK", fatal: false });
    await f.scope.dispose();
  });
  it.each([
    [{ code: 403, message: "secret" }, "AMQP_REPLY_TERMINAL", true],
    [{ replyCode: 404, message: "secret" }, "AMQP_REPLY_TERMINAL", true],
    [{ code: "ECONNRESET", message: "secret" }, "AMQP_TRANSPORT_RESET", false],
    [new Error("secret"), "AMQP_UNKNOWN", true],
  ])("normalizes RPC errors without disclosure", async (input, code, fatal) => {
    const f = await setup();
    f.channel.assertQueue.mockRejectedValue(input);
    const error = await f.owned.assertQueue("q").catch((e: unknown) => e);
    expect(error).toMatchObject({ code, fatal });
    expect(String(error)).not.toContain("secret");
    await f.scope.dispose();
  });
});
