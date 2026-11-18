import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildExecutionResultV3,
  parseExecutionResultV3,
  type ExecutionResultV3,
} from "../src/execution-result-v3.js";

const require = createRequire(import.meta.url);
const Ajv = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats").default;
const schema = JSON.parse(
  readFileSync(
    new URL("../schemas/execution-v1.schema.json", import.meta.url),
    "utf8",
  ),
);
const ajv = new Ajv({ strict: false });
addFormats(ajv);
ajv.addSchema(schema);
const validate = ajv.getSchema("execution-v1.schema.json#/$defs/execution");
const id = "11111111-1111-4111-8111-111111111111";
const receipt = { kind: "local-receipt.v1", eventId: id, message: "ok" };
const decision = {
  nodeId: "condition",
  outcome: "TRUE",
  sourcePort: "TRUE",
  targetNodeId: "action",
};
const action = { nodeId: "action", status: "executed", receipt };
const v2 = {
  kind: "condition-execution.v1",
  eventId: id,
  decision,
  action,
  failure: null,
};
const lookup = {
  nodeId: "lookup",
  kind: "viacep-address-result.v1",
  status: "found",
  cep: "01001000",
  address: { cep: "01001-000", complemento: "" },
  failure: null,
};
const v3 = {
  kind: "viacep-condition-execution.v1",
  eventId: id,
  lookup,
  decision,
  action,
  failure: null,
};
const execution = (schemaVersion: number, result: unknown) => ({
  id,
  eventId: id,
  automationId: id,
  revision: 1,
  schemaVersion,
  trigger: { type: "test" },
  action: { type: "test" },
  createdAt: "2026-01-01T00:00:00Z",
  status: "completed",
  retry: {
    scope: "event",
    generation: 0,
    attempt: 1,
    outcome: "success",
    delayMs: null,
    nextEligibleAt: null,
    reason: null,
  },
  result,
});
describe("execution schema", () => {
  it("uses a valid standard 2020-12 schema without data extensions", () => {
    expect(ajv.validateSchema(schema)).toBe(true);
    expect(JSON.stringify(schema)).not.toContain('"$data"');
  });
  it("leaves dynamic pinned-node correspondence to the runtime reader", () => {
    expect(
      validate(execution(3, { ...v3, lookup: { ...lookup, nodeId: "other" } })),
    ).toBe(true);
  });
  it.each([
    [1, receipt],
    [2, v2],
    [3, v3],
  ])("accepts version %s", (version, result) => {
    expect(validate(execution(version as number, result))).toBe(true);
  });
  it("accepts v3 accepted with null result", () => {
    expect(
      validate({ ...execution(3, null), status: "accepted", retry: null }),
    ).toBe(true);
  });
  it.each([
    { ...execution(4, v3) },
    { ...execution(3, v3), status: "other" },
    execution(2, v3),
    execution(3, { ...v3, extra: true }),
    execution(3, {
      ...v3,
      lookup: { ...lookup, address: { cep: "01001-000", extra: "x" } },
    }),
    execution(3, {
      ...v3,
      lookup: { ...lookup, address: { cep: "01001-000", complemento: null } },
    }),
    execution(3, { ...v3, lookup: { ...lookup, address: null } }),
    execution(3, {
      ...v3,
      failure: {
        classification: "transient",
        code: "invalid_cep",
        nodeId: "lookup",
      },
    }),
  ])("rejects invalid output %#", (value) => {
    expect(validate(value)).toBe(false);
  });
  it("accepts omitted optional address fields and ignored status", () => {
    expect(
      validate({
        ...execution(3, {
          ...v3,
          lookup: { ...lookup, address: { cep: "01001-000" } },
          decision: {
            ...decision,
            outcome: "FALSE",
            sourcePort: "FALSE",
            targetNodeId: "end",
          },
          action: { nodeId: "action", status: "ignored", receipt: null },
        }),
        status: "ignored",
      }),
    ).toBe(true);
  });
});

