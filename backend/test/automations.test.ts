import { describe, it, expect, vi } from "vitest";
import type pg from "pg";
import { api } from "../src/api.js";
import { readFile } from "node:fs/promises";
import {
  createSchema,
  updateSchema,
  params,
  query,
  response,
} from "../src/automations.js";
const valid = {
  scope: "demo",
  name: "Receipt",
  schemaVersion: 1,
  trigger: { type: "receipt.v1" },
  action: { type: "record-receipt.v1" },
};
describe("automation request validation", () => {
  it("publishes the schemas used by the routes", async () => {
    const contract = JSON.parse(
      await readFile(
        new URL("../schemas/automation-v1.schema.json", import.meta.url),
        "utf8",
      ),
    );
    expect(contract.definitions).toEqual({
      create: createSchema,
      update: updateSchema,
      params,
      query,
      response,
    });
  });
  it("rejects invalid configurations before accessing storage", async () => {
    const app = api({} as pg.Pool);
    const invalid = [
      { ...valid, unknown: true },
      { ...valid, scope: " " },
      { ...valid, name: "x".repeat(201) },
      { ...valid, schemaVersion: 2 },
      { ...valid, trigger: { type: "other" } },
      {
        ...valid,
        action: { type: "record-receipt.v1", url: "https://example.com" },
      },
      { ...valid, active: true },
    ];
    for (const payload of invalid)
      expect(
        (await app.inject({ method: "POST", url: "/automations", payload }))
          .statusCode,
      ).toBe(400);
    for (const url of [
      "/automations",
      "/automations?scope=",
      "/automations?scope=x&other=x",
      "/automations/not-a-uuid",
      "/automations/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa%0a",
    ])
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/automations/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          payload: { ...valid, expectedRevision: 1, active: true },
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
  });
  it("rejects unsafe text and boundaries without calling storage", async () => {
    const pool = { connect: vi.fn(), query: vi.fn() };
    const app = api(pool as unknown as pg.Pool);
    const update = {
      name: valid.name,
      schemaVersion: valid.schemaVersion,
      trigger: valid.trigger,
      action: valid.action,
      active: true,
      expectedRevision: 1,
    };
    for (const value of ["\u0000", "\ud800", "\udfff"]) {
      for (const field of ["name", "scope"]) {
        const result = await app.inject({
          method: "POST",
          url: "/automations",
          payload: { ...valid, [field]: `x${value}y` },
        });
        expect(result.statusCode).toBe(400);
      }
      const result = await app.inject({
        method: "PUT",
        url: "/automations/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        payload: { ...update, name: `x${value}y` },
      });
      expect(result.statusCode).toBe(400);
    }
    const requests = [
      { method: "GET" as const, url: "/automations?scope=x%00y" },
      ...["", " ", "x".repeat(129)].map((scope) => ({
        method: "POST" as const,
        url: "/automations",
        payload: { ...valid, scope },
      })),
      ...["", " ", "x".repeat(201)].map((name) => ({
        method: "POST" as const,
        url: "/automations",
        payload: { ...valid, name },
      })),
      ...[0, 2147483647, 1.5].map((expectedRevision) => ({
        method: "PUT" as const,
        url: "/automations/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        payload: { ...update, expectedRevision },
      })),
    ];
    for (const request of requests)
      expect((await app.inject(request)).statusCode).toBe(400);
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
    await app.close();
  });
});
