import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  useViewport,
  type NodeProps,
  type Node,
  MarkerType,
  ReactFlow,
  type Connection,
  type NodeChange,
  type EdgeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import { edgeIdentity } from "./condition-contract";
import {
  ConflictError,
  ValidationError,
  getDefinition,
  saveGraph,
  type Definition,
  type ValidationIssue,
} from "./automation-api";
import {
  defaultGraph,
  graphValid,
  type GraphNode,
  type WorkflowGraph,
} from "./workflow-graph";

type BuilderNode = Node<
  {
    label: React.ReactNode;
    kind: GraphNode["kind"];
    version: WorkflowGraph["version"];
  },
  "builder"
>;

function CanvasNode({ data }: NodeProps<BuilderNode>) {
  const { zoom } = useViewport();
  const style = { "--port-hit-size": `${44 / zoom}px` } as React.CSSProperties;
  return (
    <div>
      {data.kind !== "trigger" && (
        <Handle type="target" position={Position.Top} style={style} />
      )}
      {data.label}
      {data.kind === "condition" && data.version === 2 ? (
        <>
          <Handle
            id="TRUE"
            type="source"
            position={Position.Bottom}
            style={{ ...style, left: "30%" }}
            aria-label="TRUE output"
          />
          <Handle
            id="FALSE"
            type="source"
            position={Position.Bottom}
            style={{ ...style, left: "70%" }}
            aria-label="FALSE output"
          />
        </>
      ) : data.kind !== "end" &&
        (data.kind !== "action" || data.version === 2) ? (
        <Handle type="source" position={Position.Bottom} style={style} />
      ) : null}
    </div>
  );
}
const nodeTypes = { builder: CanvasNode };

