import { describe, expect, it } from "vitest";
import {
  buildExecutionResultV3,
  parseExecutionResultV3,
  reusableFoundObservation,
  type ExecutionResultV3,
} from "../src/execution-result-v3.js";
const eventId = "00000000-0000-0000-0000-000000000001";
const found = {
  nodeId: "lookup",
  kind: "viacep-address-result.v1",
  status: "found",
  cep: "01001000",
  address: { cep: "01001-000", complemento: "" },
  failure: null,
} as const;
const decision = {
  nodeId: "condition",
  outcome: "TRUE",
  sourcePort: "TRUE",
  targetNodeId: "action",
} as const;
const base: ExecutionResultV3 = {
  kind: "viacep-condition-execution.v1",
  eventId,
  lookup: found,
  decision,
  action: {
    nodeId: "action",
    status: "executed",
    receipt: { kind: "local-receipt.v1", eventId, message: "ok" },
  },
  failure: null,
};
const fail = (code: string, classification: string, nodeId: string | null) => ({
  code,
  classification,
  nodeId,
});
const make = (
  lookup: unknown,
  d: unknown,
  action: unknown,
  failure: unknown,
) => ({ ...base, lookup, decision: d, action, failure });
const action = (status: string) => ({
  nodeId: "action",
  status,
  receipt: null,
});
const failed = (
  code: string,
  classification: string,
  cep: string | null = "01001000",
  status = "failed",
) => ({
  nodeId: "lookup",
  kind: "viacep-address-result.v1",
  status,
  cep,
  address: null,
  failure: fail(code, classification, "lookup"),
});
const cases: unknown[] = [
  base,
  make(
    found,
    { ...decision, outcome: "FALSE", sourcePort: "FALSE", targetNodeId: "end" },
    action("ignored"),
    null,
  ),
  make(
    found,
    decision,
    action("pending"),
    fail("action_transient", "transient", "action"),
  ),
  make(
    found,
    decision,
    action("pending"),
    fail("event_peer_failure", "transient", null),
  ),
  ...[
    ["action_permanent", "permanent"],
    ["action_unknown", "unknown"],
    ["retry_exhausted", "exhausted"],
  ].map(([code, cls]) =>
    make(found, decision, action("not_executed"), fail(code!, cls!, "action")),
  ),
  ...[
    "invalid_condition_config",
    "invalid_condition_value",
    "condition_type_mismatch",
  ].map((code) =>
    make(
      found,
      null,
      action("not_executed"),
      fail(code, "permanent", "condition"),
    ),
  ),
  make(
    found,
    null,
    action("not_executed"),
    fail("event_peer_failure", "unknown", null),
  ),
  ...[
    ["invalid_cep", "permanent", null],
    ["viacep_timeout", "transient", "01001000"],
    ["viacep_transport", "transient", "01001000"],
    ["viacep_http_transient", "transient", "01001000"],
    ["viacep_http_permanent", "permanent", "01001000"],
    ["viacep_invalid_response", "permanent", "01001000"],
    ["viacep_security_rejected", "permanent", "01001000"],
    ["viacep_unknown", "unknown", "01001000"],
    ["retry_exhausted", "exhausted", "01001000"],
  ].map(([code, cls, cep]) =>
    make(
      failed(code!, cls!, cep),
      null,
      action(cls === "transient" ? "pending" : "not_executed"),
      fail(code!, cls!, "lookup"),
    ),
  ),
  make(
    failed("viacep_not_found", "permanent", "01001000", "not_found"),
    null,
    action("not_executed"),
    fail("viacep_not_found", "permanent", "lookup"),
  ),
  make(
    failed("viacep_timeout", "transient"),
    null,
    action("not_executed"),
    fail("event_peer_failure", "permanent", null),
  ),
  make(
    null,
    null,
    { nodeId: null, status: "not_executed", receipt: null },
    fail("unsupported_execution_contract", "unknown", null),
  ),
];
describe("v3 persisted contract", () => {
  it("validates PostgreSQL-compatible receipt Unicode without a length cap", () => {
    for (const [message, accepted] of [
      ["before\0after", false],
      ["\uD800", false],
      ["\uDC00", false],
      ["Olá 😀", true],
      ["x".repeat(10000), true],
    ] as const) {
      const value: ExecutionResultV3 = {
        ...base,
        action: {
          nodeId: "action",
          status: "executed",
          receipt: { kind: "local-receipt.v1", eventId, message },
        },
      };
      if (accepted) {
        expect(parseExecutionResultV3(value, eventId, false)).toEqual(value);
        expect(buildExecutionResultV3(value)).toEqual(value);
      } else {
        expect(() => parseExecutionResultV3(value, eventId, false)).toThrow(
          "execution invariant",
        );
        expect(() => buildExecutionResultV3(value)).toThrow(
          "execution invariant",
        );
      }
    }
  });
  it("retains the address limit in Unicode scalars", () => {
    for (const count of [1024, 1025]) {
      const value = make(
        {
          ...found,
          address: { cep: "01001-000", complemento: "😀".repeat(count) },
        },
        decision,
        base.action,
        null,
      );
      if (count === 1024)
        expect(parseExecutionResultV3(value, eventId, false)).toEqual(value);
      else
        expect(() => parseExecutionResultV3(value, eventId, false)).toThrow(
          "execution invariant",
        );
    }
  });
  it("enforces the complete non-found peer override matrix", () => {
    const own = [
      ["viacep_timeout", "transient"],
      ["viacep_unknown", "unknown"],
      ["viacep_http_permanent", "permanent"],
      ["retry_exhausted", "exhausted"],
      ["viacep_not_found", "permanent"],
    ] as const;
    for (const [code, cls] of own) {
      const lookup = failed(
        code,
        cls,
        "01001000",
        code === "viacep_not_found" ? "not_found" : "failed",
      );
      for (const peer of ["transient", "unknown", "permanent", "exhausted"]) {
        const value = make(
          lookup,
          null,
          action(peer === "transient" ? "pending" : "not_executed"),
          fail("event_peer_failure", peer, null),
        );
        const allowed =
          cls === "transient"
            ? peer !== "transient"
            : cls === "unknown" && peer === "permanent";
        if (allowed)
          expect(parseExecutionResultV3(value, eventId, false)).toEqual(value);
        else
          expect(() => parseExecutionResultV3(value, eventId, false)).toThrow(
            "execution invariant",
          );
      }
    }
    const lookup = failed("viacep_unknown", "unknown");
    for (const top of [
      null,
      fail("event_peer_failure", "permanent", "lookup"),
      fail("action_permanent", "permanent", null),
      { ...fail("event_peer_failure", "permanent", null), extra: true },
      fail("viacep_unknown", "unknown", "other"),
    ]) {
      expect(() =>
        parseExecutionResultV3(
          make(lookup, null, action("not_executed"), top),
          eventId,
          false,
        ),
      ).toThrow("execution invariant");
    }
  });
  it.each(cases.map((v, i) => [i, v]))(
    "accepts migration 016 sample %i",
    (_i, value) => {
      expect(parseExecutionResultV3(value, eventId, false)).toEqual(value);
    },
  );
  it("rejects malformed and misattributed samples", () => {
    const invalid = [
      { ...base, extra: 1 },
      { ...base, lookup: undefined },
      make({ ...found, cep: "01001-000" }, decision, base.action, null),
      make(
        { ...found, address: { cep: "01001-000", uf: null } },
        decision,
        base.action,
        null,
      ),
      make(
        { ...found, address: { cep: "01001-000", uf: "x".repeat(1025) } },
        decision,
        base.action,
        null,
      ),
      make(
        { ...found, address: { cep: "01001-000", other: "x" } },
        decision,
        base.action,
        null,
      ),
      make(
        { ...found, address: { cep: "01002-000" } },
        decision,
        base.action,
        null,
      ),
      make({ ...found, nodeId: "bad\n" }, decision, base.action, null),
      make(found, { ...decision, nodeId: "lookup" }, base.action, null),
      make(found, { ...decision, targetNodeId: "end" }, base.action, null),
      make(
        failed("viacep_timeout", "permanent"),
        null,
        action("not_executed"),
        fail("viacep_timeout", "permanent", "lookup"),
      ),
      make(
        failed("invalid_cep", "permanent"),
        null,
        action("not_executed"),
        fail("invalid_cep", "permanent", "lookup"),
      ),
      make(
        failed("viacep_timeout", "transient"),
        null,
        action("pending"),
        fail("action_transient", "transient", "action"),
      ),
      make(
        found,
        null,
        action("not_executed"),
        fail("invalid_condition_config", "permanent", "action"),
      ),
      make(
        found,
        decision,
        action("pending"),
        fail("action_transient", "transient", "lookup"),
      ),
      make(
        found,
        decision,
        action("not_executed"),
        fail("event_peer_failure", "permanent", "action"),
      ),
      make(found, decision, { ...base.action, receipt: null }, null),
      make(
        null,
        null,
        action("not_executed"),
        fail("unsupported_execution_contract", "unknown", null),
      ),
    ];
    for (const v of invalid)
      expect(() => parseExecutionResultV3(v, eventId, false)).toThrow(
        "execution invariant",
      );
  });
  it("preserves empty and absent fields and returns detached snapshots", () => {
    const parsed = buildExecutionResultV3(base);
    const reuse = reusableFoundObservation(parsed, eventId, false)!;
    expect(reuse.address).toEqual({ cep: "01001-000", complemento: "" });
    reuse.address.complemento = "changed";
    expect(
      parsed.lookup?.status === "found" && parsed.lookup.address.complemento,
    ).toBe("");
    expect(parseExecutionResultV3(null, eventId, true)).toBeNull();
  });
  it("distinguishes SQL NULL from JSON null and rejects inconsistent indicators", () => {
    expect(parseExecutionResultV3(null, eventId, true)).toBeNull();
    expect(reusableFoundObservation(null, eventId, true)).toBeNull();
    for (const [value, indicator] of [
      [null, false],
      [base, true],
      [base, undefined],
    ] as const) {
      expect(() =>
        parseExecutionResultV3(value, eventId, indicator as boolean),
      ).toThrow("execution invariant");
    }
  });
  it("rejects non-enumerable data and accessors at every object level without invoking getters", () => {
    const paths = [
      ["eventId"],
      ["lookup", "status"],
      ["lookup", "address", "cep"],
      ["lookup", "address", "complemento"],
      ["decision", "outcome"],
      ["action", "status"],
      ["action", "receipt", "message"],
    ];
    const failureBase = make(
      found,
      decision,
      action("pending"),
      fail("action_transient", "transient", "action"),
    );
    for (const [sample, path] of [
      ...paths.map((path) => [base, path] as const),
      [failureBase, ["failure", "code"]] as const,
    ]) {
      for (const accessor of [false, true]) {
        const candidate = structuredClone(sample) as Record<string, unknown>;
        let target = candidate;
        for (const key of path.slice(0, -1))
          target = target[key] as Record<string, unknown>;
        const key = path[path.length - 1]!;
        const original = target[key];
        let invoked = false;
        Object.defineProperty(
          target,
          key,
          accessor
            ? {
                enumerable: true,
                configurable: true,
                get: () => {
                  invoked = true;
                  throw new Error("secret");
                },
              }
            : { enumerable: false, configurable: true, value: original },
        );
        expect(() => parseExecutionResultV3(candidate, eventId, false)).toThrow(
          "execution invariant",
        );
        expect(invoked).toBe(false);
      }
    }
  });
  it("validates untrusted reusable observations and detaches valid results", () => {
    for (const malformed of [
      { ...base, eventId: "wrong" },
      make(
        { ...found, address: { cep: "01002-000" } },
        decision,
        base.action,
        null,
      ),
      make(found, decision, { ...base.action, receipt: null }, null),
      { ...base, extra: true },
    ]) {
      expect(() => reusableFoundObservation(malformed, eventId, false)).toThrow(
        "execution invariant",
      );
    }
    const input = structuredClone(base);
    const observation = reusableFoundObservation(input, eventId, false)!;
    observation.address.complemento = "changed";
    expect(
      input.lookup?.status === "found" && input.lookup.address.complemento,
    ).toBe("");
  });
});
