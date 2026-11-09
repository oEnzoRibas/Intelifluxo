import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  type Connection,
  type NodeChange,
  type EdgeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ConflictError,
  ValidationError,
  getDefinition,
  saveGraph,
  type Definition,
} from "./automation-api";
import {
  defaultGraph,
  graphValid,
  type GraphNode,
  type WorkflowGraph,
} from "./workflow-graph";

export const nodeLabel = (node: GraphNode) =>
  node.kind === "trigger"
    ? "Receipt Trigger"
    : node.kind === "action"
      ? "Record Receipt Action"
      : "Condition · not executable";
export function flowNodes(graph: WorkflowGraph) {
  return graph.nodes.map((n) => ({
    id: n.id,
    position: n.position,
    data: { label: nodeLabel(n) },
    type:
      n.kind === "trigger"
        ? "input"
        : n.kind === "action"
          ? "output"
          : "default",
  }));
}
export function flowEdges(graph: WorkflowGraph) {
  return graph.edges.map((e) => ({
    ...e,
    id: `${e.source}->${e.target}`,
    markerEnd: { type: MarkerType.ArrowClosed },
  }));
}
export default function WorkflowBuilder({
  definition,
  onSaved,
  onDirty,
  busy = false,
}: {
  definition: Definition;
  onSaved: (d: Definition) => void;
  onDirty: (dirty: boolean) => void;
  busy?: boolean;
}) {
  const [draft, setDraft] = useState<WorkflowGraph>(definition.graph);
  const [baseline, setBaseline] = useState(definition);
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState("");
  const [locked, setLocked] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline.graph);
  const editable =
    baseline.graphSource === "server" &&
    !definition.active &&
    !pending &&
    !locked &&
    !busy;
  const valid = graphValid(draft);
  useEffect(() => {
    onDirty(
      dirty ||
        locked ||
        pending ||
        !graphValid(draft, true) ||
        baseline.graphSource !== "server",
    );
  }, [dirty, locked, pending, draft, baseline.graphSource, onDirty]);
  const nodes = useMemo(() => flowNodes(draft), [draft]);
  const edges = useMemo(() => flowEdges(draft), [draft]);
  const chosen = draft.nodes.find((n) => n.id === selected);
  function add(kind: GraphNode["kind"]) {
    if (!editable || draft.nodes.some((n) => n.kind === kind)) return;
    const n: GraphNode =
      kind === "trigger"
        ? { id: "trigger", kind, type: "receipt.v1", position: { x: 0, y: 0 } }
        : kind === "action"
          ? {
              id: "action",
              kind,
              type: "record-receipt.v1",
              position: { x: 320, y: 0 },
            }
          : {
              id: "condition",
              kind,
              type: "condition-placeholder.v1",
              position: { x: 160, y: 140 },
            };
    setDraft((g) => ({ ...g, nodes: [...g.nodes, n] }));
  }
  function connect(c: Connection) {
    if (!editable || !c.source || !c.target) return;
    const source = draft.nodes.find((n) => n.id === c.source),
      target = draft.nodes.find((n) => n.id === c.target);
    if (
      !source ||
      !target ||
      source.kind === "action" ||
      target.kind === "trigger" ||
      source.id === target.id ||
      (source.kind === "trigger" &&
        target.kind === "action" &&
        draft.nodes.some((n) => n.kind === "condition"))
    )
      return;
    setDraft((g) => ({
      ...g,
      edges: [
        ...g.edges.filter(
          (e) => e.source !== c.source && e.target !== c.target,
        ),
        { source: c.source!, target: c.target! },
      ],
    }));
  }
  function changes(changes: NodeChange[]) {
    if (!editable) return;
    setDraft((g) => ({
      ...g,
      nodes: g.nodes.map((n) => {
        const change = changes.find(
          (c) => c.type === "position" && c.id === n.id,
        );
        if (!change || change.type !== "position" || !change.position) return n;
        return {
          ...n,
          position: {
            x: Math.max(-10000, Math.min(10000, change.position.x)),
            y: Math.max(-10000, Math.min(10000, change.position.y)),
          },
        };
      }),
    }));
  }
  function edgeChanges(changes: EdgeChange[]) {
    if (!editable) return;
    const removed = new Set(
      changes.filter((c) => c.type === "remove").map((c) => c.id),
    );
    if (removed.size)
      setDraft((g) => ({
        ...g,
        edges: g.edges.filter((e) => !removed.has(`${e.source}->${e.target}`)),
      }));
  }
  async function save() {
    if (!editable || !valid || !dirty) return;
    setPending(true);
    setProblem("");
    const controller = new AbortController();
    request.current = controller;
    try {
      const updated = await saveGraph(baseline, draft, controller.signal);
      if (controller.signal.aborted) return;
      setBaseline(updated);
      setDraft(updated.graph);
      onSaved(updated);
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err instanceof ValidationError) {
        const labels: Record<string, string> = {
          invalid_shape: "Invalid graph or request shape",
          unsupported_graph_version: "Unsupported graph version",
          unsupported_node_type: "Unsupported node type",
          duplicate_node_id: "Duplicate node ID",
          dangling_edge: "Connection references a missing node",
          duplicate_edge: "Duplicate connection",
          self_edge: "Self connection",
          invalid_node_count: "Invalid number of nodes",
          cycle_detected: "Workflow contains a cycle",
          invalid_topology: "Invalid workflow path",
          projection_mismatch: "Workflow does not match the automation",
          non_executable_graph: "Workflow is not executable",
        };
        setProblem(
          `Server rejected the workflow: ${err.issues.map((issue) => labels[issue.code] ?? "Invalid workflow").join("; ")}. Your draft is preserved.`,
        );
        return;
      }
      setLocked(true);
      setProblem(
        err instanceof ConflictError
          ? "Revision conflict. Your draft is preserved. Reload the server version before editing again."
          : "Save outcome is unknown. Your draft is preserved; reload the server version before retrying.",
      );
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }
  async function reload() {
    if (
      !window.confirm("Reload the server version and discard your local draft?")
    )
      return;
    setPending(true);
    const controller = new AbortController();
    request.current = controller;
    try {
      const updated = await getDefinition(definition.id, controller.signal);
      if (controller.signal.aborted) return;
      setBaseline(updated);
      setDraft(updated.graph);
      onSaved(updated);
      setLocked(false);
      setProblem("");
    } catch {
      if (controller.signal.aborted) return;
      setProblem(
        "Could not reload. Your local draft remains available; try again.",
      );
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }
  return (
    <section
      className="panel builder"
      aria-label="Visual workflow builder"
      onKeyDown={(e) => {
        if (e.key === "Escape") setSelected(null);
      }}
    >
      <div className="heading">
        <div>
          <h2>Visual Workflow Builder</h2>
          <p role="status">
            {pending
              ? "Saving or loading…"
              : dirty
                ? "Unsaved changes"
                : baseline.graphSource === "server"
                  ? `Saved · revision ${baseline.revision}`
                  : "Preview · not persisted"}
          </p>
        </div>
        <button disabled={!editable || !dirty || !valid} onClick={save}>
          Save workflow
        </button>
      </div>
      {definition.active && (
        <p>Deactivate this automation before editing its workflow.</p>
      )}
      {baseline.graphSource !== "server" && (
        <p role="alert">
          This server does not support graph persistence. The workflow preview
          is read-only; upgrade the server to edit, save, or activate it.
        </p>
      )}
      {problem && (
        <div role="alert">
          <p>{problem}</p>
          {locked && (
            <button disabled={pending} onClick={reload}>
              Reload server version…
            </button>
          )}
        </div>
      )}
      {!valid && (
        <p role="status">
          Complete the directed path before saving: trigger → optional condition
          → action.
        </p>
      )}
      {draft.nodes.some((n) => n.kind === "condition") && (
        <p>Condition is a placeholder and blocks activation.</p>
      )}
      <div className="builder-layout">
        <aside className="builder-palette">
          <h3>Available nodes</h3>
          <button
            disabled={
              !editable || draft.nodes.some((n) => n.kind === "trigger")
            }
            onClick={() => add("trigger")}
          >
            + Receipt Trigger
          </button>
          <button
            disabled={!editable || draft.nodes.some((n) => n.kind === "action")}
            onClick={() => add("action")}
          >
            + Record Receipt Action
          </button>
          <button
            disabled={
              !editable || draft.nodes.some((n) => n.kind === "condition")
            }
            onClick={() => add("condition")}
          >
            + Condition (placeholder)
          </button>
          <button disabled>ViaCEP · future</button>
          <h3>Accessible path controls</h3>
          <button
            disabled={!editable}
            onClick={() =>
              setDraft((g) => {
                const defaults = defaultGraph();
                const retainedTrigger = g.nodes.find(
                  (n) => n.kind === "trigger",
                );
                const retainedAction = g.nodes.find((n) => n.kind === "action");
                const used = new Set(
                  [retainedTrigger, retainedAction]
                    .filter((n): n is GraphNode => n !== undefined)
                    .map((n) => n.id),
                );
                const rebuild = (node: GraphNode) => {
                  let id = node.id;
                  for (let suffix = 1; used.has(id); suffix++)
                    id = `${node.id}-${suffix}`;
                  used.add(id);
                  return { ...node, id };
                };
                const trigger = retainedTrigger ?? rebuild(defaults.nodes[0]);
                const action = retainedAction ?? rebuild(defaults.nodes[1]);
                return {
                  ...g,
                  nodes: [trigger, action],
                  edges: [{ source: trigger.id, target: action.id }],
                };
              })
            }
          >
            Reset to executable path
          </button>
          <button
            disabled={
              !editable ||
              draft.nodes.length !== 2 ||
              !draft.nodes.some((n) => n.kind === "trigger") ||
              !draft.nodes.some((n) => n.kind === "action")
            }
            onClick={() => {
              const t = draft.nodes.find((n) => n.kind === "trigger")!,
                a = draft.nodes.find((n) => n.kind === "action")!;
              setDraft((g) => ({
                ...g,
                edges: [{ source: t.id, target: a.id }],
              }));
            }}
          >
            Connect trigger to action
          </button>
          <button
            disabled={!editable || draft.nodes.length !== 3}
            onClick={() => {
              const t = draft.nodes.find((n) => n.kind === "trigger"),
                c = draft.nodes.find((n) => n.kind === "condition"),
                a = draft.nodes.find((n) => n.kind === "action");
              if (t && c && a)
                setDraft((g) => ({
                  ...g,
                  edges: [
                    { source: t.id, target: c.id },
                    { source: c.id, target: a.id },
                  ],
                }));
            }}
          >
            Connect through condition
          </button>
        </aside>
        <div>
          <p>
            Canvas · {draft.nodes.length} nodes / {draft.edges.length}{" "}
            connections
          </p>
          <div className="builder-canvas">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={changes}
              onEdgesChange={edgeChanges}
              onConnect={connect}
              onNodeClick={(_, node) => setSelected(node.id)}
              nodesDraggable={editable}
              nodesConnectable={editable}
              edgesFocusable
              fitView
            >
              <Background />
              <Controls />
            </ReactFlow>
          </div>
          <p>
            Drag nodes to move; drag the background to pan. Use the zoom and fit
            controls. Tab to nodes and press Enter to select; Escape closes the
            information panel. Use the buttons and node list as a non-drag
            alternative.
          </p>
          <h3>Node list</h3>
          {draft.nodes.length === 0 && (
            <p>No nodes. Add nodes or reset the path.</p>
          )}
          {draft.nodes.map((n) => (
            <button key={n.id} onClick={() => setSelected(n.id)}>
              {nodeLabel(n)}
            </button>
          ))}
        </div>
        <aside className="builder-info">
          <h3>Configuration</h3>
          {chosen ? (
            <>
              <strong>{nodeLabel(chosen)}</strong>
              <p>{chosen.type}</p>
              <p>Label is derived from the fixed type and cannot be edited.</p>
              <p>
                Incoming connections:{" "}
                {draft.edges.filter((e) => e.target === chosen.id).length}
              </p>
              <button onClick={() => setSelected(null)}>Close</button>
              <button
                disabled={!editable}
                onClick={() => {
                  setDraft((g) => ({
                    ...g,
                    nodes: g.nodes.filter((n) => n.id !== chosen.id),
                    edges: g.edges.filter(
                      (e) => e.source !== chosen.id && e.target !== chosen.id,
                    ),
                  }));
                  setSelected(null);
                }}
              >
                Remove node
              </button>
            </>
          ) : (
            <p>Select a node for information.</p>
          )}
        </aside>
      </div>
    </section>
  );
}
