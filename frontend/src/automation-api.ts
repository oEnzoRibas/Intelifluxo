import {
  ApiError,
  base,
  dateTime,
  exactKeys,
  integerAtLeast,
  object,
  retryValid,
  uuid,
  type Retry,
} from "./api";
import { defaultGraph, graphValid, type WorkflowGraph } from "./workflow-graph";
import { conditionGraphValid } from "./condition-contract";

export type Definition = {
  id: string;
  scope: string;
  revision: number;
  name: string;
  active: boolean;
  schemaVersion: 1 | 2;
  trigger: { type: "receipt.v1" };
  action: { type: "record-receipt.v1" };
  createdAt: string;
  graph: WorkflowGraph;
  graphSource: "server" | "legacy-default" | "condition-v2";
};
export type Execution = {
  id: string;
  eventId: string;
  automationId: string;
  revision: number;
  schemaVersion: 1 | 2;
  trigger: { type: "receipt.v1" };
  action: { type: "record-receipt.v1" };
  createdAt: string;
  status:
    | "accepted"
    | "completed"
    | "ignored"
    | "retry_scheduled"
    | "retry_released"
    | "blocked";
  retry: null | (Retry & { scope: "event" });
  result: null | Receipt | ConditionResult;
};
type Receipt = { kind: "local-receipt.v1"; eventId: string; message: string };
export type ConditionResult = {
  kind: "condition-execution.v1";
  eventId: string;
  decision: null | {
    nodeId: string;
    outcome: "TRUE" | "FALSE";
    sourcePort: "TRUE" | "FALSE";
    targetNodeId: string;
  };
  action: {
    nodeId: string | null;
    status: "executed" | "ignored" | "pending" | "not_executed";
    receipt: Receipt | null;
  };
  failure: null | {
    classification: string;
    code: string;
    nodeId: string | null;
  };
};
const node = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v);
const nullableNode = (v: unknown) => v === null || node(v);
const receipt = (v: unknown, eventId: unknown) =>
  object(v) &&
  exactKeys(v, ["kind", "eventId", "message"]) &&
  v.kind === "local-receipt.v1" &&
  v.eventId === eventId &&
  typeof v.message === "string";
function resultValid(version: unknown, eventId: unknown, v: unknown): boolean {
  if (v === null) return true;
  if (version === 1) return receipt(v, eventId);
  if (
    version !== 2 ||
    !object(v) ||
    !exactKeys(v, ["kind", "eventId", "decision", "action", "failure"]) ||
    v.kind !== "condition-execution.v1" ||
    v.eventId !== eventId ||
    !object(v.action) ||
    !exactKeys(v.action, ["nodeId", "status", "receipt"]) ||
    !nullableNode(v.action.nodeId)
  )
    return false;
  const { decision: d, action: a, failure: f } = v;
  if (
    d !== null &&
    (!object(d) ||
      !exactKeys(d, ["nodeId", "outcome", "sourcePort", "targetNodeId"]) ||
      !node(d.nodeId) ||
      !node(d.targetNodeId) ||
      (d.outcome !== "TRUE" && d.outcome !== "FALSE") ||
      d.sourcePort !== d.outcome)
  )
    return false;
  if (
    f !== null &&
    (!object(f) ||
      !exactKeys(f, ["classification", "code", "nodeId"]) ||
      typeof f.classification !== "string" ||
      !["transient", "permanent", "unknown", "exhausted"].includes(
        f.classification,
      ) ||
      typeof f.code !== "string" ||
      ![
        "invalid_condition_config",
        "invalid_condition_value",
        "condition_type_mismatch",
        "unsupported_execution_contract",
        "action_transient",
        "action_permanent",
        "action_unknown",
        "event_peer_failure",
        "retry_exhausted",
      ].includes(f.code) ||
      !nullableNode(f.nodeId))
  )
    return false;
  const decision = d as Record<string, unknown> | null;
  const failure = f as Record<string, unknown> | null;
  const trueTarget =
    decision?.outcome === "TRUE" &&
    decision.targetNodeId === a.nodeId &&
    node(a.nodeId);
  switch (a.status) {
    case "executed":
      return !!trueTarget && f === null && receipt(a.receipt, eventId);
    case "ignored":
      return (
        decision?.outcome === "FALSE" &&
        node(a.nodeId) &&
        decision.targetNodeId !== a.nodeId &&
        f === null &&
        a.receipt === null
      );
    case "pending":
      return (
        !!trueTarget &&
        failure?.classification === "transient" &&
        a.receipt === null
      );
    case "not_executed":
      return (d === null || !!trueTarget) && f !== null && a.receipt === null;
    default:
      return false;
  }
}
export const fixed = {
  schemaVersion: 1 as const,
  trigger: { type: "receipt.v1" as const },
  action: { type: "record-receipt.v1" as const },
};
export const validText = (v: unknown, max: number): v is string =>
  typeof v === "string" &&
  [...v].length <= max &&
  /\S/u.test(v) &&
  !v.includes(String.fromCharCode(0)) &&
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
    v,
  );