function useMedia(query: string) {
  const [matches, setMatches] = useState(
    () => window.matchMedia?.(query).matches ?? false,
  );
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export const nodeLabel = (node: GraphNode) =>
  node.kind === "trigger"
    ? "Receipt Trigger"
    : node.kind === "action"
      ? "Record Receipt Action"
      : node.kind === "end"
        ? "End"
        : node.type === "condition.v1"
          ? "Condition"
          : "Condition · not executable";
export function flowNodes(graph: WorkflowGraph) {
  return graph.nodes.map((n) => ({
    id: n.id,
    position: n.position,
    data: {
      kind: n.kind,
      version: graph.version,
      label: (
        <>
          <span className="builder-node-type">
            {n.kind === "trigger"
              ? "01 / TRIGGER"
              : n.kind === "action"
                ? "02 / ACTION"
                : n.kind === "end"
                  ? "04 / END"
                  : graph.version === 2
                    ? "02 / CONDITION"
                    : "◇ / PLANNED"}
          </span>
          <span className="builder-node-name">{nodeLabel(n)}</span>
          <span className="builder-node-id">{n.type}</span>
          <span className="builder-node-port-label">
            {n.kind === "trigger"
              ? "OUTPUT / RECEIPT"
              : n.kind === "action"
                ? "INPUT / RECEIPT"
                : n.kind === "end"
                  ? "INPUT"
                  : graph.version === 2
                    ? "TRUE / FALSE"
                    : "Blocks activation"}
          </span>
        </>
      ),
    },
    className: `builder-node builder-node--${n.kind}`,
    type: "builder" as const,
  }));
}
export function flowEdges(graph: WorkflowGraph) {
  return graph.edges.map((e) => ({
    ...e,
    id: edgeIdentity(e),
    sourceHandle: e.sourcePort,
    label: e.sourcePort,
    ariaLabel: `${e.source} to ${e.target}${e.sourcePort ? ` via ${e.sourcePort}` : ""}`,
    markerEnd: { type: MarkerType.ArrowClosed, color: "#b6d3ff" },
    type: "step",
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
  const mobile = useMedia("(max-width: 767px)");
  const tablet = useMedia("(min-width: 768px) and (max-width: 1279px)");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const libraryButton = useRef<HTMLButtonElement>(null);
  const libraryClose = useRef<HTMLButtonElement>(null);
  const inspectorDialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<WorkflowGraph>(definition.graph);
  const [baseline, setBaseline] = useState(definition);
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState("");
  const [nodeIssues, setNodeIssues] = useState<ValidationIssue[]>([]);
  const [locked, setLocked] = useState(false);
  useLayoutEffect(() => {
    const dialog = inspectorDialog.current;
    if (mobile && dialog && !dialog.open) dialog.showModal();
  }, [mobile, selected]);
  useEffect(() => {
    if (tablet && libraryOpen) libraryClose.current?.focus();
  }, [tablet, libraryOpen]);
  function closeLibrary() {
    setLibraryOpen(false);
    libraryButton.current?.focus();
  }
  const invoker = useRef<HTMLElement | null>(null);
  const focusAfterClose = useRef(false);
  const nodeListHeading = useRef<HTMLHeadingElement>(null);
  function selectNode(id: string, origin: HTMLElement) {
    invoker.current = origin;
    setSelected(id);
  }
  function closeInspector() {
    focusAfterClose.current = true;
    setSelected(null);
  }
  useLayoutEffect(() => {
    if (selected === null && focusAfterClose.current) {
      focusAfterClose.current = false;
      const target = invoker.current;
      if (target?.isConnected && !target.matches(":disabled")) target.focus();
      else nodeListHeading.current?.focus();
    }
  }, [selected, draft]);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const serializedDraft = JSON.stringify(draft);
  useEffect(() => setNodeIssues([]), [serializedDraft]);
  const dirty = serializedDraft !== JSON.stringify(baseline.graph);
  const persisted = baseline.graphSource !== "legacy-default";
  const v2 = draft.version === 2;
  const editable =
    persisted && !definition.active && !pending && !locked && !busy;
  const valid = graphValid(draft);
  useEffect(() => {
    onDirty(
      dirty || locked || pending || !graphValid(draft, true) || !persisted,
    );
  }, [dirty, locked, pending, draft, persisted, onDirty]);
  const nodes = useMemo(
    () =>
      flowNodes(draft).map((node) => ({
        ...node,
        selected: node.id === selected,
        domAttributes: {
          "aria-invalid":
            nodeIssues.some((issue) => issue.nodeId === node.id) || undefined,
          "aria-describedby":
            nodeIssues
              .map((issue, index) =>
                issue.nodeId === node.id ? `node-issue-${index}` : "",
              )
              .filter(Boolean)
              .join(" ") || undefined,
        },
        className: `${node.className}${nodeIssues.some((issue) => issue.nodeId === node.id) ? " builder-node--invalid" : ""}`,
      })),
    [draft, selected, nodeIssues],
  );
  const edges = useMemo(() => flowEdges(draft), [draft]);
  const chosen = draft.nodes.find((n) => n.id === selected);
  function add(kind: GraphNode["kind"]) {
    if (!editable || v2 || draft.nodes.some((n) => n.kind === kind)) return;
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
    if (!editable || v2 || !c.source || !c.target) return;
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
    const positions = changes.filter(
      (change): change is Extract<NodeChange, { type: "position" }> =>
        change.type === "position" && !!change.position,
    );
    if (!positions.length) return;
    setDraft((g) => {
      let changed = false;
      const nodes = g.nodes.map((n) => {
        const change = [...positions].reverse().find((c) => c.id === n.id);
        if (!change?.position) return n;
        const position = {
          x: Math.max(-10000, Math.min(10000, change.position.x)),
          y: Math.max(-10000, Math.min(10000, change.position.y)),
        };
        if (position.x === n.position.x && position.y === n.position.y)
          return n;
        changed = true;
        return { ...n, position };
      });
      return changed ? { ...g, nodes } : g;
    });
  }
  function edgeChanges(changes: EdgeChange[]) {
    if (!editable || v2) return;
    const removed = new Set(
      changes.filter((c) => c.type === "remove").map((c) => c.id),
    );
    if (removed.size)
      setDraft((g) => ({
        ...g,
        edges: g.edges.filter((e) => !removed.has(edgeIdentity(e))),
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
        setNodeIssues(
          err.issues.filter(
            (issue) =>
              issue.nodeId &&
              draft.nodes.some((node) => node.id === issue.nodeId),
          ),
        );
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
        if (e.key === "Escape" && libraryOpen && tablet) {
          e.stopPropagation();
          closeLibrary();
        } else if (e.key === "Escape" && selected && !mobile) closeInspector();
      }}
    >
      <div className="heading">
        <div>
          <h2>Visual Workflow Builder</h2>
          <p
            role="status"
            className={`builder-status ${dirty || pending || !persisted ? "builder-status--dirty" : "builder-status--saved"}`}
          >
            {pending
              ? "Saving or loading…"
              : dirty
                ? "Unsaved changes"
                : persisted
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
      {v2 && !definition.active && (
        <p>
          Condition workflow topology is fixed. Position changes can be saved.
        </p>
      )}
      {!persisted && (
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
      {nodeIssues.length > 0 && (
        <div aria-label="Node validation errors">
          <h3>Node validation errors</h3>
          {nodeIssues.map((issue, index) => (
            <p id={`node-issue-${index}`} key={`${issue.nodeId}-${index}`}>
              <button
                onClick={() =>
                  document.getElementById(`node-list-${issue.nodeId}`)?.focus()
                }
              >
                {draft.nodes.find((node) => node.id === issue.nodeId)
                  ? nodeLabel(
                      draft.nodes.find((node) => node.id === issue.nodeId)!,
                    )
                  : issue.nodeId}
                : {issue.code.replaceAll("_", " ")}
              </button>
            </p>
          ))}
        </div>
      )}
      {!valid && (
        <p role="status">
          Complete the directed path before saving: trigger → optional condition
          → action.
        </p>
      )}
      {!v2 && draft.nodes.some((n) => n.kind === "condition") && (
        <p>Condition is a placeholder and blocks activation.</p>
      )}
      <div className="builder-layout">
        <button
          ref={libraryButton}
          className="builder-library-open"
          aria-expanded={libraryOpen}
          aria-controls="builder-library"
          onClick={() => setLibraryOpen(true)}
        >
          Open node library
        </button>
        <aside
          id="builder-library"
          aria-label="Node library"
          className={`builder-palette${tablet && !libraryOpen ? " builder-palette--closed" : ""}`}
        >
          <button
            ref={libraryClose}
            className="builder-library-close"
            onClick={closeLibrary}
          >
            Close node library
          </button>
          <span className="builder-index">01 / LIBRARY</span>
          <h3>Available nodes</h3>
          <p>Add a node using the controls below.</p>
          <button
            disabled={
              !editable || v2 || draft.nodes.some((n) => n.kind === "trigger")
            }
            onClick={() => add("trigger")}
          >
            + Receipt Trigger
          </button>
          <button
            disabled={
              !editable || v2 || draft.nodes.some((n) => n.kind === "action")
            }
            onClick={() => add("action")}
          >
            + Record Receipt Action
          </button>
          <button
            disabled={
              !editable || v2 || draft.nodes.some((n) => n.kind === "condition")
            }
            onClick={() => add("condition")}
          >
            + Condition (placeholder)
          </button>
          <button disabled>ViaCEP · future</button>
          <h3>Accessible path controls</h3>
          {v2 && (
            <ul aria-label="Workflow connections">
              {draft.edges.map((edge) => (
                <li key={edgeIdentity(edge)}>
                  {nodeLabel(
                    draft.nodes.find((node) => node.id === edge.source)!,
                  )}{" "}
                  {edge.sourcePort ? `— ${edge.sourcePort} →` : "→"}{" "}
                  {nodeLabel(
                    draft.nodes.find((node) => node.id === edge.target)!,
                  )}
                </li>
              ))}
            </ul>
          )}
          <button
            disabled={!editable || v2}
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
              v2 ||
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
            disabled={!editable || v2 || draft.nodes.length !== 3}
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
        <div className="builder-workspace">
          <p className="builder-command">
            Canvas · {draft.nodes.length} nodes / {draft.edges.length}{" "}
            connections
          </p>
          <div className="builder-canvas">
            <ReactFlow
              nodeTypes={nodeTypes}
              nodes={nodes}
              edges={edges}
              onNodesChange={changes}
              onEdgesChange={edgeChanges}
              onConnect={connect}
              onNodeClick={(event, node) =>
                selectNode(node.id, event.currentTarget as HTMLElement)
              }
              nodesDraggable={editable}
              nodesConnectable={editable && !v2}
              edgesFocusable
              fitView
            >
              <Background
                gap={32}
                color="#253241"
                variant={BackgroundVariant.Lines}
              />
              <Controls />
            </ReactFlow>
          </div>
          <p>
            Drag nodes to move; drag the background to pan. Use the zoom and fit
            controls. Tab to nodes and press Enter to select; Escape closes the
            information panel. Use the buttons and node list as a non-drag
            alternative.
          </p>
          <h3 ref={nodeListHeading} tabIndex={-1}>
            Node list / no dragging
          </h3>
          {draft.nodes.length === 0 && (
            <p>No nodes. Add nodes or reset the path.</p>
          )}
          {draft.nodes.map((n) => (
            <button
              key={n.id}
              id={`node-list-${n.id}`}
              aria-invalid={
                nodeIssues.some((issue) => issue.nodeId === n.id) || undefined
              }
              aria-describedby={
                nodeIssues
                  .map((issue, index) =>
                    issue.nodeId === n.id ? `node-issue-${index}` : "",
                  )
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              onClick={(event) => selectNode(n.id, event.currentTarget)}
            >
              {nodeLabel(n)}
            </button>
          ))}
          {v2 && chosen && (
            <div aria-label="Move selected node without dragging">
              {(
                [
                  ["left", -20, 0],
                  ["right", 20, 0],
                  ["up", 0, -20],
                  ["down", 0, 20],
                ] as const
              ).map(([direction, x, y]) => (
                <button
                  key={direction}
                  disabled={!editable}
                  onClick={() =>
                    setDraft((g) => ({
                      ...g,
                      nodes: g.nodes.map((node) =>
                        node.id === chosen.id
                          ? {
                              ...node,
                              position: {
                                x: Math.max(
                                  -10000,
                                  Math.min(10000, node.position.x + x),
                                ),
                                y: Math.max(
                                  -10000,
                                  Math.min(10000, node.position.y + y),
                                ),
                              },
                            }
                          : node,
                      ),
                    }))
                  }
                >
                  Move {direction}
                </button>
              ))}
            </div>
          )}
        </div>
        {mobile ? (
          chosen && (
            <dialog
              ref={inspectorDialog}
              className="builder-info builder-inspector-dialog"
              aria-label="Node configuration"
              aria-modal="true"
              onCancel={(event) => {
                event.preventDefault();
                closeInspector();
              }}
            >
              <span className="builder-index">03 / INSPECTOR</span>
              <h3>Configuration</h3>
              {chosen ? (
                <>
                  <strong>{nodeLabel(chosen)}</strong>
                  <p>{chosen.type}</p>
                  <p>
                    Label is derived from the fixed type and cannot be edited.
                  </p>
                  <p>
                    Incoming connections:{" "}
                    {draft.edges.filter((e) => e.target === chosen.id).length}
                  </p>
                  <button onClick={closeInspector}>Close</button>
                  <button
                    disabled={!editable || v2}
                    onClick={() => {
                      setDraft((g) => ({
                        ...g,
                        nodes: g.nodes.filter((n) => n.id !== chosen.id),
                        edges: g.edges.filter(
                          (e) =>
                            e.source !== chosen.id && e.target !== chosen.id,
                        ),
                      }));
                      closeInspector();
                    }}
                  >
                    Remove node
                  </button>
                </>
              ) : (
                <p>Select a node for information.</p>
              )}
            </dialog>
          )
        ) : (
          <aside className="builder-info">
            <span className="builder-index">03 / INSPECTOR</span>
            <h3>Configuration</h3>
            {chosen ? (
              <>
                <strong>{nodeLabel(chosen)}</strong>
                <p>{chosen.type}</p>
                <p>
                  Label is derived from the fixed type and cannot be edited.
                </p>
                <p>
                  Incoming connections:{" "}
                  {draft.edges.filter((e) => e.target === chosen.id).length}
                </p>
                <button onClick={closeInspector}>Close</button>
                <button
                  disabled={!editable || v2}
                  onClick={() => {
                    setDraft((g) => ({
                      ...g,
                      nodes: g.nodes.filter((n) => n.id !== chosen.id),
                      edges: g.edges.filter(
                        (e) => e.source !== chosen.id && e.target !== chosen.id,
                      ),
                    }));
                    closeInspector();
                  }}
                >
                  Remove node
                </button>
              </>
            ) : (
              <p>Select a node for information.</p>
            )}
          </aside>
        )}
      </div>
    </section>
  );
}
