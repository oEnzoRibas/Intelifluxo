import { describe, expect, it } from "vitest";
import { normalizeCep, projectViaCep } from "../src/viacep-projection.js";

const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
const project = (value: unknown) => projectViaCep(encode(value), "01001000");

describe("ViaCEP isolated input and response validation", () => {
  it.each([
    ["01001000", "01001000"],
    ["01001-000", "01001000"],
    ["00000000", "00000000"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeCep(input)).toBe(expected);
  });
  it.each([
    null,
    true,
    1001000,
    {},
    [],
    "0100100",
    "010010000",
    " 01001000",
    "01001000\n",
    "+01001000",
    "０１００１０００",
    "01001--000",
    "01001000/../",
  ])("rejects invalid CEP %s", (value) => {
    expect(normalizeCep(value)).toBeNull();
  });
  it("preserves present empty strings and omits absent and unknown fields", () => {
    expect(
      project({
        cep: "01001-000",
        complemento: "",
        uf: "SP",
        ibge: "001",
        ignored: "secret",
      }),
    ).toEqual({
      status: "found",
      address: { cep: "01001-000", complemento: "", uf: "SP", ibge: "001" },
    });
  });
  it.each([
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
  ])("preserves empty %s", (field) => {
    expect(project({ cep: "01001000", [field]: "" })).toEqual({
      status: "found",
      address: { cep: "01001000", [field]: "" },
    });
  });
  it.each([{ erro: true }, { erro: true, ignored: "x" }])(
    "recognizes not found",
    (value) => {
      expect(project(value)).toEqual({ status: "not_found" });
    },
  );
  it.each([
    null,
    [],
    "x",
    {},
    { cep: "99999999" },
    { cep: "01001000", uf: null },
    { cep: "01001000", uf: 1 },
    { cep: "01001000", uf: "\ud800" },
    { cep: "01001000", uf: "x".repeat(1025) },
    { erro: false },
    { erro: "true" },
    { erro: true, cep: "01001000" },
    JSON.parse('{"cep":"01001000","__proto__":{}}'),
  ])("rejects invalid response", (value) => {
    expect(project(value)).toEqual({ status: "invalid_response" });
  });
  it("rejects invalid UTF-8, malformed JSON and oversized bodies", () => {
    for (const body of [
      new Uint8Array([0xff]),
      new TextEncoder().encode("{"),
      new Uint8Array(16385),
    ]) {
      expect(projectViaCep(body, "01001000")).toEqual({
        status: "invalid_response",
      });
    }
  });
});
