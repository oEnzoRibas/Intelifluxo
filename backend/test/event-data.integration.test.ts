import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { api } from "../src/api.js";

describe.skipIf(process.env.INTEGRATION !== "1")(
  "event data and snapshot guards",
  () => {
    const schema = `data_${randomUUID().replaceAll("-", "")}`;
    let admin: pg.Pool;
    let pool: pg.Pool;
    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        options: `-c search_path=${schema}`,
      });
      for (const file of [
        "001_init.sql",
        "002_retry_dispositions.sql",
        "003_retry_publications.sql",
        "004_automation_definitions.sql",
        "005_automation_executions.sql",
        "006_automation_graph.sql",
        "007_validate_automation_graph.sql",
        "008_immutable_event_and_execution.sql",
      ]) {
        await pool.query(
          await readFile(
            new URL(`../migrations/${file}`, import.meta.url),
            "utf8",
          ),
        );
      }
    });
    afterAll(async () => {
      await pool?.end();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
      }
    });
    it("persists complete content, replays by JSONB equality, rejects changes and SQL mutation", async () => {
      const app = api(pool);
      const body = {
        scope: "s",
        idempotencyKey: "k",
        type: "receipt.v1",
        target: "local-receipt",
        message: "m",
        data: { n: 150, nested: { flag: true }, items: [1, 2] },
      };
      try {
        const accepted = await app.inject({
          method: "POST",
          url: "/events",
          payload: body,
        });
        expect(accepted.statusCode).toBe(202);
        const id = accepted.json().id as string;
        const replay = await app.inject({
          method: "POST",
          url: "/events",
          payload: {
            ...body,
            data: { items: [1, 2], nested: { flag: true }, n: 150 },
          },
        });
        expect(replay.statusCode).toBe(200);
        expect(replay.json()).toEqual({ id, replay: true });
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/events",
              payload: { ...body, data: { ...body.data, items: [2, 1] } },
            })
          ).statusCode,
        ).toBe(409);
        expect(
          (await app.inject({ method: "GET", url: `/events/${id}` })).json()
            .content,
        ).toEqual({
          type: body.type,
          target: body.target,
          message: body.message,
          data: body.data,
        });
        await expect(
          pool.query("UPDATE events SET content='{}' WHERE id=$1", [id]),
        ).rejects.toMatchObject({ code: "23514" });
        await expect(
          pool.query("UPDATE events SET scope='changed' WHERE id=$1", [id]),
        ).rejects.toMatchObject({ code: "23514" });
        expect(
          (await pool.query("SELECT count(*)::int AS count FROM events"))
            .rows[0].count,
        ).toBe(1);
      } finally {
        await app.close();
      }
    });
  },
);
