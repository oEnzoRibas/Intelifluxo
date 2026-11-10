import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { api } from "../src/api.js";
import { listQuery, listResponse } from "../src/automation-list.js";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const row = (n: number) => ({
  id: id(n),
  name: `Name ${n}`,
  scope: "demo",
  active: n % 2 === 0,
  revision: 1,
  schema_version: 1,
  workflow_version: 1,
});

describe("automation summary list", () => {
  it("publishes the actual request and response contracts", async () => {
    const schema = JSON.parse(
      await readFile(
        new URL("../schemas/automation-list-v1.schema.json", import.meta.url),
        "utf8",
      ),
    );
    expect(schema.definitions).toEqual({
      query: listQuery,
      response: listResponse,
    });
  });
  it("validates all inputs before touching storage, including duplicates and escaped unknown paths", async () => {
    const query = vi.fn();
    const app = api({ query } as unknown as pg.Pool);
    for (const suffix of [
      "limit=0",
      "limit=101",
      "limit=01",
      "limit=1.0",
      "limit=1e1",
      "limit=1%0A",
      "active=True",
      "active=1",
      "active=",
      "cursor=ABC",
      "q=%20",
      "scope=",
      "q=%00",
      "limit=1&limit=1",
    ]) {
      const res = await app.inject(`/automations/list?${suffix}`);
      expect(res.statusCode, suffix).toBe(400);
    }
    const res = await app.inject("/automations/list?z=1&a%2Fb=1&limit=0");
    expect(res.json()).toEqual({
      error: "validation_failed",
      issues: ["/a~1b", "/limit", "/z"].map((path) => ({
        code: "invalid_shape",
        path,
      })),
    });
    expect(query).not.toHaveBeenCalled();
    expect((await app.inject("/automations")).statusCode).toBe(400);
    await app.close();
  });
  it("uses bounded SQL and returns an exact summary with last-returned cursor", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row(1), row(2)] });
    const app = api({ query } as unknown as pg.Pool);
    const res = await app.inject(
      `/automations/list?scope=demo&q=${encodeURIComponent("%_!\\'")}&active=false&limit=1&cursor=${id(0)}`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [
        {
          id: id(1),
          name: "Name 1",
          scope: "demo",
          active: false,
          revision: 1,
          schemaVersion: 1,
          workflowVersion: 1,
        },
      ],
      nextCursor: id(1),
    });
    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain("ORDER BY d.id ASC LIMIT $5::integer");
    expect(sql).toContain("ILIKE $4::text ESCAPE '!'");
    expect(values).toEqual([id(0), "demo", false, "%!%!_!!\\'%", 2]);
    query.mockResolvedValueOnce({ rows: [] });
    expect((await app.inject("/automations/list")).json()).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(query.mock.calls[1][1]).toEqual([26]);
    await app.close();
  });
  it("returns sanitized unavailable errors on storage and invariant failures and can recover", async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error("secret"))
      .mockResolvedValueOnce({ rows: [{ ...row(1), workflow_version: 3 }] })
      .mockResolvedValueOnce({ rows: [row(1)] });
    const app = api({ query } as unknown as pg.Pool);
    for (let i = 0; i < 2; i++) {
      const res = await app.inject("/automations/list");
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "unavailable" });
    }
    expect((await app.inject("/automations/list")).statusCode).toBe(200);
    await app.close();
  });
});
