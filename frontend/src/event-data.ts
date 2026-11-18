/** The event API accepts a bounded JSON object, not arbitrary JavaScript values. */
export type EventData = { readonly [key: string]: JsonValue };
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | EventData
  | readonly JsonValue[];

export function validEventData(value: unknown): value is EventData {
  const seen = new Set<object>();
  function visit(v: unknown, depth: number): boolean {
    if (v === null || typeof v === "boolean") return true;
    if (typeof v === "number") return Number.isFinite(v);
    if (typeof v === "string")
      return (
        [...v].length <= 1024 &&
        !v.includes("\0") &&
        !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
          v,
        )
      );
    if (typeof v !== "object" || depth > 7 || seen.has(v)) return false;
    const proto: unknown = Object.getPrototypeOf(v);
    if (
      Array.isArray(v)
        ? proto !== Array.prototype
        : proto !== Object.prototype && proto !== null
    )
      return false;
    if (Reflect.ownKeys(v).some((k) => typeof k !== "string")) return false;
    seen.add(v);
    const entries = Object.getOwnPropertyDescriptors(v);
    const valid = Array.isArray(v)
      ? Object.keys(entries).length === v.length + 1 &&
        Array.from({ length: v.length }, (_, i) => entries[String(i)]).every(
          (d) => d && "value" in d && visit(d.value, depth + 1),
        )
      : Object.entries(entries).every(
          ([key, d]) =>
            /^[A-Za-z_][A-Za-z0-9_]{0,63}$(?![\s\S])/.test(key) &&
            !["__proto__", "prototype", "constructor"].includes(key) &&
            "value" in d &&
            d.enumerable &&
            visit(d.value, depth + 1),
        );
    seen.delete(v);
    return valid;
  }
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    visit(value, 1) &&
    new TextEncoder().encode(JSON.stringify(value)).length <= 4096
  );
}

/** Copy as well as freeze so caller edits cannot change an uncertain request. */
export function freezeEventData(data: EventData): EventData {
  function copy(v: JsonValue): JsonValue {
    if (v === null || typeof v !== "object") return v;
    return Object.freeze(
      Array.isArray(v)
        ? v.map(copy)
        : Object.fromEntries(
            Object.entries(v).map(([key, value]) => [key, copy(value)]),
          ),
    );
  }
  return copy(data) as EventData;
}
