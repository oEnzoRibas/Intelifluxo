import { validEventData } from "./contract.js";

export type FormField = {
  key: string;
  label: string;
  type: "text" | "textarea" | "email" | "cep";
  required: boolean;
};
export type FormConfig = {
  title: string;
  description: string;
  city: string;
  fields: FormField[];
};
const cleanText = (
  value: unknown,
  max: number,
  allowEmpty = false,
): value is string =>
  typeof value === "string" &&
  (allowEmpty || value.trim().length > 0) &&
  value.length <= max &&
  !value.includes("\0") &&
  !/[\uD800-\uDFFF]/u.test(value);

export function validForm(value: FormConfig): boolean {
  return (
    cleanText(value.title, 160) &&
    cleanText(value.description, 500, true) &&
    cleanText(value.city, 100) &&
    Array.isArray(value.fields) &&
    value.fields.length >= 1 &&
    value.fields.length <= 12 &&
    new Set(value.fields.map((f) => f.key)).size === value.fields.length &&
    value.fields.every(
      (f) =>
        /^[a-z][a-z0-9_]{0,31}(?![\s\S])/.test(f.key) &&
        !["__proto__", "prototype", "constructor"].includes(f.key) &&
        cleanText(f.label, 80) &&
        ["text", "textarea", "email", "cep"].includes(f.type) &&
        typeof f.required === "boolean",
    ) &&
    value.fields.filter((f) => f.type === "cep").length === 1 &&
    value.fields.some((f) => f.key === "cep" && f.type === "cep" && f.required)
  );
}

export function formData(
  config: FormConfig,
  answers: Record<string, string>,
): Record<string, unknown> | null {
  if (!answers || typeof answers !== "object" || Array.isArray(answers))
    return null;
  if (
    Object.keys(answers).some(
      (key) => !config.fields.some((f) => f.key === key),
    )
  )
    return null;
  const normalized: Record<string, string> = {};
  for (const field of config.fields) {
    const value = Object.hasOwn(answers, field.key) ? answers[field.key] : "";
    if (!cleanText(value, 500, !field.required)) return null;
    if (
      value &&
      field.type === "cep" &&
      !/^(?:[0-9]{8}|[0-9]{5}-[0-9]{3})(?![\s\S])/.test(value)
    )
      return null;
    if (
      value &&
      field.type === "email" &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
    )
      return null;
    normalized[field.key] =
      field.type === "cep" ? value.replace("-", "") : value;
  }
  const data = { cep: normalized.cep, answers };
  return validEventData(data) ? data : null;
}

export function formGraph(city: string) {
  return {
    version: 3,
    nodes: [
      {
        id: "trigger",
        kind: "trigger",
        type: "receipt.v1",
        position: { x: 0, y: 0 },
      },
      {
        id: "lookup",
        kind: "lookup",
        type: "viacep-address.v1",
        position: { x: 0, y: 100 },
        config: { cep: { source: "event", fieldPath: "data.cep" } },
      },
      {
        id: "condition",
        kind: "condition",
        type: "condition.v2",
        position: { x: 0, y: 200 },
        config: {
          input: {
            source: "step",
            nodeId: "lookup",
            fieldPath: "address.localidade",
          },
          operator: "equals",
          expectedType: "string",
          expectedValue: city,
        },
      },
      {
        id: "action",
        kind: "action",
        type: "record-receipt.v1",
        position: { x: 0, y: 300 },
      },
      { id: "end", kind: "end", type: "end.v1", position: { x: 0, y: 400 } },
    ],
    edges: [
      { source: "trigger", target: "lookup" },
      { source: "lookup", target: "condition" },
      { source: "condition", target: "action", sourcePort: "TRUE" },
      { source: "condition", target: "end", sourcePort: "FALSE" },
      { source: "action", target: "end" },
    ],
  };
}
