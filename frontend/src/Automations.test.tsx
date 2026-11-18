import { conditionDraft, defaultGraph } from "./workflow-graph";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import Automations from "./Automations";
import { runtimeStatus } from "./test-runtime-status-fixture";
import {
  definition,
  execution,
  listDefinitions,
  updateDefinition,
  validText,
  saveGraph,
  ValidationError,
  validationIssues,
} from "./automation-api";
const id = "11111111-1111-1111-1111-111111111111";
const eventId = "22222222-2222-2222-2222-222222222222";
const d = {
  id,
  scope: "tenant",
  revision: 1,
  name: "Receipt",
  active: false,
  schemaVersion: 1,
  trigger: { type: "receipt.v1" },
  action: { type: "record-receipt.v1" },
  graph: defaultGraph(),
  createdAt: "2026-01-01T00:00:00.000Z",
};
const x = {
  id,
  eventId,
  automationId: id,
  revision: 1,
  schemaVersion: 1,
  trigger: d.trigger,
  action: d.action,
  createdAt: d.createdAt,
  status: "accepted",
  retry: null,
  result: null,
};
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("automation response contracts", () => {
  it("distinguishes exact validation envelopes from ambiguous responses", async () => {
    const issues = [{ code: "invalid_topology", path: "/graph/edges" }];
    expect(validationIssues({ error: "validation_failed", issues })).toEqual(
      issues,
    );
    expect(
      validationIssues({ error: "validation_failed", issues, extra: true }),
    ).toBeNull();
    expect(
      validationIssues({
        error: "validation_failed",
        issues: [{ code: "bad", path: 1 }],
      }),
    ).toBeNull();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        response({ error: "validation_failed", issues }, 400),
      )
      .mockResolvedValueOnce(response({ error: "other" }, 400));
    await expect(
      saveGraph(definition(d), d.graph, new AbortController().signal),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      saveGraph(definition(d), d.graph, new AbortController().signal),
    ).rejects.not.toBeInstanceOf(ValidationError);
    fetchMock.mockRestore();
  });
  it("accepts definition and execution payloads", () => {
    expect(definition(d)).toMatchObject({
      ...d,
      graphSource: "server",
    });
    expect(execution(x)).toEqual(x);
  });
  it.each([
    { ...d, revision: 0 },
    { ...d, active: "false" },
    { ...d, trigger: { type: "other" } },
    { ...d, createdAt: "yesterday" },
    { ...d, extra: true },
  ])("rejects malformed definition", (value) => {
    expect(() => definition(value)).toThrow();
  });
  it.each([
    "accepted",
    "completed",
    "retry_scheduled",
    "retry_released",
    "blocked",
  ])("accepts persisted status %s", (status) => {
    expect(execution({ ...x, status }).status).toBe(status);
  });
  it("rejects malformed execution and result", () => {
    expect(() => execution({ ...x, status: "running" })).toThrow();
    expect(() =>
      execution({
        ...x,
        result: { kind: "local-receipt.v1", eventId: id, message: "m" },
      }),
    ).toThrow();
  });
  it("checks strings for blank, NUL and surrogates", () => {
    expect(validText(" ", 200)).toBe(false);
    expect(validText("a\0", 200)).toBe(false);
    expect(validText("\ud800", 200)).toBe(false);
    expect(validText("receipt", 200)).toBe(true);
  });
  it("rejects mismatched scope in list and reports conflicts", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(response({ items: [d] }))
        .mockResolvedValueOnce(response({}, 409)),
    );
    await expect(
      listDefinitions("other", new AbortController().signal),
    ).rejects.toThrow();
    await expect(
      updateDefinition(
        d as Parameters<typeof updateDefinition>[0],
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    vi.unstubAllGlobals();
  });
});
describe("automation screens", () => {
  it("restores focus to the details heading after a successful error reload", async () => {
    let detailCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).endsWith("/runtime/status"))
        return response(runtimeStatus("unknown"));
      if (String(url).includes("/executions?")) return response({ items: [] });
      return ++detailCalls === 1 ? response({}, 503) : response(d);
    });
    render(<Automations route={`#automations/${id}`} />);
    const heading = screen.getByRole("heading", {
      name: "Detalhes da automação",
    });
    expect(heading).not.toHaveFocus();
    const reload = await screen.findByRole("button", { name: "Recarregar" });
    reload.focus();
    expect(reload).toHaveFocus();
    fireEvent.click(reload);
    await screen.findByRole("button", { name: "Ativar" });
    expect(heading).toHaveFocus();
  });
  it.each([
    [409, "Conflito de revisão"],
    [503, "pode ter sido concluída"],
  ])(
    "preserves the condition workflow on toggle failure %i",
    async (status, text) => {
      const graph = conditionDraft(d.graph, false, {
        fieldPath: "data.value",
        operator: "exists",
      });
      const v2 = { ...d, schemaVersion: 2, graph };
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
        if (options?.method === "PUT") return response({}, status);
        return String(url).includes("/executions?")
          ? response({ items: [] })
          : response(v2);
      });
      vi.spyOn(window, "confirm").mockReturnValue(true);
      render(<Automations route={`#automations/${id}/builder`} />);
      const activate = await screen.findByRole("button", { name: "Ativar" });
      await waitFor(() => expect(activate).toBeEnabled());
      fireEvent.click(activate);
      expect(await screen.findByRole("alert")).toHaveTextContent(text);
      expect(screen.getByRole("button", { name: "Ativar" })).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Condição" }),
      ).toBeInTheDocument();
    },
  );
  it("blocks activation for dirty and incomplete condition drafts, then activates after saving", async () => {
    let server = { ...d };
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, options) => {
        if (options?.method === "PUT") {
          const body = JSON.parse(String(options.body));
          server = {
            ...server,
            active: body.active,
            schemaVersion: body.schemaVersion,
            graph: body.graph,
            revision: server.revision + 1,
          };
          return response(server);
        }
        return String(url).includes("/executions?")
          ? response({ items: [] })
          : response(server);
      });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Automations route={`#automations/${id}/builder`} />);
    await screen.findByRole("button", {
      name: "Usar condição guiada",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Usar condição guiada" }),
    );
    expect(screen.getByRole("button", { name: "Ativar" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Campo do evento"), {
      target: { value: "" },
    });
    expect(screen.getByRole("button", { name: "Ativar" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Salvar alterações" }),
    ).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Campo do evento"), {
      target: { value: "data.value" },
    });
    expect(screen.getByRole("button", { name: "Ativar" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Salvar alterações" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Ativar" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Ativar" }));
    await screen.findByRole("button", { name: "Desativar" });
    const writes = fetcher.mock.calls.filter(
      ([, options]) => options?.method === "PUT",
    );
    const saved = JSON.parse(String(writes[0][1]?.body));
    expect(JSON.parse(String(writes[1][1]?.body))).toEqual({
      ...saved,
      active: true,
      expectedRevision: 2,
    });
  });
  it("activates a saved condition graph and displays a disabled-writes rejection", async () => {
    const graph = conditionDraft(d.graph, false, {
      fieldPath: "data.value",
      operator: "exists",
    });
    const v2 = { ...d, schemaVersion: 2, graph };
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, options) => {
        if (options?.method === "PUT")
          return response(
            {
              error: "validation_failed",
              issues: [{ code: "conditions_disabled", path: "/graph" }],
            },
            400,
          );
        return String(url).includes("/executions?")
          ? response({ items: [] })
          : response(v2);
      });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Automations route={`#automations/${id}`} />);
    const activate = await screen.findByRole("button", { name: "Ativar" });
    await waitFor(() => expect(activate).toBeEnabled());
    fireEvent.click(activate);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "edição de condições está indisponível",
    );
    const write = fetcher.mock.calls.find(
      ([, options]) => options?.method === "PUT",
    );
    expect(JSON.parse(String(write?.[1]?.body))).toEqual({
      expectedRevision: 1,
      active: true,
      name: d.name,
      schemaVersion: 2,
      trigger: d.trigger,
      action: d.action,
      graph,
    });
  });
  it("treats an old server definition as a read-only preview", async () => {
    const legacy: Partial<typeof d> = { ...d };
    delete legacy.graph;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url).includes("/executions?")
        ? response({ items: [] })
        : response(legacy),
    );
    render(<Automations route={`#automations/${id}/builder`} />);
    expect(
      await screen.findByText(/server does not support graph persistence/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Salvar alterações" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "+ Condition (placeholder)" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: /Ativar/ })).toBeDisabled();
  });
  it("loads an unscoped empty dashboard", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({ items: [], nextCursor: null })),
    );
    render(<Automations route="#automations" />);
    expect(
      await screen.findByText("Crie sua primeira automação"),
    ).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
  it("validates creation and sends fixed inactive definition", async () => {
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/runtime/status"))
        return response({
          ...runtimeStatus(),
          capabilities: {
            ...runtimeStatus().capabilities,
            conditionsWrites: true,
          },
        });
      const body = JSON.parse(String(options?.body));
      return response({ ...d, ...body, active: false }, 201);
    });
    vi.stubGlobal("fetch", fetcher);
    render(<Automations route="#automations/create" />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Criar desativada" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Criar desativada" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Informe um nome válido",
    );
    expect(screen.getByLabelText("Nome da automação")).toHaveFocus();
    expect(
      screen.getByLabelText("Nome da automação"),
    ).toHaveAccessibleDescription(/Informe um nome válido/);
    fireEvent.change(screen.getByLabelText("Nome da automação"), {
      target: { value: "tenant" },
    });
    fireEvent.change(screen.getByLabelText("Nome da automação"), {
      target: { value: "Receipt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Criar desativada" }));
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(([, options]) => options?.method === "POST"),
      ).toBe(true),
    );
    expect(
      JSON.parse(
        String(
          fetcher.mock.calls.find(
            ([, options]) => options?.method === "POST",
          )![1]?.body,
        ),
      ),
    ).toEqual({
      scope: "local",
      name: "Receipt",
      schemaVersion: 2,
      graph: conditionDraft(defaultGraph(), false, {
        fieldPath: "message",
        operator: "contains",
        expectedType: "string",
        expectedValue: "pedido",
      }),
      trigger: d.trigger,
      action: d.action,
    });
    vi.unstubAllGlobals();
  });
  it("renders history and event link then shows revision conflict", async () => {
    let historyCalls = 0;
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
      if (
        url.endsWith("/runtime/status") &&
        (options?.method ?? "GET") === "GET"
      )
        return response(runtimeStatus("unknown"));
      if (url.includes("/executions?") && (options?.method ?? "GET") === "GET")
        return response({ items: historyCalls++ === 0 ? [x] : [] });
      if (url.endsWith(`/automations/${id}`)) {
        if (options?.method === "PUT") return response({}, 409);
        if ((options?.method ?? "GET") === "GET") return response(d);
      }
      throw new Error(`Unexpected request ${options?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Automations route={`#automations/${id}`} />);
    expect(await screen.findByText("Recebida")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Abrir evento" })).toHaveAttribute(
      "href",
      `#explorer?eventId=${eventId}`,
    );
    fireEvent.click(screen.getByRole("button", { name: "Ativar" }));
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining("revisão 1"),
    );
    expect(await screen.findByText(/Conflito de revisão/)).toBeInTheDocument();
    const write = fetcher.mock.calls.find(
      ([, options]) => options?.method === "PUT",
    );
    expect(JSON.parse(String(write?.[1]?.body))).toMatchObject({
      active: true,
      expectedRevision: 1,
    });
    fireEvent.click(screen.getByRole("button", { name: "Recarregar" }));
    expect(await screen.findByRole("button", { name: "Ativar" })).toBeEnabled();
    vi.unstubAllGlobals();
  });
  it("requests scope during creation and aborts a pending mutation on navigation", async () => {
    const fetcher = vi.fn((url: string, options?: RequestInit) => {
      if (url.endsWith("/runtime/status"))
        return Promise.resolve(
          response({
            ...runtimeStatus(),
            capabilities: {
              ...runtimeStatus().capabilities,
              conditionsWrites: true,
            },
          }),
        );
      if (options?.method === "POST") return new Promise<Response>(() => {});
      if (url.includes("executions"))
        return Promise.resolve(response({ items: [] }));
      if (url.includes(id)) return Promise.resolve(response(d));
      return Promise.resolve(response({ items: [], nextCursor: null }));
    });
    vi.stubGlobal("fetch", fetcher);
    const { rerender } = render(<Automations route="#automations" />);
    await screen.findByText("Crie sua primeira automação");
    rerender(<Automations route="#automations/create" />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Criar desativada" }),
      ).toBeEnabled(),
    );
    fireEvent.change(screen.getByLabelText("Nome da automação"), {
      target: { value: "tenant" },
    });
    fireEvent.change(screen.getByLabelText("Nome da automação"), {
      target: { value: "Receipt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Criar desativada" }));
    expect(
      JSON.parse(
        fetcher.mock.calls.find(
          ([, options]) => options?.method === "POST",
        )![1]!.body as string,
      ).scope,
    ).toBe("local");
    rerender(<Automations route={`#automations/${id}`} />);
    expect(await screen.findByRole("button", { name: "Ativar" })).toBeEnabled();
    rerender(<Automations route="#automations" />);
    expect(
      await screen.findByText("Crie sua primeira automação"),
    ).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
  it("reports malformed list response with retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({ items: [{}] })),
    );
    render(<Automations route="#automations" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Não foi possível carregar",
    );
    expect(
      screen.getByRole("button", { name: "Tentar novamente" }),
    ).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
