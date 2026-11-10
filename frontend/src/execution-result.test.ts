import { afterEach, describe, expect, it, vi } from "vitest";
import { execution, fixed } from "./automation-api";
import { getEvent } from "./api";

const id = "123e4567-e89b-42d3-a456-426614174000";
const receipt = { kind: "local-receipt.v1", eventId: id, message: "ok" };
const retry = {
  generation: 0,
  attempt: 1,
  outcome: "success",
  delayMs: null,
  nextEligibleAt: null,
  reason: null,
};
const eventRetry = { scope: "event", ...retry };
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
  afterEach(() => vi.restoreAllMocks());
  it("accepts mixed v1 and TRUE executed v2", () => {
    expect([
      execution({ ...base, result: receipt }),
      execution({ ...v2(result), retry: eventRetry }),
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
  it("accepts a FALSE execution with ignored status and rejects unknown statuses", () => {
    const ignored = {
      ...v2({
        ...result,
        decision: {
          ...decision,
          outcome: "FALSE",
          sourcePort: "FALSE",
          targetNodeId: "end",
        },
        action: { nodeId: "action", status: "ignored", receipt: null },
      }),
      status: "ignored",
      retry: eventRetry,
    };
    expect(execution(ignored)).toEqual(ignored);
    expect(() => execution({ ...ignored, status: "unknown" })).toThrow();
  });
  it("requires the exact event-scoped execution retry shape", () => {
    for (const candidate of [
      retry,
      { ...eventRetry, scope: "execution" },
      { ...eventRetry, scope: null },
      { ...eventRetry, extra: true },
    ])
      expect(() => execution({ ...v2(result), retry: candidate })).toThrow();
    expect(execution({ ...v2(result), retry: null }).retry).toBeNull();
  });
  it("keeps the event detail retry contract unscoped and exact", async () => {
    const detail = {
      id,
      scope: "demo",
      content: { type: "receipt.v1", target: "local-receipt", message: "ok" },
      createdAt: base.createdAt,
      publication: "confirmed",
      status: "completed",
      result: receipt,
      retry,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(detail)));
    await expect(getEvent(id, new AbortController().signal)).resolves.toEqual(
      detail,
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ...detail, retry: eventRetry })),
    );
    await expect(
      getEvent(id, new AbortController().signal),
    ).rejects.toMatchObject({
      kind: "invalid",
    });
  });
});
