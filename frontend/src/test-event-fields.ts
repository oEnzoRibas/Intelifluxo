import type { Definition } from "./automation-api";
import { fieldPathValid } from "./condition-contract";
import { validEventData, type EventData, type JsonValue } from "./event-data";

export type FieldValue = {
  type: "string" | "number" | "boolean" | "null" | "missing";
  value: string;
};
export function readTestField(
  data: EventData | undefined,
  path: string | null,
): FieldValue {
  let value: JsonValue | undefined = data;
  for (const part of path?.split(".").slice(1) ?? []) {
    value =
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.hasOwn(value, part)
        ? (value as EventData)[part]
        : undefined;
  }
  if (!path || value === undefined) return { type: "missing", value: "" };
  if (value === null) return { type: "null", value: "" };
  if (typeof value === "object") return { type: "missing", value: "" };
  return {
    type: typeof value as "string" | "number" | "boolean",
    value: String(value),
  };
}
export function conditionTestField(definition: Definition) {
  const node = definition.graph.nodes.find((n) => n.kind === "condition");
  if (!node || !("config" in node) || !node.config) return null;
  const config = node.config;
  if (!("operator" in config)) return null;
  const path =
    "input" in config
      ? config.input.source === "event"
        ? config.input.fieldPath
        : null
      : config.fieldPath;
  if (!path?.startsWith("data.")) return null;
  return {
    path,
    type:
      config.operator === "exists" ? ("string" as const) : config.expectedType,
  };
}

/** Build nested data without losing scalar types or silently overwriting a parent. */
export function testEventData(
  fields: Array<{ path: string; input: FieldValue }>,
): EventData | undefined {
  if (!fields.length) return undefined;
  const data: Record<string, JsonValue> = {};
  for (const { path, input } of fields) {
    if (!fieldPathValid(path) || !path.startsWith("data."))
      throw new Error("Campo incompatível com os dados do evento.");
    if (input.type === "missing") continue;
    let value: JsonValue = input.value;
    if (input.type === "number") {
      if (!input.value.trim() || !Number.isFinite(Number(input.value)))
        throw new Error(`Informe um número válido para ${path}.`);
      value = Number(input.value);
    } else if (input.type === "boolean") value = input.value === "true";
    else if (input.type === "null") value = null;
    let target = data;
    const segments = path.split(".").slice(1);
    for (const segment of segments.slice(0, -1)) {
      if (!Object.hasOwn(target, segment)) target[segment] = {};
      const next = target[segment];
      if (!next || typeof next !== "object" || Array.isArray(next))
        throw new Error(
          "Os campos do teste têm caminhos sobrepostos. Revise a configuração.",
        );
      target = next as Record<string, JsonValue>;
    }
    const key = segments.at(-1)!;
    if (Object.hasOwn(target, key))
      throw new Error(
        "Os campos do teste têm caminhos sobrepostos. Revise a configuração.",
      );
    target[key] = value;
  }
  if (!validEventData(data))
    throw new Error(
      "Dados inválidos: use até 4 KB, campos de até 1024 caracteres e até 7 níveis.",
    );
  return data;
}
