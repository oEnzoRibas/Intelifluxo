// Published contract is stricter than the serializer schemas used by the API.
// Draft-07 cannot compare node IDs with edge endpoints: consumers must also run
// graph-v2 semantic validation before accepting or executing a definition.
const id = {
  type: "string",
  pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}(?![\\s\\S])",
};
const position = {
  type: "object",
  additionalProperties: false,
  required: ["x", "y"],
  properties: {
    x: { type: "number", minimum: -10000, maximum: 10000 },
    y: { type: "number", minimum: -10000, maximum: 10000 },
  },
};
const fieldPath = {
  type: "string",
  maxLength: 256,
  pattern:
    "^(?!(?:.*\\.)?(?:__proto__|prototype|constructor)(?:\\.|(?![\\s\\S])))[A-Za-z_][A-Za-z0-9_]{0,63}(?:\\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,7}(?![\\s\\S])",
};
const stringValue = {
  type: "string",
  maxLength: 1024,
  pattern:
    "^(?:[^\\u0000\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])*(?![\\s\\S])",
};
const variants = [
  { operator: ["equals", "not_equals"], type: "null", value: { type: "null" } },
  {
    operator: ["equals", "not_equals"],
    type: "boolean",
    value: { type: "boolean" },
  },
  {
    operator: ["equals", "not_equals", "greater_than", "less_than"],
    type: "number",
    value: { type: "number" },
  },
  {
    operator: ["equals", "not_equals", "contains"],
    type: "string",
    value: stringValue,
  },
];
const config = {
  type: "object",
  additionalProperties: false,
  required: ["fieldPath", "operator"],
  properties: {
    fieldPath,
    operator: { type: "string" },
    expectedType: { type: "string" },
    expectedValue: {},
  },
  oneOf: [
    {
      properties: { operator: { const: "exists" } },
      not: {
        anyOf: [
          { required: ["expectedType"] },
          { required: ["expectedValue"] },
        ],
      },
    },
    ...variants.map(({ operator, type, value }) => ({
      required: ["expectedType", "expectedValue"],
      properties: {
        operator: { enum: operator },
        expectedType: { const: type },
        expectedValue: value,
      },
    })),
  ],
};
const kinds = [
  ["trigger", "receipt.v1"],
  ["condition", "condition.v1"],
  ["action", "record-receipt.v1"],
  ["end", "end.v1"],
];
const nodes = kinds.map(([kind, type]) => ({
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "kind",
    "type",
    "position",
    ...(kind === "condition" ? ["config"] : []),
  ],
  properties: {
    id,
    kind: { const: kind },
    type: { const: type },
    position,
    ...(kind === "condition" ? { config } : {}),
  },
}));
// Draft-07 has no maxContains; enumerate the two port positions instead.
const portLayouts = Array.from({ length: 4 }, (_, trueIndex) =>
  Array.from({ length: 4 }, (_, falseIndex) =>
    trueIndex === falseIndex
      ? null
      : {
          items: Array.from({ length: 4 }, (_, index) =>
            index === trueIndex || index === falseIndex
              ? {
                  required: ["sourcePort"],
                  properties: {
                    sourcePort: {
                      const: index === trueIndex ? "TRUE" : "FALSE",
                    },
                  },
                }
              : { not: { required: ["sourcePort"] } },
          ),
        },
  ).filter((layout) => layout !== null),
).flat();
export const publishedGraphV2 = {
  description:
    "Draft-07 cannot enforce ID uniqueness or edge-to-node topology; validate graph-v2 semantics before use.",
  type: "object",
  additionalProperties: false,
  required: ["version", "nodes", "edges"],
  properties: {
    version: { const: 2 },
    nodes: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      items: { oneOf: nodes },
      allOf: kinds.map(([kind]) => ({
        contains: { properties: { kind: { const: kind } }, required: ["kind"] },
      })),
    },
    edges: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      uniqueItems: true,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source", "target"],
        properties: {
          source: id,
          target: id,
          sourcePort: { enum: ["TRUE", "FALSE"] },
        },
      },
      anyOf: portLayouts,
    },
  },
};

// Graph may be omitted only for v1. A supplied graph must match schemaVersion.
export const versionPairing = {
  allOf: [
    {
      if: {
        properties: { schemaVersion: { const: 2 } },
        required: ["schemaVersion"],
      },
      then: {
        required: ["graph"],
        properties: { graph: { properties: { version: { const: 2 } } } },
      },
    },
    {
      if: {
        properties: { schemaVersion: { const: 1 } },
        required: ["schemaVersion"],
      },
      then: {
        properties: { graph: { properties: { version: { const: 1 } } } },
      },
    },
  ],
};
