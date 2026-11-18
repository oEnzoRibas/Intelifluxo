import { describe, expect, it } from "vitest";
import { effectiveRuntime, parseRuntimeStatus } from "./runtime-status";

const ready = () => ({
  version: 1,
  state: "ready",
  canSubmit: true,
  observedAt: "2026-01-01T00:00:00.000Z",
  components: Object.fromEntries(
    [
      "supervisor",
      "database",
      "rabbitmq",
      "api",
      "frontend",
      "worker",
      "relay",
      "scheduler",
    ].map((x) => [x, { state: "ready", reasonCode: null as string | null }]),
  ),
  capabilities: {
    automationSnapshots: true,
    conditionsWrites: false,
    viacepWrites: false,
    viacepExternalExecution: false,
  },
});
describe("runtime public contract", () => {
  it("accepts exact ready status and derives stale without changing DTO", () => {
    const value = ready();
    const parsed = parseRuntimeStatus(value);
    expect(parsed).not.toBeNull();
    expect(
      effectiveRuntime(parsed, Date.parse(value.observedAt) + 14999).canSubmit,
    ).toBe(true);
    expect(
      effectiveRuntime(parsed, Date.parse(value.observedAt) + 15000),
    ).toEqual({ state: "unknown", canSubmit: false, stale: true });
    expect(effectiveRuntime(parsed, Date.parse(value.observedAt) - 1)).toEqual({
      state: "unknown",
      canSubmit: false,
      stale: true,
    });
    expect(value.state).toBe("ready");
  });
  it("rejects extra keys, invalid reason, component state and capabilities", () => {
    expect(parseRuntimeStatus({ ...ready(), extra: true })).toBeNull();
    const a = ready();
    a.components.api = { state: "starting", reasonCode: null };
    expect(parseRuntimeStatus(a)).toBeNull();
    const b = ready();
    b.components.api = { state: "ready", reasonCode: "BAD" };
    expect(parseRuntimeStatus(b)).toBeNull();
    const c = ready();
    expect(
      parseRuntimeStatus({
        ...c,
        capabilities: { ...c.capabilities, viacepExternalExecution: true },
      }),
    ).not.toBeNull();
    expect(
      parseRuntimeStatus({
        ...ready(),
        observedAt: "2026-02-30T00:00:00.000Z",
      }),
    ).toBeNull();
  });
  it("fails closed for unknown and disabled snapshots", () => {
    expect(effectiveRuntime(null).canSubmit).toBe(false);
    const value = ready();
    value.capabilities.automationSnapshots = false;
    expect(
      effectiveRuntime(parseRuntimeStatus(value), Date.parse(value.observedAt))
        .canSubmit,
    ).toBe(false);
  });
});
