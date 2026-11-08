import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { api } from "../src/api.js";
describe.skipIf(process.env.INTEGRATION !== "1")(
  "automation definitions PostgreSQL",
  () => {
    const schema = `test_${randomUUID().replaceAll("-", "")}`;
    let admin: pg.Pool;
    let pool: pg.Pool;
    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        options: `-c search_path=${schema}`,
      });
      const migration = await readFile(
        new URL(
          "../migrations/004_automation_definitions.sql",
          import.meta.url,
        ),
        "utf8",
      );
      await pool.query(migration);
      await pool.query(migration);
    });
    afterAll(async () => {
      await pool?.end();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
      }
    });
    it("rejects unsafe text and accepts valid Unicode and length boundaries", async () => {
      const app = api(pool);
      const config = {
        name: "x",
        schemaVersion: 1,
        trigger: { type: "receipt.v1" },
        action: { type: "record-receipt.v1" },
      };
      for (const value of ["\u0000", "\ud800", "\udfff"]) {
        for (const field of ["name", "scope"]) {
          const result = await app.inject({
            method: "POST",
            url: "/automations",
            payload: { scope: "x", ...config, [field]: `x${value}y` },
          });
          expect(result.statusCode).toBe(400);
          expect(result.body).not.toContain("PostgreSQL");
        }
        const result = await app.inject({
          method: "PUT",
          url: `/automations/${randomUUID()}`,
          payload: {
            ...config,
            name: `x${value}y`,
            active: true,
            expectedRevision: 1,
          },
        });
        expect(result.statusCode).toBe(400);
      }
      expect(
        (await app.inject({ method: "GET", url: "/automations?scope=x%00y" }))
          .statusCode,
      ).toBe(400);
      for (const [scope, name] of [
        ["x", "x"],
        ["s".repeat(127) + "😀", "n".repeat(199) + "😀"],
      ]) {
        const created = await app.inject({
          method: "POST",
          url: "/automations",
          payload: { scope, ...config, name },
        });
        expect(created.statusCode).toBe(201);
        expect(created.json()).toMatchObject({ scope, name });
        expect(
          (
            await app.inject({
              method: "GET",
              url: `/automations?scope=${encodeURIComponent(scope)}`,
            })
          ).statusCode,
        ).toBe(200);
        const update = await app.inject({
          method: "PUT",
          url: `/automations/${created.json().id}`,
          payload: { ...config, name, active: true, expectedRevision: 1 },
        });
        expect(update.statusCode).toBe(200);
        const conflict = await app.inject({
          method: "PUT",
          url: `/automations/${created.json().id}`,
          payload: {
            ...config,
            name,
            active: true,
            expectedRevision: 2147483646,
          },
        });
        expect(conflict.statusCode).toBe(409);
      }
      await app.close();
    });
    it("creates, lists, updates concurrently, activates, deactivates and preserves history", async () => {
      const app = api(pool);
      const config = {
        name: "Receipt",
        schemaVersion: 1,
        trigger: { type: "receipt.v1" },
        action: { type: "record-receipt.v1" },
      };
      const body = { scope: "demo", ...config };
      const created = await app.inject({
        method: "POST",
        url: "/automations",
        payload: body,
      });
      expect(created.statusCode).toBe(201);
      const first = created.json();
      expect(first).toMatchObject({
        scope: "demo",
        revision: 1,
        active: false,
        ...config,
      });
      expect(
        (
          await app.inject({ method: "GET", url: `/automations/${first.id}` })
        ).json(),
      ).toEqual(first);
      expect(
        (
          await app.inject({ method: "GET", url: "/automations?scope=other" })
        ).json(),
      ).toEqual({ items: [] });
      expect(
        (
          await app.inject({ method: "GET", url: "/automations?scope=demo" })
        ).json(),
      ).toEqual({ items: [first] });
      const update = { ...config, active: true, expectedRevision: 1 };
      const concurrent = await Promise.all(
        [1, 2].map(() =>
          app.inject({
            method: "PUT",
            url: `/automations/${first.id}`,
            payload: update,
          }),
        ),
      );
      expect(concurrent.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      expect(concurrent.find((r) => r.statusCode === 409)?.json()).toEqual({
        error: "revision_conflict",
      });
      const second = concurrent.find((r) => r.statusCode === 200)?.json();
      expect(second).toMatchObject({ id: first.id, revision: 2, active: true });
      const off = await app.inject({
        method: "PUT",
        url: `/automations/${first.id}`,
        payload: {
          ...update,
          expectedRevision: 2,
          active: false,
          name: "Changed",
        },
      });
      expect(off.json()).toMatchObject({
        revision: 3,
        active: false,
        name: "Changed",
        scope: "demo",
      });
      const history = await pool.query(
        "SELECT revision,name,active FROM automation_definition_revisions WHERE automation_id=$1 ORDER BY revision",
        [first.id],
      );
      expect(history.rows).toEqual([
        { revision: 1, name: "Receipt", active: false },
        { revision: 2, name: "Receipt", active: true },
        { revision: 3, name: "Changed", active: false },
      ]);
      await expect(
        pool.query(
          "UPDATE automation_definition_revisions SET name='bad' WHERE automation_id=$1",
          [first.id],
        ),
      ).rejects.toThrow();
      await expect(
        pool.query(
          "DELETE FROM automation_definition_revisions WHERE automation_id=$1",
          [first.id],
        ),
      ).rejects.toThrow();
      await expect(
        pool.query(
          "UPDATE automation_definitions SET scope='bad' WHERE id=$1",
          [first.id],
        ),
      ).rejects.toThrow();
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/automations/${randomUUID()}`,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `/automations/${randomUUID()}`,
            payload: update,
          })
        ).statusCode,
      ).toBe(404);
      await app.close();
    });
  },
);
