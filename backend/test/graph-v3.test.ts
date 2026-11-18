import { describe, expect, it } from "vitest";
import { validateGraphV3 } from "../src/graph-v3.js";
import { viacepWritesEnabled } from "../src/config.js";

function graph() {
  return {
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
        position: { x: 1, y: 0 },
        config: { cep: { source: "fixed", value: "01001-000" } },
      },
      {
        id: "condition",
        kind: "condition",
        type: "condition.v2",
        position: { x: 2, y: 0 },
        config: {
          input: { source: "step", nodeId: "lookup", fieldPath: "address.uf" },
          operator: "equals",
          expectedType: "string",
          expectedValue: "SP",
        },
      },
      {
        id: "action",
        kind: "action",
        type: "record-receipt.v1",
        position: { x: 3, y: 0 },
      },
      { id: "end", kind: "end", type: "end.v1", position: { x: 4, y: 0 } },
    ],
    edges: [
      { source: "trigger", target: "lookup" },
      { source: "lookup", target: "condition" },
      { source: "condition", sourcePort: "TRUE", target: "action" },
      { source: "condition", sourcePort: "FALSE", target: "end" },
      { source: "action", target: "end" },
    ],
  };
}
const validate = (value: unknown) =>
  validateGraphV3(value, "receipt.v1", "record-receipt.v1");
describe("v3 definition contract", () => {
  it("accepts graph permutations", () => {
    const g = graph();
    expect(validate(g)).toEqual([]);
    g.nodes.reverse();
    g.edges.reverse();
    expect(validate(g)).toEqual([]);
  });
  it.each([
    "0100100",
    "010010000",
    "01001-000\n",
    " 01001000",
    "０１００１０００",
    "01001--000",
  ])("rejects CEP %j", (cep) => {
    const g = graph();
    g.nodes[1].config!.cep!.value = cep;
    expect(validate(g).map((x) => x.code)).toContain("invalid_cep");
  });
  it("rejects an invalid step reference and swapped branch", () => {
    const g = graph();
    g.nodes[2].config!.input!.nodeId = "trigger";
    expect(validate(g).map((x) => x.code)).toContain("invalid_step_reference");
    const h = graph();
    h.edges[2].target = "end";
    expect(validate(h).map((x) => x.code)).toContain("invalid_topology");
  });
  it("defaults the flag off and rejects typos", () => {
    expect(viacepWritesEnabled(undefined)).toBe(false);
    expect(viacepWritesEnabled("true")).toBe(true);
    expect(() => viacepWritesEnabled("")).toThrow();
    expect(() => viacepWritesEnabled("TRUE")).toThrow();
  });
});
