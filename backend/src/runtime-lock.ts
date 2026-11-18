import pg from "pg";
import { required } from "./config.js";

// Session locks coordinate cooperating clients only; they do not fence RabbitMQ.
const keys = { relay: [1229342284, 1], scheduler: [1229342284, 2] } as const;
export type RuntimeRole = keyof typeof keys;

export interface LockClient {
  connect(): Promise<unknown>;
  query(
    sql: string,
    values: number[],
  ): Promise<{ rows: { acquired: boolean }[] }>;
  on(event: "error" | "end", listener: () => void): unknown;
  removeListener?(event: "error" | "end", listener: () => void): unknown;
  end(): Promise<void>;
}

export type RuntimeLock = { release(): Promise<void> };
export type RuntimeLockCode =
  | "CONNECT"
  | "QUERY"
  | "CONTENTION_END"
  | "RELEASE_END"
  | "SESSION_LOST"
  | "ACQUIRE_TIMEOUT"
  | "HEARTBEAT_TIMEOUT"
  | "CLEANUP_STUCK";

export class RuntimeLockError extends Error {
  constructor(public readonly code: RuntimeLockCode) {
    super(`runtime lock: ${code}`);
    this.name = "RuntimeLockError";
  }
}

export interface RuntimeLockOptions {
  intervalMs?: number;
  deadlineMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  /** Must synchronously destroy the dedicated transport, including during connect. */
  dispose?: (client: LockClient) => void;
}

// pg does not expose transport destruction in its public Client API. Keep this
// driver-specific access in one seam, replaceable by tests or another adapter.
function disposePg(client: LockClient): void {
  const connection = (
    client as unknown as { connection?: { stream?: { destroy(): void } } }
  ).connection;
  if (!connection?.stream) throw new Error("transport unavailable");
  connection.stream.destroy();
}

export async function acquireRuntimeLock(
  role: RuntimeRole,
  onLost: (error: RuntimeLockError) => void,
  client: LockClient = new pg.Client({
    connectionString: required("DATABASE_URL"),
    connectionTimeoutMillis: 5000,
  }),
  options: RuntimeLockOptions = {},
): Promise<RuntimeLock | null> {
  const interval = options.intervalMs ?? 2000;
  const deadline = options.deadlineMs ?? 5000;
  if (
    !Number.isFinite(interval) ||
    interval <= 0 ||
    !Number.isFinite(deadline) ||
    deadline <= 0
  )
    throw new RangeError("runtime lock: invalid timing");
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const dispose = options.dispose ?? disposePg;
  let closing = false;
  let lost = false;
  let disposed = false;
  let disposalFailed = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: Promise<void> | undefined;
  let heartbeatUnsettled = false;
  let heartbeatTerminal = false;
  let endPromise: Promise<void> | undefined;
  const destroy = () => {
    if (disposed) return;
    disposed = true;
    try {
      dispose(client);
    } catch {
      disposalFailed = true;
    }
  };
  const stopIdle = () => {
    if (idle !== undefined) clearTimer(idle);
    idle = undefined;
  };
  const notifyLost = (code: RuntimeLockCode = "SESSION_LOST") => {
    if (closing || lost) return;
    lost = true;
    stopIdle();
    try {
      onLost(new RuntimeLockError(code));
    } catch {
      /* callbacks cannot break cleanup */
    }
  };
  const eventLost = () => {
    if (!disposed) notifyLost();
  };
  client.on("error", eventLost);
  client.on("end", eventLost);
  const detach = () => {
    client.removeListener?.("error", eventLost);
    client.removeListener?.("end", eventLost);
  };
  // A timed-out operation is abandoned only after its transport is destroyed.
  // Its eventual settlement is consumed and cannot schedule further lock work.
  const bounded = <T>(
    operation: Promise<T>,
    code: RuntimeLockCode,
  ): Promise<T> =>
    new Promise((resolve, reject) => {
      const timer = setTimer(() => {
        destroy();
        reject(new RuntimeLockError(disposalFailed ? "CLEANUP_STUCK" : code));
      }, deadline);
      operation.then(
        (value) => {
          clearTimer(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimer(timer);
          reject(error);
        },
      );
    });
  const end = () => {
    endPromise ??= bounded(
      Promise.resolve().then(() => client.end()),
      "CLEANUP_STUCK",
    )
      .then(() => {
        // A forced or failed transport close can still emit a late error.
        if (!disposed) detach();
      })
      .catch(() => {
        // Rejection is not evidence that the session transport has closed.
        throw new RuntimeLockError("CLEANUP_STUCK");
      });
    return endPromise;
  };
  let phase: RuntimeLockCode = "CONNECT";
  try {
    await bounded(
      Promise.resolve().then(() => client.connect()),
      "ACQUIRE_TIMEOUT",
    );
    if (lost) throw new RuntimeLockError("SESSION_LOST");
    phase = "QUERY";
    const result = await bounded(
      Promise.resolve().then(() =>
        client.query("SELECT pg_try_advisory_lock($1, $2) AS acquired", [
          ...keys[role],
        ]),
      ),
      "ACQUIRE_TIMEOUT",
    );
    if (lost) throw new RuntimeLockError("SESSION_LOST");
    if (!result.rows[0]?.acquired) {
      closing = true;
      phase = "CONTENTION_END";
      try {
        await end();
      } catch {
        // Busy is safe only after a proven close; a rejected end is not proof.
        throw new RuntimeLockError("CLEANUP_STUCK");
      }
      return null;
    }
    const schedule = () => {
      if (closing || lost) return;
      idle = setTimer(() => {
        idle = undefined;
        if (closing || lost) return;
        heartbeatUnsettled = true;
        const operation = Promise.resolve()
          .then(() => client.query("SELECT 1", []))
          .finally(() => {
            heartbeatUnsettled = false;
          });
        heartbeat = bounded(operation, "HEARTBEAT_TIMEOUT")
          .then(
            () => {},
            (error: unknown) => {
              if (
                error instanceof RuntimeLockError &&
                error.code === "CLEANUP_STUCK"
              )
                heartbeatTerminal = true;
              notifyLost(
                error instanceof RuntimeLockError &&
                  (error.code === "HEARTBEAT_TIMEOUT" ||
                    error.code === "CLEANUP_STUCK")
                  ? error.code
                  : "SESSION_LOST",
              );
            },
          )
          .then(() => {
            heartbeat = undefined;
            schedule();
          });
      }, interval);
    };
    schedule();
    let release: Promise<void> | undefined;
    return {
      release() {
        if (release) return release;
        closing = true;
        stopIdle();
        release = (async () => {
          if (heartbeat) await heartbeat;
          let endError: unknown;
          try {
            await end();
          } catch (error) {
            endError = error;
          }
          if (heartbeatTerminal || heartbeatUnsettled)
            throw new RuntimeLockError("CLEANUP_STUCK");
          if (endError) throw endError;
        })();
        return release;
      },
    };
  } catch (error) {
    const wasClosing = closing;
    closing = true;
    stopIdle();
    if (!wasClosing) {
      try {
        await end();
      } catch {
        // A rejected close does not prove the failed acquisition was cleaned up.
        throw new RuntimeLockError("CLEANUP_STUCK");
      }
    }
    throw error instanceof RuntimeLockError
      ? error
      : new RuntimeLockError(lost ? "SESSION_LOST" : phase);
  }
}
