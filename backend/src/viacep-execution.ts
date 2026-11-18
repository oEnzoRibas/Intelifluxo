import { validateGraphV3 } from "./graph-v3.js";
import { evaluateConditionV3 } from "./condition-v3.js";
import { validFieldPath } from "./condition.js";
import { normalizeCep } from "./viacep-projection.js";
import type { ViaCepResult } from "./viacep-transport.js";
import {
  buildExecutionResultV3,
  parseExecutionResultV3,
} from "./execution-result-v3.js";
import type {
  Decision,
  ExecutionFailure,
  ExecutionResultV3,
  Lookup,
  Receipt,
} from "./execution-result-v3.js";
import type { Outcome } from "./retry-policy.js";

export type ViaCepExecutionInput = {
  executionId: string;
  eventId: string;
  eventContent: unknown;
  graph: unknown;
  schemaVersion: number;
  triggerType: string;
  actionType: string;
  revisionVersion: number;
  revisionTrigger: string;
  revisionAction: string;
  persistedResult: unknown;
  resultIsSqlNull: boolean;
  timeoutMs: number;
};
export type ViaCepLookup = (
  cep: string,
  options: { timeoutMs: number },
) => Promise<ViaCepResult>;
type Supported = {
  kind: "supported";
  executionId: string;
  eventId: string;
  nodes: {
    trigger: string;
    lookup: string;
    condition: string;
    action: string;
    end: string;
  };
  canonicalCep: string | null;
  lookup: Lookup;
  decision: Decision | null;
  failure: ExecutionFailure | null;
  terminal: ExecutionResultV3 | null;
};
export type PreparedViaCepExecution =
  Supported | { kind: "unsupported"; executionId: string; eventId: string };
// peerOutcome is explicit: it proves both precedence and the source of retry.
export type ViaCepEventAggregate =
  | {
      state: "completed";
      outcome: "success";
      peerOutcome: "success";
      actionOutcome: "success";
      receipt: Receipt;
    }
  | {
      state: "scheduled";
      outcome: "transient";
      peerOutcome: Outcome;
      actionOutcome: Outcome;
      receipt: null;
    }
  | {
      state: "blocked";
      outcome: "permanent" | "unknown" | "transient";
      reason: "permanent" | "unknown" | "exhausted";
      peerOutcome: Outcome;
      actionOutcome: Outcome;
      receipt: null;
    };
