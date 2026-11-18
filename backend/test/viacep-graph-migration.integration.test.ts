import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
describe.skipIf(process.env.INTEGRATION !== "1")(
  "ViaCEP graph migration",
  () => {
    const schema = `graph3_${randomUUID().replaceAll("-", "")}`;
    let admin: pg.Pool, pool: pg.Pool;
    const graph = {
      version: 3,
      nodes: [
        {
          id: "t",
          kind: "trigger",
          type: "receipt.v1",
          position: { x: 0, y: 0 },
        },
        {
          id: "l",
          kind: "lookup",
          type: "viacep-address.v1",
          position: { x: 1, y: 0 },
          config: { cep: { source: "fixed", value: "01001-000" } },
        },
        {
          id: "c",
          kind: "condition",
          type: "condition.v2",
          position: { x: 2, y: 0 },
          config: {
            input: { source: "step", nodeId: "l", fieldPath: "address.uf" },
            operator: "equals",
            expectedType: "string",
            expectedValue: "SP",
          },
        },
        {
          id: "a",
          kind: "action",
          type: "record-receipt.v1",
          position: { x: 3, y: 0 },
        },
        { id: "e", kind: "end", type: "end.v1", position: { x: 4, y: 0 } },
      ],
      edges: [
        { source: "t", target: "l" },
        { source: "l", target: "c" },
        { source: "c", sourcePort: "TRUE", target: "a" },
        { source: "c", sourcePort: "FALSE", target: "e" },
        { source: "a", target: "e" },
      ],
    };
    async function migrate() {
      await run(process.execPath, ["--import", "tsx", "src/migrate.ts"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, PGOPTIONS: `-c search_path=${schema}` },
      });
    }
    async function insert(version: number, value: unknown) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const id = randomUUID();
        await client.query(
          "INSERT INTO automation_definitions VALUES ($1,'test',1)",
          [id],
        );
        await client.query(
          "INSERT INTO automation_definition_revisions (automation_id,revision,name,active,schema_version,trigger_type,action_type,graph) VALUES ($1,1,'test',true,$2,'receipt.v1','record-receipt.v1',$3)",
          [id, version, value === null ? null : JSON.stringify(value)],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        options: `-c search_path=${schema}`,
      });
      await migrate();
    });
    afterAll(async () => {
      await pool?.end();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
      }
    });
    it("upgrades an old graph constraint", async () => {
      await pool.query(
        "ALTER TABLE automation_definition_revisions DROP CONSTRAINT automation_graph_valid_v3; ALTER TABLE automation_definition_revisions ADD CONSTRAINT automation_graph_valid_v2 CHECK (automation_graph_guard_v2(graph,active,schema_version,trigger_type,action_type) IS TRUE) NOT VALID",
      );
      await migrate();
      const old = await pool.query(
        "SELECT 1 FROM pg_constraint WHERE conrelid = 'automation_definition_revisions'::regclass AND conname = 'automation_graph_valid_v2'",
      );
      expect(old.rowCount).toBe(0);
    });
    it("accepts legacy, v1, v2 and reordered v3", async () => {
      await insert(1, null);
      await insert(1, {
        version: 1,
        nodes: [graph.nodes[0], graph.nodes[3]],
        edges: [{ source: "t", target: "a" }],
      });
      await insert(2, {
        version: 2,
        nodes: [
          graph.nodes[0],
          {
            id: "c",
            kind: "condition",
            type: "condition.v1",
            position: { x: 0, y: 0 },
            config: { fieldPath: "data.x", operator: "exists" },
          },
          graph.nodes[3],
          graph.nodes[4],
        ],
        edges: [{ source: "t", target: "c" }, ...graph.edges.slice(2)],
      });
      for (const source of ["fixed", "event"] as const) {
        const value = structuredClone(graph);
        if (source === "event") {
          value.nodes[1].config = {
            cep: { source: "event", fieldPath: "data.cep" },
          } as never;
        }
        for (const [nodeOrder, edgeOrder] of [
          [
            [0, 1, 2, 3, 4],
            [0, 1, 2, 3, 4],
          ],
          [
            [4, 3, 2, 1, 0],
            [4, 3, 2, 1, 0],
          ],
          [
            [2, 4, 0, 3, 1],
            [1, 3, 0, 4, 2],
          ],
        ]) {
          await insert(3, {
            ...value,
            nodes: nodeOrder.map((index) => value.nodes[index]),
            edges: edgeOrder.map((index) => value.edges[index]),
          });
        }
      }
    });
    it("rejects malformed v3 and version mismatches", async () => {
      const mutations = [
        (g: typeof graph) => {
          g.version = 2;
        },
        (g: typeof graph) => {
          g.nodes[1].config = {
            cep: { source: "fixed", value: "01001000", url: "https://evil" },
          } as never;
        },
        (g: typeof graph) => {
          g.nodes[1].config = {
            cep: { source: "event", fieldPath: "data.constructor" },
          } as never;
        },
        (g: typeof graph) => {
          g.nodes[2].config = {
            input: { source: "step", nodeId: "a", fieldPath: "address.uf" },
            operator: "exists",
          } as never;
        },
        (g: typeof graph) => {
          g.edges[0].target = "c";
        },
        (g: typeof graph) => {
          g.edges[3] = g.edges[2];
        },
        (g: typeof graph) => {
          Object.assign(g.nodes[0], { extra: true });
        },
        (g: typeof graph) => {
          Object.assign(g.nodes[1].position, { extra: true });
        },
        (g: typeof graph) => {
          Object.assign(g.nodes[1].config!, { extra: true });
        },
        (g: typeof graph) => {
          Object.assign(g.nodes[2].config!, { extra: true });
        },
        (g: typeof graph) => {
          g.nodes[2].config = {
            input: { source: "event", fieldPath: "a" },
            operator: "contains",
            expectedType: "number",
            expectedValue: 1,
          } as never;
        },
      ];
      for (const mutate of mutations) {
        const bad = structuredClone(graph);
        mutate(bad);
        await expect(insert(3, bad)).rejects.toMatchObject({ code: "23514" });
      }
      await expect(insert(2, graph)).rejects.toMatchObject({ code: "23514" });
    });
    it("reruns and recovers missing and unvalidated constraints", async () => {
      await migrate();
      await pool.query(
        "ALTER TABLE automation_definition_revisions DROP CONSTRAINT automation_graph_valid_v3",
      );
      await migrate();
      await pool.query(
        "ALTER TABLE automation_definition_revisions DROP CONSTRAINT automation_graph_valid_v3; ALTER TABLE automation_definition_revisions ADD CONSTRAINT automation_graph_valid_v3 CHECK (automation_graph_guard_v3(graph,active,schema_version,trigger_type,action_type) IS TRUE) NOT VALID",
      );
      await migrate();
      const result = await pool.query(
        "SELECT convalidated FROM pg_constraint WHERE conrelid = 'automation_definition_revisions'::regclass AND conname = 'automation_graph_valid_v3'",
      );
      expect(result.rows[0].convalidated).toBe(true);
    });
  },
);
