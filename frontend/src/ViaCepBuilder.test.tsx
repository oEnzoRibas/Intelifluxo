import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { definition, saveGraph } from "./automation-api";
import ViaCepBuilder from "./ViaCepBuilder";
import type { ViaCepGraph } from "./viacep-graph";

const graph: ViaCepGraph = {
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
        operator: "exists",
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
};
const wire = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  scope: "local",
  revision: 1,
  name: "Teste",
  active: false,
  schemaVersion: 3,
  trigger: { type: "receipt.v1" },
  action: { type: "record-receipt.v1" },
  createdAt: "2026-01-01T00:00:00.000Z",
  graph,
};

describe("ViaCEP editor integration", () => {
  it("parses v3 without accepting unknown versions or malformed topology", () => {
    expect(definition(wire).graphSource).toBe("viacep-v3");
    expect(() => definition({ ...wire, schemaVersion: 4 })).toThrow();
    expect(() =>
      definition({ ...wire, graph: { ...graph, edges: [] } }),
    ).toThrow();
  });
  it("serializes a complete v3 definition", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ...wire, revision: 2 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await saveGraph(definition(wire), graph, new AbortController().signal);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.schemaVersion).toBe(3);
    expect(body.graph).toEqual(graph);
    fetchMock.mockRestore();
  });
  it("validates fixed CEP and retains the inspector draft on Escape with focus restored", async () => {
    render(
      <ViaCepBuilder
        definition={definition(wire)}
        graph={graph}
        onDirty={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByRole("list").tagName).toBe("OL");
    const node = screen.getByRole("button", { name: /Consultar CEP/ });
    fireEvent.click(node);
    fireEvent.change(screen.getByLabelText("CEP"), {
      target: { value: " 01001000" },
    });
    expect(screen.getByLabelText("CEP")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(
      screen.getByRole("button", { name: /Aplicar ao rascunho/ }),
    ).toBeDisabled();
    fireEvent.keyDown(screen.getByLabelText("CEP"), { key: "Escape" });
    await waitFor(() => expect(node).toHaveFocus());
    fireEvent.click(node);
    expect(screen.getByLabelText("CEP")).toHaveValue(" 01001000");
    fireEvent.change(screen.getByLabelText("Origem do CEP"), {
      target: { value: "event" },
    });
    expect(screen.getByLabelText("Campo do evento")).toHaveValue("data.cep");
    fireEvent.click(
      screen.getByRole("button", { name: /Aplicar ao rascunho/ }),
    );
    expect(
      screen.getByRole("button", { name: /evento: data.cep/ }),
    ).toBeInTheDocument();
  });
  it("retains unapplied CEP values independently when switching sources", () => {
    render(
      <ViaCepBuilder
        definition={definition(wire)}
        graph={graph}
        onDirty={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Consultar CEP/ }));
    fireEvent.change(screen.getByLabelText("CEP"), {
      target: { value: " 123 " },
    });
    fireEvent.change(screen.getByLabelText("Origem do CEP"), {
      target: { value: "event" },
    });
    fireEvent.change(screen.getByLabelText("Campo do evento"), {
      target: { value: " data.custom " },
    });
    fireEvent.change(screen.getByLabelText("Origem do CEP"), {
      target: { value: "fixed" },
    });
    expect(screen.getByLabelText("CEP")).toHaveValue(" 123 ");
    fireEvent.change(screen.getByLabelText("Origem do CEP"), {
      target: { value: "event" },
    });
    expect(screen.getByLabelText("Campo do evento")).toHaveValue(
      " data.custom ",
    );
  });
  it("focuses the mobile inspector and restores its origin", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    render(
      <ViaCepBuilder
        definition={definition(wire)}
        graph={graph}
        onDirty={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    const node = screen.getByRole("button", { name: /Consultar CEP/ });
    fireEvent.click(node);
    expect(
      screen.getByRole("heading", { name: "Consultar CEP" }),
    ).toHaveFocus();
    expect(screen.getByRole("region", { name: "Editor ViaCEP" })).toHaveClass(
      "viacep-inspector-open",
    );
    fireEvent.click(screen.getByRole("button", { name: "Voltar ao nó" }));
    expect(node).toHaveFocus();
    vi.unstubAllGlobals();
  });
  it("edits the condition source and applies only to the draft", () => {
    render(
      <ViaCepBuilder
        definition={definition(wire)}
        graph={graph}
        onDirty={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Condição/ }));
    fireEvent.change(screen.getByLabelText("Origem da condição"), {
      target: { value: "event" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Aplicar ao rascunho/ }),
    );
    expect(screen.getByRole("button", { name: /data.uf/ })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Salvar definição/ }),
    ).toBeEnabled();
  });
  it.each([
    [
      400,
      {
        error: "validation_failed",
        issues: [{ code: "viacep_disabled", path: "/graph" }],
      },
      /gate desabilitado/,
    ],
    [409, {}, /Conflito de revisão/],
  ])(
    "preserves the draft after a %i response",
    async (status, body, message) => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );
      render(
        <ViaCepBuilder
          definition={definition(wire)}
          graph={graph}
          onDirty={vi.fn()}
          onSaved={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: /Consultar CEP/ }));
      fireEvent.change(screen.getByLabelText("Origem do CEP"), {
        target: { value: "event" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: /Aplicar ao rascunho/ }),
      );
      fireEvent.click(screen.getByRole("button", { name: /Salvar definição/ }));
      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(
        screen.getByRole("button", { name: /evento: data.cep/ }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /Salvar definição/ }),
      ).toBeDisabled();
      fetchMock.mockRestore();
    },
  );
});
