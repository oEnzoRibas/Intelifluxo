import pg from "pg";
import amqp from "amqplib";
import { randomUUID } from "node:crypto";

export type RuntimeResourceCode =
  | "CONFIG"
  | "PROGRAMMING"
  | "ADAPTER_MISMATCH"
  | "CONNECT"
  | "QUERY"
  | "RPC"
  | "DEADLINE"
  | "ABORTED"
  | "CLOSE"
  | "CLEANUP_STUCK";

export type AmqpResourceCode =
  | "AMQP_CONNECT_TIMEOUT"
  | "AMQP_CONNECT_REFUSED"
  | "AMQP_TRANSPORT_RESET"
  | "AMQP_DNS_TEMPORARY"
  | "AMQP_UNEXPECTED_CLOSE"
  | "AMQP_CONFIRM_NACK"
  | "AMQP_CONFIRM_LOST"
  | "AMQP_CONFIRM_TIMEOUT"
  | "AMQP_OPERATION_DEADLINE"
  | "AMQP_REPLY_TERMINAL"
  | "AMQP_UNKNOWN"
  | "AMQP_CONFORMANCE_MISMATCH"
  | "AMQP_MANDATORY_RETURN";

export type CleanupPhase =
  | "PG_END"
  | "AMQP_CHANNEL_CLOSE"
  | "AMQP_CONNECTION_CLOSE"
  | "PG_CONNECT"
  | "PG_QUERY"
  | "AMQP_CONNECT"
  | "AMQP_RPC"
  | "AMQP_CONFIRM"
  | "OPERATION";

function operationPhase(
  code: RuntimeResourceCode | AmqpResourceCode,
): CleanupPhase {
  switch (code) {
    case "CONNECT":
      return "PG_CONNECT";
    case "QUERY":
      return "PG_QUERY";
    case "AMQP_CONNECT_TIMEOUT":
      return "AMQP_CONNECT";
    case "RPC":
    case "AMQP_OPERATION_DEADLINE":
      return "AMQP_RPC";
    case "AMQP_CONFIRM_TIMEOUT":
      return "AMQP_CONFIRM";
    default:
      return "OPERATION";
  }
}

export class RuntimeResourceError extends Error {
  constructor(
    public readonly code: RuntimeResourceCode | AmqpResourceCode,
    public readonly cleanupPhases: readonly CleanupPhase[] = [],
  ) {
    super(`runtime resource: ${code}`);
    this.name = "RuntimeResourceError";
  }
  get fatal(): boolean {
    return (
      this.code === "CONFIG" ||
      this.code === "PROGRAMMING" ||
      this.code === "ADAPTER_MISMATCH" ||
      this.code === "AMQP_REPLY_TERMINAL" ||
      this.code === "AMQP_UNKNOWN" ||
      this.code === "AMQP_CONFORMANCE_MISMATCH" ||
      this.code === "AMQP_MANDATORY_RETURN" ||
      this.code === "CLEANUP_STUCK"
    );
  }
}

interface Stream {
  destroy(error?: Error): unknown;
}
interface PgClient {
  connection?: unknown;
  connect(): Promise<unknown>;
  query(text: string, values?: unknown[]): Promise<unknown>;
  end(): Promise<unknown>;
  on(event: "error", listener: (error: unknown) => void): unknown;
}
interface Channel {
  close(): Promise<unknown>;
  on(event: "error", listener: (error: unknown) => void): unknown;
}
interface Connection {
  connection?: unknown;
  createConfirmChannel?(): Promise<amqp.ConfirmChannel>;
  close(): Promise<unknown>;
  on(event: "error", listener: (error: unknown) => void): unknown;
}

// The only dependencies on pg 8.23.1 / amqplib 2.3.0 internal shapes.
function streamAt(owner: unknown, path: readonly string[]): Stream {
  let value: unknown = owner;
  for (const key of path) {
    if (typeof value !== "object" || value === null)
      throw new RuntimeResourceError("ADAPTER_MISMATCH");
    value = (value as Record<string, unknown>)[key];
  }
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as Stream).destroy !== "function"
  ) {
    throw new RuntimeResourceError("ADAPTER_MISMATCH");
  }
  return value as Stream;
}
const pgStream = (client: PgClient) =>
  streamAt(client, ["connection", "stream"]);