const fixedValid = (v: Record<string, unknown>, schemaVersion: 1 | 2 = 1) =>
  v.schemaVersion === schemaVersion &&
  object(v.trigger) &&
  exactKeys(v.trigger, ["type"]) &&
  v.trigger.type === fixed.trigger.type &&
  object(v.action) &&
  exactKeys(v.action, ["type"]) &&
  v.action.type === fixed.action.type;
export function definition(v: unknown): Definition {
  const keys = [
    "id",
    "scope",
    "revision",
    "name",
    "active",
    "schemaVersion",
    "trigger",
    "action",
    "createdAt",
  ];
  if (
    !object(v) ||
    !(exactKeys(v, keys) || exactKeys(v, [...keys, "graph"])) ||
    !uuid(v.id) ||
    !validText(v.scope, 128) ||
    !validText(v.name, 200) ||
    !integerAtLeast(v.revision, 1) ||
    typeof v.active !== "boolean" ||
    !(fixedValid(v, 1) || fixedValid(v, 2)) ||
    !dateTime(v.createdAt) ||
    (v.schemaVersion === 1
      ? "graph" in v &&
        (!object(v.graph) ||
          v.graph.version !== 1 ||
          !graphValid(v.graph, v.active === true))
      : !("graph" in v) || !conditionGraphValid(v.graph))
  )
    throw new ApiError("invalid");
  return {
    ...v,
    graph: "graph" in v ? v.graph : defaultGraph(),
    graphSource:
      v.schemaVersion === 2
        ? "condition-v2"
        : "graph" in v
          ? "server"
          : "legacy-default",
  } as Definition;
}
export function execution(v: unknown): Execution {
  if (
    !object(v) ||
    !exactKeys(v, [
      "id",
      "eventId",
      "automationId",
      "revision",
      "schemaVersion",
      "trigger",
      "action",
      "createdAt",
      "status",
      "retry",
      "result",
    ]) ||
    !uuid(v.id) ||
    !uuid(v.eventId) ||
    !uuid(v.automationId) ||
    !integerAtLeast(v.revision, 1) ||
    !(fixedValid(v, 1) || fixedValid(v, 2)) ||
    !dateTime(v.createdAt) ||
    ![
      "accepted",
      "completed",
      "ignored",
      "retry_scheduled",
      "retry_released",
      "blocked",
    ].includes(String(v.status)) ||
    !retryValid(v.retry, "event") ||
    !resultValid(v.schemaVersion, v.eventId, v.result)
  )
    throw new ApiError("invalid");
  return v as Execution;
}
export class ConflictError extends Error {}
export type ValidationIssue = {
  code: string;
  path: string;
  nodeId?: string;
  source?: string;
  target?: string;
};
export class ValidationError extends Error {
  constructor(public issues: ValidationIssue[]) {
    super("Validation failed");
  }
}
export function validationIssues(value: unknown): ValidationIssue[] | null {
  if (
    !object(value) ||
    !exactKeys(value, ["error", "issues"]) ||
    value.error !== "validation_failed" ||
    !Array.isArray(value.issues) ||
    !value.issues.length ||
    value.issues.length > 100
  )
    return null;
  const valid = value.issues.every(
    (issue: unknown) =>
      object(issue) &&
      Object.keys(issue).every((key) =>
        ["code", "path", "nodeId", "source", "target"].includes(key),
      ) &&
      typeof issue.code === "string" &&
      /^[a-z_]{1,64}$/.test(issue.code) &&
      typeof issue.path === "string" &&
      issue.path.length <= 256 &&
      issue.path.startsWith("/") &&
      ["nodeId", "source", "target"].every(
        (key) =>
          !(key in issue) ||
          (typeof issue[key] === "string" &&
            /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(issue[key] as string)),
      ),
  );
  return valid ? (value.issues as ValidationIssue[]) : null;
}
async function call(
  path: string,
  signal: AbortSignal,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      signal,
      credentials: "omit",
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError("unavailable");
  }
  if (response.status === 409) throw new ConflictError();
  if (response.status === 404) throw new ApiError("not-found");
  if (response.status === 400) {
    let issues: ValidationIssue[] | null = null;
    try {
      issues = validationIssues(await response.json());
    } catch {
      /* Ambiguous response. */
    }
    if (issues) throw new ValidationError(issues);
  }
  if (!response.ok) throw new ApiError("unavailable");
  try {
    return await response.json();
  } catch {
    throw new ApiError("invalid");
  }
}
function items<T>(v: unknown, parse: (item: unknown) => T): T[] {
  if (
    !object(v) ||
    !exactKeys(v, ["items"]) ||
    !Array.isArray(v.items) ||
    v.items.length > 100
  )
    throw new ApiError("invalid");
  return v.items.map(parse);
}
export async function listDefinitions(scope: string, signal: AbortSignal) {
  const result = items(
    await call(`/automations?scope=${encodeURIComponent(scope)}`, signal),
    definition,
  );
  if (result.some((x) => x.scope !== scope)) throw new ApiError("invalid");
  return result;
}
export async function getDefinition(id: string, signal: AbortSignal) {
  const v = definition(
    await call(`/automations/${encodeURIComponent(id)}`, signal),
  );
  if (v.id !== id) throw new ApiError("invalid");
  return v;
}
export async function createDefinition(
  scope: string,
  name: string,
  signal: AbortSignal,
) {
  const v = definition(
    await call("/automations", signal, "POST", { scope, name, ...fixed }),
  );
  if (v.scope !== scope || v.name !== name || v.active || v.revision !== 1)
    throw new ApiError("invalid");
  return v;
}
export async function updateDefinition(d: Definition, signal: AbortSignal) {
  if (
    d.graphSource === "legacy-default" ||
    !(d.schemaVersion === 1
      ? d.graph.version === 1 && graphValid(d.graph, !d.active)
      : conditionGraphValid(d.graph))
  )
    throw new ApiError("invalid");
  const v = definition(
    await call(`/automations/${encodeURIComponent(d.id)}`, signal, "PUT", {
      expectedRevision: d.revision,
      active: !d.active,
      name: d.name,
      schemaVersion: d.schemaVersion,
      trigger: d.trigger,
      action: d.action,
      graph: d.graph,
    }),
  );
  if (
    v.id !== d.id ||
    v.scope !== d.scope ||
    v.name !== d.name ||
    v.active === d.active ||
    v.revision !== d.revision + 1 ||
    v.schemaVersion !== d.schemaVersion ||
    canonical(v.graph) !== canonical(d.graph)
  )
    throw new ApiError("invalid");
  return v;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export async function saveGraph(
  d: Definition,
  graph: WorkflowGraph,
  signal: AbortSignal,
) {
  if (
    d.graphSource === "legacy-default" ||
    !(graph.version === 1
      ? graphValid(graph, d.active)
      : graph.version === 2 && conditionGraphValid(graph)) ||
    (d.active && graph.version !== d.schemaVersion)
  )
    throw new ApiError("invalid");
  const v = definition(
    await call(`/automations/${encodeURIComponent(d.id)}`, signal, "PUT", {
      expectedRevision: d.revision,
      active: d.active,
      name: d.name,
      schemaVersion: graph.version,
      trigger: d.trigger,
      action: d.action,
      graph,
    }),
  );
  if (
    v.id !== d.id ||
    v.scope !== d.scope ||
    v.name !== d.name ||
    v.active !== d.active ||
    v.revision !== d.revision + 1 ||
    v.graphSource === "legacy-default" ||
    v.schemaVersion !== graph.version ||
    canonical(v.graph) !== canonical(graph)
  )
    throw new ApiError("invalid");
  return v;
}
export async function listExecutions(id: string, signal: AbortSignal) {
  const result = items(
    await call(`/executions?automationId=${encodeURIComponent(id)}`, signal),
    execution,
  );
  if (result.some((x) => x.automationId !== id)) throw new ApiError("invalid");
  return result;
}
export async function getExecution(id: string, signal: AbortSignal) {
  const v = execution(
    await call(`/executions/${encodeURIComponent(id)}`, signal),
  );
  if (v.id !== id) throw new ApiError("invalid");
  return v;
}
