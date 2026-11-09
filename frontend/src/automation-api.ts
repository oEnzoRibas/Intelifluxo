import {
  ApiError,
  base,
  dateTime,
  exactKeys,
  integerAtLeast,
  object,
  retryValid,
  uuid,
} from "./api";
import { defaultGraph, graphValid, type WorkflowGraph } from "./workflow-graph";

export type Definition = {
  id: string;
  scope: string;
  revision: number;
  name: string;
  active: boolean;
  schemaVersion: 1;
  trigger: { type: "receipt.v1" };
  action: { type: "record-receipt.v1" };
  createdAt: string;
  graph: WorkflowGraph;
  graphSource: "server" | "legacy-default";
};
export type Execution = {
  id: string;
  eventId: string;
  automationId: string;
  revision: number;
  schemaVersion: 1;
  trigger: { type: "receipt.v1" };
  action: { type: "record-receipt.v1" };
  createdAt: string;
  status:
    | "accepted"
    | "completed"
    | "retry_scheduled"
    | "retry_released"
    | "blocked";
  retry: unknown;
  result: null | { kind: "local-receipt.v1"; eventId: string; message: string };
};
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
const fixedValid = (v: Record<string, unknown>) =>
  v.schemaVersion === 1 &&
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
    !fixedValid(v) ||
    !dateTime(v.createdAt) ||
    ("graph" in v && !graphValid(v.graph, v.active === true))
  )
    throw new ApiError("invalid");
  return {
    ...v,
    graph: "graph" in v ? v.graph : defaultGraph(),
    graphSource: "graph" in v ? "server" : "legacy-default",
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
    !fixedValid(v) ||
    !dateTime(v.createdAt) ||
    ![
      "accepted",
      "completed",
      "retry_scheduled",
      "retry_released",
      "blocked",
    ].includes(String(v.status)) ||
    !retryValid(v.retry) ||
    !(
      v.result === null ||
      (object(v.result) &&
        exactKeys(v.result, ["kind", "eventId", "message"]) &&
        v.result.kind === "local-receipt.v1" &&
        v.result.eventId === v.eventId &&
        typeof v.result.message === "string")
    )
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
  const v = definition(
    await call(`/automations/${encodeURIComponent(d.id)}`, signal, "PUT", {
      expectedRevision: d.revision,
      active: !d.active,
      name: d.name,
      ...fixed,
    }),
  );
  if (
    v.id !== d.id ||
    v.scope !== d.scope ||
    v.name !== d.name ||
    v.active === d.active ||
    v.revision !== d.revision + 1
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
  const v = definition(
    await call(`/automations/${encodeURIComponent(d.id)}`, signal, "PUT", {
      expectedRevision: d.revision,
      active: d.active,
      name: d.name,
      ...fixed,
      graph,
    }),
  );
  if (
    v.id !== d.id ||
    v.scope !== d.scope ||
    v.name !== d.name ||
    v.active !== d.active ||
    v.revision !== d.revision + 1 ||
    v.graphSource !== "server" ||
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
