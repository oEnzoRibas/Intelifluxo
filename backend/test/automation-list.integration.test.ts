import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
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
      const dir = new URL("../migrations/", import.meta.url);
      for (const migration of (await readdir(dir))
        .filter((name) => name.endsWith(".sql"))
        .sort()) {
        await pool.query(await readFile(new URL(migration, dir), "utf8"));
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
    async function transaction(run: (client: pg.PoolClient) => Promise<void>) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await run(client);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
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
    it("returns a v2 current-head summary with conditions writes disabled", async () => {
      const graph = {
        version: 2,
        nodes: [
          {
            id: "t",
            kind: "trigger",
            type: "receipt.v1",
            position: { x: 0, y: 0 },
          },
          {
            id: "c",
            kind: "condition",
            type: "condition.v1",
            position: { x: 1, y: 0 },
            config: {
              fieldPath: "data.value",
              operator: "equals",
              expectedType: "number",
              expectedValue: 42,
            },
          },
          {
            id: "a",
            kind: "action",
            type: "record-receipt.v1",
            position: { x: 2, y: 0 },
          },
          { id: "e", kind: "end", type: "end.v1", position: { x: 3, y: 0 } },
        ],
        edges: [
          { source: "t", target: "c" },
          { source: "c", sourcePort: "TRUE", target: "a" },
          { source: "c", sourcePort: "FALSE", target: "e" },
          { source: "a", target: "e" },
        ],
      };
      await transaction(async (client) => {
        await client.query(
          "INSERT INTO automation_definitions(id,scope,current_revision) VALUES ($1,'v2-only',2)",
          [id(300)],
        );
        await client.query(
          "INSERT INTO automation_definition_revisions(automation_id,revision,name,active,schema_version,trigger_type,action_type,graph) VALUES ($1,1,'old',false,1,'receipt.v1','record-receipt.v1',NULL), ($1,2,'current',false,2,'receipt.v1','record-receipt.v1',$2)",
          [id(300), JSON.stringify(graph)],
        );
      });
      const app = api(pool, false, false);
      try {
        const res = await app.inject("/automations/list?scope=v2-only");
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
          items: [
            {
              id: id(300),
              name: "current",
              scope: "v2-only",
              active: false,
              revision: 2,
              schemaVersion: 2,
              workflowVersion: 2,
            },
          ],
          nextCursor: null,
        });
      } finally {
        await app.close();
      }
    });
    it("treats quotes in name and scope searches as literal text", async () => {
      await transaction(async (client) => {
        await client.query(
          "INSERT INTO automation_definitions(id,scope,current_revision) VALUES ($1,$2,1),($3,$4,1)",
          [id(301), "quote-scope", id(302), "quote's scope"],
        );
        await client.query(
          "INSERT INTO automation_definition_revisions(automation_id,revision,name,active,schema_version,trigger_type,action_type) VALUES ($1,1,$2,false,1,'receipt.v1','record-receipt.v1'),($3,1,$4,false,1,'receipt.v1','record-receipt.v1')",
          [id(301), "quote's name", id(302), "other"],
        );
      });
      const app = api(pool);
      try {
        const res = await app.inject(
          `/automations/list?q=${encodeURIComponent("quote's")}`,
        );
        expect(res.statusCode).toBe(200);
        expect(res.json().items.map((item: { id: string }) => item.id)).toEqual(
          [id(301), id(302)],
        );
      } finally {
        await app.close();
      }
    });
    it("returns an empty continuation when unseen matches leave the filter", async () => {
      await transaction(async (client) => {
        await client.query(
          "INSERT INTO automation_definitions(id,scope,current_revision) VALUES ($1,'membership',1),($2,'membership',1),($3,'membership',1)",
          [id(310), id(311), id(312)],
        );
        await client.query(
          "INSERT INTO automation_definition_revisions(automation_id,revision,name,active,schema_version,trigger_type,action_type) SELECT id,1,'matching',true,1,'receipt.v1','record-receipt.v1' FROM automation_definitions WHERE id = ANY($1::uuid[])",
          [[id(310), id(311), id(312)]],
        );
      });
      const app = api(pool);
      try {
        const first = await app.inject(
          "/automations/list?scope=membership&active=true&limit=1",
        );
        expect(first.statusCode).toBe(200);
        expect(
          first.json().items.map((item: { id: string }) => item.id),
        ).toEqual([id(310)]);
        expect(first.json().nextCursor).toBe(id(310));
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            "INSERT INTO automation_definition_revisions(automation_id,revision,name,active,schema_version,trigger_type,action_type) SELECT id,2,'no longer matching',false,1,'receipt.v1','record-receipt.v1' FROM automation_definitions WHERE id = ANY($1::uuid[])",
            [[id(311), id(312)]],
          );
          await client.query(
            "UPDATE automation_definitions SET current_revision=2 WHERE id = ANY($1::uuid[])",
            [[id(311), id(312)]],
          );
          await client.query(
            "INSERT INTO automation_definitions(id,scope,current_revision) VALUES ($1,'membership',1)",
            [id(309)],
          );
          await client.query(
            "INSERT INTO automation_definition_revisions(automation_id,revision,name,active,schema_version,trigger_type,action_type) VALUES ($1,1,'behind cursor',true,1,'receipt.v1','record-receipt.v1')",
            [id(309)],
          );
          await client.query("COMMIT");
        } finally {
          client.release();
        }
        const next = await app.inject(
          `/automations/list?scope=membership&active=true&limit=1&cursor=${first.json().nextCursor}`,
        );
        expect(next.statusCode).toBe(200);
        expect(next.json()).toEqual({ items: [], nextCursor: null });
      } finally {
        await app.close();
      }
    });
  },
);