const invariant = (): never => {
  throw new Error("execution invariant");
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Detach graph without executing accessors before passing it to the validator.
function safeGraph(v: unknown, depth = 0): unknown {
  if (depth > 32) return invariant();
  if (v === null || typeof v !== "object") return v;
  const proto: unknown = Object.getPrototypeOf(v);
  if (Array.isArray(v)) {
    if (proto !== Array.prototype || v.length > 10000) return invariant();
    const d = Object.getOwnPropertyDescriptors(v);
    if (
      Reflect.ownKeys(d).some(
        (k) =>
          k !== "length" &&
          (typeof k !== "string" ||
            !/^(0|[1-9][0-9]*)$/.test(k) ||
            Number(k) >= v.length ||
            !("value" in d[k]) ||
            !d[k].enumerable),
      )
    )
      return invariant();
    const result: unknown[] = [];
    for (let i = 0; i < v.length; i++) {
      if (!d[String(i)]) return invariant();
      result.push(safeGraph(d[String(i)].value, depth + 1));
    }
    return result;
  }
  if (proto !== Object.prototype && proto !== null) return invariant();
  const out: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of Reflect.ownKeys(v)) {
    const d = Object.getOwnPropertyDescriptor(v, key);
    if (typeof key !== "string" || !d || !d.enumerable || !("value" in d))
      return invariant();
    Object.defineProperty(out, key, {
      value: safeGraph(d.value, depth + 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return out;
}
const addressFields = new Set([
  "cep",
  "logradouro",
  "complemento",
  "unidade",
  "bairro",
  "localidade",
  "uf",
  "estado",
  "regiao",
  "ibge",
  "gia",
  "ddd",
  "siafi",
]);
function detachAddress(
  value: unknown,
  cep: string,
): Extract<Lookup, { status: "found" }>["address"] {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(
      Object.getPrototypeOf(value) as object | null,
    )
  )
    return invariant();
  const out: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !addressFields.has(key) ||
      !d?.enumerable ||
      !("value" in d) ||
      typeof d.value !== "string" ||
      d.value.includes("\0") ||
      Array.from(d.value).length > 1024 ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
        d.value,
      )
    )
      return invariant();
    out[key] = d.value;
  }
  if (normalizeCep(out.cep) !== cep) return invariant();
  return out as Extract<Lookup, { status: "found" }>["address"];
}
function eventValue(root: unknown, path: unknown): unknown {
  if (!validFieldPath(path)) return undefined;
  let current = root;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current))
      return undefined;
    const proto: unknown = Object.getPrototypeOf(current);
    if (proto !== Object.prototype && proto !== null) return undefined;
    const d = Object.getOwnPropertyDescriptor(current, part);
    if (!d || !d.enumerable || !("value" in d)) return undefined;
    current = d.value;
  }
  return current;
}
type Node = {
  id: string;
  kind: string;
  config: { cep: { source: string; value?: unknown; fieldPath?: unknown } };
};
const transportFailures = {
  timeout: ["transient", "viacep_timeout"],
  transport: ["transient", "viacep_transport"],
  http_transient: ["transient", "viacep_http_transient"],
  http_permanent: ["permanent", "viacep_http_permanent"],
  invalid_response: ["permanent", "viacep_invalid_response"],
  security_rejected: ["permanent", "viacep_security_rejected"],
  unknown: ["unknown", "viacep_unknown"],
} as const;
/** Check a detached result against its pinned inputs without invoking the transport. */
export function validateViaCepCorrespondence(
  input: Pick<
    ViaCepExecutionInput,
    | "eventId"
    | "eventContent"
    | "graph"
    | "schemaVersion"
    | "triggerType"
    | "actionType"
    | "revisionVersion"
    | "revisionTrigger"
    | "revisionAction"
  >,
  result: ExecutionResultV3,
): void {
  try {
    const graph = safeGraph(input.graph) as { nodes: Node[] };
    if (
      input.revisionVersion == null ||
      input.revisionTrigger == null ||
      input.revisionAction == null ||
      input.graph == null ||
      result.eventId !== input.eventId
    )
      return invariant();
    const unsupported =
      input.schemaVersion !== 3 ||
      input.revisionVersion !== 3 ||
      input.triggerType !== input.revisionTrigger ||
      input.actionType !== input.revisionAction ||
      validateGraphV3(graph, input.triggerType, input.actionType).length > 0;
    if (unsupported) {
      if (result.lookup !== null) return invariant();
      return;
    }
    if (!result.lookup) return invariant();
    const byKind = (kind: string) => graph.nodes.find((n) => n.kind === kind)!;
    const ln = byKind("lookup"),
      cn = byKind("condition"),
      an = byKind("action"),
      en = byKind("end");
    const selector = ln.config.cep;
    const cep = normalizeCep(
      selector.source === "fixed"
        ? selector.value
        : eventValue(input.eventContent, selector.fieldPath),
    );
    if (
      result.lookup.nodeId !== ln.id ||
      result.lookup.cep !== cep ||
      result.action.nodeId !== an.id
    )
      return invariant();
    if (
      result.action.status === "executed" &&
      (result.action.receipt.eventId !== input.eventId ||
        result.action.receipt.message !==
          eventValue(input.eventContent, "message"))
    )
      return invariant();
    if (result.lookup.status === "found") {
      const evaluated = evaluateConditionV3(
        cn.config,
        input.eventContent,
        result.lookup,
      );
      if (evaluated.ok) {
        const outcome = evaluated.value ? "TRUE" : "FALSE";
        if (
          !result.decision ||
          result.decision.nodeId !== cn.id ||
          result.decision.outcome !== outcome ||
          result.decision.sourcePort !== outcome ||
          result.decision.targetNodeId !== (evaluated.value ? an.id : en.id)
        )
          return invariant();
      } else if (
        result.decision !== null ||
        result.failure?.code !== evaluated.code ||
        result.failure.nodeId !== cn.id
      )
        return invariant();
    }
    if (result.failure && result.failure.code !== "event_peer_failure") {
      const code = result.failure.code;
      const expected = code.startsWith("action_")
        ? an.id
        : code.startsWith("invalid_condition_") ||
            code === "condition_type_mismatch"
          ? cn.id
          : code === "retry_exhausted"
            ? result.lookup.status === "found"
              ? an.id
              : ln.id
            : ln.id;
      if (result.failure.nodeId !== expected) return invariant();
    }
  } catch {
    return invariant();
  }
}
/** Terminal observations are retained; only transient lookup failures are retried. */
export async function prepareViaCepExecution(
  input: ViaCepExecutionInput,
  lookup: ViaCepLookup,
): Promise<PreparedViaCepExecution> {
  try {
    if (!uuid.test(input.executionId) || !uuid.test(input.eventId))
      return invariant();
    const prior = parseExecutionResultV3(
      input.persistedResult,
      input.eventId,
      input.resultIsSqlNull,
    );
    const graph = safeGraph(input.graph) as { nodes: Node[] };
    if (
      input.schemaVersion !== 3 ||
      input.revisionVersion !== 3 ||
      input.triggerType !== input.revisionTrigger ||
      input.actionType !== input.revisionAction ||
      validateGraphV3(graph, input.triggerType, input.actionType).length
    ) {
      if (prior?.lookup) return invariant();
      return {
        kind: "unsupported",
        executionId: input.executionId,
        eventId: input.eventId,
      };
    }
    const byKind = (kind: string) => graph.nodes.find((n) => n.kind === kind)!;
    const trigger = byKind("trigger"),
      ln = byKind("lookup"),
      cn = byKind("condition"),
      an = byKind("action"),
      en = byKind("end");
    const nodes = {
      trigger: trigger.id,
      lookup: ln.id,
      condition: cn.id,
      action: an.id,
      end: en.id,
    };
    const selector = ln.config.cep;
    const cep = normalizeCep(
      selector.source === "fixed"
        ? selector.value
        : eventValue(input.eventContent, selector.fieldPath),
    );
    if (
      prior &&
      (!prior.lookup ||
        prior.lookup.nodeId !== ln.id ||
        prior.lookup.cep !== cep ||
        prior.action.nodeId !== an.id ||
        (prior.decision &&
          (prior.decision.nodeId !== cn.id ||
            prior.decision.targetNodeId !==
              (prior.decision.outcome === "TRUE" ? an.id : en.id))))
    )
      return invariant();
    let observation: Lookup;
    if (
      prior?.lookup &&
      (prior.lookup.status === "found" ||
        prior.lookup.failure?.classification !== "transient")
    )
      observation = prior.lookup;
    else if (cep === null)
      observation = {
        nodeId: ln.id,
        kind: "viacep-address-result.v1",
        status: "failed",
        cep: null,
        address: null,
        failure: {
          classification: "permanent",
          code: "invalid_cep",
          nodeId: ln.id,
        },
      };
    else {
      let result: ViaCepResult;
      try {
        result = await lookup(cep, { timeoutMs: input.timeoutMs });
      } catch {
        result = { status: "unknown" };
      }
      if (result.status === "found")
        observation = {
          nodeId: ln.id,
          kind: "viacep-address-result.v1",
          status: "found",
          cep,
          address: detachAddress(result.address, cep),
          failure: null,
        };
      else if (result.status === "not_found")
        observation = {
          nodeId: ln.id,
          kind: "viacep-address-result.v1",
          status: "not_found",
          cep,
          address: null,
          failure: {
            classification: "permanent",
            code: "viacep_not_found",
            nodeId: ln.id,
          },
        };
      else {
        const [classification, code] =
          transportFailures[result.status] ?? transportFailures.unknown;
        observation = {
          nodeId: ln.id,
          kind: "viacep-address-result.v1",
          status: "failed",
          cep,
          address: null,
          failure: { classification, code, nodeId: ln.id } as ExecutionFailure,
        };
      }
    }
    let decision: Decision | null = null;
    let failure: ExecutionFailure | null = observation.failure;
    if (observation.status === "found") {
      const evaluated = evaluateConditionV3(
        cn.config,
        input.eventContent,
        observation,
      );
      if (!evaluated.ok)
        failure = {
          classification: "permanent",
          code: evaluated.code,
          nodeId: cn.id,
        };
      else {
        const outcome = evaluated.value ? "TRUE" : "FALSE";
        decision = {
          nodeId: cn.id,
          outcome,
          sourcePort: outcome,
          targetNodeId: evaluated.value ? an.id : en.id,
        };
      }
    }
    if (prior?.lookup?.status === "found") {
      if (
        (prior.decision === null) !== (decision === null) ||
        (prior.decision &&
          decision &&
          (prior.decision.nodeId !== decision.nodeId ||
            prior.decision.outcome !== decision.outcome ||
            prior.decision.sourcePort !== decision.sourcePort ||
            prior.decision.targetNodeId !== decision.targetNodeId))
      )
        return invariant();
      if (
        decision === null &&
        (prior.failure?.nodeId !== cn.id ||
          prior.failure?.code !== failure?.code ||
          prior.failure?.classification !== failure?.classification)
      )
        return invariant();
    }
    return {
      kind: "supported",
      executionId: input.executionId,
      eventId: input.eventId,
      nodes,
      canonicalCep: cep,
      lookup: observation,
      decision,
      failure,
      terminal:
        prior &&
        (prior.action.status === "ignored" ||
          prior.action.status === "executed")
          ? prior
          : null,
    };
  } catch {
    return invariant();
  }
}
/** Reject inconsistent aggregation rather than manufacture a valid-looking outcome. */
export function finalizeViaCepExecution(
  prepared: PreparedViaCepExecution,
  aggregate: ViaCepEventAggregate,
): ExecutionResultV3 {
  try {
    // Unsupported contracts have a fixed unknown envelope, independent of aggregate.
    if (prepared.kind === "unsupported")
      return buildExecutionResultV3({
        kind: "viacep-condition-execution.v1",
        eventId: prepared.eventId,
        lookup: null,
        decision: null,
        action: { nodeId: null, status: "not_executed", receipt: null },
        failure: {
          classification: "unknown",
          code: "unsupported_execution_contract",
          nodeId: null,
        },
      });
    let { lookup, failure } = prepared;
    const { decision, nodes, eventId } = prepared;
    const rank: Record<Outcome, number> = {
      success: 0,
      transient: 1,
      unknown: 2,
      permanent: 3,
    };
    const own = failure?.classification ?? "success";
    if (own === "exhausted") return invariant();
    const { actionOutcome, peerOutcome, outcome } = aggregate;
    if (
      !Object.hasOwn(rank, actionOutcome) ||
      !Object.hasOwn(rank, peerOutcome) ||
      !Object.hasOwn(rank, outcome)
    )
      return invariant();
    const winning = Math.max(rank[own], rank[actionOutcome], rank[peerOutcome]);
    if (
      rank[outcome] !== winning ||
      (aggregate.state === "completed" &&
        (outcome !== "success" ||
          actionOutcome !== "success" ||
          aggregate.receipt === null)) ||
      (aggregate.state === "scheduled" &&
        (outcome !== "transient" || aggregate.receipt !== null)) ||
      (aggregate.state === "blocked" &&
        (aggregate.receipt !== null ||
          (aggregate.reason === "exhausted"
            ? outcome !== "transient"
            : aggregate.reason !== outcome))) ||
      !["completed", "scheduled", "blocked"].includes(aggregate.state)
    )
      return invariant();
    if (prepared.terminal) {
      if (
        prepared.terminal.action.status === "executed" &&
        (aggregate.state !== "completed" ||
          aggregate.receipt === null ||
          prepared.terminal.action.receipt.kind !== aggregate.receipt.kind ||
          prepared.terminal.action.receipt.eventId !==
            aggregate.receipt.eventId ||
          prepared.terminal.action.receipt.message !==
            aggregate.receipt.message)
      )
        return invariant();
      if (
        prepared.terminal.action.status === "executed" &&
        aggregate.state === "completed"
      )
        buildExecutionResultV3({
          ...prepared.terminal,
          action: { ...prepared.terminal.action, receipt: aggregate.receipt },
        });
      return prepared.terminal;
    }
    let status: "executed" | "ignored" | "pending" | "not_executed";
    if (decision?.outcome === "FALSE") {
      status = "ignored";
      failure = null;
    } else if (aggregate.state === "completed") {
      if (failure || !decision) return invariant();
      status = "executed";
    } else {
      status = aggregate.state === "scheduled" ? "pending" : "not_executed";
      const classification =
        aggregate.state === "blocked" && aggregate.reason === "exhausted"
          ? "exhausted"
          : outcome;
      if (classification === "success") return invariant();
      if (own === outcome && own !== "success") {
        if (classification === "exhausted") {
          failure = {
            classification: "exhausted",
            code: "retry_exhausted",
            nodeId: nodes.lookup,
          };
          lookup = { ...lookup, failure } as Lookup;
        }
      } else if (
        decision?.outcome === "TRUE" &&
        actionOutcome === outcome &&
        actionOutcome !== "success"
      ) {
        failure = {
          classification,
          code:
            classification === "exhausted"
              ? "retry_exhausted"
              : `action_${classification}`,
          nodeId: nodes.action,
        } as ExecutionFailure;
      } else {
        failure = { classification, code: "event_peer_failure", nodeId: null };
      }
    }
    const action =
      status === "executed"
        ? {
            nodeId: nodes.action,
            status,
            receipt:
              aggregate.state === "completed" ? aggregate.receipt : invariant(),
          }
        : { nodeId: nodes.action, status, receipt: null };
    return buildExecutionResultV3({
      kind: "viacep-condition-execution.v1",
      eventId,
      lookup,
      decision,
      action,
      failure,
    });
  } catch {
    return invariant();
  }
}
