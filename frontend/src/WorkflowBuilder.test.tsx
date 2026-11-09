import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import WorkflowBuilder, { flowEdges, flowNodes } from "./WorkflowBuilder";
import { defaultGraph } from "./workflow-graph";
import type { Definition } from "./automation-api";

const d: Definition = {
  id: "11111111-1111-1111-1111-111111111111",
  scope: "tenant",
  revision: 1,
  name: "Receipt",
  active: false,
  schemaVersion: 1,
  trigger: { type: "receipt.v1" },
  action: { type: "record-receipt.v1" },
  createdAt: "2026-01-01T00:00:00Z",
  graph: defaultGraph(),
  graphSource: "server",
};
it("maps domain positions and directed edges without changing the graph", () => {
  const graph = defaultGraph();
  expect(flowNodes(graph)[1].position).toEqual({ x: 320, y: 0 });
  expect(flowEdges(graph)[0]).toMatchObject({
    source: "trigger",
    target: "action",
  });
  expect(graph).toEqual(defaultGraph());
});
it("constructs and saves a condition path with expected revision and blocks activation", async () => {
  const onDirty = vi.fn(),
    onSaved = vi.fn();
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          ...d,
          graphSource: undefined,
          graph: body.graph,
          revision: 2,
        }),
      );
    });
  render(
    <WorkflowBuilder definition={d} onDirty={onDirty} onSaved={onSaved} />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "+ Condition (placeholder)" }),
  );
  expect(screen.getByRole("button", { name: "Save workflow" })).toBeDisabled();
  fireEvent.click(
    screen.getByRole("button", { name: "Connect through condition" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
  expect(body.expectedRevision).toBe(1);
  expect(body.graph.edges).toEqual([
    { source: "trigger", target: "condition" },
    { source: "condition", target: "action" },
  ]);
  expect(onDirty).toHaveBeenLastCalledWith(true);
  fetchMock.mockRestore();
});

it("preserves a conflicted draft until confirmed reload, then adopts the server graph", async () => {
  const onSaved = vi.fn(),
    onDirty = vi.fn();
  const confirm = vi
    .spyOn(window, "confirm")
    .mockReturnValueOnce(false)
    .mockReturnValueOnce(true);
  const server = { ...d, revision: 3, graphSource: undefined };
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(null, { status: 409 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(server)));
  render(
    <WorkflowBuilder definition={d} onDirty={onDirty} onSaved={onSaved} />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "+ Condition (placeholder)" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Connect through condition" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Revision conflict",
  );
  expect(
    screen.getByText("Condition is a placeholder and blocks activation."),
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: /Reload server version/ }),
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(
    screen.getByText("Condition is a placeholder and blocks activation."),
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: /Reload server version/ }),
  );
  await waitFor(() =>
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 3 }),
    ),
  );
  expect(
    screen.queryByText("Condition is a placeholder and blocks activation."),
  ).not.toBeInTheDocument();
  expect(onDirty).toHaveBeenLastCalledWith(false);
  confirm.mockRestore();
  fetchMock.mockRestore();
});

it("reconciles an ambiguous write by explicitly reloading with GET", async () => {
  const onSaved = vi.fn();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValueOnce(new TypeError("network"))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ...d, graphSource: undefined, revision: 2 }),
      ),
    );
  render(
    <WorkflowBuilder definition={d} onDirty={vi.fn()} onSaved={onSaved} />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "+ Condition (placeholder)" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Connect through condition" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Save outcome is unknown",
  );
  expect(screen.getByRole("button", { name: "Save workflow" })).toBeDisabled();
  fireEvent.click(
    screen.getByRole("button", { name: /Reload server version/ }),
  );
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(fetchMock.mock.calls[1][1]?.method).toBe("GET");
  vi.restoreAllMocks();
});

it("supports non-drag removal, reconnection, reset and Escape from the node list", () => {
  render(
    <WorkflowBuilder definition={d} onDirty={vi.fn()} onSaved={vi.fn()} />,
  );
  const listButton = screen.getByRole("button", { name: "Receipt Trigger" });
  listButton.focus();
  expect(listButton).toHaveFocus();
  fireEvent.click(listButton);
  expect(screen.getByText("receipt.v1")).toBeInTheDocument();
  fireEvent.keyDown(listButton, { key: "Escape" });
  expect(
    screen.getByText("Select a node for information."),
  ).toBeInTheDocument();
  fireEvent.click(listButton);
  fireEvent.click(screen.getByRole("button", { name: "Remove node" }));

  expect(screen.getByText(/Complete the directed path/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "+ Receipt Trigger" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Connect trigger to action" }),
  );
  expect(
    screen.queryByText(/Complete the directed path/),
  ).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Reset to executable path" }),
  );
  expect(screen.getByRole("button", { name: "Save workflow" })).toBeDisabled();
});

it("saves an executable edit with the full payload and clears dirty state", async () => {
  const onDirty = vi.fn(),
    onSaved = vi.fn();
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          ...d,
          graphSource: undefined,
          graph: body.graph,
          revision: 2,
        }),
      );
    });
  render(
    <WorkflowBuilder definition={d} onDirty={onDirty} onSaved={onSaved} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Receipt Trigger" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove node" }));
  fireEvent.click(screen.getByRole("button", { name: "+ Receipt Trigger" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Connect trigger to action" }),
  );
  expect(onDirty).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));
  await waitFor(() =>
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 2 }),
    ),
  );
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
    expectedRevision: 1,
    active: false,
    name: d.name,
    schemaVersion: 1,
    trigger: d.trigger,
    action: d.action,
    graph: { ...defaultGraph(), nodes: [...defaultGraph().nodes].reverse() },
  });
  expect(onDirty).toHaveBeenLastCalledWith(false);
  expect(screen.getByRole("button", { name: "Save workflow" })).toBeDisabled();
  fetchMock.mockRestore();
});

