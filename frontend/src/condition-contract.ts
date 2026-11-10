import { exactKeys, object } from "./api";

export type ConditionConfig =
  | { fieldPath: string; operator: "exists" }
  | {
      fieldPath: string;
      operator:
        | "equals"
        | "not_equals"
        | "greater_than"
        | "less_than"
        | "contains";
      expectedType: "string" | "number" | "boolean" | "null";
      expectedValue: string | number | boolean | null;
    };

export type ConditionGraph = {
  version: 2;
  nodes: Array<{
    id: string;
    kind: "trigger" | "condition" | "action" | "end";
    type: "receipt.v1" | "condition.v1" | "record-receipt.v1" | "end.v1";
    position: { x: number; y: number };
    config?: ConditionConfig;
  }>;
  edges: Array<{
    source: string;
    target: string;
    sourcePort?: "TRUE" | "FALSE";
  }>;
};

const idValid = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);

export function fieldPathValid(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 256) return false;
  const parts = value.split(".");
  return (
    parts.length <= 8 &&
    parts.every(
      (part) =>
        /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(part) &&
        !["__proto__", "prototype", "constructor"].includes(part),
    )
  );
}

export function conditionConfigValid(value: unknown): value is ConditionConfig {
  if (!object(value) || !fieldPathValid(value.fieldPath)) return false;
  if (value.operator === "exists")
    return exactKeys(value, ["fieldPath", "operator"]);
  if (
    !exactKeys(value, [
      "fieldPath",
      "operator",
      "expectedType",
      "expectedValue",
    ]) ||
    typeof value.operator !== "string" ||
    !["equals", "not_equals", "greater_than", "less_than", "contains"].includes(
      value.operator,
    )
  )
    return false;
  const v = value.expectedValue;
  const validValue =
    (value.expectedType === "null" && v === null) ||
    (value.expectedType === "boolean" && typeof v === "boolean") ||
    (value.expectedType === "number" &&
      typeof v === "number" &&
      Number.isFinite(v)) ||
    (value.expectedType === "string" &&
      typeof v === "string" &&
      [...v].length <= 1024 &&
      !v.includes("\0") &&
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
        v,
      ));
  return (
    !!validValue &&
    (!(value.operator === "greater_than" || value.operator === "less_than") ||
      value.expectedType === "number") &&
    (value.operator !== "contains" || value.expectedType === "string")
  );
}

/** Port is part of the identity even when both paths lead to the same node. */
export function edgeIdentity(edge: {
  source: string;
  target: string;
  sourcePort?: string;
}): string {
  return JSON.stringify([edge.source, edge.sourcePort ?? "", edge.target]);
}

/** Only the executable ADR 0003 topology is accepted; drafts remain local. */
export function conditionGraphValid(value: unknown): value is ConditionGraph {
  if (
    !object(value) ||
    !exactKeys(value, ["version", "nodes", "edges"]) ||
    value.version !== 2 ||
    !Array.isArray(value.nodes) ||
    value.nodes.length !== 4 ||
    !Array.isArray(value.edges) ||
    value.edges.length !== 4
  )
    return false;
  const pairs: Record<string, string> = {
    trigger: "receipt.v1",
    condition: "condition.v1",
    action: "record-receipt.v1",
    end: "end.v1",
  };
  if (
    !value.nodes.every((node: unknown) => {
      if (
        !object(node) ||
        typeof node.kind !== "string" ||
        !Object.hasOwn(pairs, node.kind) ||
        node.type !== pairs[node.kind] ||
        !exactKeys(
          node,
          node.kind === "condition"
            ? ["id", "kind", "type", "position", "config"]
            : ["id", "kind", "type", "position"],
        ) ||
        !idValid(node.id) ||
        !object(node.position) ||
        !exactKeys(node.position, ["x", "y"])
      )
        return false;
      return (
        [node.position.x, node.position.y].every(
          (n) =>
            typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 10000,
        ) &&
        (node.kind !== "condition" || conditionConfigValid(node.config))
      );
    })
  )
    return false;
  const nodes = value.nodes as ConditionGraph["nodes"];
  if (
    new Set(nodes.map((n) => n.id)).size !== 4 ||
    new Set(nodes.map((n) => n.kind)).size !== 4
  )
    return false;
  const node = (kind: ConditionGraph["nodes"][number]["kind"]) =>
    nodes.find((n) => n.kind === kind)!.id;
  const expected = [
    { source: node("trigger"), target: node("condition") },
    {
      source: node("condition"),
      sourcePort: "TRUE" as const,
      target: node("action"),
    },
    {
      source: node("condition"),
      sourcePort: "FALSE" as const,
      target: node("end"),
    },
    { source: node("action"), target: node("end") },
  ];
  if (
    !value.edges.every(
      (edge: unknown) =>
        object(edge) &&
        exactKeys(
          edge,
          edge.source === node("condition")
            ? ["source", "sourcePort", "target"]
            : ["source", "target"],
        ) &&
        typeof edge.source === "string" &&
        typeof edge.target === "string" &&
        (edge.sourcePort === undefined ||
          edge.sourcePort === "TRUE" ||
          edge.sourcePort === "FALSE"),
    )
  )
    return false;
  const identities = value.edges.map(edgeIdentity);
  return (
    new Set(identities).size === 4 &&
    expected.every((edge) => identities.includes(edgeIdentity(edge)))
  );
}
