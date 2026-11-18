import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { statSync } from "node:fs";
import type { Readable } from "node:stream";

export const childRoles = [
  "api",
  "worker",
  "relay",
  "scheduler",
  "frontend",
] as const;
export type ChildRole = (typeof childRoles)[number];
export type ChildEvent = {
  role: ChildRole;
  state: "started" | "restarting" | "terminal" | "stopped" | "control_failed";
  reason:
    | "spawned"
    | "exit"
    | "retry_signal"
    | "retry_clean_exit"
    | "retry_code_3"
    | "retry_busy_after_exit"
    | "terminal_busy"
    | "terminal_fatal"
    | "terminal_lock_lost"
    | "terminal_cleanup_stuck"
    | "terminal_unknown_exit"
    | "budget"
    | "startup_failure"
    | "shutdown"
    | "ipc_failure";
};
export type ChildSpec = {
  role: ChildRole;
  executable: string;
  args: string[];
  cwd: string;
  ipc: boolean;
};
/** All roles are direct Node children. */
export function childSpecs(root: string, node = process.execPath): ChildSpec[] {
  const backend = join(root, "backend");
  const nodeSpec = (
    role: ChildRole,
    file: string,
    extra: string[] = [],
    ipc = false,
  ): ChildSpec => ({
    role,
    executable: node,
    args: ["--import", "tsx", join(backend, "src", file), ...extra],
    cwd: backend,
    ipc,
  });
  return [
    nodeSpec("api", "api-main.ts"),
    nodeSpec("worker", "worker-main.ts"),
    nodeSpec("relay", "runtime-executable.ts", ["relay", "--daemon"], true),
    nodeSpec(
      "scheduler",
      "runtime-executable.ts",
      ["scheduler", "--daemon"],
      true,
    ),
    {
      role: "frontend",
      executable: node,
      args: [
        join(root, "frontend", "node_modules", "vite", "bin", "vite.js"),
        "--host",
        "127.0.0.1",
        "--port",
        "5173",
        "--strictPort",
      ],
      cwd: join(root, "frontend"),
      ipc: false,
    },
  ];
}
type Exit = { code: number | null; signal: NodeJS.Signals | null };
type Owned = { child: ChildProcess; exited: Promise<Exit>; startedAt: number };
export type ChildManagerOptions = {
  root: string;
  env: NodeJS.ProcessEnv;
  onEvent?: (event: ChildEvent) => void;
  spawn?: (spec: ChildSpec, env: NodeJS.ProcessEnv) => ChildProcess;
  /** Set only when an injected spawner transfers ownership of its output pipes. */
  spawnPipesOwned?: boolean;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  shutdownMs?: number;
  finalMs?: number;
  forceMs?: number;
  cleanupMs?: number;
  viteExists?: (path: string) => boolean;
};
const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};
const defaultWait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
// Deliberately stateless: even a malformed emitter may report errors after close.
const ignoreError = () => {};
function guardPipe(stream: Readable | null, owned: boolean) {
  if (!stream) return () => {};
  stream.on("error", ignoreError);
  let closed = stream.closed;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onClose = () => {
    closed = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  if (!closed) stream.once("close", onClose);
  return (ms: number) => {
    if (closed || !owned) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!closed && !stream.destroyed) {
        try {
          stream.destroy();
        } catch {
          // A broken stream must not disrupt child lifecycle cleanup.
        }
      }
    }, ms);
    timer.unref();
  };
}
export class RuntimeChildren {
  private readonly specs: ChildSpec[];
  private readonly owned = new Map<ChildRole, Owned>();
  private readonly histories = new Map<ChildRole, number[]>();
  private readonly recovering = new Set<ChildRole>();
  private readonly abort = new AbortController();
  private stopping = false;
  private startCalled = false;
  private startupComplete = false;
  private startupFailed = false;
  private stopPromise?: Promise<{
    forced: ChildRole[];
    remaining: ChildRole[];
  }>;
  private readonly now: () => number;
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  constructor(private readonly options: ChildManagerOptions) {
    this.specs = childSpecs(options.root);
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? defaultWait;
  }
  private emit(event: ChildEvent) {
    try {
      this.options.onEvent?.(event);
    } catch {
      /* observers cannot control lifecycle */
    }
  }
  private async launch(spec: ChildSpec): Promise<void> {
    if (this.stopping || this.owned.has(spec.role))
      throw new Error("startup_failure");
    if (
      spec.role === "frontend" &&
      !(this.options.viteExists ?? isFile)(spec.args[0])
    )
      throw new Error("startup_failure");
    const child = (
      this.options.spawn ??
      ((s, env) =>
        spawn(s.executable, s.args, {
          cwd: s.cwd,
          env,
          shell: false,
          windowsHide: true,
          stdio: s.ipc
            ? ["ignore", "pipe", "pipe", "ipc"]
            : ["ignore", "pipe", "pipe"],
        }))
    )(spec, this.options.env);
    let resolveExit!: (exit: Exit) => void;
    const exited = new Promise<Exit>((resolve) => {
      resolveExit = resolve;
    });
    const owned: Owned = { child, exited, startedAt: this.now() };
    this.owned.set(spec.role, owned);
    let spawned = false;
    let terminal = false;
    const pipesOwned =
      !this.options.spawn || this.options.spawnPipesOwned === true;
    const finishStdout = guardPipe(child.stdout, pipesOwned);
    const finishStderr = guardPipe(child.stderr, pipesOwned);
    let resolveStart!: () => void;
    let rejectStart!: () => void;
    const start = new Promise<void>((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = () => reject(new Error("startup_failure"));
    });
    const cleanup = () => {
      this.abort.signal.removeEventListener("abort", onAbort);
      child.removeListener("spawn", onSpawn);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
    };
    const onAbort = () => {
      if (!spawned) rejectStart();
    };
    const onSpawn = () => {
      spawned = true;
      this.abort.signal.removeEventListener("abort", onAbort);
      resolveStart();
    };
    const finish = (exit: Exit) => {
      if (terminal) return;
      terminal = true;
      if (!this.startupComplete && !this.stopping) this.startupFailed = true;
      if (this.owned.get(spec.role) === owned) this.owned.delete(spec.role);
      resolveExit(exit);
      if (!spawned) rejectStart();
      finishStdout(this.options.cleanupMs ?? 5_000);
      finishStderr(this.options.cleanupMs ?? 5_000);
      cleanup();
    };
    const onError = () => {
      if (!spawned) finish({ code: null, signal: null });
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish({ code, signal });
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      finish({ code, signal });
      cleanup();
    };
    child.on("spawn", onSpawn);
    child.on("error", ignoreError);
    child.on("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
    child.stdout?.resume();
    child.stderr?.resume();
    this.abort.signal.addEventListener("abort", onAbort, { once: true });
    if (this.stopping) onAbort();
    await start;
    if (!this.stopping)
      this.emit({ role: spec.role, state: "started", reason: "spawned" });
    void this.monitor(spec, owned);
  }
  private async monitor(spec: ChildSpec, owned: Owned) {
    const exit = await owned.exited;
    if (!this.startupComplete) return;
    if (this.stopping) {
      this.emit({ role: spec.role, state: "stopped", reason: "shutdown" });
      return;
    }
    let reason: ChildEvent["reason"] = "exit";
    const now = this.now();
    const stable = now - owned.startedAt >= 60_000;
    if (stable) this.recovering.delete(spec.role);
    if (spec.ipc) {
      const terminalReasons: Record<number, ChildEvent["reason"]> = {
        4: "terminal_fatal",
        5: "terminal_lock_lost",
        6: "terminal_cleanup_stuck",
      };
      const terminalReason =
        exit.code === 2 && !this.recovering.has(spec.role)
          ? "terminal_busy"
          : exit.code === null
            ? undefined
            : terminalReasons[exit.code];
      if (
        terminalReason ||
        (exit.code !== null &&
          exit.code !== 0 &&
          exit.code !== 2 &&
          exit.code !== 3)
      ) {
        this.emit({
          role: spec.role,
          state: "terminal",
          reason: terminalReason ?? "terminal_unknown_exit",
        });
        return;
      }
      if (exit.signal !== null) reason = "retry_signal";
      else if (exit.code === 0) reason = "retry_clean_exit";
      else if (exit.code === 3) reason = "retry_code_3";
      else if (exit.code === 2) reason = "retry_busy_after_exit";
      else {
        this.emit({
          role: spec.role,
          state: "terminal",
          reason: "terminal_unknown_exit",
        });
        return;
      }
      this.recovering.add(spec.role);
    }
    const history = stable ? [] : (this.histories.get(spec.role) ?? []);
    history.push(now);
    this.histories.set(spec.role, history);
    if (history.length >= 5) {
      this.emit({ role: spec.role, state: "terminal", reason: "budget" });
      return;
    }
    this.emit({ role: spec.role, state: "restarting", reason });
    await this.wait(
      Math.min(500 * 2 ** (history.length - 1), 30_000),
      this.abort.signal,
    );
    if (this.stopping) return;
    try {
      await this.launch(spec);
    } catch {
      if (!this.stopping)
        this.emit({
          role: spec.role,
          state: "terminal",
          reason: "startup_failure",
        });
    }
  }
  async start(): Promise<void> {
    if (this.startCalled || this.stopping) throw new Error("startup_failure");
    this.startCalled = true;
    for (const spec of this.specs) {
      try {
        await this.launch(spec);
        if (this.startupFailed) throw new Error("startup_failure");
      } catch {
        this.emit({
          role: spec.role,
          state: "terminal",
          reason: "startup_failure",
        });
        await this.stop();
        throw new Error("startup_failure");
      }
      if (this.stopping) {
        await this.stop();
        throw new Error("startup_failure");
      }
    }
    this.startupComplete = true;
  }
  stop(): Promise<{ forced: ChildRole[]; remaining: ChildRole[] }> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.abort.abort();
    this.stopPromise = this.shutdown();
    return this.stopPromise;
  }
  private async shutdown(): Promise<{
    forced: ChildRole[];
    remaining: ChildRole[];
  }> {
    const initial = [...this.owned.entries()];
    for (const [role, { child }] of initial) {
      try {
        if (role === "relay" || role === "scheduler") {
          if (child.connected)
            child.send?.("shutdown", (error) => {
              if (error)
                this.emit({
                  role,
                  state: "control_failed",
                  reason: "ipc_failure",
                });
            });
        } else child.kill();
      } catch {
        if (role === "relay" || role === "scheduler")
          this.emit({ role, state: "control_failed", reason: "ipc_failure" });
        /* force phase handles survivors */
      }
    }
    await this.bounded(
      initial.map(([, o]) => o.exited),
      this.options.shutdownMs ?? 15_000,
    );
    let survivors = [...this.owned.entries()];
    for (const [role, { child }] of survivors) {
      if ((role === "relay" || role === "scheduler") && child.connected) {
        try {
          child.send?.("force", (error) => {
            if (error)
              this.emit({
                role,
                state: "control_failed",
                reason: "ipc_failure",
              });
          });
        } catch {
          this.emit({ role, state: "control_failed", reason: "ipc_failure" });
        }
      }
    }
    await this.bounded(
      survivors.map(([, o]) => o.exited),
      this.options.forceMs ?? 2_000,
    );
    survivors = [...this.owned.entries()];
    const forced = survivors.map(([role]) => role);
    for (const [, { child }] of survivors) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* report remaining */
      }
    }
    await this.bounded(
      survivors.map(([, o]) => o.exited),
      this.options.finalMs ?? 5_000,
    );
    return { forced, remaining: [...this.owned.keys()] };
  }
  private async bounded(exits: Promise<Exit>[], ms: number) {
    if (!exits.length) return;
    const controller = new AbortController();
    try {
      await Promise.race([
        Promise.all(exits),
        this.wait(ms, controller.signal),
      ]);
    } finally {
      controller.abort();
    }
  }
}
