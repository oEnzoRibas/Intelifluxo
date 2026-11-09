import { describe, expect, it } from "vitest";
import {
  conditionConfigValid,
  conditionGraphValid,
  edgeIdentity,
  fieldPathValid,
} from "./condition-contract";

const graph = () => ({
  version: 2,
  nodes: [
    { id: "t", kind: "trigger", type: "receipt.v1", position: { x: 0, y: 0 } },
    {
      id: "c",
      kind: "condition",
      type: "condition.v1",
      position: { x: 1, y: 2 },
      config: { fieldPath: "data.value", operator: "exists" },
    },
    {
      id: "a",
      kind: "action",
      type: "record-receipt.v1",
      position: { x: 2, y: 3 },
    },
    { id: "e", kind: "end", type: "end.v1", position: { x: 4, y: 5 } },
  ],
  edges: [
    { source: "t", target: "c" },
    { source: "c", sourcePort: "TRUE", target: "a" },
    { source: "c", sourcePort: "FALSE", target: "e" },
    { source: "a", target: "e" },
  ],
});

describe("condition contract", () => {
  it.each([
    ["equals", "string", ""],
    ["not_equals", "boolean", false],
    ["equals", "null", null],
    ["greater_than", "number", 0],
    ["less_than", "number", -1.5],
    ["contains", "string", "abc"],
  ])("accepts typed %s", (operator, expectedType, expectedValue) => {
    expect(
      conditionConfigValid({
        fieldPath: "data.value",
        operator,
        expectedType,
        expectedValue,
      }),
    ).toBe(true);
  });
  it("requires omission for exists and rejects coercion, invalid operators and strings", () => {
    expect(
      conditionConfigValid({ fieldPath: "type", operator: "exists" }),
    ).toBe(true);
    expect(
      conditionConfigValid({
        fieldPath: "type",
        operator: "exists",
        expectedValue: null,
      }),
    ).toBe(false);
    expect(
      conditionConfigValid({
        fieldPath: "type",
        operator: "equals",
        expectedType: "number",
        expectedValue: "1",
      }),
    ).toBe(false);
    expect(
      conditionConfigValid({
        fieldPath: "type",
        operator: "greater_than",
        expectedType: "number",
        expectedValue: Infinity,
      }),
    ).toBe(false);
    expect(
      conditionConfigValid({
        fieldPath: "type",
        operator: "contains",
        expectedType: "boolean",
        expectedValue: true,
      }),
    ).toBe(false);
    expect(
      conditionConfigValid({
        fieldPath: "type",
        operator: "equals",
        expectedType: "string",
        expectedValue: "\ud800",
      }),
    ).toBe(false);
  });
  it("bounds and protects paths", () => {
    expect(fieldPathValid("data.cliente.ativo")).toBe(true);
    for (const path of [
      "",
      "data[0]",
      "data.__proto__",
      "constructor",
      "a..b",
      Array(9).fill("a").join("."),
    ])
      expect(fieldPathValid(path)).toBe(false);
  });
  it("validates exact topology and port-aware identity", () => {
    expect(conditionGraphValid(graph())).toBe(true);
    expect(
      edgeIdentity({ source: "c", sourcePort: "TRUE", target: "e" }),
    ).not.toBe(edgeIdentity({ source: "c", sourcePort: "FALSE", target: "e" }));
    const swapped = graph();
    swapped.edges[1].target = "e";
    expect(conditionGraphValid(swapped)).toBe(false);
    const duplicate = graph();
    duplicate.edges[2].sourcePort = "TRUE";
    expect(conditionGraphValid(duplicate)).toBe(false);
    const extra = graph();
    Object.assign(extra.edges[0], { sourcePort: "TRUE" });
    expect(conditionGraphValid(extra)).toBe(false);
  });
});
