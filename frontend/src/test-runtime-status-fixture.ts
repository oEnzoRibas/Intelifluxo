import type { RuntimeStatus } from "./runtime-status";

export function runtimeStatus(
  state: "ready" | "unknown" | "degraded" = "ready",
  automationSnapshots = true,
): RuntimeStatus {
  const ready = () => ({ state: "ready", reasonCode: null });
  return {
    version: 1,
    state,
    canSubmit: state === "ready",
    observedAt: new Date().toISOString(),
    components: {
      supervisor: {
        state,
        reasonCode: state === "ready" ? null : "DEPENDENCY_UNVERIFIED",
      },
      database: ready(),
      rabbitmq: ready(),
      api: ready(),
      frontend: ready(),
      worker: ready(),
      relay: ready(),
      scheduler: ready(),
    },
    capabilities: {
      automationSnapshots,
      conditionsWrites: false,
      viacepWrites: false,
      viacepExternalExecution: false,
    },
  };
}