it("ignores a save response after the builder unmounts", async () => {
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>((r) => {
    resolve = r;
  });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(pending);
  const onSaved = vi.fn();
  const view = render(
    <WorkflowBuilder definition={d} onDirty={vi.fn()} onSaved={onSaved} />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "+ Condition (placeholder)" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Connect through condition" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));
  const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
  view.unmount();
  expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  resolve(
    new Response(
      JSON.stringify({
        ...d,
        graphSource: undefined,
        revision: 2,
        graph: body.graph,
      }),
    ),
  );
  await pending;
  await waitFor(() => expect(onSaved).not.toHaveBeenCalled());
  fetchMock.mockRestore();
});

it("hydrates persisted IDs, positions and edges on a fresh mount", () => {
  const graph = defaultGraph();
  graph.nodes[0].id = "persisted-trigger";
  graph.nodes[1].id = "persisted-action";
  graph.nodes[0].position = { x: 57, y: -42 };
  graph.edges = [{ source: "persisted-trigger", target: "persisted-action" }];
  const view = render(
    <WorkflowBuilder
      definition={{ ...d, graph }}
      onDirty={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  expect(screen.getByTestId("rf__node-persisted-trigger")).toHaveStyle({
    transform: "translate(57px,-42px)",
  });
  expect(flowEdges(graph)[0]).toMatchObject({
    source: "persisted-trigger",
    target: "persisted-action",
  });
  view.unmount();
  render(
    <WorkflowBuilder
      definition={{ ...d, graph }}
      onDirty={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  expect(screen.getByTestId("rf__node-persisted-trigger")).toHaveStyle({
    transform: "translate(57px,-42px)",
  });
  expect(screen.getByText(/2 connections|1 connection/)).toBeInTheDocument();
});

it("reset preserves existing executable IDs and positions", async () => {
  const graph = defaultGraph();
  graph.nodes[0].id = "custom-trigger";
  graph.nodes[1].id = "custom-action";
  graph.nodes[0].position = { x: 33, y: 44 };
  graph.nodes[1].position = { x: 123, y: -45 };
  graph.nodes.push({
    id: "condition",
    kind: "condition",
    type: "condition-placeholder.v1",
    position: { x: 0, y: 0 },
  });
  graph.edges = [
    { source: "custom-trigger", target: "condition" },
    { source: "condition", target: "custom-action" },
  ];
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(null, { status: 503 }));
  render(
    <WorkflowBuilder
      definition={{ ...d, graph }}
      onDirty={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Reset to executable path" }),
  );
  expect(screen.getByTestId("rf__node-custom-trigger")).toHaveStyle({
    transform: "translate(33px,44px)",
  });
  expect(screen.getByTestId("rf__node-custom-action")).toHaveStyle({
    transform: "translate(123px,-45px)",
  });
  fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const result = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).graph;
  expect(result.nodes).toEqual(graph.nodes.slice(0, 2));
  expect(new Set(result.nodes.map((n: { id: string }) => n.id)).size).toBe(2);
  expect(result.edges).toEqual([
    { source: "custom-trigger", target: "custom-action" },
  ]);
  fetchMock.mockRestore();
});

it.each([
  {
    retained: "trigger",
    occupied: "action",
    removedLabel: "Record Receipt Action",
    source: "action",
    target: "action-1",
  },
  {
    retained: "action",
    occupied: "trigger",
    removedLabel: "Receipt Trigger",
    source: "trigger-1",
    target: "trigger",
  },
] as const)(
  "reset rebuilds a missing node when its default ID belongs to the retained $retained",
  async ({ retained, occupied, removedLabel, source, target }) => {
    const graph = defaultGraph();
    const kept = graph.nodes.find((n) => n.kind === retained)!;
    const removed = graph.nodes.find((n) => n.kind !== retained)!;
    kept.id = occupied;
    kept.position = { x: 71, y: -28 };
    removed.id = "other";
    graph.edges = [
      {
        source: retained === "trigger" ? occupied : "other",
        target: retained === "action" ? occupied : "other",
      },
    ];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 503 }));
    render(
      <WorkflowBuilder
        definition={{ ...d, graph }}
        onDirty={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: removedLabel }));
    fireEvent.click(screen.getByRole("button", { name: "Remove node" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Reset to executable path" }),
    );
    expect(screen.getByTestId(`rf__node-${occupied}`)).toHaveStyle({
      transform: "translate(71px,-28px)",
    });
    fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const result = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).graph;
    expect(result.nodes).toHaveLength(2);
    expect(new Set(result.nodes.map((n: { id: string }) => n.id)).size).toBe(2);
    expect(
      result.nodes.find((n: { kind: string }) => n.kind === retained),
    ).toEqual(kept);
    expect(result.edges).toEqual([{ source, target }]);
    fetchMock.mockRestore();
  },
);

it("keeps a rejected draft editable and dirty without reconciliation", async () => {
  const onDirty = vi.fn();
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        error: "validation_failed",
        issues: [{ code: "invalid_topology", path: "/graph/edges" }],
      }),
      { status: 400 },
    ),
  );
  render(
    <WorkflowBuilder definition={d} onDirty={onDirty} onSaved={vi.fn()} />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "+ Condition (placeholder)" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Connect through condition" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Invalid workflow path",
  );
  expect(screen.getByRole("button", { name: "Save workflow" })).toBeEnabled();
  expect(
    screen.queryByRole("button", { name: /Reload server version/ }),
  ).not.toBeInTheDocument();
  expect(onDirty).toHaveBeenLastCalledWith(true);
  fetchMock.mockRestore();
});
