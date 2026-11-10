// Pure predicate evaluation for ADR 0003. This module does not execute actions.
export type ConditionError =
  | "invalid_condition_config"
  | "invalid_condition_value"
  | "condition_type_mismatch";
export type ConditionResult =
  { ok: true; value: boolean } | { ok: false; code: ConditionError };

const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const segment = /^[A-Za-z_][A-Za-z0-9_]{0,63}(?![\s\S])/;
export function validFieldPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length > 256) return false;
  const parts = path.split(".");
  return (
    parts.length <= 8 &&
    parts.every((part) => segment.test(part) && !forbidden.has(part))
  );
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function scalarString(value: string): boolean {
  if (value.includes("\0") || Array.from(value).length > 1024) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

const missing = Symbol("missing");
const invalid = Symbol("invalid");
function lookup(root: unknown, path: string): unknown {
  let current = root;
  for (const part of path.split(".")) {
    if (Array.isArray(current)) return invalid;
    if (current === null || typeof current !== "object") return missing;
    if (!plainObject(current)) return invalid;
    const descriptor = Object.getOwnPropertyDescriptor(current, part);
    if (!descriptor) return missing;
    if (!("value" in descriptor)) return invalid;
    current = descriptor.value;
  }
  if (
    (current !== null && typeof current === "object") ||
    (typeof current === "number" && !Number.isFinite(current)) ||
    (!["string", "number", "boolean"].includes(typeof current) &&
      current !== null)
  )
    return invalid;
  return current;
}

export function evaluateCondition(
  config: unknown,
  content: unknown,
): ConditionResult {
  const bad = (code: ConditionError): ConditionResult => ({ ok: false, code });
  if (!plainObject(config)) return bad("invalid_condition_config");
  const descriptors = Object.getOwnPropertyDescriptors(config);
  if (Object.values(descriptors).some((d) => !("value" in d)))
    return bad("invalid_condition_config");
  const { fieldPath, operator, expectedType, expectedValue } = config;
  const operators = [
    "exists",
    "equals",
    "not_equals",
    "greater_than",
    "less_than",
    "contains",
  ];
  if (
    !validFieldPath(fieldPath) ||
    typeof operator !== "string" ||
    !operators.includes(operator)
  )
    return bad("invalid_condition_config");
  const keys =
    operator === "exists"
      ? ["fieldPath", "operator"]
      : ["fieldPath", "operator", "expectedType", "expectedValue"];
  if (
    Reflect.ownKeys(config).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(config, key))
  )
    return bad("invalid_condition_config");
  if (operator !== "exists") {
    const validExpected =
      (expectedType === "null" && expectedValue === null) ||
      (expectedType === "boolean" && typeof expectedValue === "boolean") ||
      (expectedType === "number" &&
        typeof expectedValue === "number" &&
        Number.isFinite(expectedValue)) ||
      (expectedType === "string" &&
        typeof expectedValue === "string" &&
        scalarString(expectedValue));
    if (
      !validExpected ||
      ((operator === "greater_than" || operator === "less_than") &&
        expectedType !== "number") ||
      (operator === "contains" && expectedType !== "string")
    )
      return bad("invalid_condition_config");
  }
  const value = lookup(content, fieldPath);
  if (value === invalid) return bad("invalid_condition_value");
  if (value === missing) return { ok: true, value: false };
  if (operator === "exists") return { ok: true, value: true };
  if (operator === "equals" || operator === "not_equals") {
    if (
      value !== null &&
      expectedValue !== null &&
      typeof value !== typeof expectedValue
    )
      return bad("condition_type_mismatch");
    const equal = value === expectedValue;
    return { ok: true, value: operator === "equals" ? equal : !equal };
  }
  if (operator === "contains") {
    if (typeof value !== "string" || typeof expectedValue !== "string")
      return bad("condition_type_mismatch");
    return { ok: true, value: value.includes(expectedValue) };
  }
  if (typeof value !== "number" || typeof expectedValue !== "number")
    return bad("condition_type_mismatch");
  return {
    ok: true,
    value:
      operator === "greater_than"
        ? value > expectedValue
        : value < expectedValue,
  };
}
