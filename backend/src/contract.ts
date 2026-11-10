export type Input = {
  scope: string;
  idempotencyKey: string;
  type: "receipt.v1";
  target: "local-receipt";
  message: string;
  data?: Record<string, unknown>;
};

export const requestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["scope", "idempotencyKey", "type", "target", "message"],
  properties: {
    scope: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: "^[A-Za-z0-9_-]+(?![\\s\\S])",
    },
    idempotencyKey: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9_-]+(?![\\s\\S])",
    },
    type: { const: "receipt.v1", type: "string" },
    target: { const: "local-receipt", type: "string" },
    message: {
      type: "string",
      minLength: 1,
      maxLength: 1024,
      pattern: "^[^\\u0000\\uD800-\\uDFFF]+$",
    },
    data: { type: "object" },
  },
} as const;

// Scope and key define identity, not content. Omission differs from an empty object.
export function content(input: Input) {
  const base = {
    type: input.type,
    target: input.target,
    message: input.message,
  };
  return Object.hasOwn(input, "data") ? { ...base, data: input.data } : base;
}

// Validate parsed data without following prototypes, invoking accessors or coercing values.
export function validEventData(value: unknown): boolean {
  const forbidden = new Set(["__proto__", "prototype", "constructor"]);
  const keyPattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}(?![\s\S])/;
  const seen = new Set<object>();
  function visit(v: unknown, depth: number): boolean {
    if (v === null || typeof v === "boolean") return true;
    if (typeof v === "number") return Number.isFinite(v);
    if (typeof v === "string") {
      if (v.includes("\0") || Array.from(v).length > 1024) return false;
      for (let i = 0; i < v.length; i++) {
        const c = v.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
          const next = v.charCodeAt(++i);
          if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
        } else if (c >= 0xdc00 && c <= 0xdfff) return false;
      }
      return true;
    }
    if (typeof v !== "object" || depth > 7 || seen.has(v)) return false;
    const proto: unknown = Object.getPrototypeOf(v);
    if (
      Array.isArray(v)
        ? proto !== Array.prototype
        : proto !== Object.prototype && proto !== null
    )
      return false;
    seen.add(v);
    const descriptors = Object.getOwnPropertyDescriptors(v);
    if (Reflect.ownKeys(v).some((key) => typeof key !== "string")) return false;
    if (Array.isArray(v)) {
      if (Object.keys(descriptors).length !== v.length + 1) return false;
      for (let i = 0; i < v.length; i++) {
        const d = descriptors[String(i)];
        if (!d || !("value" in d) || !visit(d.value, depth + 1)) return false;
      }
    } else {
      for (const [key, d] of Object.entries(descriptors)) {
        if (
          !keyPattern.test(key) ||
          forbidden.has(key) ||
          !("value" in d) ||
          !d.enumerable ||
          !visit(d.value, depth + 1)
        )
          return false;
      }
    }
    seen.delete(v);
    return true;
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !visit(value, 1)
  )
    return false;
  return Buffer.byteLength(JSON.stringify(value), "utf8") <= 4096;
}