const failure = (
  code: string,
  classification: string,
  nodeId: string | null = "lookup",
) => ({ code, classification, nodeId });
const pending = { nodeId: "action", status: "pending", receipt: null };
const stopped = { nodeId: "action", status: "not_executed", receipt: null };
const ignored = {
  ...v3,
  decision: {
    ...decision,
    outcome: "FALSE",
    sourcePort: "FALSE",
    targetNodeId: "end",
  },
  action: { nodeId: "action", status: "ignored", receipt: null },
};
const success = execution(3, null).retry;
const scheduled = {
  ...success,
  outcome: "transient",
  delayMs: 100,
  nextEligibleAt: "2026-01-01T00:00:01Z",
};
const blocked = (classification: string) => ({
  ...success,
  outcome: classification === "exhausted" ? "transient" : classification,
  reason: classification,
});
const failed = (code: string, classification: string, status = "failed") => {
  const f = failure(code, classification);
  return {
    ...v3,
    lookup: {
      ...lookup,
      status,
      cep: code === "invalid_cep" ? null : lookup.cep,
      address: null,
      failure: f,
    },
    decision: null,
    action: classification === "transient" ? pending : stopped,
    failure: f,
  };
};
const lookupPending = failed("viacep_timeout", "transient");
const actionPending = {
  ...v3,
  action: pending,
  failure: failure("action_transient", "transient", "action"),
};
const unsupported = {
  ...v3,
  lookup: null,
  decision: null,
  action: { nodeId: null, status: "not_executed", receipt: null },
  failure: failure("unsupported_execution_contract", "unknown", null),
};
const wire = (status: string, result: unknown, retry: unknown) => ({
  ...execution(3, result),
  status,
  retry,
});

