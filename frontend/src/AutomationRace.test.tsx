import { defaultGraph } from "./workflow-graph";
import { it, expect, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import Automations from "./Automations";
import { runtimeStatus } from "./test-runtime-status-fixture";

it("keeps a successful update when an older refresh resolves afterward", async () => {
  const id = "11111111-1111-1111-1111-111111111111";
  const record = {
    id,
    name: "Definition",
    scope: "scope",
    revision: 1,
    active: false,
    schemaVersion: 1,
    trigger: { type: "receipt.v1" },
    action: { type: "record-receipt.v1" },
    graph: defaultGraph(),
    createdAt: "2026-01-01T00:00:00Z",
  };
  const json = (data: unknown) => new Response(JSON.stringify(data));
  let resolveRead!: (response: Response) => void;
  const oldRead = new Promise<Response>((resolve) => {
    resolveRead = resolve;
  });
  let reads = 0;
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/runtime/status"))
        return Promise.resolve(json(runtimeStatus()));
      if (url.includes("/automations/list"))
        return Promise.resolve(json({ items: [], nextCursor: null }));
      if (url.includes("executions"))
        return Promise.resolve(json({ items: [] }));
      if (init?.method === "PUT")
        return Promise.resolve(json({ ...record, revision: 2, active: true }));
      if (!url.endsWith(`/automations/${id}`))
        throw new Error(`Unexpected request ${init?.method ?? "GET"} ${url}`);
      return ++reads === 1 ? Promise.resolve(json(record)) : oldRead;
    }),
  );
  try {
    render(<Automations route={`#automations/${id}`} />);
    expect(
      await screen.findByRole("button", { name: "Ativar" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Atualizar automação" }),
    );
    await waitFor(() => expect(reads).toBe(2));
    expect(screen.getByText("Atualizando automação.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ativar" }));
    expect(
      await screen.findByRole("button", { name: "Desativar" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Ativa .* revisão 2/)).toBeInTheDocument();
    await act(async () => {
      resolveRead(json(record));
      await oldRead;
    });
    expect(
      screen.getByRole("button", { name: "Desativar" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Ativa .* revisão 2/)).toBeInTheDocument();
    expect(
      screen.queryByText("Atualizando automação."),
    ).not.toBeInTheDocument();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("ignores a late definition response after navigation", async () => {
  const first = "11111111-1111-1111-1111-111111111111";
  const second = "22222222-2222-2222-2222-222222222222";
  const record = (id: string, name: string) => ({
    id,
    name,
    scope: "scope",
    revision: 1,
    active: false,
    schemaVersion: 1,
    trigger: { type: "receipt.v1" },
    action: { type: "record-receipt.v1" },
    graph: defaultGraph(),
    createdAt: "2026-01-01T00:00:00Z",
  });
  let resolveFirst!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    resolveFirst = resolve;
  });
  const json = (data: unknown) =>
    new Response(JSON.stringify(data), { status: 200 });
  const fetcher = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("executions")) return Promise.resolve(json({ items: [] }));
    if (url.endsWith(first)) return pending;
    return Promise.resolve(json(record(second, "New definition")));
  });
  vi.stubGlobal("fetch", fetcher);
  const view = render(<Automations route={`#automations/${first}`} />);
  view.rerender(<Automations route={`#automations/${second}`} />);
  expect(await screen.findByText("New definition")).toBeInTheDocument();
  resolveFirst(json(record(first, "Old definition")));
  await waitFor(() =>
    expect(screen.queryByText("Old definition")).not.toBeInTheDocument(),
  );
  vi.unstubAllGlobals();
});

it("does not display a previous definition or its history while navigating between IDs", async () => {
  const first = "11111111-1111-1111-1111-111111111111";
  const second = "22222222-2222-2222-2222-222222222222";
  const record = {
    id: first,
    name: "Previous definition",
    scope: "scope",
    revision: 1,
    active: false,
    schemaVersion: 1,
    trigger: { type: "receipt.v1" },
    action: { type: "record-receipt.v1" },
    graph: defaultGraph(),
    createdAt: "2026-01-01T00:00:00Z",
  };
  const json = (data: unknown) => new Response(JSON.stringify(data));
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(second)) return new Promise<Response>(() => {});
      if (url.includes("executions"))
        return Promise.resolve(json({ items: [] }));
      return Promise.resolve(json(record));
    }),
  );
  const view = render(<Automations route={`#automations/${first}`} />);
  expect(await screen.findByText("Previous definition")).toBeInTheDocument();
  view.rerender(<Automations route={`#automations/${second}`} />);
  expect(screen.queryByText("Previous definition")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Ativar" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Carregando automação");
  vi.unstubAllGlobals();
});

it("blocks activation for a dirty graph and for a saved condition placeholder", async () => {
  const id = "11111111-1111-1111-1111-111111111111";
  const record = {
    id,
    name: "Definition",
    scope: "scope",
    revision: 1,
    active: false,
    schemaVersion: 1,
    trigger: { type: "receipt.v1" },
    action: { type: "record-receipt.v1" },
    graph: defaultGraph(),
    createdAt: "2026-01-01T00:00:00Z",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("executions"))
        return Promise.resolve(new Response(JSON.stringify({ items: [] })));
      if (init?.method === "PUT")
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ...record,
              revision: 2,
              graph: JSON.parse(String(init.body)).graph,
            }),
          ),
        );
      return Promise.resolve(new Response(JSON.stringify(record)));
    }),
  );
  render(<Automations route={`#automations/${id}/builder`} />);
  const activate = await screen.findByRole("button", { name: "Ativar" });
  await waitFor(() => expect(activate).toBeEnabled());
  fireEvent.click(
    screen.getByRole("button", { name: "+ Condition (placeholder)" }),
  );
  expect(activate).toBeDisabled();
  fireEvent.click(
    screen.getByRole("button", { name: "Connect through condition" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Salvar alterações" }));
  await screen.findByText(/Desativada .* revisão 2/);
  expect(screen.getByRole("button", { name: "Ativar" })).toBeDisabled();
  vi.unstubAllGlobals();
});
