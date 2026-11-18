// Provider-independent validation only. This module does not perform network I/O
// or enable v3 workflows; the transport and persistence guards remain required.
export const VIACEP_BODY_LIMIT = 16_384;

export function normalizeCep(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !/^(?:[0-9]{8}|[0-9]{5}-[0-9]{3})(?![\s\S])/.test(value)
  )
    return null;
  return value.replace("-", "");
}

const fields = [
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
] as const;
type AddressField = (typeof fields)[number];
export type ViaCepAddress = Partial<Record<AddressField, string>> & {
  cep: string;
};
export type ViaCepProjection =
  | { status: "found"; address: ViaCepAddress }
  | { status: "not_found" }
  | { status: "invalid_response" };

function validString(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Array.from(value).length > 1024
  )
    return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

/** Parse a complete, already bounded response. Streaming limits belong to the transport. */
export function projectViaCep(
  body: Uint8Array,
  requestedCep: string,
): ViaCepProjection {
  const invalid: ViaCepProjection = { status: "invalid_response" };
  if (
    body.byteLength > VIACEP_BODY_LIMIT ||
    normalizeCep(requestedCep) !== requestedCep
  )
    return invalid;
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(body),
    ) as unknown;
  } catch {
    return invalid;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return invalid;
  const record = value as Record<string, unknown>;
  if (
    ["__proto__", "constructor", "prototype"].some((key) =>
      Object.hasOwn(record, key),
    )
  )
    return invalid;
  if (Object.hasOwn(record, "erro")) {
    return record.erro === true &&
      !fields.some((key) => Object.hasOwn(record, key))
      ? { status: "not_found" }
      : invalid;
  }
  if (
    !Object.hasOwn(record, "cep") ||
    !validString(record.cep) ||
    normalizeCep(record.cep) !== requestedCep
  )
    return invalid;
  const address: ViaCepAddress = { cep: record.cep };
  for (const key of fields) {
    if (!Object.hasOwn(record, key)) continue;
    const field = record[key];
    if (!validString(field)) return invalid;
    address[key] = field;
  }
  return { status: "found", address };
}