describe("v3 differential lifecycle and categories", () => {
  it.each([
    ["completed", wire("completed", v3, success)],
    ["ignored completed", wire("ignored", ignored, success)],
    ["ignored scheduled", wire("ignored", ignored, scheduled)],
    [
      "ignored blocked permanent",
      wire("ignored", ignored, blocked("permanent")),
    ],
    ["ignored blocked unknown", wire("ignored", ignored, blocked("unknown"))],
    [
      "ignored blocked exhausted",
      wire("ignored", ignored, blocked("exhausted")),
    ],
    ["pending lookup", wire("retry_scheduled", lookupPending, scheduled)],
    ["pending action", wire("retry_scheduled", actionPending, scheduled)],
    [
      "pending peer",
      wire(
        "retry_scheduled",
        {
          ...actionPending,
          failure: failure("event_peer_failure", "transient", null),
        },
        scheduled,
      ),
    ],
    [
      "released",
      wire("retry_released", lookupPending, { ...scheduled, generation: 1 }),
    ],
    [
      "not found",
      wire(
        "blocked",
        failed("viacep_not_found", "permanent", "not_found"),
        blocked("permanent"),
      ),
    ],
    [
      "invalid cep",
      wire("blocked", failed("invalid_cep", "permanent"), blocked("permanent")),
    ],
    [
      "unknown",
      wire("blocked", failed("viacep_unknown", "unknown"), blocked("unknown")),
    ],
    [
      "exhausted",
      wire(
        "blocked",
        failed("retry_exhausted", "exhausted"),
        blocked("exhausted"),
      ),
    ],
    [
      "stronger peer",
      wire(
        "blocked",
        {
          ...lookupPending,
          action: stopped,
          failure: failure("event_peer_failure", "permanent", null),
        },
        blocked("permanent"),
      ),
    ],
    [
      "condition failure",
      wire(
        "blocked",
        {
          ...v3,
          decision: null,
          action: stopped,
          failure: failure("invalid_condition_value", "permanent", "condition"),
        },
        blocked("permanent"),
      ),
    ],
    [
      "action failure",
      wire(
        "blocked",
        {
          ...v3,
          action: stopped,
          failure: failure("action_unknown", "unknown", "action"),
        },
        blocked("unknown"),
      ),
    ],
    ["unsupported", wire("blocked", unsupported, blocked("unknown"))],
    [
      "unsupported fallback",
      wire("blocked", unsupported, blocked("permanent")),
    ],
  ])("accepts %s", (_name, value) => {
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
  });
  it.each([
    ["null completed", wire("completed", null, success)],
    ["ignored executed", wire("ignored", v3, success)],
    ["scheduled ignored", wire("retry_scheduled", ignored, scheduled)],
    [
      "blocked ignored permanent",
      wire("blocked", ignored, blocked("permanent")),
    ],
    ["blocked ignored unknown", wire("blocked", ignored, blocked("unknown"))],
    [
      "blocked ignored exhausted",
      wire("blocked", ignored, blocked("exhausted")),
    ],
    ["released ignored", wire("retry_released", ignored, scheduled)],
    [
      "bad retry",
      wire("retry_scheduled", lookupPending, {
        ...scheduled,
        reason: "exhausted",
      }),
    ],
    [
      "bad retry date",
      wire("retry_scheduled", lookupPending, {
        ...scheduled,
        nextEligibleAt: "tomorrow",
      }),
    ],
    ["zero attempt", wire("completed", v3, { ...success, attempt: 0 })],
    [
      "not found null cep",
      wire(
        "blocked",
        {
          ...failed("viacep_not_found", "permanent", "not_found"),
          lookup: {
            ...failed("viacep_not_found", "permanent", "not_found").lookup,
            cep: null,
          },
        },
        blocked("permanent"),
      ),
    ],
    [
      "not found transient",
      wire(
        "retry_scheduled",
        {
          ...lookupPending,
          lookup: { ...lookupPending.lookup, status: "not_found" },
        },
        scheduled,
      ),
    ],
    [
      "executed null decision",
      wire("completed", { ...v3, decision: null }, success),
    ],
    [
      "bad address cep",
      wire(
        "completed",
        { ...v3, lookup: { ...lookup, address: { cep: "ABC" } } },
        success,
      ),
    ],
    [
      "invalid failure pair",
      wire(
        "blocked",
        failed("viacep_timeout", "permanent"),
        blocked("permanent"),
      ),
    ],
    [
      "pending terminal",
      wire(
        "retry_scheduled",
        {
          ...actionPending,
          failure: failure("action_permanent", "permanent", "action"),
        },
        scheduled,
      ),
    ],
    ["unprocessed status", wire("unprocessed", v3, success)],
    [
      "wrong blocked disposition",
      wire(
        "blocked",
        failed("viacep_unknown", "unknown"),
        blocked("exhausted"),
      ),
    ],
    [
      "nonfound mismatched code",
      wire(
        "blocked",
        {
          ...failed("invalid_cep", "permanent"),
          failure: failure("viacep_http_permanent", "permanent"),
        },
        blocked("permanent"),
      ),
    ],
  ])("rejects %s", (_name, value) => {
    expect(validate(value)).toBe(false);
  });
  it.each([
    ["event IDs", { ...v3, eventId: "22222222-2222-4222-8222-222222222222" }],
    [
      "address CEP equality",
      { ...v3, lookup: { ...lookup, address: { cep: "12345-678" } } },
    ],
    [
      "target/node equality",
      { ...v3, decision: { ...decision, targetNodeId: "other" } },
    ],
  ])("schema-passes runtime-owned %s", (_name, result) => {
    expect(validate(wire("completed", result, success))).toBe(true);
  });
});

