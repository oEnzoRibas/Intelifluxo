import { expect, it } from "vitest";
import { testEventData, readTestField } from "./test-event-fields";
import { newTestEventIntent } from "./test-event-api";
import { validEventData } from "./event-data";
import {
  readIntent,
  intentSlot,
  resetIntentRegistryForTests,
  sameIntentEnvelope,
} from "./test-event-intent-registry";

it("constructs nested CEP and typed condition values without coercing text", () => {
  expect(
    testEventData([
      {
        path: "data.delivery.cep",
        input: { type: "string", value: "01001000" },
      },
      { path: "data.order.total", input: { type: "number", value: "150.5" } },
      { path: "data.approved", input: { type: "boolean", value: "false" } },
      { path: "data.note", input: { type: "null", value: "" } },
      { path: "data.omitted", input: { type: "missing", value: "" } },
    ]),
  ).toEqual({
    delivery: { cep: "01001000" },
    order: { total: 150.5 },
    approved: false,
    note: null,
  });
});
it.each(["", "  ", "NaN", "Infinity", "abc"])(
  "rejects invalid numeric test input %s",
  (value) => {
    expect(() =>
      testEventData([{ path: "data.total", input: { type: "number", value } }]),
    ).toThrow();
  },
);
it.each(["data.__proto__.x", "data.constructor", "payload.cep"])(
  "rejects unsupported or unsafe paths %s",
  (path) => {
    expect(() =>
      testEventData([{ path, input: { type: "string", value: "x" } }]),
    ).toThrow();
  },
);
it("rejects overlapping paths in either order", () => {
  const fields = ["data.delivery", "data.delivery.cep"].map((path) => ({
    path,
    input: { type: "string" as const, value: "x" },
  }));
  expect(() => testEventData(fields)).toThrow(/sobrepostos/);
  expect(() => testEventData(fields.reverse())).toThrow(/sobrepostos/);
});
it("copies and deeply freezes payloads and restores every value after remount", () => {
  resetIntentRegistryForTests();
  const source = { order: { total: 150 }, cep: "01001000" };
  const intent = newTestEventIntent("local", "pedido", undefined, source);
  source.order.total = 999;
  expect(intent.data?.order).toEqual({ total: 150 });
  expect(Object.isFrozen(intent.data?.order)).toBe(true);
  const envelope = {
    version: 1 as const,
    definitionId: "11111111-1111-4111-8111-111111111111",
    owner: crypto.randomUUID(),
    context: {
      version: 1 as const,
      definitionRevision: 2,
      inputContract: "event-data-v1" as const,
    },
    intent,
  };
  const slot = intentSlot(envelope.definitionId, "local");
  const storage = new Map([[slot, JSON.stringify(envelope)]]);
  const restored = readIntent(slot, () => ({
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => {
      storage.set(key, value);
    },
    removeItem: (key) => {
      storage.delete(key);
    },
  })).envelope!;
  expect(restored).toEqual(envelope);
  expect(readTestField(restored.intent.data, "data.order.total")).toEqual({
    type: "number",
    value: "150",
  });
  expect(Object.isFrozen(restored.intent.data?.order)).toBe(true);
  expect(
    sameIntentEnvelope(envelope, {
      ...envelope,
      intent: { ...intent, data: { ...intent.data, order: { total: 999 } } },
    }),
  ).toBe(false);
});
it("applies the API bounds before sending or recovering data", () => {
  expect(validEventData({ note: "x".repeat(1025) })).toBe(false);
  expect(validEventData({ a: "á".repeat(1024), b: "á".repeat(1024) })).toBe(
    false,
  );
  expect(validEventData(JSON.parse('{"__proto__":{"polluted":true}}'))).toBe(
    false,
  );
  expect(validEventData({ a: Infinity })).toBe(false);
  expect(validEventData({ a: "\ud800" })).toBe(false);
  expect(
    validEventData({ a: { b: { c: { d: { e: { f: { g: {} } } } } } } }),
  ).toBe(false);
});
