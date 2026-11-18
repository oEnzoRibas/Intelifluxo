import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import Automations from "./Automations";
import { fixed } from "./automation-api";
import { defaultGraph } from "./workflow-graph";

const id = "11111111-1111-1111-1111-111111111111";
const eventId = "22222222-2222-2222-2222-222222222222";
const definition = {
  id,
  scope: "tenant",
  revision: 1,
  name: "Receipt",
  active: false,
  ...fixed,
  graph: defaultGraph(),
  createdAt: "2026-01-01T00:00:00.000Z",
};
const receipt = {
  kind: "local-receipt.v1",
  eventId,
  message: "receipt message",
};
const base = {
  id,
  eventId,
  automationId: id,
  revision: 1,
  ...fixed,
  createdAt: definition.createdAt,
  status: "completed",
  retry: null,
};
const decision = {
  nodeId: "condition",
  outcome: "TRUE",
  sourcePort: "TRUE",
  targetNodeId: "action",
};
const result = {
  kind: "condition-execution.v1",
  eventId,
  decision,
  action: {
    nodeId: "action",
    status: "executed",
    receipt: { ...receipt, message: "PRIVATE_RECEIPT_VALUE" },
  },
  failure: null,
};
const v2 = (n: number, value: unknown, status = "completed") => ({
  ...base,
  id: `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`,
  schemaVersion: 2,
  result: value,
  status,
});
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("apresentação do histórico", () => {
  it("mostra resumo legível e mantém o ID nos detalhes", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url).includes("/executions?")
        ? response({ items: [v2(1, result)] })
        : response(definition),
    );
    render(<Automations route={`#automations/${id}`} />);
    const section = (
      await screen.findByRole("heading", { name: "Histórico recente" })
    ).closest("section")!;
    await within(section).findByText("Concluída");
    const row = within(section).getAllByRole("row")[1];
    expect(row).toHaveTextContent("Concluída");
    expect(row).toHaveTextContent("Condição: verdadeira");
    expect(row).toHaveTextContent("Ação: executada");
    expect(row).toHaveTextContent("01/01/2026, 00:00:00 UTC");
    expect(
      within(row).getByRole("link", { name: "Abrir evento" }),
    ).toHaveAttribute("href", `#explorer?eventId=${eventId}`);
    const details = within(row)
      .getByText("Detalhes da execução")
      .closest("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(
      within(details).getByText(`ID do evento: ${eventId}`),
    ).not.toBeVisible();
    fireEvent.click(within(details).getByText("Detalhes da execução"));
    expect(within(details).getByText(`ID do evento: ${eventId}`)).toBeVisible();
    expect(
      within(section).getByText(/Lista limitada a até 100 execuções/),
    ).toBeInTheDocument();
  });
});

it("apresenta resultados ViaCEP persistidos no histórico sem inventar dados", async () => {
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
    decision,
    action: {
      nodeId: "action",
      status: "executed",
      receipt: { ...receipt, message: "Recibo persistido" },
    },
    failure: null,
  };
  const failure = {
    classification: "permanent",
    code: "viacep_not_found",
    nodeId: "lookup",
  };
  const missing = {
    ...found,
    lookup: { ...found.lookup, status: "not_found", address: null, failure },
    decision: null,
    action: { nodeId: "action", status: "not_executed", receipt: null },
    failure,
  };
  const ignored = {
    ...found,
    decision: {
      ...decision,
      outcome: "FALSE",
      sourcePort: "FALSE",
      targetNodeId: "end",
    },
    action: { nodeId: "action", status: "ignored", receipt: null },
  };
  const transient = {
    classification: "transient",
    code: "viacep_timeout",
    nodeId: "lookup",
  };
  const failed = {
    ...missing,
    lookup: { ...missing.lookup, status: "failed", failure: transient },
    action: { nodeId: "action", status: "pending", receipt: null },
    failure: transient,
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
    String(url).includes("/executions?")
      ? response({
          items: [found, ignored, missing, failed].map((value, i) => ({
            ...v2(i + 1, value, i === 1 ? "ignored" : "completed"),
            schemaVersion: 3,
          })),
        })
      : response(definition),
  );
  render(<Automations route={`#automations/${id}`} />);
  const section = (
    await screen.findByRole("heading", { name: "Histórico recente" })
  ).closest("section")!;
  await within(section).findByText("Recibo local: Recibo persistido");
  const rows = within(section).getAllByRole("row").slice(1);
  expect(rows).toHaveLength(4);
  expect(rows[0]).toHaveTextContent("01001000");
  expect(rows[0]).toHaveTextContent("São Paulo");
  expect(rows[0]).toHaveTextContent("SP");
  expect(rows[0]).toHaveTextContent("TRUE — atendida");
  expect(rows[0]).toHaveTextContent("Ação: executada");
  expect(within(rows[0]).queryByText("Logradouro")).not.toBeInTheDocument();
  expect(within(rows[0]).queryByText("Bairro")).not.toBeInTheDocument();
  expect(rows[1]).toHaveTextContent("Ação: ignorada");
  expect(rows[1]).not.toHaveTextContent("Recibo local:");
  expect(rows[2]).toHaveTextContent("CEP não encontrado");
  expect(rows[2]).toHaveTextContent("sem decisão");
  expect(rows[2]).not.toHaveTextContent("São Paulo");
  expect(rows[3]).toHaveTextContent("falha temporária");
  expect(rows[3]).toHaveTextContent("Ação: pendente");
  expect(rows[3]).not.toHaveTextContent("Recibo local:");
  const technical = within(rows[3])
    .getByText("Dados técnicos")
    .closest("details")!;
  expect(technical).not.toHaveAttribute("open");
  expect(technical).toHaveTextContent("viacep_timeout");
  expect(within(technical).getByText(/viacep_timeout/)).not.toBeVisible();
  expect(
    within(section).getByRole("columnheader", { name: "Criada em · UTC" }),
  ).toBeInTheDocument();
});
