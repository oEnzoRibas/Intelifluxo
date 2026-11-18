import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Isolate the trigger until the v3 shape constraints permit inserting v3 rows.
describe.skipIf(process.env.INTEGRATION !== "1")(
  "v3 result immutability trigger",
  () => {
    const schema = `viacep_${randomUUID().replaceAll("-", "")}`;
    let admin: pg.Pool;
    let pool: pg.Pool;

    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        options: `-c search_path=${schema}`,
      });
      await pool.query(
        "CREATE TABLE automation_executions (id integer PRIMARY KEY, schema_version integer NOT NULL, result jsonb)",
      );
      const sql = await readFile(
        new URL(
          "../migrations/013_viacep_result_immutability.sql",
          import.meta.url,
        ),
        "utf8",
      );
      await pool.query(sql);
      await pool.query(sql); // Safe rerun.
    });

    afterAll(async () => {
      await pool?.end();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
      }
    });

    it("freezes a found observation while allowing pending metadata transitions", async () => {
      const found = {
        lookup: { status: "found", address: { cep: "01001-000" } },
        action: { status: "pending" },
        failure: "first",
      };
      await pool.query("INSERT INTO automation_executions VALUES (1, 3, $1)", [
        found,
      ]);
      const next = { ...found, failure: "second" };
      await pool.query(
        "UPDATE automation_executions SET result=$1 WHERE id=1",
        [next],
      );
      await expect(
        pool.query("UPDATE automation_executions SET result=NULL WHERE id=1"),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query("UPDATE automation_executions SET result=$1 WHERE id=1", [
          { ...next, lookup: null },
        ]),
      ).rejects.toMatchObject({ code: "23514" });
      const terminal = { ...next, action: { status: "executed" } };
      await pool.query(
        "UPDATE automation_executions SET result=$1 WHERE id=1",
        [terminal],
      );
      await expect(
        pool.query("UPDATE automation_executions SET result=$1 WHERE id=1", [
          next,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
      await pool.query("DELETE FROM automation_executions WHERE id=1");
    });

    it("freezes ignored results but leaves non-v3 rows unchanged", async () => {
      const ignored = { action: { status: "ignored" } };
      await pool.query(
        "INSERT INTO automation_executions VALUES (2,3,$1), (3,2,$1)",
        [ignored],
      );
      await expect(
        pool.query("UPDATE automation_executions SET result=NULL WHERE id=2"),
      ).rejects.toMatchObject({ code: "23514" });
      await pool.query(
        "UPDATE automation_executions SET result=NULL WHERE id=3",
      );
    });
  },
);
