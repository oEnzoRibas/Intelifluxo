import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import Automations from "./Automations";
vi.mock("./TestEventPanel", () => ({
  default: ({ onExecutionTerminal }: { onExecutionTerminal: () => void }) => (
    <button onClick={onExecutionTerminal}>Simular execução finalizada</button>
  ),
}));
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
const history = () =>
  screen
    .getByRole("heading", { name: "Histórico recente" })
    .closest("section")!;
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("execution history interactions", () => {
  it("refreshes history on terminal callback without resending an event", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) =>
        String(url).includes("/executions?")
          ? response({ items: [] })
          : response(definition),
      );
    render(<Automations route={`#automations/${id}`} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Simular execução finalizada",
      }),
    );
    await vi.waitFor(() =>
      expect(
        fetcher.mock.calls.filter(([url]) =>
          String(url).includes("/executions?"),
        ),
      ).toHaveLength(2),
    );
    expect(
      fetcher.mock.calls.filter(([, options]) => options?.method === "POST"),
    ).toHaveLength(0);
  });

  it("shows mixed v1 and v2 results, expanded decisions and event-level retry without receipt values", async () => {
    const items = [
      { ...base, result: receipt },
      v2(1, result),
      v2(
        2,
        {
          ...result,
          decision: {
            ...decision,
            outcome: "FALSE",
            sourcePort: "FALSE",
            targetNodeId: "end",
          },
          action: { nodeId: "action", status: "ignored", receipt: null },
        },
        "ignored",
      ),
      v2(
        3,
        {
          ...result,
          action: { nodeId: "action", status: "pending", receipt: null },
          failure: {
            classification: "transient",
            code: "action_transient",
            nodeId: "action",
          },
        },
        "retry_scheduled",
      ),
      v2(4, {
        ...result,
        action: { nodeId: "action", status: "not_executed", receipt: null },
        failure: {
          classification: "exhausted",
          code: "retry_exhausted",
          nodeId: "action",
        },
      }),
    ];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url).includes("/executions?")
        ? response({ items })
        : response(definition),
    );
    render(<Automations route={`#automations/${id}`} />);
    await screen.findAllByText("Condição: verdadeira");
    const rows = within(history()).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveTextContent("Comprovante registrado");
    expect(
      within(rows[0]).getByRole("link", { name: "Abrir evento" }),
    ).toHaveAttribute("href", `#explorer?eventId=${eventId}`);
    expect(rows[1]).toHaveTextContent("Ação: executada");
    expect(rows[2]).toHaveTextContent("Condição: falsa");
    expect(rows[2]).toHaveTextContent("Ação: ignorada");
    for (const row of [rows[1], rows[2]]) {
      const details = within(row)
        .getByText("Detalhes da execução")
        .closest("details")!;
      expect(details).not.toHaveAttribute("open");
      fireEvent.click(within(details).getByText("Detalhes da execução"));
      expect(within(details).getByText("Revisão utilizada: 1")).toBeVisible();
      expect(
        within(details).getByText("Nó da condição: condition"),
      ).toBeVisible();
    }
    expect(rows[3]).toHaveTextContent("Ação: pendente");
    expect(rows[3]).toHaveTextContent("Nova tentativa agendada");
    expect(rows[4]).toHaveTextContent("Ação: não executada");
    const details = within(rows[4])
      .getByText("Detalhes da execução")
      .closest("details")!;
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(within(details).getByText("Detalhes da execução"));
    expect(details).toHaveTextContent(
      "exhausted · retry_exhausted · nó: action",
    );
    expect(history()).not.toHaveTextContent("PRIVATE_RECEIPT_VALUE");
  });

  it.each(["malformed", "unavailable"])(
    "sanitizes %s errors, retries and retains meaningful focus through loading and empty states",
    async (kind) => {
      let resolveRetry!: (value: Response) => void;
      let calls = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
        if (!String(url).includes("/executions?")) return response(definition);
        calls++;
        if (calls === 1)
          return kind === "malformed"
            ? response({
                items: [
                  v2(1, {
                    ...result,
                    failure: {
                      classification: "permanent",
                      code: "PRIVATE_PAYLOAD_VALUE",
                      nodeId: "action",
                    },
                  }),
                ],
              })
            : response({ error: "PRIVATE_PAYLOAD_VALUE" }, 503);
        return new Promise<Response>((resolve) => {
          resolveRetry = resolve;
        });
      });
      render(<Automations route={`#automations/${id}`} />);
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(
        kind === "malformed" ? "resposta inesperada" : "indisponível",
      );
      expect(history()).not.toHaveTextContent("PRIVATE_PAYLOAD_VALUE");
      const retry = within(history()).getByRole("button", {
        name: "Tentar novamente",
      });
      retry.focus();
      expect(retry).toHaveFocus();
      fireEvent.click(retry);
      expect(
        screen.getByRole("heading", { name: "Histórico recente" }),
      ).toHaveFocus();
      expect(
        within(history()).getByText("Carregando histórico…"),
      ).toBeInTheDocument();
      resolveRetry(response({ items: [] }));
      expect(
        await within(history()).findByText(
          "Nenhuma execução retornada nesta lista limitada.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "Histórico recente" }),
      ).toHaveFocus();
      expect(calls).toBe(2);
    },
  );
});
