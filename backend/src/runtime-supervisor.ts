import { spawn } from "node:child_process";
import { request } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bootstrapRuntime,
  type BootstrapOptions,
  type BootstrapResult,
} from "./runtime-bootstrap.js";
import {
  RuntimeChildren,
  type ChildEvent,
  type ChildManagerOptions,
} from "./runtime-children.js";
import {
  acquireSupervisorSingleton,
  type SingletonResult,
} from "./runtime-supervisor-singleton.js";
import { initialSnapshot, MAX_SNAPSHOT_AGE_MS } from "./runtime-status.js";
import { runPreflight } from "./runtime-preflight.js";

export const FRONTEND_URL = "http://127.0.0.1:5173/";
// Fixed-port HTTP responses are unauthenticated and can be spoofed locally;
// these checks identify expected content, not ownership of either port.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
type CycleOptions = {
  databaseUrl: string;
  amqpUrl: string;
  signal: AbortSignal;
  preflight: typeof runPreflight;
  probe: Dependencies["probe"];
};
type CycleResults = [
  PromiseSettledResult<Awaited<ReturnType<typeof runPreflight>>>,
  PromiseSettledResult<boolean>,
  PromiseSettledResult<boolean>,
];
type Dependencies = {
  acquire: typeof acquireSupervisorSingleton;
  bootstrap: (options: BootstrapOptions) => Promise<BootstrapResult>;
  children: (
    options: ChildManagerOptions,
  ) => Pick<RuntimeChildren, "start" | "stop">;
  probe: (
    endpoint: "api" | "frontend",
    signal: AbortSignal,
  ) => Promise<boolean>;
  preflight: typeof runPreflight;
  cycle: (options: CycleOptions) => Promise<CycleResults>;
  now: () => number;
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
  open: () => Promise<void>;
  hardExit: (code: number) => void;
  signals: Pick<NodeJS.Process, "on" | "removeListener">;
  event: (code: string) => void;
};
// Map through fixed values at runtime too: TypeScript types alone do not protect
// the log sink from malformed callbacks supplied by an integration.
const roles: Record<ChildEvent["role"], string> = {
  api: "api",
  worker: "worker",
  relay: "relay",
  scheduler: "scheduler",
  frontend: "frontend",
};
const states: Record<ChildEvent["state"], string> = {
  started: "started",
  restarting: "restarting",
  terminal: "terminal",
  stopped: "stopped",
  control_failed: "control_failed",
};
const reasons: Record<ChildEvent["reason"], string> = {
  spawned: "spawned",
  exit: "exit",
  retry_signal: "retry_signal",
  retry_clean_exit: "retry_clean_exit",
  retry_code_3: "retry_code_3",
  retry_busy_after_exit: "retry_busy_after_exit",
  terminal_busy: "terminal_busy",
  terminal_fatal: "terminal_fatal",
  terminal_lock_lost: "terminal_lock_lost",
  terminal_cleanup_stuck: "terminal_cleanup_stuck",
  terminal_unknown_exit: "terminal_unknown_exit",
  budget: "budget",
  startup_failure: "startup_failure",
  shutdown: "shutdown",
  ipc_failure: "ipc_failure",
};
function childEventCode(event: ChildEvent): string {
  if (
    !Object.hasOwn(roles, event.role) ||
    !Object.hasOwn(states, event.state) ||
    !Object.hasOwn(reasons, event.reason) ||
    (event.state === "control_failed" && event.reason !== "ipc_failure")
  )
    return "CHILD_INVALID_EVENT";
  return `CHILD_${roles[event.role]}_${states[event.state]}_${reasons[event.reason]}`;
}
export function parseSupervisorArgs(args: string[]) {
  if (
    args.some((a) => a !== "--no-infra" && a !== "--no-open") ||
    new Set(args).size !== args.length
  )
    throw new Error("INVALID_ARGUMENTS");
  return {
    mode: args.includes("--no-infra")
      ? ("no-infra" as const)
      : ("managed-infra" as const),
    noOpen: args.includes("--no-open"),
  };
}
export function childEnvironment(
  env: NodeJS.ProcessEnv,
  mode: "managed-infra" | "no-infra",
): NodeJS.ProcessEnv | null {
  // Disposable local-only defaults match backend/compose.yaml and .env.example.
  const database =
    env.DATABASE_URL ||
    (mode === "managed-infra"
      ? "postgresql://local:local@127.0.0.1:55432/intelifluxo"
      : "");
  const amqp =
    env.AMQP_URL ||
    (mode === "managed-infra" ? "amqp://local:local@127.0.0.1:55672" : "");
  if (!database.trim() || !amqp.trim()) return null;
  const result: NodeJS.ProcessEnv = {
    DATABASE_URL: database,
    AMQP_URL: amqp,
    PORT: "3000",
  };
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "ComSpec",
    "PATHEXT",
    "WINDIR",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "AUTOMATION_SNAPSHOTS_ENABLED",
    "CONDITIONS_WRITES_ENABLED",
    "VIACEP_WRITES_ENABLED",
    "VIACEP_EXTERNAL_EXECUTION_ENABLED",
  ])
    if (env[key] !== undefined) result[key] = env[key];
  return result;
}
export function probeEndpoint(
  endpoint: "api" | "frontend",
  signal: AbortSignal,
  testPort?: number,
): Promise<boolean> {
  return new Promise((done) => {
    let finished = false,
      bytes = 0;
    const chunks: Buffer[] = [];
    const finish = (ok: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      req.destroy();
      done(ok);
    };
    const req = request(
      {
        host: "127.0.0.1",
        port: testPort ?? (endpoint === "api" ? 3000 : 5173),
        path: endpoint === "api" ? "/status" : "/",
        maxHeaderSize: 8192,
        headers: { connection: "close" },
      },
      (res) => {
        const contentType = res.headers["content-type"]
          ?.split(";")[0]
          ?.trim()
          .toLowerCase();
        if (
          res.statusCode !== 200 ||
          contentType !==
            (endpoint === "api" ? "application/json" : "text/html")
        )
          return finish(false);
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 16384) finish(false);
          else chunks.push(chunk);
        });
        res.on("error", () => finish(false));
        res.on("aborted", () => finish(false));
        res.on("end", () => {
          if (endpoint === "frontend") {
            const html = Buffer.concat(chunks).toString("utf8");
            return finish(
              html.includes("InteliFluxo") &&
                /<div\s+id=["']root["']\s*>/i.test(html),
            );
          }
          try {
            const value: unknown = JSON.parse(
              Buffer.concat(chunks).toString("utf8"),
            );
            if (!value || typeof value !== "object" || Array.isArray(value))
              return finish(false);
            const dto = value as Record<string, unknown>;
            finish(
              Object.keys(dto).sort().join(",") === "limitations,profile" &&
                dto.profile === "local-development-only" &&
                Array.isArray(dto.limitations) &&
                dto.limitations.length > 0 &&
                dto.limitations.every(
                  (v: unknown) => typeof v === "string" && v.trim().length > 0,
                ),
            );
          } catch {
            finish(false);
          }
        });
      },
    );
    const abort = () => finish(false);
    const timer = setTimeout(abort, 1000);
    req.on("error", () => finish(false));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else req.end();
  });
}
async function openFrontend(): Promise<void> {
  if (process.platform !== "win32") throw new Error("OPEN_FAILED");
  await new Promise<void>((done, reject) => {
    const child = spawn("explorer.exe", [FRONTEND_URL], {
      detached: true,
      stdio: "ignore",
      shell: false,
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      done();
    });
  });
}
const defaults: Dependencies = {
  acquire: acquireSupervisorSingleton,
  bootstrap: bootstrapRuntime,
  children: (options) => new RuntimeChildren(options),
  probe: probeEndpoint,
  preflight: runPreflight,
  cycle: ({ databaseUrl, amqpUrl, signal, preflight, probe }) =>
    Promise.allSettled([
      preflight({ databaseUrl, amqpUrl, signal, probeDeadlineMs: 3000 }),
      probe("api", signal),
      probe("frontend", signal),
    ]),
  now: () => Date.now(),
  wait: (ms, signal) =>
    new Promise((done) => {
      if (signal.aborted) return done();
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        done();
      };
      const timer = setTimeout(finish, ms);
      signal.addEventListener("abort", finish, { once: true });
    }),
  open: openFrontend,
  hardExit: (code) => process.exit(code),
  signals: process,
  event: (code) => console.error(code),
};
export async function runSupervisor(options: {
  args: string[];
  env: NodeJS.ProcessEnv;
  dependencies?: Partial<Dependencies>;
  stabilityMs?: number;
  readinessMs?: number;
}): Promise<number> {
  const d = { ...defaults, ...options.dependencies };
  const emit = (code: string) => {
    try {
      d.event(code);
    } catch {
      /* Observers cannot control lifecycle. */
    }
  };
  let parsed: ReturnType<typeof parseSupervisorArgs>;
  try {
    parsed = parseSupervisorArgs(options.args);
  } catch {
    emit("INVALID_ARGUMENTS");
    return 2;
  }
  const abort = new AbortController();
  let ready = false,
    stopping = false,
    failure = false,
    signalCount = 0,
    changed: number,
    generation = 0;
  let wake!: () => void;
  const stopped = new Promise<void>((done) => {
    wake = done;
  });
  let hardExitRequested = false;
  const hardExit = () => {
    if (hardExitRequested) return;
    hardExitRequested = true;
    d.hardExit(1);
  };
  let expiry: AbortController | undefined;
  let leaseEndsAt = 0;
  let children: ReturnType<Dependencies["children"]> | undefined;
  let owner: Extract<SingletonResult, { kind: "owned" }> | undefined;
  const snapshot = initialSnapshot();
  let cycle: Promise<void> | undefined;
  const publish = (observedAt = d.now()) => {
    snapshot.observedAt = new Date(observedAt).toISOString();
    owner?.setSnapshot?.(snapshot);
  };
  const statusState = (
    state: "starting" | "ready" | "degraded" | "stopping",
    reasonCode: string | null,
    observedAt?: number,
  ) => {
    snapshot.state = state;
    snapshot.components.supervisor = { state, reasonCode };
    publish(observedAt);
  };
  let childrenStopping: ReturnType<RuntimeChildren["stop"]> | undefined;
  const stop = (failed: boolean) => {
    if (failed) failure = true;
    ready = false;
    if (!stopping) {
      stopping = true;
      emit("SUPERVISOR_stopping");
      abort.abort();
      expiry?.abort();
      wake();
      owner?.setState("stopping");
      statusState("stopping", "SUPERVISOR_STOPPING");
      if (children) {
        childrenStopping = children.stop();
        void childrenStopping.catch(() => {});
      }
    }
  };
  const signal = () => {
    if (++signalCount > 1) {
      hardExit();
      return;
    }
    stop(false);
  };
  d.signals.on("SIGINT", signal);
  d.signals.on("SIGTERM", signal);
  const running = new Set<string>();
  const open = async () => {
    if (!ready || stopping || d.now() >= leaseEndsAt)
      throw new Error("NOT_READY");
    try {
      await d.open();
    } catch {
      emit("OPEN_FAILED");
      throw new Error("OPEN_FAILED");
    }
  };
  try {
    const acquired = await d.acquire({
      workspaceRoot: root,
      openExisting: !parsed.noOpen,
      onOpen: open,
      onListenerError: () => {
        owner?.setState("degraded");
        statusState("degraded", "LISTENER_ERROR");
        emit("LISTENER_ERROR");
        stop(true);
      },
    });
    if (acquired.kind === "existing") {
      emit("SUPERVISOR_singleton_reused");
      if (parsed.noOpen || acquired.opened) return 0;
      emit("OPEN_UNAVAILABLE");
      return 1;
    }
    if (acquired.kind !== "owned") {
      emit("SINGLETON_FAILED");
      return 1;
    }
    owner = acquired;
    publish();
    emit("SUPERVISOR_singleton_owned");
    if (stopping) return failure ? 1 : 0;
    const env = childEnvironment(options.env, parsed.mode);
    if (!env) {
      owner.setState("degraded");
      statusState("degraded", "BOOTSTRAP_PENDING");
      emit("CONFIG_INVALID");
      return 1;
    }
    const result = await d.bootstrap({
      mode: parsed.mode,
      env,
      databaseUrl: env.DATABASE_URL!,
      amqpUrl: env.AMQP_URL!,
      signal: abort.signal,
    });
    if (result.reasonCode === "cleanup_stuck") {
      owner.setState("degraded");
      statusState("degraded", "BOOTSTRAP_PENDING");
      emit("CLEANUP_STUCK");
      hardExit();
      return 1;
    }
    if (result.outcome !== "ready" || stopping) {
      if (!stopping || failure) {
        owner.setState("degraded");
        statusState("degraded", "BOOTSTRAP_PENDING");
        emit("BOOTSTRAP_FAILED");
      }
      return failure || !stopping ? 1 : 0;
    }
    emit("SUPERVISOR_bootstrap_ready");
    const end = d.now() + (options.readinessMs ?? 30_000),
      stability = options.stabilityMs ?? 2_000;
    children = d.children({
      root,
      env,
      onEvent: (event) => {
        if (stopping) return;
        emit(childEventCode(event));
        if (event.state === "control_failed") return;
        if (
          !Object.hasOwn(roles, event.role) ||
          !Object.hasOwn(states, event.state) ||
          !Object.hasOwn(reasons, event.reason)
        )
          return;
        generation++;
        changed = d.now();
        if (event.state === "started") running.add(event.role);
        else running.delete(event.role);
        if (event.state !== "started") {
          ready = false;
          const reasonCode =
            event.state === "terminal" ? "CHILD_TERMINAL" : "CHILD_RESTARTING";
          snapshot.components[event.role] = {
            state:
              event.state === "terminal"
                ? "unavailable"
                : event.role === "api" || event.role === "frontend"
                  ? "unknown"
                  : "starting",
            reasonCode,
          };
          snapshot.components.database = {
            state: "unknown",
            reasonCode: "DEPENDENCY_UNVERIFIED",
          };
          snapshot.components.rabbitmq = {
            state: "unknown",
            reasonCode: "DEPENDENCY_UNVERIFIED",
          };
          if (!stopping) {
            owner?.setState("degraded");
            statusState("degraded", reasonCode);
          } else publish();
        }
        if (event.state === "terminal") {
          owner?.setState("degraded");
          emit("CHILD_TERMINAL");
          stop(true);
        }
      },
    });
    const startupDeadline = new AbortController();
    const startup = Promise.resolve()
      .then(() => children!.start())
      .then(
        () => "started" as const,
        () => "failed" as const,
      );
    let startupResult: "started" | "failed" | "deadline" | "stopped";
    try {
      startupResult = await Promise.race([
        startup,
        stopped.then(() => "stopped" as const),
        d
          .wait(Math.max(0, end - d.now()), startupDeadline.signal)
          .then(() => "deadline" as const),
      ]);
    } finally {
      startupDeadline.abort();
    }
    if (stopping || startupResult === "stopped") return failure ? 1 : 0;
    if (startupResult === "deadline" || d.now() >= end) {
      owner.setState("degraded");
      statusState("degraded", "READINESS_PENDING");
      emit("READINESS_FAILED");
      stop(true);
      return 1;
    }
    if (startupResult === "failed") {
      owner.setState("degraded");
      statusState("degraded", "BOOTSTRAP_PENDING");
      emit("CHILD_START_FAILED");
      return 1;
    }
    emit("SUPERVISOR_children_started");
    changed = d.now();
    let successSince: number | undefined;
    let everReady = false;
    const evidenceCycle = async (cycleStartedAt: number) => {
      const probeGeneration = generation;
      const results = await d.cycle({
        databaseUrl: env.DATABASE_URL!,
        amqpUrl: env.AMQP_URL!,
        signal: abort.signal,
        preflight: d.preflight,
        probe: d.probe,
      });
      const [preflightResult, apiResult, frontendResult] = results;
      const preflight =
          preflightResult.status === "fulfilled" ? preflightResult.value : null,
        api = apiResult.status === "fulfilled" && apiResult.value,
        frontend =
          frontendResult.status === "fulfilled" && frontendResult.value;
      if (preflight?.state === "cleanup_stuck") {
        emit("CLEANUP_STUCK");
        failure = true;
        hardExit();
        stop(true);
        return;
      }
      if (
        stopping ||
        (!everReady && d.now() >= end) ||
        probeGeneration !== generation
      ) {
        successSince = undefined;
        return;
      }
      const successful =
        preflight?.state === "ready" &&
        preflight.dependencies.postgres.state === "ready" &&
        preflight.dependencies.rabbitmq.state === "ready" &&
        api &&
        frontend &&
        running.size === 5;
      const expired = d.now() - cycleStartedAt >= MAX_SNAPSHOT_AGE_MS;
      if (!successful || expired) {
        ready = false;
        successSince = undefined;
        snapshot.components.database = {
          state:
            !expired && preflight?.dependencies.postgres.state === "ready"
              ? "ready"
              : "unknown",
          reasonCode:
            !expired && preflight?.dependencies.postgres.state === "ready"
              ? null
              : "DEPENDENCY_UNVERIFIED",
        };
        snapshot.components.rabbitmq = {
          state:
            !expired && preflight?.dependencies.rabbitmq.state === "ready"
              ? "ready"
              : "unknown",
          reasonCode:
            !expired && preflight?.dependencies.rabbitmq.state === "ready"
              ? null
              : "DEPENDENCY_UNVERIFIED",
        };
        for (const role of ["api", "frontend"] as const) {
          if (running.has(role))
            snapshot.components[role] = {
              state:
                !expired && (role === "api" ? api : frontend)
                  ? "ready"
                  : "unknown",
              reasonCode:
                !expired && (role === "api" ? api : frontend)
                  ? null
                  : "READINESS_PENDING",
            };
        }
        for (const role of ["worker", "relay", "scheduler"] as const)
          if (running.has(role))
            snapshot.components[role] = { state: "ready", reasonCode: null };
        // A failed aggregate can coexist with individually successful results.
        // Do not claim all components ready when readiness itself failed.
        if (
          Object.entries(snapshot.components).every(
            ([name, value]) => name === "supervisor" || value.state === "ready",
          )
        )
          snapshot.components.api = {
            state: "unknown",
            reasonCode: "READINESS_PENDING",
          };
        owner?.setState("degraded");
        statusState("degraded", "READINESS_PENDING");
        return;
      }
      successSince ??= d.now();
      if (
        !everReady &&
        (d.now() - successSince < stability || d.now() - changed < stability)
      )
        return;
      ready = true;
      leaseEndsAt = cycleStartedAt + MAX_SNAPSHOT_AGE_MS;
      expiry?.abort();
      const lease = new AbortController();
      expiry = lease;
      void d
        .wait(Math.max(0, leaseEndsAt - d.now()), lease.signal)
        .then(() => {
          if (lease.signal.aborted || stopping || !ready) return;
          ready = false;
          successSince = undefined;
          for (const role of ["database", "rabbitmq"] as const)
            snapshot.components[role] = {
              state: "unknown",
              reasonCode: "DEPENDENCY_UNVERIFIED",
            };
          for (const role of ["api", "frontend"] as const)
            snapshot.components[role] = {
              state: "unknown",
              reasonCode: "READINESS_PENDING",
            };
          owner?.setState("degraded");
          statusState("degraded", "READINESS_PENDING");
        })
        .catch(() => {});
      for (const component of Object.values(snapshot.components)) {
        component.state = "ready";
        component.reasonCode = null;
      }
      statusState("ready", null, cycleStartedAt);
      owner?.setState("ready");
      if (!everReady) {
        everReady = true;
        emit("SUPERVISOR_readiness_ready");
        if (!parsed.noOpen) {
          void open().catch(() => {
            /* reported by open; browser ownership never blocks health or shutdown */
          });
        }
      }
    };
    while (!stopping) {
      const cycleGeneration = generation;
      const cycleStartedAt = d.now();
      cycle = evidenceCycle(cycleStartedAt).catch(() => {
        if (!stopping && cycleGeneration === generation) {
          ready = false;
          successSince = undefined;
          snapshot.components.database = {
            state: "unknown",
            reasonCode: "DEPENDENCY_UNVERIFIED",
          };
          snapshot.components.rabbitmq = {
            state: "unknown",
            reasonCode: "DEPENDENCY_UNVERIFIED",
          };
          owner?.setState("degraded");
          statusState("degraded", "READINESS_PENDING");
        }
      });
      if (everReady) {
        await Promise.race([cycle, stopped]);
      } else {
        const deadline = new AbortController();
        try {
          await Promise.race([
            cycle,
            stopped,
            d.wait(Math.max(0, end - d.now()), deadline.signal),
          ]);
        } finally {
          deadline.abort();
        }
      }
      if (stopping) break;
      if (!everReady && d.now() >= end) {
        owner.setState("degraded");
        statusState("degraded", "READINESS_PENDING");
        emit("READINESS_FAILED");
        stop(true);
        break;
      }
      await Promise.race([
        stopped,
        d.wait(
          everReady
            ? ready
              ? Math.max(0, cycleStartedAt + 5000 - d.now())
              : 5000
            : Math.min(200, Math.max(0, end - d.now())),
          abort.signal,
        ),
      ]);
    }
    if (!stopping) await stopped;
    return failure ? 1 : 0;
  } catch {
    owner?.setState("degraded");
    statusState("degraded", "READINESS_PENDING");
    emit("SUPERVISOR_FAILED");
    return 1;
  } finally {
    try {
      ready = false;
      abort.abort();
      expiry?.abort();
      if (owner) {
        if (!stopping) {
          emit("SUPERVISOR_stopping");
          owner.setState("stopping");
          statusState("stopping", "SUPERVISOR_STOPPING");
        }
        let cleanupComplete = true;
        if (children) {
          try {
            const result = await (childrenStopping ?? children.stop());
            if (result.remaining.length) {
              cleanupComplete = false;
              emit("CLEANUP_STUCK");
              hardExit();
            }
          } catch {
            cleanupComplete = false;
            emit("CLEANUP_STUCK");
            hardExit();
          }
        }
        if (cycle) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const settled = await Promise.race([
            cycle.then(() => true),
            new Promise<false>((done) => {
              timer = setTimeout(() => done(false), 5000);
            }),
          ]);
          clearTimeout(timer);
          if (!settled) {
            cleanupComplete = false;
            emit("CLEANUP_STUCK");
            hardExit();
          }
        }
        try {
          await owner.close();
        } catch {
          cleanupComplete = false;
          emit("CLEANUP_STUCK");
          hardExit();
        }
        if (cleanupComplete) emit("SUPERVISOR_stopped");
        // A cleanup failure overrides any earlier successful lifecycle result.
        // eslint-disable-next-line no-unsafe-finally
        else return 1;
      }
    } finally {
      d.signals.removeListener("SIGINT", signal);
      d.signals.removeListener("SIGTERM", signal);
    }
  }
}
