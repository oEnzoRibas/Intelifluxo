import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import TestEventPanel from "./TestEventPanel";
import { conditionDraft, defaultGraph } from "./workflow-graph";
import type { Definition } from "./automation-api";
import { runtimeStatus } from "./test-runtime-status-fixture";
import { resetIntentRegistryForTests } from "./test-event-intent-registry";
import { createViaCepTemplate } from "./viacep-graph";

const definition: Definition = {
  id: "11111111-1111-4111-8111-111111111111",
  scope: "test",
  revision: 1,
  name: "Pedido",
  active: true,
  schemaVersion: 2,
  trigger: { type: "receipt.v1" },
  action: { type: "record-receipt.v1" },
  createdAt: "2026-01-01T00:00:00.000Z",
  graphSource: "server",
  graph: conditionDraft(defaultGraph(), false, {
    fieldPath: "data.order.total",
    operator: "greater_than",
    expectedType: "number",
    expectedValue: 100,
  }),
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionStorage.clear();
  resetIntentRegistryForTests();
});
const reply = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });

it("sends numeric data, restores it after an uncertain outcome, and retries the exact request", async () => {
  const posts: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    if (String(url).endsWith("/runtime/status")) return reply(runtimeStatus());
    if (options?.method === "POST") {
      posts.push(String(options.body));
      throw new TypeError("connection interrupted");
    }
    throw new Error("Unexpected read");
  });
  const view = render(
    <TestEventPanel definition={definition} blocked={false} />,
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Enviar evento de teste" }),
    ).toBeEnabled(),
  );
  fireEvent.change(screen.getByLabelText("Mensagem"), {
    target: { value: "pedido sintético" },
  });
  expect(screen.getByLabelText("Tipo do dado")).toHaveValue("number");
  fireEvent.change(screen.getByLabelText("Valor de data.order.total"), {
    target: { value: "150.5" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Enviar evento de teste" }),
  );
  await screen.findByRole("button", { name: /Tentar novamente com a mesma/ });
  expect(JSON.parse(posts[0]).data).toEqual({ order: { total: 150.5 } });
  view.unmount();
  resetIntentRegistryForTests();
  render(<TestEventPanel definition={definition} blocked={false} />);
  expect(screen.getByLabelText("Valor de data.order.total")).toHaveValue(
    "150.5",
  );
  const retry = screen.getByRole("button", {
    name: /Tentar novamente com a mesma/,
  });
  await waitFor(() => expect(retry).toBeEnabled());
  fireEvent.click(retry);
  await waitFor(() => expect(posts).toHaveLength(2));
  expect(posts[1]).toBe(posts[0]);
});

it("reads local execution results when the browser reports no Internet", async () => {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  const eventId = "22222222-2222-4222-8222-222222222222";
  const terminal = vi.fn();
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url, options) => {
      if (String(url).endsWith("/runtime/status"))
        return reply(runtimeStatus());
      if (options?.method === "POST")
        return reply({ id: eventId, replay: false }, 202);
      if (String(url).includes("/executions?")) return reply({ items: [] });
      return reply({
        id: eventId,
        scope: "test",
        createdAt: definition.createdAt,
        content: {
          type: "receipt.v1",
          target: "local-receipt",
          message: "pedido",
        },
        publication: "pending",
        status: "accepted",
        retry: null,
        result: null,
      });
    });
  render(
    <TestEventPanel
      definition={{ ...definition, schemaVersion: 1, graph: defaultGraph() }}
      blocked={false}
      onExecutionTerminal={terminal}
    />,
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Enviar evento de teste" }),
    ).toBeEnabled(),
  );
  fireEvent.change(screen.getByLabelText("Mensagem"), {
    target: { value: "pedido" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Enviar evento de teste" }),
  );
  expect(
    await screen.findByRole("region", { name: "Situação do evento" }),
  ).toHaveTextContent("Aceito — aguardando envio");
  expect(
    fetcher.mock.calls.filter(([, options]) => options?.method === "POST"),
  ).toHaveLength(1);
  expect(terminal).not.toHaveBeenCalled();
});

it("sends a nested event CEP together with the condition's typed data", async () => {
  const graph = createViaCepTemplate();
  const lookup = graph.nodes.find((n) => n.kind === "lookup")!;
  if (lookup.kind === "lookup")
    lookup.config.cep = { source: "event", fieldPath: "data.delivery.cep" };
  const condition = graph.nodes.find((n) => n.kind === "condition")!;
  if (condition.kind === "condition")
    condition.config = {
      input: { source: "event", fieldPath: "data.total" },
      operator: "greater_than",
      expectedType: "number",
      expectedValue: 100,
    };
  const posts: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    if (String(url).endsWith("/runtime/status")) {
      const state = runtimeStatus();
      state.capabilities.conditionsWrites = true;
      state.capabilities.viacepWrites = true;
      state.capabilities.viacepExternalExecution = true;
      return reply(state);
    }
    if (options?.method === "POST") {
      posts.push(String(options.body));
      throw new TypeError();
    }
    throw new Error("Unexpected request");
  });
  render(
    <TestEventPanel
      definition={{
        ...definition,
        schemaVersion: 3,
        graph,
        graphSource: "viacep-v3",
      }}
      blocked={false}
    />,
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Enviar evento de teste" }),
    ).toBeEnabled(),
  );
  fireEvent.change(screen.getByLabelText("Mensagem"), {
    target: { value: "pedido" },
  });
  fireEvent.change(screen.getByLabelText("CEP para este teste"), {
    target: { value: "01001-000" },
  });
  fireEvent.change(screen.getByLabelText("Valor de data.total"), {
    target: { value: "200" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Enviar evento de teste" }),
  );
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(JSON.parse(posts[0]).data).toEqual({
    delivery: { cep: "01001000" },
    total: 200,
  });
});
