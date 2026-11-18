import { exactKeys, object } from "./api";
import {
  conditionConfigValid,
  fieldPathValid,
  type ConditionConfig,
} from "./condition-contract";

/** CEP is a wire string; never normalize it before validation or persistence. */
export function cepValid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:[0-9]{8}|[0-9]{5}-[0-9]{3})(?![\s\S])/.test(value)
  );
}

export type CepInput =
  | { source: "fixed"; value: string }
  | { source: "event"; fieldPath: string };

export type ViaCepConditionInput =
  | { source: "event"; fieldPath: string }
  | { source: "step"; nodeId: string; fieldPath: string };
export type ViaCepConditionConfig =
  | (Omit<Extract<ConditionConfig, { operator: "exists" }>, "fieldPath"> & {
      input: ViaCepConditionInput;
    })
  | (Omit<Exclude<ConditionConfig, { operator: "exists" }>, "fieldPath"> & {
      input: ViaCepConditionInput;
    });
export type ViaCepGraph = {
  version: 3;
  nodes: Array<
    | {
        id: string;
        kind: "lookup";
        type: "viacep-address.v1";
        position: { x: number; y: number };
        config: { cep: CepInput };
      }
    | {
        id: string;
        kind: "condition";
        type: "condition.v2";
        position: { x: number; y: number };
        config: ViaCepConditionConfig;
      }
    | {
        id: string;
        kind: "trigger" | "action" | "end";
        type: "receipt.v1" | "record-receipt.v1" | "end.v1";
        position: { x: number; y: number };
      }
  >;
  edges: Array<{
    source: string;
    target: string;
    sourcePort?: "TRUE" | "FALSE";
  }>;
};

/** Complete example template; operators must review it before activation. */
export function createViaCepTemplate(): ViaCepGraph {
  const graph: ViaCepGraph = {
    version: 3,
    nodes: [
      {
        id: "trigger",
        kind: "trigger",
        type: "receipt.v1",
        position: { x: 0, y: 0 },
      },
      {
        id: "lookup",
        kind: "lookup",
        type: "viacep-address.v1",
        position: { x: 0, y: 100 },
        config: { cep: { source: "fixed", value: "01001000" } },
      },
      {
        id: "condition",
        kind: "condition",
        type: "condition.v2",
        position: { x: 0, y: 200 },
        config: {
          operator: "equals",
          expectedType: "string",
          expectedValue: "SP",
          input: { source: "step", nodeId: "lookup", fieldPath: "address.uf" },
        },
      },
      {
        id: "action",
        kind: "action",
        type: "record-receipt.v1",
        position: { x: 0, y: 300 },
      },
      { id: "end", kind: "end", type: "end.v1", position: { x: 0, y: 400 } },
    ],
    edges: [
      { source: "trigger", target: "lookup" },
      { source: "lookup", target: "condition" },
      { source: "condition", sourcePort: "TRUE", target: "action" },
      { source: "condition", sourcePort: "FALSE", target: "end" },
      { source: "action", target: "end" },
    ],
  };
  if (!viacepGraphValid(graph)) throw new Error("Invalid ViaCEP template");
  return graph;
}

export function cepInputValid(value: unknown): value is CepInput {
  return (
    object(value) &&
    ((value.source === "fixed" &&
      exactKeys(value, ["source", "value"]) &&
      cepValid(value.value)) ||
      (value.source === "event" &&
        exactKeys(value, ["source", "fieldPath"]) &&
        fieldPathValid(value.fieldPath)))
  );
}

const idValid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[A-Za-z][A-Za-z0-9_-]{0,63}(?![\s\S])/.test(value);

/** Validate the entire fixed v3 topology before treating it as editable. */
export function viacepGraphValid(value: unknown): value is ViaCepGraph {
  if (
    !object(value) ||
    !exactKeys(value, ["version", "nodes", "edges"]) ||
    value.version !== 3 ||
    !Array.isArray(value.nodes) ||
    value.nodes.length !== 5 ||
    !Array.isArray(value.edges) ||
    value.edges.length !== 5
  )
    return false;
  const types: Record<string, string> = {
    trigger: "receipt.v1",
    lookup: "viacep-address.v1",
    condition: "condition.v2",
    action: "record-receipt.v1",
    end: "end.v1",
  };
  const nodes = new Map<string, Record<string, unknown>>();
  const ids = new Set<string>();
  for (const n of value.nodes as unknown[]) {
    if (
      !object(n) ||
      typeof n.kind !== "string" ||
      !Object.hasOwn(types, n.kind) ||
      n.type !== types[n.kind] ||
      nodes.has(n.kind) ||
      !idValid(n.id) ||
      ids.has(n.id) ||
      !exactKeys(
        n,
        n.kind === "lookup" || n.kind === "condition"
          ? ["id", "kind", "type", "position", "config"]
          : ["id", "kind", "type", "position"],
      ) ||
      !object(n.position) ||
      !exactKeys(n.position, ["x", "y"]) ||
      ![n.position.x, n.position.y].every(
        (x) =>
          typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= 10000,
      )
    )
      return false;
    nodes.set(n.kind, n);
    ids.add(n.id);
  }
  const lookup = nodes.get("lookup")!;
  if (
    !object(lookup.config) ||
    !exactKeys(lookup.config, ["cep"]) ||
    !cepInputValid(lookup.config.cep)
  )
    return false;
  const condition = nodes.get("condition")!;
  if (!object(condition.config) || !object(condition.config.input))
    return false;
  const input = condition.config.input;
  if (
    !fieldPathValid(input.fieldPath) ||
    !(
      (input.source === "event" && exactKeys(input, ["source", "fieldPath"])) ||
      (input.source === "step" &&
        exactKeys(input, ["source", "nodeId", "fieldPath"]) &&
        input.nodeId === lookup.id)
    )
  )
    return false;
  const rest = { ...condition.config };
  delete rest.input;
  if (
    Object.hasOwn(rest, "fieldPath") ||
    !conditionConfigValid({ ...rest, fieldPath: input.fieldPath })
  )
    return false;
  const edge = (source: string, target: string, sourcePort?: string) =>
    JSON.stringify([
      nodes.get(source)!.id,
      sourcePort ?? "",
      nodes.get(target)!.id,
    ]);
  const expected = new Set([
    edge("trigger", "lookup"),
    edge("lookup", "condition"),
    edge("condition", "action", "TRUE"),
    edge("condition", "end", "FALSE"),
    edge("action", "end"),
  ]);
  const actual = new Set<string>();
  for (const e of value.edges as unknown[]) {
    if (
      !object(e) ||
      !exactKeys(
        e,
        Object.hasOwn(e, "sourcePort")
          ? ["source", "target", "sourcePort"]
          : ["source", "target"],
      ) ||
      !idValid(e.source) ||
      !idValid(e.target) ||
      (Object.hasOwn(e, "sourcePort") &&
        e.sourcePort !== "TRUE" &&
        e.sourcePort !== "FALSE")
    )
      return false;
    actual.add(JSON.stringify([e.source, e.sourcePort ?? "", e.target]));
  }
  return (
    actual.size === expected.size && [...actual].every((e) => expected.has(e))
  );
}