const amqpStream = (connection: Connection) =>
  streamAt(connection, ["connection", "stream"]);
const localDestroy = (stream: Stream) =>
  stream.destroy(new Error("runtime resource cancelled"));
const normalize = (
  error: unknown,
  fallback: RuntimeResourceCode | AmqpResourceCode,
) =>
  error instanceof RuntimeResourceError
    ? error
    : new RuntimeResourceError(fallback);

// Driver messages are deliberately never inspected or retained.
function amqpError(error: unknown): RuntimeResourceError {
  if (error instanceof RuntimeResourceError) return error;
  if (typeof error === "object" && error !== null) {
    const fields = error as { code?: unknown; replyCode?: unknown };
    if (
      [403, 404, 405, 406].includes(Number(fields.replyCode)) ||
      [403, 404, 405, 406].includes(Number(fields.code))
    )
      return new RuntimeResourceError("AMQP_REPLY_TERMINAL");
    switch (fields.code) {
      case "ETIMEDOUT":
        return new RuntimeResourceError("AMQP_CONNECT_TIMEOUT");
      case "ECONNREFUSED":
        return new RuntimeResourceError("AMQP_CONNECT_REFUSED");
      case "ECONNRESET":
      case "EPIPE":
        return new RuntimeResourceError("AMQP_TRANSPORT_RESET");
      case "EAI_AGAIN":
        return new RuntimeResourceError("AMQP_DNS_TEMPORARY");
    }
  }
  return new RuntimeResourceError("AMQP_UNKNOWN");
}

function boundedTimeout(milliseconds: number): void {
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds <= 0 ||
    milliseconds > 60_000
  )
    throw new RuntimeResourceError("CONFIG");
}

/** The channel is private; every operation has exclusive scope-owned admission. */
function confirmAdapter(scope: SweepScope, channel: amqp.ConfirmChannel) {
  let busy = false;
  const exclusive = async <T>(start: () => Promise<T>): Promise<T> => {
    scope.check();
    if (busy) throw new RuntimeResourceError("PROGRAMMING");
    busy = true;
    try {
      return await start();
    } finally {
      busy = false;
    }
  };
  channel.on("error", (error: unknown) => scope.abort(amqpError(error)));
  channel.on("close", () =>
    scope.abort(new RuntimeResourceError("AMQP_UNEXPECTED_CLOSE")),
  );
  return Object.freeze({
    assertQueue: (
      name: string,
      options?: amqp.Options.AssertQueue,
      milliseconds = 10_000,
    ) =>
      exclusive(() => {
        boundedTimeout(milliseconds);
        return scope.operation(
          async () => {
            try {
              const result = await channel.assertQueue(name, options);
              return {
                queue: result.queue,
                messageCount: result.messageCount,
                consumerCount: result.consumerCount,
              };
            } catch (error) {
              throw amqpError(error);
            }
          },
          milliseconds,
          "AMQP_OPERATION_DEADLINE",
        );
      }),
    deleteQueue: (
      name: string,
      options?: amqp.Options.DeleteQueue,
      milliseconds = 10_000,
    ) =>
      exclusive(() => {
        boundedTimeout(milliseconds);
        return scope.operation(
          async () => {
            try {
              const result = await channel.deleteQueue(name, options);
              return { messageCount: result.messageCount };
            } catch (error) {
              throw amqpError(error);
            }
          },
          milliseconds,
          "AMQP_OPERATION_DEADLINE",
        );
      }),
    publish: async (
      exchange: string,
      routingKey: string,
      content: Buffer,
      milliseconds = 10_000,
    ): Promise<{ confirmed: true; routed: true }> =>
      exclusive(async () => {
        boundedTimeout(milliseconds);
        const messageId = randomUUID();
        return await scope.operation(
          () =>
            new Promise<{ confirmed: true; routed: true }>(
              (resolve, reject) => {
                let returned = false;
                let nacked = false;
                let done = false;
                const cleanup = () => {
                  channel.removeListener("return", onReturn);
                  channel.removeListener("close", onClose);
                  channel.removeListener("nack", onNack);
                  scope.signal.removeEventListener("abort", onAbort);
                };
                const finish = (error?: RuntimeResourceError) => {
                  if (done) return;
                  done = true;
                  cleanup();
                  if (error) reject(error);
                  else resolve({ confirmed: true, routed: true });
                };
                const onReturn = (message: amqp.Message) => {
                  if (message.properties.messageId === messageId)
                    returned = true;
                };
                const onClose = () =>
                  finish(new RuntimeResourceError("AMQP_UNEXPECTED_CLOSE"));
                const onNack = () => {
                  nacked = true;
                };
                const onAbort = () =>
                  finish(new RuntimeResourceError("AMQP_CONFIRM_LOST"));
                channel.on("return", onReturn);
                channel.on("close", onClose);
                channel.prependListener("nack", onNack);
                scope.signal.addEventListener("abort", onAbort, { once: true });
                try {
                  channel.publish(
                    exchange,
                    routingKey,
                    content,
                    { mandatory: true, persistent: true, messageId },
                    (error) => {
                      if (error)
                        finish(
                          new RuntimeResourceError(
                            nacked ? "AMQP_CONFIRM_NACK" : "AMQP_CONFIRM_LOST",
                          ),
                        );
                      // RabbitMQ sends basic.return before the publisher confirm for
                      // mandatory unroutable messages; amqplib dispatches frames in
                      // order. This conclusion depends on that broker/driver contract.
                      else if (returned)
                        finish(
                          new RuntimeResourceError("AMQP_MANDATORY_RETURN"),
                        );
                      else finish();
                    },
                  );
                } catch (error) {
                  finish(amqpError(error));
                }
              },
            ),
          milliseconds,
          "AMQP_CONFIRM_TIMEOUT",
        );
      }),
  });
}

