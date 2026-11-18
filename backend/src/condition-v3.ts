import { evaluateCondition, validFieldPath } from "./condition.js";
import type { ConditionResult } from "./condition.js";

const nodeId = /^[A-Za-z][A-Za-z0-9_-]{0,63}(?![\s\S])/;

// Read data properties only: configuration and persisted observations must not
// execute user-supplied accessors. Symbols and extra keys remain visible.
function properties(value: unknown): PropertyDescriptorMap | null {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) => !("value" in descriptors[key as string]),
    )
  )
    return null;
  return descriptors;
}

function exact(descriptors: PropertyDescriptorMap, keys: string[]): boolean {
  return (
    Reflect.ownKeys(descriptors).length === keys.length &&
    keys.every((key) => Object.hasOwn(descriptors, key))
  );
}

/**
 * Evaluate against immutable event content or a persisted lookup result.
 * The caller must pass the observation from this execution's preceding lookup
 * and propagate lookup failures before calling; a non-found observation here is
 * a defensive invalid_condition_value, never a predicate outcome.
 */
export function evaluateConditionV3(
  config: unknown,
  eventContent: unknown,
  lookup: unknown,
): ConditionResult {
  const badConfig: ConditionResult = {
    ok: false,
    code: "invalid_condition_config",
  };
  const badValue: ConditionResult = {
    ok: false,
    code: "invalid_condition_value",
  };
  const c = properties(config);
  if (!c || !Object.hasOwn(c, "input") || !Object.hasOwn(c, "operator"))
    return badConfig;
  const input = properties(c.input.value);
  if (
    !input ||
    !Object.hasOwn(input, "source") ||
    !Object.hasOwn(input, "fieldPath")
  )
    return badConfig;
  const source: unknown = input.source.value;
  const path: unknown = input.fieldPath.value;
  if (!validFieldPath(path)) return badConfig;
  if (source === "event") {
    if (!exact(input, ["source", "fieldPath"])) return badConfig;
  } else if (source === "step") {
    if (
      !exact(input, ["source", "nodeId", "fieldPath"]) ||
      typeof input.nodeId.value !== "string" ||
      !nodeId.test(input.nodeId.value)
    )
      return badConfig;
  } else return badConfig;

  const keys =
    c.operator.value === "exists"
      ? ["input", "operator"]
      : ["input", "operator", "expectedType", "expectedValue"];
  if (!exact(c, keys)) return badConfig;
  const scalarConfig =
    c.operator.value === "exists"
      ? { fieldPath: path, operator: c.operator.value }
      : {
          fieldPath: path,
          operator: c.operator.value,
          expectedType: c.expectedType.value,
          expectedValue: c.expectedValue.value,
        };
  const validation = evaluateCondition(scalarConfig, {});
  if (!validation.ok) return validation;

  // Only inspect metadata here; traversal of the chosen root is delegated.
  // A malformed metadata accessor must not run, even for an event selector.
  const observation = properties(lookup);
  if (
    !observation ||
    !Object.hasOwn(observation, "nodeId") ||
    typeof observation.nodeId.value !== "string" ||
    !nodeId.test(observation.nodeId.value) ||
    !Object.hasOwn(observation, "status") ||
    observation.status.value !== "found"
  )
    return badValue;
  if (source === "step" && input.nodeId.value !== observation.nodeId.value)
    return badConfig;
  return evaluateCondition(
    scalarConfig,
    source === "event" ? eventContent : lookup,
  );
}
