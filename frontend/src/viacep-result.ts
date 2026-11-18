import { cepValid } from "./viacep-graph";
type ViaCepAddress = {
  cep: string;
  logradouro?: string;
  complemento?: string;
  unidade?: string;
  bairro?: string;
  localidade?: string;
  uf?: string;
  estado?: string;
  regiao?: string;
  ibge?: string;
  gia?: string;
  ddd?: string;
  siafi?: string;
};
const normalizeCep = (value: unknown) =>
  cepValid(value) ? value.replace("-", "") : null;

const codes = {
  invalid_condition_config: "permanent",
  invalid_condition_value: "permanent",
  condition_type_mismatch: "permanent",
  action_permanent: "permanent",
  invalid_cep: "permanent",
  viacep_not_found: "permanent",
  viacep_http_permanent: "permanent",
  viacep_invalid_response: "permanent",
  viacep_security_rejected: "permanent",
  action_transient: "transient",
  viacep_timeout: "transient",
  viacep_transport: "transient",
  viacep_http_transient: "transient",
  unsupported_execution_contract: "unknown",
  action_unknown: "unknown",
  viacep_unknown: "unknown",
  retry_exhausted: "exhausted",
} as const;
type Classification = "permanent" | "transient" | "unknown" | "exhausted";
export type ExecutionFailure =
  | {
      [K in keyof typeof codes]: {
        classification: (typeof codes)[K];
        code: K;
        nodeId: string | null;
      };
    }[keyof typeof codes]
  | {
      classification: Classification;
      code: "event_peer_failure";
      nodeId: null;
    };
export type Lookup =
  | {
      nodeId: string;
      kind: "viacep-address-result.v1";
      status: "found";
      cep: string;
      address: ViaCepAddress;
      failure: null;
    }
  | {
      nodeId: string;
      kind: "viacep-address-result.v1";
      status: "not_found";
      cep: string;
      address: null;
      failure: ExecutionFailure;
    }
  | {
      nodeId: string;
      kind: "viacep-address-result.v1";
      status: "failed";
      cep: string | null;
      address: null;
      failure: ExecutionFailure;
    };
export type Decision = {
  nodeId: string;
  outcome: "TRUE" | "FALSE";
  sourcePort: "TRUE" | "FALSE";
  targetNodeId: string;
};
export type Receipt = {
  kind: "local-receipt.v1";
  eventId: string;
  message: string;
};
export type Action =
  | {
      nodeId: string | null;
      status: "pending" | "ignored" | "not_executed";
      receipt: null;
    }
  | { nodeId: string; status: "executed"; receipt: Receipt };
export type ExecutionResultV3 = {
  kind: "viacep-condition-execution.v1";
  eventId: string;
  lookup: Lookup | null;
  decision: Decision | null;
  action: Action;
  failure: ExecutionFailure | null;
};
type Obj = Record<string, unknown>;
const object = (x: unknown): x is Obj =>
  x !== null &&
  typeof x === "object" &&
  !Array.isArray(x) &&
  (Object.getPrototypeOf(x) === Object.prototype ||
    Object.getPrototypeOf(x) === null);
const exact = (x: unknown, keys: string[]): x is Obj =>
  object(x) &&
  Reflect.ownKeys(x).length === keys.length &&
  keys.every((k) => enumerableDataProperty(x, k));
const enumerableDataProperty = (x: object, k: PropertyKey): boolean => {
  const descriptor = Object.getOwnPropertyDescriptor(x, k);
  return (
    descriptor !== undefined &&
    descriptor.enumerable === true &&
    "value" in descriptor
  );
};
const node = (x: unknown): x is string =>
  typeof x === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}(?![\s\S])/.test(x);
const uuid = (x: unknown): x is string =>
  typeof x === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/.test(
    x,
  );
const addressFields = [
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
];
const postgresUnicode = (v: unknown): v is string =>
  typeof v === "string" &&
  !v.includes("\0") &&
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
    v,
  );
const validString = (v: unknown): v is string =>
  postgresUnicode(v) && Array.from(v).length <= 1024;
function failure(x: unknown): x is ExecutionFailure {
  if (
    !exact(x, ["classification", "code", "nodeId"]) ||
    !(x.nodeId === null || node(x.nodeId)) ||
    typeof x.code !== "string"
  )
    return false;
  if (x.code === "event_peer_failure")
    return (
      x.nodeId === null &&
      ["transient", "permanent", "unknown", "exhausted"].includes(
        x.classification as string,
      )
    );
  return (
    Object.hasOwn(codes, x.code) &&
    codes[x.code as keyof typeof codes] === x.classification
  );
}
const sameFailure = (a: ExecutionFailure | null, b: ExecutionFailure | null) =>
  a !== null &&
  b !== null &&
  a.code === b.code &&
  a.classification === b.classification &&
  a.nodeId === b.nodeId;
