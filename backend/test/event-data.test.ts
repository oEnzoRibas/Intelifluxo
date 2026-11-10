import { describe, expect, it } from "vitest";
import type pg from "pg";
import { api } from "../src/api.js";
import { content, validEventData } from "../src/contract.js";

const input = {
  scope: "s",
  idempotencyKey: "k",
  type: "receipt.v1" as const,
  target: "local-receipt" as const,
  message: "m",
};

describe("optional event data", () => {
  it("preserves omission and typed nested data", () => {
    expect(content(input)).toEqual({
      type: "receipt.v1",
      target: "local-receipt",
      message: "m",
    });
    expect(content({ ...input, data: {} })).toHaveProperty("data", {});
    expect(
      validEventData({
        valor: 150,
        nested: { active: true, note: null },
        list: [1, "😀"],
      }),
    ).toBe(true);
  });
  it("bounds keys, depth, values and compact UTF-8 bytes", () => {
    expect(validEventData(JSON.parse('{"constructor": 1}'))).toBe(false);
    expect(validEventData({ nested: [{ "bad.key": 1 }] })).toBe(false);
    expect(validEventData({ "bad\n": 1 })).toBe(false);
    expect(validEventData({ a: { b: { c: { d: { e: { f: {} } } } } } })).toBe(
      true,
    );
    expect(
      validEventData({ a: { b: { c: { d: { e: { f: { g: {} } } } } } } }),
    ).toBe(false);
    expect(validEventData({ a: Infinity })).toBe(false);
    expect(validEventData({ a: "\ud800" })).toBe(false);
    expect(validEventData({ a: "x".repeat(1025) })).toBe(false);
    expect(
      validEventData({
        a: "x".repeat(1024),
        b: "x".repeat(1024),
        c: "x".repeat(1024),
        d: "x".repeat(1024),
      }),
    ).toBe(false);
    expect(
      validEventData({
        get a() {
          throw new Error("must not invoke");
        },
      }),
    ).toBe(false);
  });
  it("rejects malformed data before storage over HTTP", async () => {
    const app = api({} as pg.Pool);
    try {
      for (const data of [
        null,
        [],
        5,
        { a: "\u0000" },
        { a: { "bad.key": 2 } },
      ]) {
        const response = await app.inject({
          method: "POST",
          url: "/events",
          payload: { ...input, data },
        });
        expect(response.statusCode).toBe(400);
      }
      const overflow = await app.inject({
        method: "POST",
        url: "/events",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify(input).replace(/}$/, ',"data":{"n":1e400}}'),
      });
      expect(overflow.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
