export type GraphNode = {
  id: string;
  position: { x: number; y: number };
} & (
  | { kind: "trigger"; type: "receipt.v1" }
  | { kind: "action"; type: "record-receipt.v1" }
  | { kind: "condition"; type: "condition-placeholder.v1" }
);
export type Graph = {
  version: 1;
  nodes: GraphNode[];
  edges: { source: string; target: string }[];
};
export type Issue = {
  code: string;
  path: string;
  nodeId?: string;
  source?: string;
  target?: string;
};
export const defaultGraph = (): Graph => ({
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
});
const idPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const obj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
const sorted = (issues: Issue[]) =>
  issues.sort((a, b) => {
    for (const k of ["path", "code", "nodeId", "source", "target"] as const) {
      const x = a[k] ?? "",
        y = b[k] ?? "";
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  });
// Shape is checked before locking; semantic checks run only after revision conflict checks.
export function graphShape(value: unknown): Issue[] {
  if (!obj(value)) return [{ code: "invalid_shape", path: "/graph" }];
  if (Object.hasOwn(value, "version") && value.version !== 1)
    return [{ code: "unsupported_graph_version", path: "/graph/version" }];
  if (!exact(value, ["version", "nodes", "edges"]))
    return [{ code: "invalid_shape", path: "/graph" }];
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges))
    return [{ code: "invalid_shape", path: "/graph" }];
  const issues: Issue[] = [];
  value.nodes.forEach((n: unknown, i: number) => {
    const path = `/graph/nodes/${i}`;
    if (
      !obj(n) ||
      !exact(n, ["id", "kind", "type", "position"]) ||
      typeof n.id !== "string" ||
      !idPattern.test(n.id) ||
      typeof n.kind !== "string" ||
      typeof n.type !== "string" ||
      !obj(n.position) ||
      !exact(n.position, ["x", "y"]) ||
      ![n.position.x, n.position.y].every(
        (x) =>
          typeof x === "number" &&
          Number.isFinite(x) &&
          x >= -10000 &&
          x <= 10000,
      )
    ) {
      issues.push({ code: "invalid_shape", path });
      return;
    }
    if (!(
      (n.kind === "trigger" && n.type === "receipt.v1") ||
      (n.kind === "action" && n.type === "record-receipt.v1") ||
      (n.kind === "condition" && n.type === "condition-placeholder.v1")
    ))
      issues.push({ code: "unsupported_node_type", path, nodeId: n.id });
  });
  value.edges.forEach((e: unknown, i: number) => {
    if (
      !obj(e) ||
      !exact(e, ["source", "target"]) ||
      typeof e.source !== "string" ||
      !idPattern.test(e.source) ||
      typeof e.target !== "string" ||
      !idPattern.test(e.target)
    )
      issues.push({ code: "invalid_shape", path: `/graph/edges/${i}` });
  });
  return sorted(issues);
}
export function graphSemantics(
  graph: Graph,
  active: boolean,
  trigger: string,
  action: string,
): Issue[] {
  const issues: Issue[] = [];
  const ids = new Set<string>();
  graph.nodes.forEach((n, i) => {
    if (ids.has(n.id))
      issues.push({
        code: "duplicate_node_id",
        path: `/graph/nodes/${i}`,
        nodeId: n.id,
      });
    ids.add(n.id);
  });
  const pairs = new Set<string>();
  graph.edges.forEach((e, i) => {
    const path = `/graph/edges/${i}`,
      details = { source: e.source, target: e.target };
    const key = `${e.source}\0${e.target}`;
    if (!ids.has(e.source) || !ids.has(e.target))
      issues.push({ code: "dangling_edge", path, ...details });
    if (pairs.has(key))
      issues.push({ code: "duplicate_edge", path, ...details });
    pairs.add(key);
    if (e.source === e.target)
      issues.push({ code: "self_edge", path, ...details });
  });
  if (issues.length) return sorted(issues);
  const triggers = graph.nodes.filter((n) => n.kind === "trigger"),
    actions = graph.nodes.filter((n) => n.kind === "action"),
    conditions = graph.nodes.filter((n) => n.kind === "condition");
  if (
    triggers.length !== 1 ||
    actions.length !== 1 ||
    conditions.length > 1 ||
    graph.nodes.length < 2 ||
    graph.nodes.length > 3
  )
    return [{ code: "invalid_node_count", path: "/graph/nodes" }];
  const adj = new Map([...ids].sort().map((id) => [id, [] as string[]]));
  const indegree = new Map([...ids].map((id) => [id, 0]));
  for (const e of graph.edges) {
    adj.get(e.source)!.push(e.target);
    indegree.set(e.target, indegree.get(e.target)! + 1);
  }
  for (const list of adj.values()) list.sort();
  const degrees = new Map(indegree);
  const queue = [...ids].filter((id) => degrees.get(id) === 0).sort();
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!;
    visited++;
    for (const target of adj.get(id)!) {
      degrees.set(target, degrees.get(target)! - 1);
      if (degrees.get(target) === 0) {
        queue.push(target);
        queue.sort();
      }
    }
  }
  if (visited !== ids.size)
    return [{ code: "cycle_detected", path: "/graph/edges" }];
  if (
    graph.edges.length !== graph.nodes.length - 1 ||
    graph.nodes.some(
      (n) =>
        indegree.get(n.id) !== (n.kind === "trigger" ? 0 : 1) ||
        adj.get(n.id)!.length !== (n.kind === "action" ? 0 : 1),
    )
  )
    return [{ code: "invalid_topology", path: "/graph/edges" }];
  if (triggers[0].type !== trigger || actions[0].type !== action)
    return [{ code: "projection_mismatch", path: "/graph" }];
  if (active && conditions.length) {
    const i = graph.nodes.indexOf(conditions[0]);
    return [
      {
        code: "non_executable_graph",
        path: `/graph/nodes/${i}`,
        nodeId: conditions[0].id,
      },
    ];
  }
  return [];
}
