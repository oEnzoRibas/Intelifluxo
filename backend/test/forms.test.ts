import { describe, expect, it } from "vitest";
import type pg from "pg";
import { api } from "../src/api.js";
import {
  formData,
  formGraph,
  validForm,
  type FormConfig,
} from "../src/forms-contract.js";
import { validateGraphV3 } from "../src/graph-v3.js";

const form: FormConfig = {
  title: "Entrega BH",
  description: "Teste",
  city: "Belo Horizonte",
  fields: [
    { key: "cep", label: "CEP", type: "cep", required: true },
    { key: "email", label: "E-mail", type: "email", required: false },
  ],
};
describe("form contract", () => {
  it("requires exactly one mandatory CEP, unique safe keys and bounded fields", () => {
    expect(validForm(form)).toBe(true);
    for (const fields of [
      [],
      [...form.fields, form.fields[0]],
      [{ ...form.fields[0], required: false }],
      [{ ...form.fields[0], key: "constructor" }],
      [{ ...form.fields[0], key: "cep\n" }],
    ])
      expect(validForm({ ...form, fields })).toBe(false);
    expect(validForm({ ...form, title: "x\0y" })).toBe(false);
    expect(validForm({ ...form, title: "Entrega 😀" })).toBe(true);
  });
  it("maps only declared answers, validates data and preserves CEP leading zeros", () => {
    expect(formData(form, { cep: "01001-000" })).toEqual({
      cep: "01001000",
      answers: { cep: "01001-000" },
    });
    for (const answers of [
      { cep: "" },
      { cep: "1234567" },
      { cep: "01001000\n" },
      { cep: "01001000", extra: "x" },
      { cep: "01001000", email: "invalid" },
    ] as Record<string, string>[])
      expect(formData(form, answers)).toBeNull();
  });
  it("builds a valid executable graph reading the response CEP and matching city", () => {
    const graph = formGraph("Belo Horizonte");
    expect(validateGraphV3(graph, "receipt.v1", "record-receipt.v1")).toEqual(
      [],
    );
    expect(graph.nodes[1].config).toEqual({
      cep: { source: "event", fieldPath: "data.cep" },
    });
  });
  it("rejects writes while gates are off before touching the database", async () => {
    const app = api({} as pg.Pool, false, false, false, false);
    const response = await app.inject({
      method: "POST",
      url: "/forms",
      payload: form,
    });
    expect(response.statusCode).toBe(503);
    await app.close();
  });
});
