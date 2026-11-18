import { describe, expect, it } from "vitest";
import { evaluateConditionV3 } from "../src/condition-v3.js";

const lookup = {
  nodeId: "address-lookup",
  status: "found",
  address: { uf: "SP", empty: "" },
};
const step = (fieldPath = "address.uf") => ({
  source: "step",
  nodeId: "address-lookup",
  fieldPath,
});
const event = (fieldPath = "address.uf") => ({ source: "event", fieldPath });
const config = (
  input: unknown,
  operator = "exists",
  expectedType?: string,
  expectedValue?: unknown,
) =>
  operator === "exists"
    ? { input, operator }
    : { input, operator, expectedType, expectedValue };
const yes = { ok: true, value: true };
const no = { ok: true, value: false };
const invalid = { ok: false, code: "invalid_condition_value" };
const badConfig = { ok: false, code: "invalid_condition_config" };
const mismatch = { ok: false, code: "condition_type_mismatch" };

describe("v3 condition input resolution", () => {
  it("isolates event and persisted step roots and handles hyphenated node IDs", () => {
    const content = { address: { uf: "RJ" } };
    expect(
      evaluateConditionV3(
        config(step(), "equals", "string", "SP"),
        content,
        lookup,
      ),
    ).toEqual(yes);
    expect(
      evaluateConditionV3(
        config(step(), "equals", "string", "RJ"),
        content,
        lookup,
      ),
    ).toEqual(no);
    expect(
      evaluateConditionV3(
        config(event(), "equals", "string", "RJ"),
        content,
        lookup,
      ),
    ).toEqual(yes);
    expect(
      evaluateConditionV3(
        config(event(), "equals", "string", "SP"),
        content,
        lookup,
      ),
    ).toEqual(no);
  });
  it.each([
    ["exists", undefined, undefined, true, false],
    ["equals", "string", "", true, false],
    ["not_equals", "string", "", false, false],
  ])(
    "distinguishes empty and missing for %s",
    (op, type, expected, present, absent) => {
      expect(
        evaluateConditionV3(
          config(step("address.empty"), op, type, expected),
          {},
          lookup,
        ),
      ).toEqual({ ok: true, value: present });
      expect(
        evaluateConditionV3(
          config(step("address.absent"), op, type, expected),
          {},
          lookup,
        ),
      ).toEqual({ ok: true, value: absent });
    },
  );
  it.each([
    ["equals", 2, "number", 2, yes],
    ["not_equals", 2, "number", 3, yes],
    ["greater_than", 3, "number", 2, yes],
    ["less_than", 2, "number", 3, yes],
    ["contains", "abc", "string", "b", yes],
    ["equals", true, "boolean", true, yes],
    ["equals", null, "null", null, yes],
    ["contains", null, "string", "a", mismatch],
    ["equals", "2", "number", 2, mismatch],
    ["exists", {}, undefined, undefined, invalid],
    ["exists", [], undefined, undefined, invalid],
    ["exists", Infinity, undefined, undefined, invalid],
  ])(
    "delegates %s and scalar/type behavior",
    (op, value, type, expected, result) => {
      expect(
        evaluateConditionV3(
          config(
            event("value"),
            op as string,
            type as string | undefined,
            expected,
          ),
          { value },
          lookup,
        ),
      ).toEqual(result);
    },
  );
  it("rejects invalid selectors, paths, references and operators", () => {
    for (const input of [
      step("__proto__.x"),
      step("address.constructor"),
      step("a..b"),
      step(Array(9).fill("a").join(".")),
      { ...step(), nodeId: "other" },
      { ...step(), nodeId: "bad.id" },
      { ...event(), nodeId: "address-lookup" },
      { source: "unknown", fieldPath: "a" },
    ])
      expect(evaluateConditionV3(config(input), {}, lookup)).toEqual(badConfig);
    expect(
      evaluateConditionV3(config(event(), "contains", "number", 1), {}, lookup),
    ).toEqual(badConfig);
    expect(
      evaluateConditionV3({ ...config(event()), extra: true }, {}, lookup),
    ).toEqual(badConfig);
  });
  it("never treats absent or failed lookups as FALSE, including event conditions", () => {
    for (const observation of [
      null,
      { ...lookup, status: "not_found" },
      { ...lookup, status: "failed" },
      { ...lookup, status: "pending" },
    ])
      for (const input of [step(), event()])
        expect(evaluateConditionV3(config(input), {}, observation)).toEqual(
          invalid,
        );
  });
  it("does not invoke getters or traverse inherited properties", () => {
    let calls = 0;
    const getter = () => {
      calls++;
      return "SP";
    };
    const address = Object.defineProperty({}, "uf", { get: getter });
    expect(
      evaluateConditionV3(config(step()), {}, { ...lookup, address }),
    ).toEqual(invalid);
    expect(
      evaluateConditionV3(
        config(step()),
        {},
        { ...lookup, address: Object.create({ uf: "SP" }) },
      ),
    ).toEqual(invalid);
    expect(evaluateConditionV3(config(event()), { address }, lookup)).toEqual(
      invalid,
    );
    expect(
      evaluateConditionV3(
        Object.defineProperty({}, "input", { get: getter }),
        {},
        lookup,
      ),
    ).toEqual(badConfig);
    expect(
      evaluateConditionV3(
        config(event()),
        {},
        Object.defineProperty({}, "status", { get: getter }),
      ),
    ).toEqual(invalid);
    expect(calls).toBe(0);
  });
  it("does not mutate frozen inputs", () => {
    const input = Object.freeze(step());
    const cfg = Object.freeze(config(input, "equals", "string", "SP"));
    const observation = Object.freeze({
      ...lookup,
      address: Object.freeze({ ...lookup.address }),
    });
    const content = Object.freeze({});
    expect(evaluateConditionV3(cfg, content, observation)).toEqual(yes);
    expect(observation).toEqual(lookup);
  });
});
