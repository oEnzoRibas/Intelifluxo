import { retryDelay } from "./runtime-loop.js";

export type RoleOutcomeCode =
  | "success"
  | "busy"
  | "stopped"
  | "retryable_failure"
  | "fatal"
  | "lock_lost"
  | "cleanup_stuck";
export type RoleOutcome =
  | {
      code: Exclude<RoleOutcomeCode, "cleanup_stuck">;
      sweeps: number;
      requiresProcessTermination?: false;
    }
  | { code: "cleanup_stuck"; sweeps: number; requiresProcessTermination: true };
export type RoleClassification = "retryable" | "fatal";

/** All callbacks must be bounded; scope creation must synchronously bind the
 * supplied signal to scope.abort(), including when already aborted. Disposal
 * must reject on terminal cleanup errors, not return them silently. */
export interface RoleOptions<Scope> {
  role: "relay" | "scheduler";
  mode: "one-shot" | "daemon";
  signal: AbortSignal;
  forceSignal?: AbortSignal;
  acquireLock(
    onLost: (error: unknown) => void,
  ): Promise<{ release(): Promise<void> } | null>;
  createScope(signal: AbortSignal): Scope;
  sweep(scope: Scope): Promise<unknown>;
  disposeScope(scope: Scope): Promise<unknown>;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
  classify(error: unknown): RoleClassification;
  log(event: { role: "relay" | "scheduler"; code: RoleOutcomeCode }): void;
  /** Called once with the terminal result; cleanup_stuck requires the caller
   * to terminate the process so an intentionally retained lock can be lost. */
  onOutcome?(outcome: RoleOutcome): void;
  drainMs?: number;
  random?: () => number;
}

function codeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code: unknown }).code
    : undefined;
}

/** Never logs or returns adapter errors. The caller owns process exit policy. */
export async function runRole<Scope>(
  options: RoleOptions<Scope>,
): Promise<RoleOutcome> {
  const idle = new AbortController();
  let active: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  let lost = false;
  let lostCleanup = false;
  let sweeps = 0;
  let outcome: RoleOutcomeCode = "stopped";
  let lock: { release(): Promise<void> } | null = null;
  let acquisitionRetryable = false;
  const clearDrain = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    idle.abort();
    if (active)
      timer = setTimeout(() => active?.abort(), options.drainMs ?? 10_000);
  };
  const force = () => {
    stop();
    clearDrain();
    active?.abort();
  };
  const onLost = (error: unknown) => {
    lost = true;
    if (codeOf(error) === "CLEANUP_STUCK") lostCleanup = true;
    force();
  };
  const classify = (error: unknown): RoleOutcomeCode => {
    const code = codeOf(error);
    if (code === "CLEANUP_STUCK") return "cleanup_stuck";
    if (
      code === "ADAPTER_MISMATCH" ||
      code === "AMQP_CONFORMANCE_MISMATCH" ||
      (typeof error === "object" &&
        error !== null &&
        "fatal" in error &&
        error.fatal === true)
    )
      return "fatal";
    try {
      return options.classify(error) === "retryable"
        ? "retryable_failure"
        : "fatal";
    } catch {
      return "fatal";
    }
  };
  // Controls are installed before acquisition: loss/abort can occur before it resolves.
  options.signal.addEventListener("abort", stop);
  options.forceSignal?.addEventListener("abort", force);
  if (options.signal.aborted) stop();
  if (options.forceSignal?.aborted) force();
  try {
    if (!stopping) {
      try {
        lock = await options.acquireLock(onLost);
      } catch (error) {
        outcome = classify(error);
        acquisitionRetryable = outcome === "retryable_failure";
      }
      if (lock === null && outcome === "stopped" && !stopping) outcome = "busy";
    }
    let failures = 0;
    while (lock && !stopping) {
      active = new AbortController();
      let scope: Scope | undefined;
      let created = false;
      let failure: RoleOutcomeCode | undefined;
      try {
        scope = options.createScope(active.signal);
        created = true;
        if (!stopping) {
          await options.sweep(scope);
          sweeps++;
        }
      } catch (error) {
        failure = classify(error);
      }
      if (created) {
        try {
          await options.disposeScope(scope as Scope);
        } catch (error) {
          const cleanup = classify(error);
          failure =
            cleanup === "cleanup_stuck" || failure === "cleanup_stuck"
              ? "cleanup_stuck"
              : "fatal";
        }
      }
      clearDrain();
      active = undefined;
      if (failure === "cleanup_stuck" || failure === "fatal") {
        outcome = failure;
        break;
      }
      if (stopping) break;
      if (options.mode === "one-shot") {
        outcome = failure ?? "success";
        break;
      }
      if (failure) failures++;
      else failures = 0;
      try {
        await options.wait(
          failure ? retryDelay(failures, options.random) : 1000,
          idle.signal,
        );
      } catch {
        if (!stopping) {
          outcome = "fatal";
          break;
        }
      }
    }
  } finally {
    clearDrain();
    options.signal.removeEventListener("abort", stop);
    options.forceSignal?.removeEventListener("abort", force);
    // A stuck scope (or lost-lock cleanup) may still own live work. Retain the
    // session until the entrypoint terminates the process; never release it here.
    if (lock && outcome !== "cleanup_stuck" && !lostCleanup) {
      try {
        await lock.release();
      } catch {
        // A rejected release cannot prove that ownership was relinquished.
        outcome = "cleanup_stuck";
      }
    }
  }
  if (lostCleanup) outcome = "cleanup_stuck";
  else if (lost && outcome !== "cleanup_stuck") outcome = "lock_lost";
  const result: RoleOutcome =
    outcome === "cleanup_stuck"
      ? { code: outcome, sweeps, requiresProcessTermination: true }
      : acquisitionRetryable && outcome === "retryable_failure"
        ? { code: outcome, sweeps, requiresProcessTermination: false }
        : { code: outcome, sweeps };
  // Telemetry/reporting cannot disrupt ownership or expose adapter errors.
  try {
    options.log({ role: options.role, code: outcome });
  } catch {
    /* ignored */
  }
  try {
    options.onOutcome?.(result);
  } catch {
    /* ignored */
  }
  return result;
}
