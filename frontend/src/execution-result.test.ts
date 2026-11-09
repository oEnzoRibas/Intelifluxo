import { describe, expect, it } from "vitest";
import { execution, fixed } from "./automation-api";

const id = "123e4567-e89b-42d3-a456-426614174000";
const receipt = { kind: "local-receipt.v1", eventId: id, message: "ok" };
const base = {
  id,
  eventId: id,
  automationId: id,
  revision: 3,
  ...fixed,
  createdAt: "2025-01-01T00:00:00.000Z",
  status: "completed",
  retry: null,
};
const decision = {
  nodeId: "condition",
  outcome: "TRUE",
  sourcePort: "TRUE",
  targetNodeId: "action",
};
const result = {
  kind: "condition-execution.v1",
  eventId: id,
  decision,
  action: { nodeId: "action", status: "executed", receipt },
  failure: null,
};
const v2 = (value: unknown) => ({ ...base, schemaVersion: 2, result: value });

describe("execution results", () => {
  it("accepts mixed v1 and TRUE executed v2", () => {
    expect([
      execution({ ...base, result: receipt }),
      execution(v2(result)),
    ]).toHaveLength(2);
  });
  it("accepts FALSE ignored, transient pending, permanent and exhausted failures", () => {
    const failure = (classification: string, code: string) => ({
      classification,
      code,
      nodeId: "action",
    });
    const variants = [
      {
        ...result,
        decision: {
          ...decision,
          outcome: "FALSE",
          sourcePort: "FALSE",
          targetNodeId: "end",
        },
        action: { nodeId: "action", status: "ignored", receipt: null },
      },
      {
        ...result,
        action: { nodeId: "action", status: "pending", receipt: null },
        failure: failure("transient", "action_transient"),
      },
      ...[
        failure("permanent", "action_permanent"),
        failure("exhausted", "retry_exhausted"),
      ].map((f) => ({
        ...result,
        action: { nodeId: "action", status: "not_executed", receipt: null },
        failure: f,
      })),
    ];
    for (const variant of variants)
      expect(() => execution(v2(variant))).not.toThrow();
  });
  it("rejects malformed and unknown results", () => {
    for (const invalid of [
      { ...result, extra: true },
      { ...result, eventId: "wrong" },
      { ...result, decision: { ...decision, sourcePort: "FALSE" } },
      { ...result, action: { ...result.action, status: "unknown" } },
      receipt,
    ])
      expect(() => execution(v2(invalid))).toThrow();
  });
});
