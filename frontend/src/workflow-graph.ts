import { exactKeys, object } from "./api";
import {
  conditionConfigValid,
  conditionGraphValid,
  type ConditionConfig,
  type ConditionGraph,
} from "./condition-contract";

export type GraphNode = {
  id: string;
  kind: "trigger" | "action" | "condition" | "end";
  type:
    | "receipt.v1"
    | "record-receipt.v1"
    | "condition-placeholder.v1"
    | "condition.v1"
    | "end.v1";
  position: { x: number; y: number };
  config?: ConditionConfig;
};
export type WorkflowGraph = {
  version: 1 | 2;
  nodes: GraphNode[];
  edges: { source: string; target: string; sourcePort?: "TRUE" | "FALSE" }[];
};

export function defaultGraph(): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      {
        id: "trigger",
        kind: "trigger",
        type: "receipt.v1",
        position: { x: 0, y: 0 },
      },
      {
        id: "action",
        kind: "action",
        type: "record-receipt.v1",
        position: { x: 320, y: 0 },
      },
    ],
    edges: [{ source: "trigger", target: "action" }],
  };
}

/** Explicit conversion only; never change an active definition. */
export function conditionDraft(
  graph: WorkflowGraph,
  active: boolean,
  config: ConditionConfig,
): ConditionGraph {
  if (
    active ||
    graph.version !== 1 ||
    !graphValid(graph) ||
    !conditionConfigValid(config)
  )
    throw new Error("Cannot convert graph");
  const trigger = graph.nodes.find((n) => n.kind === "trigger")!;
  const action = graph.nodes.find((n) => n.kind === "action")!;
  const used = new Set(graph.nodes.map((n) => n.id));
  const allocate = (base: string) => {
    let id = base,
      suffix = 1;
    while (used.has(id)) id = `${base}-${suffix++}`;
    used.add(id);
    return id;
  };
  const old = graph.nodes.find((n) => n.kind === "condition");
  const condition = {
    id: old?.id ?? allocate("condition"),
    kind: "condition" as const,
    type: "condition.v1" as const,
    position: old ? { ...old.position } : { x: 160, y: 140 },
    config: { ...config },
  };
  const end = {
    id: allocate("end"),
    kind: "end" as const,
    type: "end.v1" as const,
    position: { x: 640, y: 0 },
  };
  const result: ConditionGraph = {
    version: 2,
    nodes: [
      { ...trigger, type: "receipt.v1", position: { ...trigger.position } },
      condition,
      {
        ...action,
        type: "record-receipt.v1",
        position: { ...action.position },
      },
      end,
    ],
    edges: [
      { source: trigger.id, target: condition.id },
      { source: condition.id, sourcePort: "TRUE", target: action.id },
      { source: condition.id, sourcePort: "FALSE", target: end.id },
      { source: action.id, target: end.id },
    ],
  };
  if (!conditionGraphValid(result)) throw new Error("Cannot convert graph");
  return result;
}

/** Strictly accept only complete v1 paths. Unknown future graphs fail closed. */
export function graphValid(
  value: unknown,
  active = false,
): value is WorkflowGraph {
  if (object(value) && value.version === 2) return conditionGraphValid(value);
  if (
    !object(value) ||
    !exactKeys(value, ["version", "nodes", "edges"]) ||
    value.version !== 1 ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges) ||
    value.nodes.length < 2 ||
    value.nodes.length > 3 ||
    value.edges.length !== value.nodes.length - 1
  )
    return false;
  const nodes = value.nodes;
  const pairs: Record<string, string> = {
    trigger: "receipt.v1",
    action: "record-receipt.v1",
    condition: "condition-placeholder.v1",
  };
  if (
    !nodes.every((node: unknown) => {
      if (
        !object(node) ||
        !exactKeys(node, ["id", "kind", "type", "position"]) ||
        typeof node.id !== "string" ||
        !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(node.id) ||
        typeof node.kind !== "string" ||
        !Object.hasOwn(pairs, node.kind) ||
        node.type !== pairs[node.kind] ||
        !object(node.position) ||
        !exactKeys(node.position, ["x", "y"])
      )
        return false;
      return [node.position.x, node.position.y].every(
        (n) =>
          typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 10000,
      );
    })
  )
    return false;
  const typed = nodes as GraphNode[];
  if (
    new Set(typed.map((n) => n.id)).size !== typed.length ||
    typed.filter((n) => n.kind === "trigger").length !== 1 ||
    typed.filter((n) => n.kind === "action").length !== 1 ||
    typed.filter((n) => n.kind === "condition").length > 1 ||
    (active && typed.some((n) => n.kind === "condition"))
  )
    return false;
  const trigger = typed.find((n) => n.kind === "trigger")!;
  const action = typed.find((n) => n.kind === "action")!;
  const condition = typed.find((n) => n.kind === "condition");
  const expected = condition
    ? [
        [trigger.id, condition.id],
        [condition.id, action.id],
      ]
    : [[trigger.id, action.id]];
  return (
    value.edges.every(
      (edge: unknown) =>
        object(edge) &&
        exactKeys(edge, ["source", "target"]) &&
        typeof edge.source === "string" &&
        typeof edge.target === "string" &&
        expected.some(
          ([source, target]) =>
            edge.source === source && edge.target === target,
        ),
    ) &&
    new Set(
      value.edges.map((e: { source: string; target: string }) =>
        JSON.stringify([e.source, e.target]),
      ),
    ).size === expected.length
  );
}