export function validViaCepResult(
  value: unknown,
  eventId: string,
): value is ExecutionResultV3 {
  if (
    !uuid(eventId) ||
    !exact(value, [
      "kind",
      "eventId",
      "lookup",
      "decision",
      "action",
      "failure",
    ]) ||
    value.kind !== "viacep-condition-execution.v1" ||
    value.eventId !== eventId ||
    !(value.failure === null || failure(value.failure))
  )
    return false;
  const f = value.failure as ExecutionFailure | null;
  const l = value.lookup;
  if (l === null) {
    return (
      value.decision === null &&
      f?.code === "unsupported_execution_contract" &&
      f.nodeId === null &&
      exact(value.action, ["nodeId", "status", "receipt"]) &&
      value.action.nodeId === null &&
      value.action.status === "not_executed" &&
      value.action.receipt === null
    );
  }
  if (
    !exact(l, ["nodeId", "kind", "status", "cep", "address", "failure"]) ||
    !node(l.nodeId) ||
    l.kind !== "viacep-address-result.v1" ||
    !["found", "not_found", "failed"].includes(l.status as string)
  )
    return false;
  if (
    l.cep !== null &&
    (typeof l.cep !== "string" || normalizeCep(l.cep) !== l.cep)
  )
    return false;
  if (l.status !== "failed" && l.cep === null) return false;
  if (l.status === "found") {
    if (
      l.failure !== null ||
      !object(l.address) ||
      !Object.hasOwn(l.address, "cep") ||
      Reflect.ownKeys(l.address).some(
        (k) =>
          typeof k !== "string" ||
          !addressFields.includes(k) ||
          !enumerableDataProperty(l.address as Obj, k) ||
          !validString((l.address as Obj)[k]),
      ) ||
      normalizeCep(l.address.cep) !== l.cep
    )
      return false;
  } else {
    if (
      l.address !== null ||
      !failure(l.failure) ||
      l.failure.nodeId !== l.nodeId
    )
      return false;
    if (l.status === "not_found") {
      if (l.failure.code !== "viacep_not_found") return false;
    } else if (
      ![
        "invalid_cep",
        "viacep_timeout",
        "viacep_transport",
        "viacep_http_transient",
        "viacep_http_permanent",
        "viacep_invalid_response",
        "viacep_security_rejected",
        "viacep_unknown",
        "retry_exhausted",
      ].includes(l.failure.code) ||
      (l.failure.code === "invalid_cep") !== (l.cep === null)
    )
      return false;
  }
  const d = value.decision;
  if (
    d !== null &&
    (!exact(d, ["nodeId", "outcome", "sourcePort", "targetNodeId"]) ||
      !node(d.nodeId) ||
      !node(d.targetNodeId) ||
      !["TRUE", "FALSE"].includes(d.outcome as string) ||
      d.sourcePort !== d.outcome ||
      l.status !== "found")
  )
    return false;
  const a = value.action;
  if (
    !exact(a, ["nodeId", "status", "receipt"]) ||
    !node(a.nodeId) ||
    a.nodeId === l.nodeId ||
    (d !== null && (d.nodeId === l.nodeId || d.nodeId === a.nodeId))
  )
    return false;
  const trueTarget =
    d !== null && d.outcome === "TRUE" && d.targetNodeId === a.nodeId;
  if (a.status === "executed") {
    if (
      !trueTarget ||
      f !== null ||
      !exact(a.receipt, ["kind", "eventId", "message"]) ||
      a.receipt.kind !== "local-receipt.v1" ||
      a.receipt.eventId !== eventId ||
      !postgresUnicode(a.receipt.message)
    )
      return false;
  } else if (a.status === "ignored") {
    if (
      d === null ||
      d.outcome !== "FALSE" ||
      d.targetNodeId === a.nodeId ||
      f !== null ||
      a.receipt !== null
    )
      return false;
  } else if (a.status === "pending") {
    if (
      a.receipt !== null ||
      f?.classification !== "transient" ||
      !(
        (l.status === "failed" &&
          failure(l.failure) &&
          l.failure.classification === "transient" &&
          d === null) ||
        (l.status === "found" && trueTarget)
      )
    )
      return false;
  } else if (a.status === "not_executed") {
    if (
      a.receipt !== null ||
      f === null ||
      f.classification === "transient" ||
      !(d === null || trueTarget)
    )
      return false;
  } else return false;
  if (l.status !== "found") {
    if (
      !failure(l.failure) ||
      (!sameFailure(f, l.failure) &&
        !(
          f?.code === "event_peer_failure" &&
          ((l.failure.classification === "transient" &&
            ["unknown", "permanent", "exhausted"].includes(f.classification)) ||
            (l.failure.classification === "unknown" &&
              f.classification === "permanent"))
        ))
    )
      return false;
  } else if (a.status === "not_executed" && d === null) {
    if (
      !(
        f &&
        (([
          "invalid_condition_config",
          "invalid_condition_value",
          "condition_type_mismatch",
        ].includes(f.code) &&
          f.nodeId !== null &&
          f.nodeId !== l.nodeId &&
          f.nodeId !== a.nodeId) ||
          (f.code === "event_peer_failure" && f.classification !== "transient"))
      )
    )
      return false;
  } else if (a.status === "pending") {
    if (
      !(
        f &&
        ((f.code === "action_transient" && f.nodeId === a.nodeId) ||
          (f.code === "event_peer_failure" && f.classification === "transient"))
      )
    )
      return false;
  } else if (a.status === "not_executed") {
    if (
      !(
        f &&
        trueTarget &&
        ((["action_permanent", "action_unknown", "retry_exhausted"].includes(
          f.code,
        ) &&
          f.nodeId === a.nodeId) ||
          (f.code === "event_peer_failure" && f.classification !== "transient"))
      )
    )
      return false;
  }
  return true;
}
