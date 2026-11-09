import { describe, expect, it } from "vitest";
import { validateGraphV2 } from "../src/graph-v2.js";

const graph = () => ({
  version: 2,
  nodes: [
    { id: "t", kind: "trigger", type: "receipt.v1", position: { x: 0, y: 0 } },
    {
      id: "c",
      kind: "condition",
      type: "condition.v1",
      position: { x: 1, y: 0 },
      config: { fieldPath: "data.value", operator: "exists" },
    },
    {
      id: "a",
      kind: "action",
      type: "record-receipt.v1",
      position: { x: 2, y: 0 },
    },
    { id: "e", kind: "end", type: "end.v1", position: { x: 3, y: 0 } },
  ],
  edges: [
    { source: "t", target: "c" },
    { source: "c", sourcePort: "TRUE", target: "a" },
    { source: "c", sourcePort: "FALSE", target: "e" },
    { source: "a", target: "e" },
  ],
});
const validate = (g: unknown) =>
  validateGraphV2(g, "receipt.v1", "record-receipt.v1");

describe("v2 graph validator foundation", () => {
  it("accepts the exact topology independent of array order", () => {
    const g = graph();
    g.nodes.reverse();
    g.edges.reverse();
    expect(validate(g)).toEqual([]);
  });
  it("rejects invalid paths and configs", () => {
    const g = graph();
    g.nodes[1].config!.fieldPath = "data.constructor";
    expect(validate(g)[0].code).toBe("invalid_field_path");
    g.nodes[1].config!.fieldPath = "data.value";
    g.nodes[1].config!.operator = "unknown";
    expect(validate(g)[0].code).toBe("invalid_condition_config");
  });
  it("rejects invalid ports, branch swaps and cycles", () => {
    const g = graph();
    g.edges[1].sourcePort = "true";
    expect(validate(g)[0].code).toBe("invalid_source_port");
    g.edges[1].sourcePort = "FALSE";
    expect(validate(g)[0].code).toBe("invalid_topology");
    g.edges[1].sourcePort = "TRUE";
    g.edges[3].target = "c";
    expect(validate(g)[0].code).toBe("cycle_detected");
  });
});