export class SweepScope {
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private pg?: PgClient;
  private connection?: Connection;
  private channel?: Channel;
  private channelReservation?: symbol;
  private disposal?: Promise<RuntimeResourceError[]>;
  private forced = false;
  private readonly pending = new Map<Promise<unknown>, CleanupPhase>();
  private reason: RuntimeResourceError = new RuntimeResourceError("ABORTED");
  constructor(private readonly postForceSettlementMs: number) {
    if (!Number.isFinite(postForceSettlementMs) || postForceSettlementMs <= 0)
      throw new RuntimeResourceError("CONFIG");
    this.timer = setTimeout(
      () => this.abort(new RuntimeResourceError("DEADLINE")),
      60_000,
    );
  }
  get signal(): AbortSignal {
    return this.controller.signal;
  }
  check(): void {
    if (this.signal.aborted) throw this.reason;
  }
  private track<T>(
    promise: Promise<T>,
    phase: CleanupPhase = "OPERATION",
  ): Promise<T> {
    this.pending.set(promise, phase);
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    );
    return promise;
  }
  abort(reason = new RuntimeResourceError("ABORTED")): void {
    if (this.signal.aborted) return;
    this.reason = reason;
    this.controller.abort();
    // Destroy immediately to stop in-flight driver work, then perform bounded cleanup.
    try {
      if (this.pg) localDestroy(pgStream(this.pg));
    } catch {
      /* cleanup reports mismatch */
    }
    try {
      if (this.connection) localDestroy(amqpStream(this.connection));
    } catch {
      /* cleanup reports mismatch */
    }
    void this.dispose().catch(() => {});
  }
  registerPg(client: PgClient): void {
    if (this.pg) throw new RuntimeResourceError("PROGRAMMING");
    this.pg = client;
    client.on("error", () => {});
    if (this.signal.aborted) {
      try {
        localDestroy(pgStream(client));
      } catch {
        /* fail closed */
      }
      if (!this.forced)
        void this.track(
          Promise.resolve().then(() => {
            if (!this.forced) return client.end();
          }),
        ).catch(() => {});
    }
  }
  registerConnection(connection: Connection): void {
    if (this.connection) throw new RuntimeResourceError("PROGRAMMING");
    this.connection = connection;
    connection.on("error", () => {});
    if (this.signal.aborted) {
      try {
        localDestroy(amqpStream(connection));
      } catch {
        /* fail closed */
      }
      if (!this.forced)
        void this.track(
          Promise.resolve().then(() => {
            if (!this.forced) return connection.close();
          }),
        ).catch(() => {});
    }
  }
  reserveChannel(): symbol {
    this.check();
    if (this.channelReservation) throw new RuntimeResourceError("PROGRAMMING");
    return (this.channelReservation = Symbol("channel"));
  }
  registerChannel(channel: Channel, reservation: symbol): void {
    channel.on("error", () => {});
    if (
      this.signal.aborted ||
      this.channelReservation !== reservation ||
      this.channel
    ) {
      // Disposal may already have snapshotted resources. Track late cleanup
      // separately, including synchronous close failures.
      if (this.forced) {
        try {
          if (this.connection) localDestroy(amqpStream(this.connection));
        } catch {
          /* fail closed */
        }
      } else {
        void this.track(
          Promise.resolve().then(() => {
            if (!this.forced) return channel.close();
          }),
        ).catch(() => {});
      }
      if (!this.signal.aborted) {
        const error = new RuntimeResourceError("PROGRAMMING");
        this.abort(error);
        throw error;
      }
      this.check();
    }
    this.channel = channel;
  }
  latePgConnect(client: PgClient): void {
    if (!this.signal.aborted) return;
    try {
      localDestroy(pgStream(client));
    } catch {
      /* fail closed */
    }
    if (!this.forced)
      void this.track(
        Promise.resolve().then(() => {
          if (!this.forced) return client.end();
        }),
      ).catch(() => {});
  }
  // Timeout aborts the scope, unlike a timeout that only rejects the caller.
  async operation<T>(
    start: () => Promise<T>,
    milliseconds: number,
    code: RuntimeResourceCode | AmqpResourceCode,
  ): Promise<T> {
    this.check();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.signal.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = () => finish(() => reject(this.reason));
      const timer = setTimeout(() => {
        this.abort(new RuntimeResourceError(code));
      }, milliseconds);
      this.signal.addEventListener("abort", onAbort, { once: true });
      try {
        this.track(Promise.resolve(start()), operationPhase(code)).then(
          (result) => finish(() => resolve(result)),
          (error: unknown) => finish(() => reject(normalize(error, code))),
        );
      } catch (error) {
        finish(() => reject(normalize(error, code)));
      }
    });
  }
  dispose(): Promise<RuntimeResourceError[]> {
    if (this.disposal) return this.disposal;
    clearTimeout(this.timer);
    // Close admission even for normal disposal without immediately destroying streams.
    if (!this.signal.aborted) {
      this.reason = new RuntimeResourceError("ABORTED");
      this.controller.abort();
    }
    const pgClient = this.pg;
    const connection = this.connection;
    const channel = this.channel;
    this.disposal = (async () => {
      const errors: RuntimeResourceError[] = [];
      let forced = false;
      const close = async (action: () => Promise<unknown>) => {
        try {
          await action();
        } catch {
          errors.push(new RuntimeResourceError("CLOSE"));
        }
      };
      if (pgClient)
        this.track(
          close(() => pgClient.end()),
          "PG_END",
        );
      // amqplib's connection close can close a channel without resolving its
      // pending close handshake. Serialize them, and track the entire chain.
      if (channel || connection) {
        const chain = Promise.resolve().then(async () => {
          if (channel) await close(() => channel.close());
          // After force, the transport is destroyed; never initiate another
          // driver action even if the channel close settles after termination.
          if (connection && !forced) {
            this.pending.set(chain, "AMQP_CONNECTION_CLOSE");
            await close(() => connection.close());
          }
        });
        this.track(
          chain,
          channel ? "AMQP_CHANNEL_CLOSE" : "AMQP_CONNECTION_CLOSE",
        );
      }
      const settle = async () => {
        while (this.pending.size)
          await Promise.allSettled([...this.pending.keys()]);
      };
      const settlement = settle();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        settlement.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), 2000);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (timedOut) {
        forced = true;
        this.forced = true;
        errors.push(new RuntimeResourceError("CLOSE"));
        for (const get of [
          () => this.pg && pgStream(this.pg),
          () => this.connection && amqpStream(this.connection),
        ]) {
          try {
            const stream = get();
            if (stream) localDestroy(stream);
          } catch {
            errors.push(new RuntimeResourceError("ADAPTER_MISMATCH"));
          }
        }
        const stuck = await Promise.race([
          settlement.then(() => false),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(true), this.postForceSettlementMs);
          }),
        ]);
        if (timer) clearTimeout(timer);
        if (stuck)
          throw new RuntimeResourceError("CLEANUP_STUCK", [
            ...new Set(this.pending.values()),
          ]);
      }
      return errors;
    })();
    return this.disposal;
  }
}

