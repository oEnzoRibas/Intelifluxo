import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { validateGraphV2 } from "../src/graph-v2.js";

const document = JSON.parse(
  readFileSync(
    new URL("../schemas/automation-v1.schema.json", import.meta.url),
    "utf8",
  ),
);
const ajv = new Ajv({ strict: false });
const validate = ajv.compile(document.definitions.create);
const base = () => ({
  scope: "test",
  name: "test",
  schemaVersion: 2,
  trigger: { type: "receipt.v1" },
  action: { type: "record-receipt.v1" },
  graph: {
    version: 2,
    nodes: [
      {
        id: "t",
        kind: "trigger",
        type: "receipt.v1",
        position: { x: 0, y: 0 },
      },
      {
        id: "c",
        kind: "condition",
        type: "condition.v1",
        position: { x: 0, y: 0 },
        config: { fieldPath: "data.value", operator: "exists" } as Record<
          string,
          unknown
        >,
      },
      {
        id: "a",
        kind: "action",
        type: "record-receipt.v1",
        position: { x: 0, y: 0 },
      },
      { id: "e", kind: "end", type: "end.v1", position: { x: 0, y: 0 } },
    ],
    edges: [
      { source: "t", target: "c" },
      { source: "c", target: "a", sourcePort: "TRUE" },
      { source: "c", target: "e", sourcePort: "FALSE" },
      { source: "a", target: "e" },
    ],
  },
});
const runtime = (g: unknown) =>
  validateGraphV2(g, "receipt.v1", "record-receipt.v1").length === 0;

describe("published v2 schema", () => {
  it("matches every allowed operator and expected type", () => {
    const configs: Record<string, unknown>[] = [
      { fieldPath: "data.value", operator: "exists" },
    ];
    for (const operator of ["equals", "not_equals"])
      for (const [expectedType, expectedValue] of [
        ["null", null],
        ["boolean", true],
        ["number", 1],
        ["string", "hello"],
      ])
        configs.push({
          fieldPath: "data.value",
          operator,
          expectedType,
          expectedValue,
        });
    for (const operator of ["greater_than", "less_than"])
      configs.push({
        fieldPath: "data.value",
        operator,
        expectedType: "number",
        expectedValue: 1,
      });
    configs.push({
      fieldPath: "data.value",
      operator: "contains",
      expectedType: "string",
      expectedValue: "x",
    });
    for (const config of configs) {
      const input = base();
      input.graph.nodes[1].config = config;
      expect(runtime(input.graph)).toBe(true);
      expect(validate(input), JSON.stringify(config)).toBe(true);
    }
  });
  it("rejects malformed expressible shapes consistently", () => {
    const badConfigs = [
      { fieldPath: "a", operator: "unknown" },
      { fieldPath: "a", operator: "exists", extra: 1 },
      { fieldPath: "a", operator: "equals", expectedType: "number" },
      {
        fieldPath: "a",
        operator: "equals",
        expectedType: "number",
        expectedValue: "1",
      },
      { fieldPath: "constructor.x", operator: "exists" },
      {
        fieldPath: "a",
        operator: "contains",
        expectedType: "number",
        expectedValue: 1,
      },
    ];
    for (const config of badConfigs) {
      const input = base();
      input.graph.nodes[1].config = config;
      expect(runtime(input.graph)).toBe(false);
      expect(validate(input), JSON.stringify(config)).toBe(false);
    }
    const mutations: ((input: ReturnType<typeof base>) => void)[] = [
      (x) => {
        x.graph.nodes[0].type = "end.v1";
      },
      (x) => {
        x.graph.nodes[0].config = { fieldPath: "a", operator: "exists" };
      },
      (x) => {
        x.graph.edges[1].sourcePort = "true";
      },
      (x) => {
        x.graph.edges.pop();
      },
      (x) => {
        x.graph.nodes.pop();
      },
      (x) => {
        x.graph.edges[2].sourcePort = "TRUE";
      },
    ];
    for (const mutate of mutations) {
      const input = base();
      mutate(input);
      expect(runtime(input.graph)).toBe(false);
      expect(validate(input)).toBe(false);
    }
  });
  it("enforces version pairing and requires v2 graph", () => {
    const input = base();
    input.schemaVersion = 1;
    expect(validate(input)).toBe(false);
    const missing: Record<string, unknown> = base();
    delete missing.graph;
    expect(validate(missing)).toBe(false);
  });
  it("requires runtime validation for topology not expressible in draft-07", () => {
    const input = base();
    input.graph.edges[1].target = "e";
    input.graph.edges[2].target = "a";
    expect(validate(input)).toBe(true);
    expect(runtime(input.graph)).toBe(false);
  });
});
