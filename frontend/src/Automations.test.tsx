import { defaultGraph } from "./workflow-graph";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import Automations from "./Automations";
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
  it("keeps a dirty builder mounted when retrying history", async () => {
    let historyCalls = 0;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) => {
        if (String(url).includes("/executions?"))
          return ++historyCalls === 1
            ? response({}, 503)
            : response({ items: [] });
        return response(d);
      });
    render(<Automations route={`#automations/${id}`} />);
    await screen.findByRole("button", { name: "+ Condition (placeholder)" });
    fireEvent.click(
      screen.getByRole("button", { name: "+ Condition (placeholder)" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await screen.findByText("No executions yet.");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(
      screen.getByText("Condition is a placeholder and blocks activation."),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(
        ([url]) => !String(url).includes("/executions?"),
      ).length,
    ).toBe(1);
  });
  it("treats an old server definition as a read-only preview", async () => {
    const legacy: Partial<typeof d> = { ...d };
    delete legacy.graph;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url).includes("/executions?")
        ? response({ items: [] })
        : response(legacy),
    );
    render(<Automations route={`#automations/${id}`} />);
    expect(
      await screen.findByText(/server does not support graph persistence/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save workflow" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "+ Condition (placeholder)" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: /Activate/ })).toBeDisabled();
  });
  it("loads scoped empty list and exposes accessible scope", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ items: [] })));
    render(<Automations route="#automations" />);
    fireEvent.change(screen.getByLabelText("Scope"), {
      target: { value: "tenant" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Load automations" }));
    expect(await screen.findByText("No automations yet.")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
  it("validates creation and sends fixed inactive definition", async () => {
    const fetcher = vi.fn().mockResolvedValue(response(d, 201));
    vi.stubGlobal("fetch", fetcher);
    render(<Automations route="#automations/create" />);
    fireEvent.click(
      screen.getByRole("button", { name: "Create inactive automation" }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid");
    expect(screen.getByLabelText("Scope (required)")).toHaveFocus();
    expect(
      screen.getByLabelText("Scope (required)"),
    ).toHaveAccessibleDescription(/Enter a valid/);
    fireEvent.change(screen.getByLabelText("Scope (required)"), {
      target: { value: "tenant" },
    });
    fireEvent.change(screen.getByLabelText("Name (required)"), {
      target: { value: "Receipt" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create inactive automation" }),
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      scope: "tenant",
      name: "Receipt",
      schemaVersion: 1,
      trigger: d.trigger,
      action: d.action,
    });
    vi.unstubAllGlobals();
  });
  it("renders history and event link then shows revision conflict", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(d))
      .mockResolvedValueOnce(response({ items: [x] }))
      .mockResolvedValueOnce(response({}, 409))
      .mockResolvedValueOnce(response(d))
      .mockResolvedValueOnce(response({ items: [] }));
    vi.stubGlobal("fetch", fetcher);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Automations route={`#automations/${id}`} />);
    expect(await screen.findByText("accepted")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: eventId })).toHaveAttribute(
      "href",
      `#explorer?eventId=${eventId}`,
    );
    fireEvent.click(screen.getByRole("button", { name: "Activate" }));
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining("revision 1"),
    );
    expect(await screen.findByText(/Revision conflict/)).toBeInTheDocument();
    expect(JSON.parse(fetcher.mock.calls[2][1].body)).toMatchObject({
      active: true,
      expectedRevision: 1,
    });
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(
      await screen.findByRole("button", { name: "Activate" }),
    ).toBeEnabled();
    vi.unstubAllGlobals();
  });
  it("keeps the reviewed scope through creation and navigation, including an aborted pending mutation", async () => {
    const fetcher = vi.fn((url: string, options?: RequestInit) => {
      if (options?.method === "POST") return new Promise<Response>(() => {});
      if (url.includes("executions"))
        return Promise.resolve(response({ items: [] }));
      if (url.includes(id)) return Promise.resolve(response(d));
      return Promise.resolve(response({ items: [] }));
    });
    vi.stubGlobal("fetch", fetcher);
    const { rerender } = render(<Automations route="#automations" />);
    fireEvent.change(screen.getByLabelText("Scope"), {
      target: { value: "tenant" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Load automations" }));
    await screen.findByText("No automations yet.");
    fireEvent.change(screen.getByLabelText("Scope"), {
      target: { value: "unreviewed" },
    });
    fireEvent.click(screen.getByRole("link", { name: "Create Automation" }));
    rerender(<Automations route="#automations/create" />);
    expect(screen.getByLabelText("Scope (required)")).toHaveValue("tenant");
    fireEvent.change(screen.getByLabelText("Name (required)"), {
      target: { value: "Receipt" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create inactive automation" }),
    );
    expect(
      JSON.parse(
        fetcher.mock.calls.find(
          ([, options]) => options?.method === "POST",
        )![1]!.body as string,
      ).scope,
    ).toBe("tenant");
    rerender(<Automations route={`#automations/${id}`} />);
    expect(
      await screen.findByRole("button", { name: "Activate" }),
    ).toBeEnabled();
    rerender(<Automations route="#automations" />);
    expect(
      await screen.findByText("Automations in tenant"),
    ).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
  it("reports malformed list response with retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({ items: [{}] })),
    );
    render(<Automations route="#automations" />);
    fireEvent.change(screen.getByLabelText("Scope"), {
      target: { value: "tenant" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Load automations" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "unexpected response",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
