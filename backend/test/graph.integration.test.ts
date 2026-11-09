import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { api } from "../src/api.js";
import { defaultGraph } from "../src/graph.js";
describe.skipIf(process.env.INTEGRATION !== "1")("persistent graph", () => {
  const schema = `graph_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Pool, pool: pg.Pool;
  const legacyId = randomUUID();
  const eventId = randomUUID(),
    executionId = randomUUID();
  const input = {
    name: "workflow",
    schemaVersion: 1,
    trigger: { type: "receipt.v1" },
    action: { type: "record-receipt.v1" },
  };
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    await pool.query(
      await readFile(
        new URL("../migrations/001_init.sql", import.meta.url),
        "utf8",
      ),
    );
    await pool.query(
      await readFile(
        new URL(
          "../migrations/004_automation_definitions.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await pool.query("BEGIN");
    await pool.query(
      "INSERT INTO automation_definitions VALUES ($1,'legacy',1)",
      [legacyId],
    );
    await pool.query(
      "INSERT INTO automation_definition_revisions (automation_id,revision,name,active,schema_version,trigger_type,action_type) VALUES ($1,1,'legacy',true,1,'receipt.v1','record-receipt.v1')",
      [legacyId],
    );
    await pool.query("COMMIT");
    await pool.query(
      await readFile(
        new URL("../migrations/005_automation_executions.sql", import.meta.url),
        "utf8",
      ),
    );
    await pool.query(
      "INSERT INTO events (id,scope,idempotency_key,content) VALUES ($1,'legacy','key','{}')",
      [eventId],
    );
    await pool.query(
      "INSERT INTO event_automation_context VALUES ($1,'receipt.v1')",
      [eventId],
    );
    await pool.query(
      "INSERT INTO automation_executions (id,event_id,automation_id,revision,schema_version,trigger_type,action_type,result) VALUES ($1,$2,$3,1,1,'receipt.v1','record-receipt.v1',$4)",
      [executionId, eventId, legacyId, JSON.stringify({ preserved: true })],
    );
    const migration = await readFile(
      new URL("../migrations/006_automation_graph.sql", import.meta.url),
      "utf8",
    );
    await pool.query(migration);
    await pool.query(migration);
    const validation = await readFile(
      new URL(
        "../migrations/007_validate_automation_graph.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(
      (
        await pool.query(
          "SELECT convalidated FROM pg_constraint WHERE conrelid='automation_definition_revisions'::regclass AND conname='automation_graph_valid'",
        )
      ).rows[0].convalidated,
    ).toBe(false);
    await pool.query(validation);
    await pool.query(validation);
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });
  it("materializes legacy data and preserves graphs on omitted PUT, including activation denial", async () => {
    expect(
      (
        await pool.query(
          "SELECT name,active,graph FROM automation_definition_revisions WHERE automation_id=$1 AND revision=1",
          [legacyId],
        )
      ).rows[0],
    ).toEqual({ name: "legacy", active: true, graph: null });
    expect(
      (
        await pool.query(
          "SELECT automation_id,revision,result FROM automation_executions WHERE id=$1",
          [executionId],
        )
      ).rows[0],
    ).toEqual({
      automation_id: legacyId,
      revision: 1,
      result: { preserved: true },
    });
    const app = api(pool);
    const old = await app.inject({
      method: "GET",
      url: `/automations/${legacyId}`,
    });
    expect(old.json().graph).toEqual(defaultGraph());
    const g = defaultGraph();
    g.nodes[0].id = "start";
    g.edges[0].source = "start";
    g.nodes[0].position.x = 17;
    const created = (
      await app.inject({
        method: "POST",
        url: "/automations",
        payload: { ...input, scope: "demo", graph: g },
      })
    ).json();
    expect(created.graph).toEqual(g);
    const url = `/automations/${created.id}`;
    const put = { ...input, expectedRevision: 1, active: false };
    const saved = await app.inject({ method: "PUT", url, payload: put });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().graph).toEqual(g);
    const c = structuredClone(g);
    c.nodes.push({
      id: "condition",
      kind: "condition",
      type: "condition-placeholder.v1",
      position: { x: 0, y: 0 },
    });
    c.edges = [
      { source: "start", target: "condition" },
      { source: "condition", target: "action" },
    ];
    expect(
      (
        await app.inject({
          method: "PUT",
          url,
          payload: { ...put, expectedRevision: 2, graph: c },
        })
      ).statusCode,
    ).toBe(200);
    const denied = await app.inject({
      method: "PUT",
      url,
      payload: { ...put, expectedRevision: 3, active: true },
    });
    expect(denied.statusCode).toBe(400);
    expect(denied.json().issues[0].code).toBe("non_executable_graph");
    const race = await Promise.all(
      [1, 2].map(() =>
        app.inject({
          method: "PUT",
          url,
          payload: { ...put, expectedRevision: 3 },
        }),
      ),
    );
    expect(race.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await app.inject({ method: "GET", url })).json().graph).toEqual(c);
    const stale = await app.inject({
      method: "PUT",
      url,
      payload: { ...put, expectedRevision: 3, active: true, graph: c },
    });
    expect(stale.statusCode).toBe(409);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM automation_definition_revisions WHERE automation_id=$1",
          [created.id],
        )
      ).rows[0].n,
    ).toBe(4);
    await app.close();
  });
  it("keeps automation errors scoped and enforces the body limit", async () => {
    const app = api(pool);
    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/automations", payload });
    const malformed = await post({ ...input, scope: "demo", graph: null });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({
      error: "validation_failed",
      issues: [{ code: "invalid_shape", path: "/graph" }],
    });
    const unsupported = await post({
      ...input,
      scope: "demo",
      graph: { version: 2, nodes: null, edges: null },
    });
    expect(unsupported.json().issues[0].code).toBe("unsupported_graph_version");
    expect(
      (await post({ ...input, scope: "demo", name: "x".repeat(9000) }))
        .statusCode,
    ).toBe(413);
    const event = await app.inject({
      method: "POST",
      url: "/events",
      payload: {},
    });
    expect(event.statusCode).toBe(400);
    expect(event.json().error).not.toBe("validation_failed");
    await app.close();
  });
  it("rejects raw invalid and active placeholder inserts while allowing null and valid active graph", async () => {
    const id = legacyId;
    const insert = (revision: number, active: boolean, graph: unknown) =>
      pool.query(
        "INSERT INTO automation_definition_revisions (automation_id,revision,name,active,schema_version,trigger_type,action_type,graph) VALUES ($1,$2,'raw',$3,1,'receipt.v1','record-receipt.v1',$4)",
        [id, revision, active, graph === null ? null : JSON.stringify(graph)],
      );
    const condition = {
      version: 1,
      nodes: [
        ...defaultGraph().nodes,
        {
          id: "condition",
          kind: "condition",
          type: "condition-placeholder.v1",
          position: { x: 1, y: 1 },
        },
      ],
      edges: [
        { source: "trigger", target: "condition" },
        { source: "condition", target: "action" },
      ],
    };
    for (const g of [
      "null",
      "[]",
      "42",
      '"string"',
      "{}",
      JSON.stringify({
        ...defaultGraph(),
        nodes: [null, defaultGraph().nodes[1]],
      }),
      JSON.stringify({ ...defaultGraph(), edges: [null] }),
      JSON.stringify({
        ...defaultGraph(),
        nodes: [
          { ...defaultGraph().nodes[0], position: { x: null, y: 0 } },
          defaultGraph().nodes[1],
        ],
      }),
    ])
      await expect(
        pool.query(
          "INSERT INTO automation_definition_revisions (automation_id,revision,name,active,schema_version,trigger_type,action_type,graph) VALUES ($1,2,'raw',false,1,'receipt.v1','record-receipt.v1',$2::jsonb)",
          [id, g],
        ),
      ).rejects.toThrow();
    await expect(
      pool.query(
        "INSERT INTO automation_definition_revisions (automation_id,revision,name,active,schema_version,trigger_type,action_type,graph) VALUES ($1,2,'raw',false,1,'receipt.v1','record-receipt.v1',$2::jsonb)",
        [id, "{bad"],
      ),
    ).rejects.toThrow();
    for (const g of [
      { version: 1, nodes: null, edges: [] },
      { ...defaultGraph(), version: null },
      condition,
    ])
      await expect(insert(2, true, g)).rejects.toThrow();
    await insert(2, false, condition);
    await insert(3, true, defaultGraph());
    await insert(4, true, null);
  });
});
