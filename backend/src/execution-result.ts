type ObjectValue = Record<string, unknown>;
const object = (value: unknown, keys: string[]): value is ObjectValue =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const node = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);
const nullableNode = (value: unknown) => value === null || node(value);
const receipt = (value: unknown, eventId: string) =>
  object(value, ["kind", "eventId", "message"]) &&
  value.kind === "local-receipt.v1" &&
  value.eventId === eventId &&
  typeof value.message === "string";

/** Returns the action status only for a structurally valid persisted result. */
export function executionResultStatus(
  version: number,
  eventId: string,
  result: unknown,
): string | null {
  if (version !== 1 && version !== 2) throw new Error("execution invariant");
  if (result === null) return null;
  if (version === 1) {
    if (!receipt(result, eventId)) throw new Error("execution invariant");
    return "executed";
  }
  if (
    !object(result, ["kind", "eventId", "decision", "action", "failure"]) ||
    result.kind !== "condition-execution.v1" ||
    result.eventId !== eventId ||
    !object(result.action, ["nodeId", "status", "receipt"]) ||
    !nullableNode(result.action.nodeId)
  )
    throw new Error("execution invariant");
  const { decision, action, failure } = result;
  if (
    decision !== null &&
    (!object(decision, ["nodeId", "outcome", "sourcePort", "targetNodeId"]) ||
      !node(decision.nodeId) ||
      !node(decision.targetNodeId) ||
      (decision.outcome !== "TRUE" && decision.outcome !== "FALSE") ||
      decision.sourcePort !== decision.outcome)
  )
    throw new Error("execution invariant");
  if (
    failure !== null &&
    (!object(failure, ["classification", "code", "nodeId"]) ||
      !["transient", "permanent", "unknown", "exhausted"].includes(
        failure.classification as string,
      ) ||
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
      ].includes(failure.code as string) ||
      !nullableNode(failure.nodeId))
  )
    throw new Error("execution invariant");
  const d = decision as ObjectValue | null;
  const f = failure as ObjectValue | null;
  const trueTarget =
    d?.outcome === "TRUE" &&
    d.targetNodeId === action.nodeId &&
    node(action.nodeId);
  const valid =
    action.status === "executed"
      ? trueTarget && f === null && receipt(action.receipt, eventId)
      : action.status === "ignored"
        ? d?.outcome === "FALSE" &&
          node(action.nodeId) &&
          d.targetNodeId !== action.nodeId &&
          f === null &&
          action.receipt === null
        : action.status === "pending"
          ? trueTarget &&
            f?.classification === "transient" &&
            action.receipt === null
          : action.status === "not_executed"
            ? (d === null || trueTarget) &&
              f !== null &&
              action.receipt === null
            : false;
  if (!valid) throw new Error("execution invariant");
  return action.status as string;
}
