import { base, exactKeys, object } from "./api";

const states = {
  supervisor: ["starting", "ready", "degraded", "stopping", "unknown"],
  database: ["ready", "unknown", "unavailable"],
  rabbitmq: ["ready", "unknown", "unavailable"],
  api: ["ready", "unknown", "unavailable"],
  frontend: ["ready", "unknown", "unavailable"],
  worker: ["ready", "starting", "unknown", "unavailable"],
  relay: ["ready", "starting", "unknown", "unavailable"],
  scheduler: ["ready", "starting", "unknown", "unavailable"],
} as const;
const reasons = [
  "SUPERVISOR_UNAVAILABLE",
  "BOOTSTRAP_PENDING",
  "CHILD_STARTING",
  "CHILD_RESTARTING",
  "CHILD_TERMINAL",
  "DEPENDENCY_UNVERIFIED",
  "READINESS_PENDING",
  "SUPERVISOR_STOPPING",
  "LISTENER_ERROR",
];
export type RuntimeStatus = {
  version: 1;
  state: "starting" | "ready" | "degraded" | "stopping" | "unknown";
  canSubmit: boolean;
  observedAt: string;
  components: Record<
    keyof typeof states,
    { state: string; reasonCode: string | null }
  >;
  capabilities: {
    automationSnapshots: boolean;
    conditionsWrites: boolean;
    viacepWrites: boolean;
    viacepExternalExecution: boolean;
  };
};
export function parseRuntimeStatus(value: unknown): RuntimeStatus | null {
  if (
    !object(value) ||
    !exactKeys(value, [
      "version",
      "state",
      "canSubmit",
      "observedAt",
      "components",
      "capabilities",
    ]) ||
    value.version !== 1 ||
    typeof value.state !== "string" ||
    !(states.supervisor as readonly string[]).includes(value.state) ||
    typeof value.canSubmit !== "boolean" ||
    typeof value.observedAt !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.observedAt) ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    new Date(value.observedAt).toISOString() !== value.observedAt ||
    !object(value.components) ||
    !exactKeys(value.components, Object.keys(states)) ||
    !object(value.capabilities) ||
    !exactKeys(value.capabilities, [
      "automationSnapshots",
      "conditionsWrites",
      "viacepWrites",
      "viacepExternalExecution",
    ])
  )
    return null;
  const caps = value.capabilities;
  if (
    typeof caps.automationSnapshots !== "boolean" ||
    typeof caps.conditionsWrites !== "boolean" ||
    typeof caps.viacepWrites !== "boolean" ||
    typeof caps.viacepExternalExecution !== "boolean"
  )
    return null;
  for (const name of Object.keys(states) as (keyof typeof states)[]) {
    const c = value.components[name];
    if (
      !object(c) ||
      !exactKeys(c, ["state", "reasonCode"]) ||
      typeof c.state !== "string" ||
      !(states[name] as readonly string[]).includes(c.state) ||
      !(
        c.reasonCode === null ||
        (typeof c.reasonCode === "string" && reasons.includes(c.reasonCode))
      )
    )
      return null;
  }
  if ((value.components.supervisor as { state: string }).state !== value.state)
    return null;
  return value as RuntimeStatus;
}
export function effectiveRuntime(
  status: RuntimeStatus | null,
  now = Date.now(),
) {
  const age = status === null ? 0 : now - Date.parse(status.observedAt);
  const stale = status !== null && (age < 0 || age >= 15000);
  return {
    stale,
    state: stale || !status ? "unknown" : status.state,
    canSubmit:
      !!status &&
      !stale &&
      status.state === "ready" &&
      status.canSubmit &&
      status.capabilities.automationSnapshots,
  };
}
export async function fetchRuntimeStatus(
  signal: AbortSignal,
): Promise<RuntimeStatus | null> {
  try {
    const response = await fetch(`${base}/runtime/status`, {
      credentials: "omit",
      headers: { Accept: "application/json" },
      signal,
    });
    if (!response.ok) return null;
    return parseRuntimeStatus(await response.json());
  } catch {
    return null;
  }
}