describe("legacy lifecycle compatibility", () => {
  it.each([1, 2])(
    "accepts v%s accepted and shared-event blocked null",
    (version) => {
      expect(
        validate({
          ...execution(version, null),
          status: "accepted",
          retry: null,
        }),
      ).toBe(true);
      expect(
        validate({
          ...execution(version, null),
          status: "blocked",
          retry: blocked("permanent"),
        }),
      ).toBe(true);
    },
  );
  it("accepts v2 pending and ignored condition envelopes", () => {
    const pendingV2 = {
      ...v2,
      action: pending,
      failure: failure("action_transient", "transient", "action"),
    };
    const ignoredV2 = {
      ...v2,
      decision: ignored.decision,
      action: ignored.action,
    };
    expect(
      validate({
        ...execution(2, pendingV2),
        status: "retry_scheduled",
        retry: scheduled,
      }),
    ).toBe(true);
    expect(
      validate({
        ...execution(2, ignoredV2),
        status: "ignored",
        retry: success,
      }),
    ).toBe(true);
    expect(
      validate({ ...execution(2, v2), status: "ignored", retry: success }),
    ).toBe(false);
  });
});

const lookupCodes = [
  ["invalid_cep", "permanent", "failed"],
  ["viacep_timeout", "transient", "failed"],
  ["viacep_transport", "transient", "failed"],
  ["viacep_http_transient", "transient", "failed"],
  ["viacep_http_permanent", "permanent", "failed"],
  ["viacep_invalid_response", "permanent", "failed"],
  ["viacep_security_rejected", "permanent", "failed"],
  ["viacep_unknown", "unknown", "failed"],
  ["retry_exhausted", "exhausted", "failed"],
  ["viacep_not_found", "permanent", "not_found"],
] as const;
const disposition = (classification: string, result: unknown) =>
  classification === "transient"
    ? wire("retry_scheduled", result, scheduled)
    : wire("blocked", result, blocked(classification));

describe("lookup failure conformance", () => {
  it.each(lookupCodes)(
    "%s requires %s and the canonical CEP rule",
    (code, cls, status) => {
      const result = failed(code, cls, status);
      expect(
        validate(disposition(cls, result)),
        JSON.stringify(validate.errors),
      ).toBe(true);
      for (const wrong of [
        "transient",
        "unknown",
        "permanent",
        "exhausted",
      ].filter((x) => x !== cls)) {
        expect(validate(disposition(wrong, failed(code, wrong, status)))).toBe(
          false,
        );
      }
      for (const cep of code === "invalid_cep"
        ? ["01001000", "01001-000"]
        : [null, "01001-000", "123"]) {
        expect(
          validate(
            disposition(cls, { ...result, lookup: { ...result.lookup, cep } }),
          ),
        ).toBe(false);
      }
    },
  );
});

describe("non-found peer precedence", () => {
  const own = [
    ["viacep_timeout", "transient"],
    ["viacep_unknown", "unknown"],
    ["viacep_http_permanent", "permanent"],
    ["retry_exhausted", "exhausted"],
  ] as const;
  const categories = [
    "transient",
    "unknown",
    "permanent",
    "exhausted",
  ] as const;
  it.each(
    own.flatMap(([code, cls]) =>
      categories.map((peer) => [code, cls, peer] as const),
    ),
  )("%s (%s) overridden by %s", (code, cls, peer) => {
    const allowed =
      cls === "transient"
        ? peer !== "transient"
        : cls === "unknown" && peer === "permanent";
    const result = {
      ...failed(code, cls),
      action: peer === "transient" ? pending : stopped,
      failure: failure("event_peer_failure", peer, null),
    };
    expect(
      validate(disposition(peer, result)),
      JSON.stringify(validate.errors),
    ).toBe(allowed);
  });
  it.each([
    ["event_peer_failure", "permanent", "lookup"],
    ["action_permanent", "permanent", null],
    ["event_peer_failure", "bogus", null],
  ])("rejects peer code/category/node %s/%s/%s", (code, cls, node) => {
    const result = {
      ...lookupPending,
      action: stopped,
      failure: failure(code, cls, node),
    };
    expect(validate(disposition("permanent", result))).toBe(false);
  });
});

