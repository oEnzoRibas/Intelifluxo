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

// This validator is intentionally not wired into writes until v3 database guards are installed.
export function validateGraphV3(
  value: unknown,
  trigger: string,
  action: string,
  shapeOnly = false,
): Issue[] {
  if (
    !object(value) ||
    !exact(value, ["version", "nodes", "edges"]) ||
    value.version !== 3 ||
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
        n.kind === "condition" || n.kind === "lookup"
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
      (n.kind === "condition" && n.type === "condition.v2") ||
      (n.kind === "lookup" && n.type === "viacep-address.v1") ||
      (n.kind === "action" && n.type === "record-receipt.v1") ||
      (n.kind === "end" && n.type === "end.v1")
    ))
      issues.push({ code: "unsupported_node_type", path, nodeId: n.id });
    if (n.kind === "lookup") {
      const cep =
        object(n.config) && exact(n.config, ["cep"]) ? n.config.cep : null;
      if (
        !object(cep) ||
        !(
          (cep.source === "fixed" && exact(cep, ["source", "value"])) ||
          (cep.source === "event" && exact(cep, ["source", "fieldPath"]))
        )
      )
        issues.push({
          code: "invalid_cep_config",
          path: `${path}/config`,
          nodeId: n.id,
        });
      else if (
        cep.source === "fixed" &&
        (typeof cep.value !== "string" ||
          !/^(?:[0-9]{8}|[0-9]{5}-[0-9]{3})(?![\s\S])/.test(cep.value))
      )
        issues.push({
          code: "invalid_cep",
          path: `${path}/config/cep/value`,
          nodeId: n.id,
        });
      else if (cep.source === "event" && !validFieldPath(cep.fieldPath))
        issues.push({
          code: "invalid_field_path",
          path: `${path}/config/cep/fieldPath`,
          nodeId: n.id,
        });
    }
    if (n.kind === "condition") {
      const config = n.config;
      const input = object(config) ? config.input : null;
      if (
        !object(input) ||
        !(
          (input.source === "event" && exact(input, ["source", "fieldPath"])) ||
          (input.source === "step" &&
            exact(input, ["source", "nodeId", "fieldPath"]) &&
            typeof input.nodeId === "string" &&
            id.test(input.nodeId))
        )
      )
        issues.push({
          code: "invalid_condition_input",
          path: `${path}/config/input`,
          nodeId: n.id,
        });
      else if (!validFieldPath(input.fieldPath))
        issues.push({
          code: "invalid_field_path",
          path: `${path}/config/input/fieldPath`,
          nodeId: n.id,
        });
      else if (object(config)) {
        const rest = { ...config };
        delete rest.input;
        const result = evaluateCondition(
          { ...rest, fieldPath: input.fieldPath },
          {},
        );
        if (
          Object.hasOwn(rest, "fieldPath") ||
          (!result.ok && result.code === "invalid_condition_config")
        )
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
  const [triggers, lookups, conditions, actions, ends] = [
    "trigger",
    "lookup",
    "condition",
    "action",
    "end",
  ].map(byKind);
  if (
    nodes.length !== 5 ||
    [triggers, lookups, conditions, actions, ends].some(
      (list) => list.length !== 1,
    )
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
    { source: triggers[0].id, target: lookups[0].id },
    { source: lookups[0].id, target: conditions[0].id },
    { source: conditions[0].id, sourcePort: "TRUE", target: actions[0].id },
    { source: conditions[0].id, sourcePort: "FALSE", target: ends[0].id },
    { source: actions[0].id, target: ends[0].id },
  ];
  if (
    edges.length !== 5 ||
    expected.some(
      (e) => !pairs.has(`${e.source}\0${e.sourcePort ?? ""}\0${e.target}`),
    )
  )
    return [{ code: "invalid_topology", path: "/graph/edges" }];
  const conditionIndex = value.nodes.findIndex(
    (n: unknown) => object(n) && n.id === conditions[0].id,
  );
  const condition = value.nodes[conditionIndex] as Record<string, unknown>;
  const config = condition.config as Record<string, unknown>;
  const input = config.input as Record<string, unknown>;
  if (input.source === "step" && input.nodeId !== lookups[0].id)
    return [
      {
        code: "invalid_step_reference",
        path: `/graph/nodes/${conditionIndex}/config/input/nodeId`,
        nodeId: conditions[0].id,
      },
    ];
  if (triggers[0].type !== trigger || actions[0].type !== action)
    return [{ code: "projection_mismatch", path: "/graph" }];
  return [];
}
