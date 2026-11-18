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
    expect(executionResultStatus(version as 1 | 2, eventId, value)).toBe(
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
      executionResultStatus(version as 1 | 2, eventId, value),
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

describe("v3 reader lifecycle", () => {
  const graph = {
    version: 3,
    nodes: [
      {
        id: "trigger",
        kind: "trigger",
        type: "receipt.v1",
        position: { x: 0, y: 0 },
      },
      {
        id: "lookup",
        kind: "lookup",
        type: "viacep-address.v1",
        position: { x: 0, y: 0 },
        config: { cep: { source: "fixed", value: "01001000" } },
      },
      {
        id: "condition",
        kind: "condition",
        type: "condition.v2",
        position: { x: 0, y: 0 },
        config: {
          input: { source: "event", fieldPath: "branch" },
          operator: "equals",
          expectedType: "string",
          expectedValue: "yes",
        },
      },
      {
        id: "action",
        kind: "action",
        type: "record-receipt.v1",
        position: { x: 0, y: 0 },
      },
      { id: "end", kind: "end", type: "end.v1", position: { x: 0, y: 0 } },
    ],
    edges: [
      { source: "trigger", target: "lookup" },
      { source: "lookup", target: "condition" },
      { source: "condition", sourcePort: "TRUE", target: "action" },
      { source: "condition", sourcePort: "FALSE", target: "end" },
      { source: "action", target: "end" },
    ],
  };
  const found = {
    kind: "viacep-condition-execution.v1",
    eventId,
    lookup: {
      nodeId: "lookup",
      kind: "viacep-address-result.v1",
      status: "found",
      cep: "01001000",
      address: { cep: "01001-000", complemento: "" },
      failure: null,
    },
    decision: {
      nodeId: "condition",
      outcome: "TRUE",
      sourcePort: "TRUE",
      targetNodeId: "action",
    },
    action: { nodeId: "action", status: "executed", receipt },
    failure: null,
  };
  const ignoredV3 = {
    ...found,
    decision: {
      ...found.decision,
      outcome: "FALSE",
      sourcePort: "FALSE",
      targetNodeId: "end",
    },
    action: { nodeId: "action", status: "ignored", receipt: null },
  };
  const failureV3 = {
    classification: "transient",
    code: "viacep_timeout",
    nodeId: "lookup",
  };
  const pendingV3 = {
    ...found,
    lookup: {
      ...found.lookup,
      status: "failed",
      address: null,
      failure: failureV3,
    },
    decision: null,
    action: { nodeId: "action", status: "pending", receipt: null },
    failure: failureV3,
  };
  const blockedV3 = {
    ...found,
    lookup: null,
    decision: null,
    action: { nodeId: null, status: "not_executed", receipt: null },
    failure: {
      classification: "unknown",
      code: "unsupported_execution_contract",
      nodeId: null,
    },
  };
  const blank = {
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
  const completed = {
    ...blank,
    generation: 0,
    attempt: 1,
    outcome: "success",
    state: "completed",
  };
  const scheduled = {
    ...blank,
    generation: 1,
    attempt: 1,
    outcome: "transient",
    state: "retry_scheduled",
    delay_ms: 100,
    next_eligible_at: new Date(),
  };
  const stopped = {
    ...blank,
    generation: 0,
    attempt: 1,
    outcome: "unknown",
    state: "blocked",
    reason: "unknown",
  };
  const permanent = { ...stopped, outcome: "permanent", reason: "permanent" };
  const exhausted = { ...stopped, outcome: "transient", reason: "exhausted" };
  const actionFailure = (
    classification: string,
    code: string,
    nodeId: string | null = "action",
  ) => ({
    ...found,
    action: { nodeId: "action", status: "not_executed", receipt: null },
    failure: { classification, code, nodeId },
  });
  const ownPermanent = actionFailure("permanent", "action_permanent");
  const ownUnknown = actionFailure("unknown", "action_unknown");
  const ownExhausted = actionFailure("exhausted", "retry_exhausted");
  const peerPermanent = actionFailure("permanent", "event_peer_failure", null);
  const peerUnknown = actionFailure("unknown", "event_peer_failure", null);
  const peerExhausted = actionFailure("exhausted", "event_peer_failure", null);
  const peerTransient = {
    ...found,
    action: { nodeId: "action", status: "pending", receipt: null },
    failure: {
      classification: "transient",
      code: "event_peer_failure",
      nodeId: null,
    },
  };
  it.each([
    [null, true, blank, "accepted"],
    [found, false, completed, "completed"],
    [ignoredV3, false, completed, "ignored"],
    [ignoredV3, false, scheduled, "ignored"],
    [ignoredV3, false, stopped, "ignored"],
    [ignoredV3, false, permanent, "ignored"],
    [ignoredV3, false, exhausted, "ignored"],
    [pendingV3, false, scheduled, "retry_scheduled"],
    [peerTransient, false, scheduled, "retry_scheduled"],
    [ownPermanent, false, permanent, "blocked"],
    [peerPermanent, false, permanent, "blocked"],
    [ownUnknown, false, stopped, "blocked"],
    [peerUnknown, false, stopped, "blocked"],
    [ownExhausted, false, exhausted, "blocked"],
    [peerExhausted, false, exhausted, "blocked"],
    [blockedV3, false, permanent, "blocked"],
    [ownPermanent, false, stopped, null],
    [ownUnknown, false, permanent, null],
    [peerPermanent, false, stopped, null],
    [peerUnknown, false, permanent, null],
    [peerExhausted, false, permanent, null],
    [ownExhausted, false, scheduled, null],
    [blockedV3, false, exhausted, null],
    [
      found,
      false,
      {
        ...completed,
        generation: 1,
        publication_generation: 1,
        processed_at: new Date(),
      },
      "completed",
    ],
    [
      blockedV3,
      false,
      {
        ...stopped,
        generation: 1,
        publication_generation: 1,
        processed_at: new Date(),
      },
      "blocked",
    ],
    [
      found,
      false,
      { ...completed, generation: 1, publication_generation: 1 },
      null,
    ],
    [
      blockedV3,
      false,
      { ...stopped, generation: 1, publication_generation: 1 },
      null,
    ],
    [
      pendingV3,
      false,
      { ...scheduled, publication_generation: 1, processed_at: new Date() },
      "retry_scheduled",
    ],
    [ignoredV3, false, { ...scheduled, publication_generation: 2 }, null],
    [ignoredV3, false, { ...scheduled, processed_at: new Date() }, null],
    [
      pendingV3,
      false,
      { ...scheduled, publication_generation: 1 },
      "retry_released",
    ],
    [ignoredV3, false, { ...scheduled, publication_generation: 1 }, "ignored"],
    [blockedV3, false, stopped, "blocked"],
    [null, false, blank, null],
    [null, true, completed, null],
    [found, false, blank, null],
    [found, false, scheduled, null],
    [found, false, stopped, null],
    [pendingV3, false, completed, null],
    [pendingV3, false, stopped, null],
    [blockedV3, false, completed, null],
    [blockedV3, false, scheduled, null],
    [found, false, { ...completed, publication_generation: 0 }, null],
    [pendingV3, false, { ...scheduled, publication_generation: 2 }, null],
    [pendingV3, false, { ...scheduled, delay_ms: 0 }, null],
    [blockedV3, false, { ...stopped, reason: "permanent" }, null],
    [{ secret: "sensitive" }, false, completed, null],
  ])(
    "validates lifecycle %#",
    async (result, sqlNull, disposition, expected) => {
      const row = {
        id: eventId,
        event_id: eventId,
        automation_id: eventId,
        revision: 1,
        schema_version: 3,
        trigger_type: "receipt.v1",
        action_type: "record-receipt.v1",
        created_at: new Date(),
        result,
        result_is_sql_null: sqlNull,
        graph: result === blockedV3 ? { version: 0 } : graph,
        revision_version: 3,
        revision_trigger: "receipt.v1",
        revision_action: "record-receipt.v1",
        event_content: {
          message: "ok",
          branch: result === ignoredV3 ? "no" : "yes",
        },
        pinned_event_id: eventId,
        ...disposition,
      };
      const pool = {
        query: async (sql: string) => {
          expect(sql).toContain("x.result IS NULL AS result_is_sql_null");
          return { rowCount: 1, rows: [row] };
        },
      } as unknown as pg.Pool;
      const app = api(pool, true);
      for (const url of [
        `/executions/${eventId}`,
        `/executions?eventId=${eventId}`,
      ]) {
        const response = await app.inject({ method: "GET", url });
        if (expected === null) {
          expect(response.statusCode).toBe(503);
          expect(response.json()).toEqual({ error: "unavailable" });
        } else {
          expect(response.statusCode).toBe(200);
          const output = url.includes("?")
            ? response.json().items[0]
            : response.json();
          expect(output.status).toBe(expected);
          expect(output.result).toEqual(result);
        }
      }
      await app.close();
    },
  );
  it.each([
    { ...found, lookup: { ...found.lookup, nodeId: "wrong" } },
    {
      ...found,
      action: { ...found.action, nodeId: "wrong" },
      decision: { ...found.decision, targetNodeId: "wrong" },
    },
    { ...found, decision: { ...found.decision, nodeId: "wrong" } },
    {
      ...found,
      lookup: {
        ...found.lookup,
        cep: "12345678",
        address: { cep: "12345-678" },
      },
    },
    {
      ...found,
      decision: {
        ...found.decision,
        outcome: "FALSE",
        sourcePort: "FALSE",
        targetNodeId: "end",
      },
      action: { nodeId: "action", status: "ignored", receipt: null },
    },
    {
      ...found,
      action: { ...found.action, receipt: { ...receipt, message: "wrong" } },
    },
  ])(
    "rejects pinned semantic mismatch %# in detail and list",
    async (result) => {
      const row = {
        id: eventId,
        event_id: eventId,
        automation_id: eventId,
        revision: 1,
        schema_version: 3,
        trigger_type: "receipt.v1",
        action_type: "record-receipt.v1",
        created_at: new Date(),
        result,
        result_is_sql_null: false,
        graph,
        revision_version: 3,
        revision_trigger: "receipt.v1",
        revision_action: "record-receipt.v1",
        event_content: { message: "ok", branch: "yes" },
        pinned_event_id: eventId,
        ...completed,
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
    },
  );
});