describe("retry and fallback bounds", () => {
  it.each([
    [
      "negative generation",
      wire("completed", v3, { ...success, generation: -1 }),
    ],
    ["zero attempt", wire("completed", v3, { ...success, attempt: 0 })],
    ["negative attempt", wire("completed", v3, { ...success, attempt: -1 })],
    [
      "released generation zero",
      wire("retry_released", lookupPending, scheduled),
    ],
    [
      "invalid created date",
      { ...wire("completed", v3, success), createdAt: "2026-02-30T00:00:00Z" },
    ],
    [
      "invalid retry date",
      wire("retry_scheduled", lookupPending, {
        ...scheduled,
        nextEligibleAt: "2026-02-30T00:00:00Z",
      }),
    ],
  ])("rejects %s", (_name, value) => expect(validate(value)).toBe(false));
  it("accepts the minimum generation and attempt", () => {
    expect(
      validate(
        wire("completed", v3, { ...success, generation: 0, attempt: 1 }),
      ),
    ).toBe(true);
    expect(
      validate(
        wire("retry_released", lookupPending, {
          ...scheduled,
          generation: 1,
          attempt: 1,
        }),
      ),
    ).toBe(true);
  });
  it.each([
    ["lookup", { ...unsupported, lookup }],
    ["decision", { ...unsupported, decision }],
    [
      "action node",
      { ...unsupported, action: { ...unsupported.action, nodeId: "action" } },
    ],
    ["receipt", { ...unsupported, action: { ...unsupported.action, receipt } }],
    [
      "failure node",
      { ...unsupported, failure: { ...unsupported.failure, nodeId: "lookup" } },
    ],
    ["extra result key", { ...unsupported, extra: true }],
    [
      "extra action key",
      { ...unsupported, action: { ...unsupported.action, extra: true } },
    ],
    [
      "extra failure key",
      { ...unsupported, failure: { ...unsupported.failure, extra: true } },
    ],
    [
      "missing lookup",
      Object.fromEntries(
        Object.entries(unsupported).filter(([key]) => key !== "lookup"),
      ),
    ],
    [
      "missing decision",
      Object.fromEntries(
        Object.entries(unsupported).filter(([key]) => key !== "decision"),
      ),
    ],
    [
      "missing receipt",
      { ...unsupported, action: { nodeId: null, status: "not_executed" } },
    ],
  ])("rejects unsupported fallback with %s", (_name, result) => {
    expect(validate(wire("blocked", result, blocked("unknown")))).toBe(false);
  });
});

describe("serialized runtime/schema boundary", () => {
  it.each([
    ["completed", v3, "completed", success],
    ["ignored", ignored, "ignored", success],
    ["pending", lookupPending, "retry_scheduled", scheduled],
    [
      "blocked",
      failed("viacep_unknown", "unknown"),
      "blocked",
      blocked("unknown"),
    ],
    ["unsupported", unsupported, "blocked", blocked("unknown")],
  ])("accepts builder/parser result: %s", (_name, value, status, retry) => {
    const built = buildExecutionResultV3(value as ExecutionResultV3);
    const serialized = JSON.parse(JSON.stringify(built));
    expect(parseExecutionResultV3(serialized, id, false)).toEqual(built);
    expect(
      validate(wire(status as string, serialized, retry)),
      JSON.stringify(validate.errors),
    ).toBe(true);
  });
  it.each([
    ["event", { ...v3, eventId: "22222222-2222-4222-8222-222222222222" }],
    ["CEP", { ...v3, lookup: { ...lookup, address: { cep: "12345-678" } } }],
    ["target", { ...v3, decision: { ...decision, targetNodeId: "other" } }],
  ])(
    "schema permits semantic-only wrong %s; parser rejects",
    (_name, value) => {
      const serialized = JSON.parse(JSON.stringify(value));
      expect(validate(wire("completed", serialized, success))).toBe(true);
      expect(() => parseExecutionResultV3(serialized, id, false)).toThrow(
        "execution invariant",
      );
    },
  );
});
