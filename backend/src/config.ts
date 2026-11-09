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
