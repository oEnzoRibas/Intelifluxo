// The delay is deterministic exponential backoff without jitter. This module
// does not itself persist or execute a retry.
export type RetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  capDelayMs: number;
};

export type Outcome = "success" | "transient" | "permanent" | "unknown";
export type Decision =
  | { state: "completed" }
  | { state: "scheduled"; delayMs: number }
  | { state: "blocked"; reason: "exhausted" | "permanent" | "unknown" };

// Bound values to PostgreSQL integer range, including the persisted delay.
const MAX_VALUE = 2_147_483_647;

export function validatePolicy(policy: RetryPolicy): void {
  for (const value of [
    policy.maxAttempts,
    policy.baseDelayMs,
    policy.capDelayMs,
  ]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_VALUE)
      throw new Error("invalid retry policy");
  }
  if (policy.baseDelayMs > policy.capDelayMs)
    throw new Error("invalid retry policy");
}

export function decideRetry(
  policy: RetryPolicy,
  attempt: number,
  outcome: Outcome,
): Decision {
  validatePolicy(policy);
  if (
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    attempt > policy.maxAttempts
  )
    throw new Error("invalid attempt");
  if (outcome === "success") return { state: "completed" };
  if (outcome === "permanent" || outcome === "unknown")
    return { state: "blocked", reason: outcome };
  if (outcome !== "transient") throw new Error("invalid outcome");
  if (attempt === policy.maxAttempts)
    return { state: "blocked", reason: "exhausted" };

  // Saturate before exponentiation so even extreme attempt ordinals are safe.
  const exponent = Math.min(attempt - 1, 31);
  const delayMs = Math.min(
    policy.capDelayMs,
    policy.baseDelayMs * 2 ** exponent,
  );
  return { state: "scheduled", delayMs };
}
