import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe.skipIf(process.env.INTEGRATION !== "1")("condition migrations", () => {
  const schema = `conditions_${randomUUID().replaceAll("-", "")}`;
  const definition = randomUUID(),
    event = randomUUID(),
    execution = randomUUID();
  let admin: pg.Pool, pool: pg.Pool;
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
        config: { fieldPath: "data.value", operator: "exists" },
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
  async function migration(prefix: string) {
    const files: Record<string, string> = {
      "001": "init",
      "002": "retry_dispositions",
      "003": "retry_publications",
      "004": "automation_definitions",
      "005": "automation_executions",
      "006": "automation_graph",
      "007": "validate_automation_graph",
      "008": "immutable_event_and_execution",
      "009": "automation_conditions",
      "010": "validate_automation_conditions",
      "011": "execution_result_targets",
      "012": "validate_execution_result_targets",
    };
    await pool.query(
      await readFile(
        new URL(
          `../migrations/${prefix}_${files[prefix]}.sql`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
  }
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    for (const p of ["001", "002", "003", "004", "005", "006", "007", "008"])
      await migration(p);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO automation_definitions VALUES ($1,'legacy',1)",
        [definition],
      );
      await client.query(
        "INSERT INTO automation_definition_revisions (automation_id,revision,name,active,schema_version,trigger_type,action_type) VALUES ($1,1,'legacy',true,1,'receipt.v1','record-receipt.v1')",
        [definition],
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const legacyGraph = {
      version: 1,
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
          type: "condition-placeholder.v1",
          position: { x: 1, y: 0 },
        },
        {
          id: "a",
          kind: "action",
          type: "record-receipt.v1",
          position: { x: 2, y: 0 },
        },
      ],
      edges: [
        { source: "t", target: "c" },
        { source: "c", target: "a" },
      ],
    };
    await pool.query(
      "INSERT INTO automation_definition_revisions (automation_id,revision,name,active,schema_version,trigger_type,action_type,graph) VALUES ($1,2,'draft',false,1,'receipt.v1','record-receipt.v1',$2)",
      [definition, JSON.stringify(legacyGraph)],
    );
    await pool.query(
      "INSERT INTO events (id,scope,idempotency_key,content) VALUES ($1,'legacy','key','{}')",
      [event],
    );
    await pool.query(
      "INSERT INTO event_automation_context VALUES ($1,'receipt.v1')",
      [event],
    );
    await pool.query(
      "INSERT INTO automation_executions (id,event_id,automation_id,revision,schema_version,trigger_type,action_type,result) VALUES ($1,$2,$3,1,1,'receipt.v1','record-receipt.v1',$4)",
      [execution, event, definition, JSON.stringify({ old: true })],
    );
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });
  it("upgrades without rewriting legacy snapshots and validates separately", async () => {
    const before = await pool.query(
      "SELECT to_jsonb(r)::text AS row FROM automation_definition_revisions r UNION ALL SELECT to_jsonb(e)::text FROM automation_executions e ORDER BY 1",
    );
    await migration("009");
    expect(
      (
        await pool.query(
          "SELECT convalidated FROM pg_constraint WHERE conname='automation_graph_valid_v2' AND conrelid='automation_definition_revisions'::regclass",
        )
      ).rows[0].convalidated,
    ).toBe(false);
    await migration("010");
    const newEvent = randomUUID();
    await pool.query(
      "INSERT INTO events (id,scope,idempotency_key,content) VALUES ($1,'upgrade','key','{}')",
      [newEvent],
    );
    await pool.query(
      "INSERT INTO event_automation_context VALUES ($1,'receipt.v1')",
      [newEvent],
    );
    const prior = {
      kind: "condition-execution.v1",
      eventId: newEvent,
      decision: {
        nodeId: "c",
        outcome: "TRUE",
        sourcePort: "TRUE",
        targetNodeId: "wrong",
      },
      action: { nodeId: "a", status: "pending", receipt: null },
      failure: {
        classification: "transient",
        code: "action_transient",
        nodeId: "a",
      },
    };
    await pool.query(
      "INSERT INTO automation_executions (id,event_id,automation_id,revision,schema_version,trigger_type,action_type,result) VALUES ($1,$2,$3,1,2,'receipt.v1','record-receipt.v1',$4)",
      [randomUUID(), newEvent, definition, JSON.stringify(prior)],
    );
    await migration("011");
    expect(
      (
        await pool.query(
          "SELECT convalidated FROM pg_constraint WHERE conname='automation_execution_target_valid_v2' AND conrelid='automation_executions'::regclass",
        )
      ).rows[0].convalidated,
    ).toBe(false);
    await expect(migration("012")).rejects.toThrow();
    prior.decision.targetNodeId = "a";
    await pool.query(
      "UPDATE automation_executions SET result=$1 WHERE event_id=$2",
      [JSON.stringify(prior), newEvent],
    );
    await migration("012");
    expect(
      (
        await pool.query(
          "SELECT convalidated FROM pg_constraint WHERE conname='automation_execution_target_valid_v2' AND conrelid='automation_executions'::regclass",
        )
      ).rows[0].convalidated,
    ).toBe(true);
    expect(
      (
        await pool.query(
          "SELECT to_jsonb(r)::text AS row FROM automation_definition_revisions r UNION ALL SELECT to_jsonb(e)::text FROM automation_executions e WHERE event_id <> $1 ORDER BY 1",
          [newEvent],
        )
      ).rows,
    ).toEqual(before.rows);
  });
  it("accepts only paired, configured graph v2 and valid result envelopes", async () => {
    const valid = await pool.query(
      "SELECT automation_graph_guard_v2($1,true,2,'receipt.v1','record-receipt.v1') AS ok",
      [JSON.stringify(graph)],
    );
    expect(valid.rows[0].ok).toBe(true);
    const id = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO automation_definitions VALUES ($1,'new',1)",
        [id],
      );
      await client.query(
        "INSERT INTO automation_definition_revisions VALUES ($1,1,'new',true,2,'receipt.v1','record-receipt.v1',now(),$2)",
        [id, JSON.stringify(graph)],
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const bad = structuredClone(graph);
    bad.edges[1].sourcePort = "FALSE";
    const badConfig = structuredClone(graph);
    badConfig.nodes[1].config = {
      fieldPath: "__proto__.x",
      operator: "exists",
    };
    for (const [g, version] of [
      [graph, 1],
      [bad, 2],
      [badConfig, 2],
      [null, 2],
    ]) {
      await expect(
        pool.query(
          "INSERT INTO automation_definition_revisions (automation_id,revision,name,active,schema_version,trigger_type,action_type,graph) VALUES ($1,2,'bad',false,$2,'receipt.v1','record-receipt.v1',$3)",
          [id, version, JSON.stringify(g)],
        ),
      ).rejects.toThrow();
    }
    const result = {
      kind: "condition-execution.v1",
      eventId: event,
      decision: {
        nodeId: "c",
        outcome: "FALSE",
        sourcePort: "FALSE",
        targetNodeId: "e",
      },
      action: { nodeId: "a", status: "ignored", receipt: null },
      failure: null,
    };
    await pool.query(
      "INSERT INTO automation_executions (id,event_id,automation_id,revision,schema_version,trigger_type,action_type,result) VALUES ($1,$2,$3,1,2,'receipt.v1','record-receipt.v1',$4)",
      [randomUUID(), event, id, JSON.stringify(result)],
    );
    const failure = {
      classification: "transient",
      code: "action_transient",
      nodeId: "a",
    };
    const receipt = { kind: "local-receipt.v1", eventId: event, message: "ok" };
    const decision = {
      nodeId: "c",
      outcome: "TRUE",
      sourcePort: "TRUE",
      targetNodeId: "a",
    };
    const envelopes = [
      {
        ...result,
        decision,
        action: { nodeId: "a", status: "executed", receipt },
        failure: null,
      },
      {
        ...result,
        decision,
        action: { nodeId: "a", status: "pending", receipt: null },
        failure,
      },
      {
        ...result,
        decision,
        action: { nodeId: "a", status: "not_executed", receipt: null },
        failure,
      },
      {
        ...result,
        decision: null,
        action: { nodeId: null, status: "not_executed", receipt: null },
        failure,
      },
      result,
    ];
    for (const envelope of envelopes) {
      await pool.query(
        "UPDATE automation_executions SET result=$1 WHERE automation_id=$2",
        [JSON.stringify(envelope), id],
      );
    }
    const mismatches = [
      ...envelopes.slice(0, 3).map((envelope) => ({
        ...envelope,
        decision: { ...decision, targetNodeId: "e" },
      })),
      { ...result, decision: { ...result.decision, targetNodeId: "a" } },
      {
        ...envelopes[2],
        action: { nodeId: null, status: "not_executed", receipt: null },
      },
      { ...envelopes[2], decision: result.decision },
    ];
    for (const envelope of mismatches) {
      await expect(
        pool.query(
          "UPDATE automation_executions SET result=$1 WHERE automation_id=$2",
          [JSON.stringify(envelope), id],
        ),
      ).rejects.toThrow();
    }
    await expect(
      pool.query(
        "UPDATE automation_executions SET result='null'::jsonb WHERE automation_id=$1",
        [id],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        "UPDATE automation_executions SET result=jsonb_set(result,'{action,status}','\"executed\"') WHERE automation_id=$1",
        [id],
      ),
    ).rejects.toThrow();
  });
});
