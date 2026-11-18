import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { createViaCepTemplate, viacepGraphValid } from "./viacep-graph";
import { newTestEventIntent } from "./test-event-api";
import { validViaCepResult } from "./viacep-result";
import ViaCepResult from "./ViaCepResult";

const eventId = "11111111-1111-4111-8111-111111111111";
const found = {
  kind: "viacep-condition-execution.v1",
  eventId,
  lookup: {
    nodeId: "lookup",
    kind: "viacep-address-result.v1",
    status: "found",
    cep: "01001000",
    address: { cep: "01001-000", localidade: "São Paulo", uf: "SP" },
    failure: null,
  },
  decision: {
    nodeId: "condition",
    outcome: "TRUE",
    sourcePort: "TRUE",
    targetNodeId: "action",
  },
  action: {
    nodeId: "action",
    status: "executed",
    receipt: { kind: "local-receipt.v1", eventId, message: "ok" },
  },
  failure: null,
} as const;

describe("ViaCEP increment", () => {
  it("creates independent complete fixed-example templates", () => {
    const graph = createViaCepTemplate();
    expect(viacepGraphValid(graph)).toBe(true);
    expect(graph.nodes.find((n) => n.kind === "lookup")).toMatchObject({
      config: { cep: { source: "fixed", value: "01001000" } },
    });
    expect(graph.nodes.find((n) => n.kind === "condition")).toMatchObject({
      config: { input: { fieldPath: "address.uf" }, expectedValue: "SP" },
    });
    expect(createViaCepTemplate()).not.toBe(graph);
  });
  it("validates and normalizes only the optional event CEP", () => {
    expect(newTestEventIntent("local", "test")).not.toHaveProperty("data");
    expect(newTestEventIntent("local", "test", "01001-000").data).toEqual({
      cep: "01001000",
    });
    expect(() => newTestEventIntent("local", "test", " 01001000")).toThrow();
  });
  it("strictly validates and renders actual lookup evidence", () => {
    expect(validViaCepResult(found, eventId)).toBe(true);
    expect(validViaCepResult({ ...found, extra: true }, eventId)).toBe(false);
    expect(
      validViaCepResult(
        { ...found, lookup: { ...found.lookup, cep: "123" } },
        eventId,
      ),
    ).toBe(false);
    if (!validViaCepResult(found, eventId)) throw new Error("fixture");
    render(<ViaCepResult result={found} />);
    expect(screen.getByText("São Paulo")).toBeTruthy();
    expect(screen.queryByText("Logradouro")).toBeNull();
    expect(screen.getByText(/Ação: executada/)).toBeTruthy();
  });
});
