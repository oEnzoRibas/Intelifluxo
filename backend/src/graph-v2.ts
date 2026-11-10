import { evaluateCondition, validFieldPath } from "./condition.js";
import type { Issue } from "./graph.js";

const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
const id = /^[A-Za-z][A-Za-z0-9_-]{0,63}(?![\s\S])/;
const sort = (issues: Issue[]) =>
  issues.sort((a, b) => {
    for (const key of ["path", "code", "nodeId", "source", "target"] as const) {
      const x = a[key] ?? "",
        y = b[key] ?? "";
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  });

// Kept separate from v1 until the v2 persistence guard and write gate are installed.
export function validateGraphV2(
  value: unknown,
  trigger: string,
  action: string,
  shapeOnly = false,
): Issue[] {
  if (
    !object(value) ||
    !exact(value, ["version", "nodes", "edges"]) ||
    value.version !== 2 ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges)
  )
    return [{ code: "invalid_shape", path: "/graph" }];
  const issues: Issue[] = [];
  const nodes: { id: string; kind: string; type: string }[] = [];
  const edges: { source: string; target: string; sourcePort?: string }[] = [];
  value.nodes.forEach((n: unknown, i: number) => {
    const path = `/graph/nodes/${i}`;
    if (
      !object(n) ||
      !exact(
        n,
        n.kind === "condition"
          ? ["id", "kind", "type", "position", "config"]
          : ["id", "kind", "type", "position"],
      ) ||
      typeof n.id !== "string" ||
      !id.test(n.id) ||
      typeof n.kind !== "string" ||
      typeof n.type !== "string" ||
      !object(n.position) ||
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
      (n.kind === "condition" && n.type === "condition.v1") ||
      (n.kind === "action" && n.type === "record-receipt.v1") ||
      (n.kind === "end" && n.type === "end.v1")
    ))
      issues.push({ code: "unsupported_node_type", path, nodeId: n.id });
    if (n.kind === "condition") {
      if (object(n.config) && !validFieldPath(n.config.fieldPath))
        issues.push({
          code: "invalid_field_path",
          path: `${path}/config/fieldPath`,
          nodeId: n.id,
        });
      else {
        const result = evaluateCondition(n.config, {});
        if (!result.ok && result.code === "invalid_condition_config")
          issues.push({
            code: "invalid_condition_config",
            path: `${path}/config`,
            nodeId: n.id,
          });
      }
    }
    nodes.push({ id: n.id, kind: n.kind, type: n.type });
  });
  value.edges.forEach((e: unknown, i: number) => {
    const path = `/graph/edges/${i}`;
    if (
      !object(e) ||
      !exact(
        e,
        Object.hasOwn(e, "sourcePort")
          ? ["source", "target", "sourcePort"]
          : ["source", "target"],
      ) ||
      typeof e.source !== "string" ||
      !id.test(e.source) ||
      typeof e.target !== "string" ||
      !id.test(e.target)
    ) {
      issues.push({ code: "invalid_shape", path });
      return;
    }
    if (
      Object.hasOwn(e, "sourcePort") &&
      e.sourcePort !== "TRUE" &&
      e.sourcePort !== "FALSE"
    ) {
      issues.push({ code: "invalid_source_port", path: `${path}/sourcePort` });
      return;
    }
    edges.push({
      source: e.source,
      target: e.target,
      ...(typeof e.sourcePort === "string" ? { sourcePort: e.sourcePort } : {}),
    });
  });
  if (issues.length || shapeOnly) return sort(issues);
  const ids = new Set<string>();
  nodes.forEach((n, i) => {
    if (ids.has(n.id))
      issues.push({
        code: "duplicate_node_id",
        path: `/graph/nodes/${i}`,
        nodeId: n.id,
      });
    ids.add(n.id);
  });
  const pairs = new Set<string>();
  edges.forEach((e, i) => {
    const path = `/graph/edges/${i}`,
      details = { source: e.source, target: e.target };
    if (!ids.has(e.source) || !ids.has(e.target))
      issues.push({ code: "dangling_edge", path, ...details });
    if (e.source === e.target)
      issues.push({ code: "self_edge", path, ...details });
    const key = `${e.source}\0${e.sourcePort ?? ""}\0${e.target}`;
    if (pairs.has(key))
      issues.push({ code: "duplicate_edge", path, ...details });
    pairs.add(key);
  });
  if (issues.length) return sort(issues);
  const byKind = (kind: string) => nodes.filter((n) => n.kind === kind);
  const [triggers, conditions, actions, ends] = [
    "trigger",
    "condition",
    "action",
    "end",
  ].map(byKind);
  if (
    nodes.length !== 4 ||
    [triggers, conditions, actions, ends].some((list) => list.length !== 1)
  )
    return [{ code: "invalid_node_count", path: "/graph/nodes" }];
  const adj = new Map(nodes.map((n) => [n.id, [] as string[]]));
  const degree = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) {
    adj.get(e.source)!.push(e.target);
    degree.set(e.target, degree.get(e.target)! + 1);
  }
  const queue = nodes.filter((n) => degree.get(n.id) === 0).map((n) => n.id);
  let visited = 0;
  while (queue.length) {
    const current = queue.shift()!;
    visited++;
    for (const target of adj.get(current)!) {
      degree.set(target, degree.get(target)! - 1);
      if (degree.get(target) === 0) queue.push(target);
    }
  }
  if (visited !== nodes.length)
    return [{ code: "cycle_detected", path: "/graph/edges" }];
  const expected = [
    { source: triggers[0].id, target: conditions[0].id },
    { source: conditions[0].id, sourcePort: "TRUE", target: actions[0].id },
    { source: conditions[0].id, sourcePort: "FALSE", target: ends[0].id },
    { source: actions[0].id, target: ends[0].id },
  ];
  if (
    edges.length !== 4 ||
    expected.some(
      (e) => !pairs.has(`${e.source}\0${e.sourcePort ?? ""}\0${e.target}`),
    )
  )
    return [{ code: "invalid_topology", path: "/graph/edges" }];
  if (triggers[0].type !== trigger || actions[0].type !== action)
    return [{ code: "projection_mismatch", path: "/graph" }];
  return [];
}
