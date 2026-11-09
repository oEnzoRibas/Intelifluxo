import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { api } from "../src/api.js";
import { conditionsWritesEnabled } from "../src/config.js";

const graph = {
  version: 2,
  nodes: [
    { id: "t", kind: "trigger", type: "receipt.v1", position: { x: 0, y: 0 } },
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
const input = {
  scope: "conditions",
  name: "test",
  schemaVersion: 2,
  trigger: { type: "receipt.v1" },
  action: { type: "record-receipt.v1" },
  graph,
};
it("uses a strict default-off conditions gate", () => {
  expect(conditionsWritesEnabled(undefined)).toBe(false);
  expect(conditionsWritesEnabled("false")).toBe(false);
  expect(conditionsWritesEnabled("true")).toBe(true);
  expect(() => conditionsWritesEnabled("TRUE")).toThrow();
});
describe.skipIf(process.env.INTEGRATION !== "1")(
  "conditions definition HTTP",
  () => {
    const schema = `conditions_api_${randomUUID().replaceAll("-", "")}`;
    let admin: pg.Pool, pool: pg.Pool;
    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        options: `-c search_path=${schema}`,
      });
      const dir = new URL("../migrations/", import.meta.url);
      for (const name of (await readdir(dir))
        .filter((x) => x.endsWith(".sql"))
        .sort())
        await pool.query(await readFile(new URL(name, dir), "utf8"));
    });
    it("validates versions, topology, config and ports before creating revisions", async () => {
      const app = api(pool, false, true);
      try {
        const send = (payload: Record<string, unknown>) =>
          app.inject({ method: "POST", url: "/automations", payload });
        expect(
          (await send({ ...input, graph: undefined })).json().issues[0].code,
        ).toBe("graph_required");
        expect(
          (await send({ ...input, schemaVersion: 1 })).json().issues[0].code,
        ).toBe("execution_schema_mismatch");
        const badPort = structuredClone(graph);
        badPort.edges[1].sourcePort = "yes";
        expect(
          (await send({ ...input, graph: badPort })).json().issues[0].code,
        ).toBe("invalid_source_port");
        const badConfig = structuredClone(graph);
        badConfig.nodes[1].config!.fieldPath = "__proto__.x";
        expect(
          (await send({ ...input, graph: badConfig })).json().issues[0].code,
        ).toBe("invalid_field_path");
        const badTopology = structuredClone(graph);
        badTopology.edges[1].target = "e";
        expect(
          (await send({ ...input, graph: badTopology })).json().issues[0].code,
        ).toBe("invalid_topology");
        const created = await send(input);
        const id = created.json().id;
        const { scope: _scope, ...update } = input;
        void _scope;
        const put = (payload: Record<string, unknown>) =>
          app.inject({ method: "PUT", url: `/automations/${id}`, payload });
        expect(
          (
            await put({
              ...update,
              graph: badPort,
              active: false,
              expectedRevision: 99,
            })
          ).json().issues[0].code,
        ).toBe("invalid_source_port");
        expect(
          (
            await put({
              ...update,
              graph: badTopology,
              active: false,
              expectedRevision: 99,
            })
          ).statusCode,
        ).toBe(409);
        expect(
          (
            await put({
              ...update,
              graph: undefined,
              active: false,
              expectedRevision: 1,
            })
          ).json().issues[0].code,
        ).toBe("graph_required");
        expect(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM automation_definition_revisions WHERE automation_id=$1",
              [id],
            )
          ).rows[0].n,
        ).toBe(1);
      } finally {
        await app.close();
      }
    });
    it("reads a directly persisted v2 row with the gate off", async () => {
      const id = randomUUID();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "INSERT INTO automation_definitions(id,scope,current_revision) VALUES ($1,'direct',1)",
          [id],
        );
        await client.query(
          "INSERT INTO automation_definition_revisions(automation_id,revision,name,active,schema_version,trigger_type,action_type,graph) VALUES ($1,1,'direct',false,2,'receipt.v1','record-receipt.v1',$2)",
          [id, JSON.stringify(graph)],
        );
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      const app = api(pool, false, false);
      try {
        expect(
          (
            await app.inject({ method: "GET", url: `/automations/${id}` })
          ).json().graph,
        ).toEqual(graph);
      } finally {
        await app.close();
      }
    });
    afterAll(async () => {
      await pool?.end();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
      }
    });
    it("saves, reopens, activates, protects and deactivates v2", async () => {
      const on = api(pool, false, true),
        off = api(pool, false, false);
      try {
        expect(
          (
            await off.inject({
              method: "POST",
              url: "/automations",
              payload: input,
            })
          ).json().issues[0].code,
        ).toBe("conditions_disabled");
        const created = await on.inject({
          method: "POST",
          url: "/automations",
          payload: input,
        });
        expect(created.statusCode).toBe(201);
        expect(created.json().graph).toEqual(graph);
        const id = created.json().id;
        const url = `/automations/${id}`;
        expect((await off.inject({ method: "GET", url })).json().graph).toEqual(
          graph,
        );
        expect(
          (
            await off.inject({
              method: "GET",
              url: "/automations?scope=conditions",
            })
          ).json().items[0].graph,
        ).toEqual(graph);
        const { scope: _scope, ...update } = input;
        void _scope;
        expect(
          (
            await off.inject({
              method: "PUT",
              url,
              payload: { ...update, active: true, expectedRevision: 1 },
            })
          ).json().issues[0].code,
        ).toBe("conditions_disabled");
        const activated = await on.inject({
          method: "PUT",
          url,
          payload: { ...update, active: true, expectedRevision: 1 },
        });
        expect(activated.statusCode).toBe(200);
        expect((await on.inject({ method: "GET", url })).json()).toMatchObject({
          active: true,
          revision: 2,
          graph,
        });
        expect(
          (
            await on.inject({
              method: "PUT",
              url,
              payload: { ...update, active: false, expectedRevision: 1 },
            })
          ).statusCode,
        ).toBe(409);
        const deactivated = await off.inject({
          method: "PUT",
          url,
          payload: { ...update, active: false, expectedRevision: 2 },
        });
        expect(deactivated.statusCode).toBe(200);
        expect(deactivated.json()).toMatchObject({
          active: false,
          revision: 3,
          graph,
        });
        const changed = structuredClone(update);
        changed.graph.nodes[1].config!.fieldPath = "data.other";
        expect(
          (
            await off.inject({
              method: "PUT",
              url,
              payload: { ...changed, active: false, expectedRevision: 3 },
            })
          ).json().issues[0].code,
        ).toBe("conditions_disabled");
        const results = await Promise.all(
          [1, 2].map(() =>
            on.inject({
              method: "PUT",
              url,
              payload: { ...update, active: false, expectedRevision: 3 },
            }),
          ),
        );
        expect(results.map((x) => x.statusCode).sort()).toEqual([200, 409]);
        expect(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM automation_definition_revisions WHERE automation_id=$1",
              [id],
            )
          ).rows[0].n,
        ).toBe(4);
        expect(
          (
            await on.inject({
              method: "POST",
              url: "/automations",
              payload: { ...input, name: "x".repeat(9000) },
            })
          ).statusCode,
        ).toBe(413);
      } finally {
        await on.close();
        await off.close();
      }
    });
  },
);
