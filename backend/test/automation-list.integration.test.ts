import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api } from "../src/api.js";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

describe.skipIf(process.env.INTEGRATION !== "1")(
  "summary list PostgreSQL",
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
      for (const migration of [
        "004_automation_definitions.sql",
        "006_automation_graph.sql",
      ]) {
        await pool.query(
          await readFile(
            new URL(`../migrations/${migration}`, import.meta.url),
            "utf8",
          ),
        );
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (let n = 205; n >= 1; n--) {
          const scope = n === 1 ? "special%_!\\scope" : n % 2 ? "one" : "two";
          await client.query(
            "INSERT INTO automation_definitions(id,scope,current_revision) VALUES ($1,$2,1)",
            [id(n), scope],
          );
          await client.query(
            "INSERT INTO automation_definition_revisions(automation_id,revision,name,active,schema_version,trigger_type,action_type) VALUES ($1,1,$2,$3,1,'receipt.v1','record-receipt.v1')",
            [id(n), n === 2 ? "Hello%_!\\World" : `Name ${n}`, n % 2 === 0],
          );
        }
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    });
    afterAll(async () => {
      await pool?.end();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
      }
    });
    it("paginates sorted current heads with literal searches, filters, and live revision changes", async () => {
      const app = api(pool);
      const get = async (query = "") => {
        const result = await app.inject(`/automations/list${query}`);
        expect(result.statusCode).toBe(200);
        return result.json();
      };
      expect(await get("?scope=absent")).toEqual({
        items: [],
        nextCursor: null,
      });
      const literal = encodeURIComponent("%_!\\");
      expect(
        (await get(`?q=${literal}`)).items.map((x: { id: string }) => x.id),
      ).toEqual([id(1), id(2)]);
      expect((await get("?q=hELLo")).items[0].id).toBe(id(2));
      expect(
        (await get("?q=ONE&active=false&scope=one&limit=100")).items,
      ).toHaveLength(100);
      expect((await get("?scope=ONE")).items).toHaveLength(0);
      const first = await get("?limit=1");
      expect(first.nextCursor).toBe(id(1));
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const n of [1, 2]) {
          await client.query(
            "INSERT INTO automation_definition_revisions(automation_id,revision,name,active,schema_version,trigger_type,action_type) VALUES ($1,2,$2,true,1,'receipt.v1','record-receipt.v1')",
            [id(n), `Updated ${n}`],
          );
          await client.query(
            "UPDATE automation_definitions SET current_revision=2 WHERE id=$1",
            [id(n)],
          );
        }
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      const second = await get(`?limit=1&cursor=${first.nextCursor}`);
      expect(second.items[0]).toMatchObject({
        id: id(2),
        name: "Updated 2",
        active: true,
        revision: 2,
        workflowVersion: 1,
      });
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await get(`?limit=25${cursor ? `&cursor=${cursor}` : ""}`);
        ids.push(...page.items.map((x: { id: string }) => x.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(ids).toEqual(Array.from({ length: 205 }, (_, i) => id(i + 1)));
      expect(await get(`?cursor=${id(999)}`)).toEqual({
        items: [],
        nextCursor: null,
      });
      const legacy = await app.inject("/automations?scope=one");
      expect(legacy.statusCode).toBe(200);
      expect(Object.keys(legacy.json())).toEqual(["items"]);
      expect(legacy.json().items).toHaveLength(100);
      await app.close();
    });
  },
);
