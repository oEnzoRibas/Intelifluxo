import { describe, expect, it } from "vitest";
import { evaluateCondition, validFieldPath } from "../src/condition.js";

const config = (
  operator: string,
  expectedType?: string,
  expectedValue?: unknown,
) =>
  operator === "exists"
    ? { fieldPath: "data.value", operator }
    : { fieldPath: "data.value", operator, expectedType, expectedValue };
const run = (
  operator: string,
  value: unknown,
  type?: string,
  expected?: unknown,
) => evaluateCondition(config(operator, type, expected), { data: { value } });

describe("condition evaluator", () => {
  it.each([
    ["equals", 2, "number", 2, true],
    ["not_equals", 2, "number", 3, true],
    ["greater_than", 3, "number", 2, true],
    ["less_than", 2, "number", 3, true],
    ["contains", "abc", "string", "bc", true],
    ["contains", "abc", "string", "", true],
    ["equals", null, "null", null, true],
    ["not_equals", null, "number", 1, true],
    ["equals", -0, "number", 0, true],
    ["greater_than", 2, "number", 2, false],
  ])("evaluates %s without coercion", (op, value, type, expected, result) => {
    expect(run(op as string, value, type as string, expected)).toEqual({
      ok: true,
      value: result,
    });
  });
  it("distinguishes missing and null", () => {
    for (const op of [
      "exists",
      "equals",
      "not_equals",
      "greater_than",
      "less_than",
      "contains",
    ]) {
      const c =
        op === "exists"
          ? config(op)
          : config(
              op,
              op === "contains" ? "string" : "number",
              op === "contains" ? "x" : 1,
            );
      expect(evaluateCondition(c, { data: {} })).toEqual({
        ok: true,
        value: false,
      });
    }
    expect(run("exists", null)).toEqual({ ok: true, value: true });
    expect(run("contains", null, "string", "x")).toEqual({
      ok: false,
      code: "condition_type_mismatch",
    });
  });
  it("rejects complex values, nonfinite values and incompatible types", () => {
    for (const value of [[], {}, Infinity, NaN])
      expect(run("exists", value)).toEqual({
        ok: false,
        code: "invalid_condition_value",
      });
    expect(run("not_equals", "1", "number", 1)).toEqual({
      ok: false,
      code: "condition_type_mismatch",
    });
    expect(evaluateCondition(config("exists"), { data: [] })).toEqual({
      ok: false,
      code: "invalid_condition_value",
    });
  });
  it("never invokes getters or traverses prototypes", () => {
    let invoked = false;
    const data = Object.defineProperty({}, "value", {
      get() {
        invoked = true;
        return 1;
      },
    });
    expect(evaluateCondition(config("exists"), { data })).toEqual({
      ok: false,
      code: "invalid_condition_value",
    });
    expect(invoked).toBe(false);
    expect(
      evaluateCondition(config("exists"), {
        data: Object.create({ value: 1 }),
      }),
    ).toEqual({ ok: false, code: "invalid_condition_value" });
  });
  it("rejects invalid config and paths", () => {
    for (const path of [
      "",
      "a..b",
      "a.0",
      "__proto__.x",
      "a.constructor",
      "a.prototype",
      "x".repeat(65),
      Array(9).fill("a").join("."),
    ])
      expect(validFieldPath(path)).toBe(false);
    expect(validFieldPath("data.cliente_1.ativo")).toBe(true);
    for (const c of [
      { fieldPath: "a", operator: "exists", expectedValue: 1 },
      config("equals", "number", Infinity),
      config("equals", "string", "\ud800"),
      config("contains", "number", 1),
    ])
      expect(evaluateCondition(c, {})).toEqual({
        ok: false,
        code: "invalid_condition_config",
      });
  });
});