export async function ownedPg(
  scope: SweepScope,
  connectionString: string,
  create: (config: {
    connectionString: string;
    connectionTimeoutMillis: number;
  }) => PgClient = (config) => new pg.Client(config) as unknown as PgClient,
) {
  if (!connectionString) throw new RuntimeResourceError("CONFIG");
  scope.check();
  try {
    const client = create({ connectionString, connectionTimeoutMillis: 5000 });
    scope.registerPg(client);
    pgStream(client);
    await scope.operation(
      () =>
        client.connect().then(() => {
          scope.latePgConnect(client);
        }),
      6000,
      "CONNECT",
    );
    scope.check();
    await scope.operation(
      () => client.query("SET statement_timeout = 5000"),
      6000,
      "QUERY",
    );
    return {
      query: <T>(text: string, values?: unknown[]) =>
        scope.operation(
          () => client.query(text, values) as Promise<T>,
          6000,
          "QUERY",
        ),
    };
  } catch (error) {
    scope.abort(normalize(error, "CONNECT"));
    throw normalize(error, "CONNECT");
  }
}

export async function ownedAmqp(
  scope: SweepScope,
  url: string,
  connect: (
    url: string,
    options: { signal: AbortSignal; timeout: number },
  ) => Promise<Connection> = (address, options) =>
    amqp.connect(address, options) as unknown as Promise<Connection>,
) {
  if (!url) throw new RuntimeResourceError("CONFIG");
  scope.check();
  const socketAbort = new AbortController();
  const abortSocket = () => socketAbort.abort();
  scope.signal.addEventListener("abort", abortSocket, { once: true });
  try {
    const connection = await scope.operation(
      () => {
        const pending = connect(url, {
          signal: socketAbort.signal,
          timeout: 5000,
        });
        return pending.then(
          (value) => {
            scope.registerConnection(value);
            return value;
          },
          (error: unknown) => {
            throw amqpError(error);
          },
        );
      },
      5000,
      "AMQP_CONNECT_TIMEOUT",
    );
    amqpStream(connection);
    return {
      createConfirmChannel: async () => {
        scope.check();
        if (typeof connection.createConfirmChannel !== "function")
          throw new RuntimeResourceError("ADAPTER_MISMATCH");
        const reservation = scope.reserveChannel();
        const channel = await scope.operation(
          async () => {
            try {
              const value = await connection.createConfirmChannel!();
              scope.registerChannel(value as unknown as Channel, reservation);
              return value;
            } catch (error) {
              // A failed broker creation leaves ownership uncertain. Never reuse
              // this slot; abort and dispose the owned connection instead.
              const normalized = amqpError(error);
              scope.abort(normalized);
              throw normalized;
            }
          },
          10_000,
          "AMQP_OPERATION_DEADLINE",
        );
        scope.check();
        const events =
          connection as unknown as import("node:events").EventEmitter;
        events.on("error", (error: unknown) => scope.abort(amqpError(error)));
        events.on("close", () =>
          scope.abort(new RuntimeResourceError("AMQP_UNEXPECTED_CLOSE")),
        );
        return confirmAdapter(scope, channel);
      },
      operation: <T>(callback: () => Promise<T>, timeout: number) =>
        scope.operation(callback, timeout, "RPC"),
    };
  } catch (error) {
    scope.abort(normalize(error, "CONNECT"));
    throw normalize(error, "CONNECT");
  } finally {
    scope.signal.removeEventListener("abort", abortSocket);
  }
}
