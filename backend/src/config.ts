// Reject typos rather than silently enabling or changing rollout behavior.
export function automationSnapshotsEnabled(value: string | undefined): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error("AUTOMATION_SNAPSHOTS_ENABLED must be exactly true or false");
}
export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set explicitly`);
  return value;
}

export const queue = "intelifluxo.local.receipt.v1";

export function conditionsWritesEnabled(value: string | undefined): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error("CONDITIONS_WRITES_ENABLED must be exactly true or false");
}

export function viacepWritesEnabled(value: string | undefined): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error("VIACEP_WRITES_ENABLED must be exactly true or false");
}

export function viacepExternalExecutionEnabled(
  value: string | undefined,
): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(
    "VIACEP_EXTERNAL_EXECUTION_ENABLED must be exactly true or false",
  );
}

export function viacepTimeoutMs(value: string | undefined): number {
  if (value === undefined) return 5000;
  if (/^[1-9][0-9]*$/.test(value)) {
    const timeout = Number(value);
    if (Number.isSafeInteger(timeout) && timeout >= 1000 && timeout <= 10000)
      return timeout;
  }
  throw new Error(
    "VIACEP_TIMEOUT_MS must be a canonical integer from 1000 to 10000",
  );
}
