import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runPreflight,
  type PreflightOptions,
  type PreflightResult,
} from "./runtime-preflight.js";

export type BootstrapReason =
  | "compose_unavailable"
  | "dependency_unavailable"
  | "cleanup_stuck"
  | "migration_failed"
  | "aborted"
  | "ready";
export type BootstrapResult = {
  phase: "compose" | "preflight" | "migration" | "complete";
  outcome: "failed" | "aborted" | "ready";
  reasonCode: BootstrapReason;
  attempts: number;
};
type Command = {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs: number;
};
type CommandResult = "success" | "failure" | "aborted" | "cleanup_stuck";
export type BootstrapOptions = {
  mode: "managed-infra" | "no-infra";
  env: NodeJS.ProcessEnv;
  databaseUrl: string;
  amqpUrl: string;
  signal: AbortSignal;
  readinessWindowMs?: number;
  probeDeadlineMs?: number;
  commandTimeoutMs?: number;
  dependencies?: {
    command?: (command: Command) => Promise<CommandResult>;
    preflight?: (
      options: PreflightOptions,
    ) => Promise<Pick<PreflightResult, "state">>;
    spawn?: typeof spawn;
    migrationCommand?: { executable: string; args: string[] };
    now?: () => number;
    wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  };
};

// Derived from this module, not from caller input or the current directory.
const backend = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = resolve(backend, "..");
const composeFile = join(workspace, "backend", "compose.yaml");

// A stuck child cannot safely be replaced in this process, even by a later caller.
let cleanupStuck = false;
let bootstrapActive = false;

// Kept on the child even after close: a synthetic or late error must not throw.
// This shared listener captures no command state and does not keep the child alive.
const ignoreChildError = () => {};

/** Owns only the direct child. Docker may spawn helpers: their termination is not guaranteed.
 * The migration entrypoint and its imports must not spawn processes. Output is discarded. */
async function commandRun(
  command: Command,
  spawnChild: typeof spawn = spawn,
): Promise<CommandResult> {
  if (command.signal.aborted) return "aborted";
  return new Promise((resolveResult) => {
    let settled = false;
    let termination: NodeJS.Timeout | undefined;
    let finalDeadline: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    let stopped: CommandResult | undefined;
    let child: ReturnType<typeof spawn>;
    const finish = (value: CommandResult) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (termination) clearTimeout(termination);
      if (finalDeadline) clearTimeout(finalDeadline);
      command.signal.removeEventListener("abort", abort);
      child?.removeListener("error", onError);
      child?.removeListener("exit", onExit);
      child?.removeListener("close", onClose);
      resolveResult(value);
    };
    const onError = () => {
      // A spawn failure has no child process to reap; other errors do not prove exit.
      if (!child.pid) finish(stopped ?? "failure");
    };
    const onExit = (code: number | null) =>
      finish(stopped ?? (code === 0 ? "success" : "failure"));
    const onClose = (code: number | null) =>
      finish(stopped ?? (code === 0 ? "success" : "failure"));
    const stop = (reason: CommandResult) => {
      if (stopped || settled) return;
      stopped = reason;
      try {
        child.kill("SIGTERM");
      } catch {
        /* wait for exit */
      }
      if (settled) return;
      termination = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* wait for exit */
        }
        if (!settled)
          finalDeadline = setTimeout(() => finish("cleanup_stuck"), 1000);
      }, 1000);
    };
    const abort = () => stop("aborted");
    try {
      child = spawnChild(command.executable, command.args, {
        cwd: command.cwd,
        env: command.env,
        stdio: "ignore",
        shell: false,
        windowsHide: true,
      });
      child.on("error", ignoreChildError);
      child.once("error", onError);
      child.once("exit", onExit);
      child.once("close", onClose);
      command.signal.addEventListener("abort", abort, { once: true });
      deadline = setTimeout(() => stop("failure"), command.timeoutMs);
      if (command.signal.aborted) abort();
    } catch {
      finish("failure");
    }
  });
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      done();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}
const positive = (value: number | undefined, fallback: number, max: number) =>
  Number.isFinite(value) && value! > 0 ? Math.min(value!, max) : fallback;

export async function bootstrapRuntime(
  options: BootstrapOptions,
): Promise<BootstrapResult> {
  if (cleanupStuck || bootstrapActive)
    return {
      phase: "compose",
      outcome: "failed",
      reasonCode: cleanupStuck ? "cleanup_stuck" : "dependency_unavailable",
      attempts: 0,
    };
  bootstrapActive = true;
  try {
    return await bootstrapOnce(options);
  } finally {
    bootstrapActive = false;
  }
}

