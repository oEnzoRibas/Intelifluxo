export type Input = {
  scope: string;
  idempotencyKey: string;
  type: "receipt.v1";
  target: "local-receipt";
  message: string;
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
  },
} as const;

// The only content fields are explicit; scope and key define identity, not content.
export function content(input: Input) {
  return { type: input.type, target: input.target, message: input.message };
}
