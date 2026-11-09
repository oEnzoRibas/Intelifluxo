import { describe, expect, it } from "vitest";
import type pg from "pg";
import { api } from "../src/api.js";
import { executionResultStatus } from "../src/execution-result.js";
const eventId = "11111111-1111-4111-8111-111111111111";
const receipt = { kind: "local-receipt.v1", eventId, message: "ok" };
const base = {
  kind: "condition-execution.v1",
  eventId,
  decision: {
    nodeId: "c",
    outcome: "TRUE",
    sourcePort: "TRUE",
    targetNodeId: "a",
  },
  action: { nodeId: "a", status: "executed", receipt },
  failure: null,
};
const failure = {
  classification: "transient",
  code: "action_transient",
  nodeId: "a",
};
const pending = {
  ...base,
  action: { nodeId: "a", status: "pending", receipt: null },
  failure,
};
const ignored = {
  ...base,
  decision: {
    ...base.decision,
    outcome: "FALSE",
    sourcePort: "FALSE",
    targetNodeId: "end",
  },
  action: { nodeId: "a", status: "ignored", receipt: null },
};
const blocked = {
  ...base,
  decision: null,
  action: { nodeId: "a", status: "not_executed", receipt: null },
  failure: {
    classification: "permanent",
    code: "invalid_condition_value",
    nodeId: "c",
  },
};
describe("persisted execution invariants", () => {
  it.each([
    [base, "completed", "completed"],
    [ignored, "retry_scheduled", "ignored"],
    [pending, "retry_scheduled", "retry_scheduled"],
    [blocked, "blocked", "blocked"],
    [pending, "completed", null],
    [blocked, null, null],
  ])("validates status in API responses", async (result, state, expected) => {
    const row = {
      id: eventId,
      event_id: eventId,
      automation_id: eventId,
      revision: 1,
      schema_version: 2,
      trigger_type: "receipt.v1",
      action_type: "record-receipt.v1",
      created_at: new Date(),
      result,
      generation: 1,
      attempt: 1,
      outcome: "transient",
      state,
      delay_ms: null,
      next_eligible_at: null,
      reason: null,
      publication_generation: null,
      processed_at: null,
    };
    const pool = {
      query: async () => ({ rowCount: 1, rows: [row] }),
    } as unknown as pg.Pool;
    const app = api(pool, true);
    const response = await app.inject({
      method: "GET",
      url: `/executions/${eventId}`,
    });
    if (expected === null) {
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: "unavailable" });
    } else {
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: expected,
        retry: { scope: "event" },
        result,
      });
    }
    await app.close();
  });
  it.each([
    [1, receipt, "executed"],
    [2, base, "executed"],
    [2, ignored, "ignored"],
    [2, pending, "pending"],
    [2, blocked, "not_executed"],
    [2, null, null],
  ])("accepts valid envelopes", (version, value, status) => {
    expect(executionResultStatus(version as number, eventId, value)).toBe(
      status,
    );
  });
  it.each([
    [1, base],
    [2, receipt],
    [3, null],
    [1, { ...receipt, extra: 1 }],
    [1, { ...receipt, eventId: "other" }],
    [2, { ...base, extra: 1 }],
    [2, { ...base, eventId: "other" }],
    [2, { ...base, decision: { ...base.decision, sourcePort: "FALSE" } }],
    [2, { ...base, decision: { ...base.decision, targetNodeId: "other" } }],
    [2, { ...base, action: { ...base.action, extra: 1 } }],
    [2, { ...base, action: { ...base.action, receipt: null } }],
    [2, { ...ignored, decision: base.decision }],
    [2, { ...pending, failure: { ...failure, classification: "permanent" } }],
    [2, { ...pending, failure: { ...failure, code: 2 } }],
    [2, { ...blocked, failure: { ...blocked.failure, nodeId: 1 } }],
    [2, { ...blocked, failure: null }],
    [2, { ...base, action: { ...base.action, status: "unknown" } }],
  ])("rejects malformed envelopes", (version, value) => {
    expect(() =>
      executionResultStatus(version as number, eventId, value),
    ).toThrow("execution invariant");
  });
  it("fails closed on detail and list without exposing persisted data", async () => {
    const row = {
      id: eventId,
      event_id: eventId,
      automation_id: eventId,
      revision: 1,
      schema_version: 2,
      trigger_type: "receipt.v1",
      action_type: "record-receipt.v1",
      created_at: new Date(),
      result: { secret: "sensitive" },
      generation: null,
      attempt: null,
      outcome: null,
      state: null,
      delay_ms: null,
      next_eligible_at: null,
      reason: null,
      publication_generation: null,
      processed_at: null,
    };
    const pool = {
      query: async () => ({ rowCount: 1, rows: [row] }),
    } as unknown as pg.Pool;
    const app = api(pool, true);
    for (const url of [
      `/executions/${eventId}`,
      `/executions?eventId=${eventId}`,
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: "unavailable" });
    }
    await app.close();
  });
});