async function bootstrapOnce(
  options: BootstrapOptions,
): Promise<BootstrapResult> {
  let attempts = 0;
  const result = (
    phase: BootstrapResult["phase"],
    reasonCode: BootstrapReason,
  ): BootstrapResult => ({
    phase,
    outcome:
      reasonCode === "ready"
        ? "ready"
        : reasonCode === "aborted"
          ? "aborted"
          : "failed",
    reasonCode,
    attempts,
  });
  const { signal } = options;
  const runner =
    options.dependencies?.command ??
    ((command: Command) => commandRun(command, options.dependencies?.spawn));
  const probe = options.dependencies?.preflight ?? runPreflight;
  const now = options.dependencies?.now ?? (() => performance.now());
  const pause = options.dependencies?.wait ?? wait;
  const windowMs = positive(options.readinessWindowMs, 90_000, 600_000);
  const probeMs = positive(options.probeDeadlineMs, 5_000, 60_000);
  const commandMs = positive(options.commandTimeoutMs, 120_000, 600_000);
  // Use only host OS essentials, not caller overrides: PATH/HOME could redirect Docker.
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
    "WINDIR",
    "TEMP",
    "TMP",
    "HOME",
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  const run = async (
    executable: string,
    args: string[],
    childEnv: NodeJS.ProcessEnv,
  ): Promise<CommandResult> => {
    try {
      const status = await runner({
        executable,
        args,
        cwd: backend,
        env: childEnv,
        signal,
        timeoutMs: commandMs,
      });
      if (status === "cleanup_stuck") cleanupStuck = true;
      return status;
    } catch {
      return "failure";
    }
  };
  if (cleanupStuck) return result("compose", "cleanup_stuck");
  if (typeof options.databaseUrl !== "string" || !options.databaseUrl.trim())
    return result("preflight", "dependency_unavailable");
  if (signal.aborted) return result("compose", "aborted");
  if (options.mode === "managed-infra") {
    // Docker Desktop discovers its Compose plugin through these Windows paths.
    // Keep them out of the migration environment and ignore caller overrides.
    const composeEnv = { ...env };
    for (const key of ["ProgramFiles", "ProgramW6432"]) {
      const value = process.env[key];
      if (value !== undefined) composeEnv[key] = value;
    }
    const status = await run(
      "docker",
      [
        "compose",
        "--project-name",
        "intelifluxo-local",
        "-f",
        composeFile,
        "up",
        "-d",
        "postgres",
        "rabbitmq",
      ],
      composeEnv,
    );
    if (status === "cleanup_stuck") return result("compose", "cleanup_stuck");
    if (signal.aborted || status === "aborted")
      return result("compose", "aborted");
    if (status !== "success") return result("compose", "compose_unavailable");
  } else if (options.mode !== "no-infra")
    return result("compose", "compose_unavailable");
  const end = now() + windowMs;
  let backoff = 250;
  while (now() < end) {
    if (signal.aborted) return result("preflight", "aborted");
    attempts++;
    let state: PreflightResult["state"];
    try {
      state = (
        await probe({
          databaseUrl: options.databaseUrl,
          amqpUrl: options.amqpUrl,
          signal,
          probeDeadlineMs: Math.min(probeMs, Math.max(1, end - now())),
        })
      ).state;
    } catch {
      state = "unavailable";
    }
    if (state === "cleanup_stuck") {
      cleanupStuck = true;
      return result("preflight", "cleanup_stuck");
    }
    if (signal.aborted || state === "aborted")
      return result("preflight", "aborted");
    if (state === "ready") {
      if (now() >= end) return result("preflight", "dependency_unavailable");
      // Node resolves tsx from the fixed backend cwd; no npm or tsx wrapper child.
      const migration = options.dependencies?.migrationCommand ?? {
        executable: process.execPath,
        args: ["--import", "tsx", "src/migrate.ts"],
      };
      const status = await run(migration.executable, migration.args, {
        ...env,
        DATABASE_URL: options.databaseUrl,
      });
      if (status === "cleanup_stuck")
        return result("migration", "cleanup_stuck");
      if (signal.aborted || status === "aborted")
        return result("migration", "aborted");
      return status === "success"
        ? result("complete", "ready")
        : result("migration", "migration_failed");
    }
    const remaining = end - now();
    if (remaining <= 0) break;
    try {
      await pause(Math.min(backoff, remaining), signal);
    } catch {
      return result(
        "preflight",
        signal.aborted ? "aborted" : "dependency_unavailable",
      );
    }
    backoff = Math.min(backoff * 2, 2000);
  }
  return result(
    "preflight",
    signal.aborted ? "aborted" : "dependency_unavailable",
  );
}
