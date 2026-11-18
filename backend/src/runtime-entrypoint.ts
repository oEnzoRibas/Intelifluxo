import { setTimeout as delay } from "node:timers/promises";
import { required } from "./config.js";
import { acquireRuntimeLock, RuntimeLockError } from "./runtime-lock.js";
import { createRuntimeRelay } from "./runtime-relay.js";
import { RuntimeResourceError, type SweepScope } from "./runtime-resources.js";
import {
  runRole,
  type RoleClassification,
  type RoleOutcome,
} from "./runtime-role.js";
import { createRuntimeScheduler } from "./runtime-scheduler.js";

export type EntrypointRole = "relay" | "scheduler";
export type EntrypointMode = "one-shot" | "daemon";
type Signal = "SIGINT" | "SIGTERM";
export interface SignalSource {
  on(signal: Signal, listener: () => void): unknown;
  removeListener(signal: Signal, listener: () => void): unknown;
}
export interface Adapter<Scope> {
  createScope(signal: AbortSignal): Scope;
  sweep(scope: Scope): Promise<unknown>;
  disposeScope(scope: Scope): Promise<unknown>;
}
export interface RuntimeControls {
  signal: AbortSignal;
  forceSignal: AbortSignal;
  requestShutdown(): void;
  requestForce(): void;
}
export interface EntrypointOptions<Scope> {
  controls?: RuntimeControls;
  role: EntrypointRole;
  args: string[];
  signals: SignalSource;
  acquireLock: (
    role: EntrypointRole,
    onLost: (error: unknown) => void,
  ) => Promise<{ release(): Promise<void> } | null>;
  createAdapter: (role: EntrypointRole) => Adapter<Scope>;
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  log: (event: {
    event: "runtime_terminal";
    role: EntrypointRole;
    mode: EntrypointMode;
    outcome: RoleOutcome["code"];
    sweeps: number;
  }) => void;
  hardExit: (code: number) => void;
}

export function parseMode(args: string[]): EntrypointMode {
  if (args.length === 0 || (args.length === 1 && args[0] === "--one-shot"))
    return "one-shot";
  if (args.length === 1 && args[0] === "--daemon") return "daemon";
  throw new RuntimeResourceError("CONFIG");
}

export function classifyRuntimeError(error: unknown): RoleClassification {
  if (error instanceof RuntimeResourceError) {
    if (error.fatal) return "fatal";
    switch (error.code) {
      case "CONNECT":
      case "QUERY":
      case "RPC":
      case "DEADLINE":
      case "ABORTED":
      case "CLOSE":
      case "AMQP_CONNECT_TIMEOUT":
      case "AMQP_CONNECT_REFUSED":
      case "AMQP_TRANSPORT_RESET":
      case "AMQP_DNS_TEMPORARY":
      case "AMQP_UNEXPECTED_CLOSE":
      case "AMQP_CONFIRM_NACK":
      case "AMQP_CONFIRM_LOST":
      case "AMQP_CONFIRM_TIMEOUT":
      case "AMQP_OPERATION_DEADLINE":
        return "retryable";
      default:
        return "fatal";
    }
  }
  if (error instanceof RuntimeLockError) {
    switch (error.code) {
      case "CONNECT":
      case "QUERY":
      case "SESSION_LOST":
      case "ACQUIRE_TIMEOUT":
      case "HEARTBEAT_TIMEOUT":
        return "retryable";
      default:
        return "fatal";
    }
  }
  return "fatal";
}

const exits: Record<RoleOutcome["code"], number> = {
  success: 0,
  stopped: 0,
  busy: 2,
  retryable_failure: 3,
  fatal: 4,
  lock_lost: 5,
  cleanup_stuck: 6,
};

/** Returns undefined only if a test hardExit seam returns; real hardExit never returns. */
export async function runEntrypoint<Scope>(
  options: EntrypointOptions<Scope>,
): Promise<number | undefined> {
  let mode: EntrypointMode = "one-shot";
  const emit = (outcome: RoleOutcome) => {
    try {
      options.log({
        event: "runtime_terminal",
        role: options.role,
        mode,
        outcome: outcome.code,
        sweeps: outcome.sweeps,
      });
    } catch {
      /* telemetry must not alter shutdown */
    }
  };
  try {
    mode = parseMode(options.args);
  } catch {
    emit({ code: "fatal", sweeps: 0 });
    return exits.fatal;
  }
  const graceful = new AbortController();
  const force = new AbortController();
  const controls = options.controls ?? {
    signal: graceful.signal,
    forceSignal: force.signal,
    requestShutdown: () => graceful.abort(),
    requestForce: () => force.abort(),
  };
  let signalled = false;
  const onSignal = () => {
    if (signalled) controls.requestForce();
    else {
      signalled = true;
      controls.requestShutdown();
    }
  };
  options.signals.on("SIGINT", onSignal);
  options.signals.on("SIGTERM", onSignal);
  let adapter: Adapter<Scope> | undefined;
  let result: RoleOutcome;
  try {
    result = await runRole({
      role: options.role,
      mode,
      signal: controls.signal,
      forceSignal: controls.forceSignal,
      acquireLock: (onLost) => options.acquireLock(options.role, onLost),
      createScope: (signal) =>
        (adapter ??= options.createAdapter(options.role)).createScope(signal),
      sweep: (scope) => adapter!.sweep(scope),
      disposeScope: (scope) => adapter!.disposeScope(scope),
      wait: options.wait,
      classify: classifyRuntimeError,
      log: () => {},
    });
  } catch {
    // An unexpected escape may have occurred after ownership was acquired.
    result = {
      code: "cleanup_stuck",
      sweeps: 0,
      requiresProcessTermination: true,
    };
  }
  emit(result);
  if (
    result.code === "cleanup_stuck" ||
    ("requiresProcessTermination" in result &&
      result.requiresProcessTermination)
  ) {
    options.signals.removeListener("SIGINT", onSignal);
    options.signals.removeListener("SIGTERM", onSignal);
    options.hardExit(exits.cleanup_stuck);
    return undefined;
  }
  options.signals.removeListener("SIGINT", onSignal);
  options.signals.removeListener("SIGTERM", onSignal);
  return exits[result.code];
}

/** Executable-only process seam; all resource construction stays in existing factories. */
export async function main(
  role: EntrypointRole,
  args = process.argv.slice(2),
  controls?: RuntimeControls,
): Promise<void> {
  const code = await runEntrypoint<SweepScope>({
    role,
    args,
    controls,
    signals: process,
    acquireLock: (name, onLost) => acquireRuntimeLock(name, onLost),
    createAdapter: (name) =>
      name === "relay"
        ? createRuntimeRelay({
            connectionString: required("DATABASE_URL"),
            amqpUrl: required("AMQP_URL"),
            postForceSettlementMs: 2000,
          })
        : createRuntimeScheduler({
            connectionString: required("DATABASE_URL"),
            postForceSettlementMs: 2000,
          }),
    wait: async (milliseconds, signal) => {
      await delay(milliseconds, undefined, { signal });
    },
    log: (event) => console.log(JSON.stringify(event)),
    hardExit: (exitCode) => process.exit(exitCode),
  });
  if (code !== undefined) process.exitCode = code;
}
