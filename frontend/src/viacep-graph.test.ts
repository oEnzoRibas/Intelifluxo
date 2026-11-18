import { describe, expect, it } from "vitest";
import { cepInputValid, cepValid, viacepGraphValid } from "./viacep-graph";

const graph = () => ({
  version: 3,
  nodes: [
    {
      id: "trigger",
      kind: "trigger",
      type: "receipt.v1",
      position: { x: 0, y: 0 },
    },
    {
      id: "address-lookup",
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
        input: {
          source: "step",
          nodeId: "address-lookup",
          fieldPath: "address.uf",
        },
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
    { source: "trigger", target: "address-lookup" },
    { source: "address-lookup", target: "condition" },
    { source: "condition", sourcePort: "TRUE", target: "action" },
    { source: "condition", sourcePort: "FALSE", target: "end" },
    { source: "action", target: "end" },
  ],
});

describe("ViaCEP v3 wire validation", () => {
  it("accepts only strict CEP strings without normalization", () => {
    for (const v of ["01001000", "01001-000"]) expect(cepValid(v)).toBe(true);
    for (const v of [
      1001000,
      "1001000",
      " 01001000",
      "01001000\n",
      "0100-000",
      "０１００１０００",
    ])
      expect(cepValid(v)).toBe(false);
  });
  it("enforces exclusive fixed/event inputs", () => {
    expect(cepInputValid({ source: "event", fieldPath: "data.cep" })).toBe(
      true,
    );
    expect(
      cepInputValid({
        source: "fixed",
        value: "01001000",
        fieldPath: "data.cep",
      }),
    ).toBe(false);
    expect(cepInputValid({ source: "event", fieldPath: "__proto__.cep" })).toBe(
      false,
    );
  });
  it("accepts the fixed topology and rejects altered ports and references", () => {
    const g = graph();
    expect(viacepGraphValid(g)).toBe(true);
    g.edges[2].target = "end";
    expect(viacepGraphValid(g)).toBe(false);
    const bad = graph();
    bad.nodes[2].config!.input!.nodeId = "trigger";
    expect(viacepGraphValid(bad)).toBe(false);
    expect(viacepGraphValid({ ...graph(), version: 4 })).toBe(false);
  });
  it("accepts event condition and CEP sources", () => {
    const g = graph();
    g.nodes[1].config = {
      cep: { source: "event", fieldPath: "data.cep" },
    } as never;
    g.nodes[2].config!.input = {
      source: "event",
      fieldPath: "data.uf",
    } as never;
    expect(viacepGraphValid(g)).toBe(true);
  });
});
