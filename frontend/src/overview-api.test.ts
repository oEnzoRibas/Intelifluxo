import { describe, expect, it } from "vitest";
import { parseOverview } from "./overview-api";

const stamp = (ms: number) => new Date(ms).toISOString().replace("Z", "000Z");
function zero() {
  const start = Date.UTC(2026, 0, 1);
  return {
    version: 1,
    period: "24h",
    window: {
      start: stamp(start),
      end: stamp(start + 86400000),
      timestamp: "createdAt",
    },
    automations: { total: 0, active: 0 },
    executions: {
      total: 0,
      success: 0,
      failed: 0,
      skipped: 0,
      pendingOrUnknown: 0,
      successRate: null,
      successRateDenominator: "success_plus_failed",
    },
    buckets: Array.from({ length: 24 }, (_, i) => ({
      start: stamp(start + i * 3600000),
      end: stamp(start + (i + 1) * 3600000),
      executions: 0,
    })),
    recent: [],
    executionFailures: [],
    eventAttention: {
      scope: "current",
      timestamp: "eventCreatedAt",
      items: [],
    },
    limitations: {
      completionTime: {
        value: null,
        reason: "completion_timestamp_not_persisted",
      },
      listLimit: 10,
    },
  };
}
describe("overview contract", () => {
  it("accepts a confirmed zero snapshot", () =>
    expect(parseOverview(zero(), "24h").executions.successRate).toBeNull());
  it("rejects mismatched periods and unknown keys", () => {
    expect(() => parseOverview(zero(), "7d")).toThrow();
    expect(() => parseOverview({ ...zero(), problems: [] })).toThrow();
  });
  it("rejects inconsistent counts and buckets", () => {
    const x = zero();
    x.executions.total = 1;
    expect(() => parseOverview(x)).toThrow();
    const y = zero();
    y.buckets[0].executions = 1;
    expect(() => parseOverview(y)).toThrow();
  });
});
