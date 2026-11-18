import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
describe.skipIf(process.env.INTEGRATION !== "1")(
  "ViaCEP execution migration",
  () => {
    const schema = `exec3_${randomUUID().replaceAll("-", "")}`;
    let admin: pg.Pool, pool: pg.Pool;
    const event = randomUUID();
    const lookup = {
      nodeId: "lookup",
      kind: "viacep-address-result.v1",
      status: "found",
      cep: "01001000",
      address: { cep: "01001-000" },
      failure: null,
    };
    const decision = {
      nodeId: "condition",
      outcome: "TRUE",
      sourcePort: "TRUE",
      targetNodeId: "action",
    };
    const action = {
      nodeId: "action",
      status: "executed",
      receipt: { kind: "local-receipt.v1", eventId: event, message: "ok" },
    };
    const result = {
      kind: "viacep-condition-execution.v1",
      eventId: event,
      lookup,
      decision,
      action,
      failure: null,
    };
    async function migrate(target = schema) {
      await run(process.execPath, ["--import", "tsx", "src/migrate.ts"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, PGOPTIONS: `-c search_path=${target}` },
      });
    }
    async function migration(n: number) {
      const dir = new URL("../migrations/", import.meta.url);
      const name = (await readdir(dir)).find((s) =>
        s.startsWith(`${String(n).padStart(3, "0")}_`),
      );
      if (!name) throw new Error(`missing migration ${n}`);
      await pool.query(await readFile(new URL(name, dir), "utf8"));
    }
    async function insert(version: number, value: unknown) {
      const id = randomUUID(),
        automation = randomUUID(),
        client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "INSERT INTO automation_definitions VALUES ($1,'test',1)",
          [automation],
        );
        await client.query(
          "INSERT INTO automation_definition_revisions (automation_id,revision,name,active,schema_version,trigger_type,action_type) VALUES ($1,1,'test',true,1,'receipt.v1','record-receipt.v1')",
          [automation],
        );
        await client.query(
          "INSERT INTO automation_executions (id,event_id,automation_id,revision,schema_version,trigger_type,action_type,result) VALUES ($1,$2,$3,1,$4,'receipt.v1','record-receipt.v1',$5)",
          [
            id,
            event,
            automation,
            version,
            value === null ? null : JSON.stringify(value),
          ],
        );
        await client.query("COMMIT");
        return id;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    async function expectV3() {
      const rows = (
        await pool.query(
          "SELECT conname,convalidated FROM pg_constraint WHERE conrelid='automation_executions'::regclass AND conname LIKE 'automation_execution%valid_v%' ORDER BY conname",
        )
      ).rows;
      expect(rows).toEqual(
        ["result", "target", "types"].map((part) => ({
          conname: `automation_execution_${part}_valid_v3`,
          convalidated: true,
        })),
      );
    }
    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        options: `-c search_path=${schema}`,
      });
      for (let n = 1; n <= 15; n++) await migration(n);
      await pool.query(
        "INSERT INTO events (id,scope,idempotency_key,content) VALUES ($1,'test','key','{}')",
        [event],
      );
      await pool.query(
        "INSERT INTO event_automation_context VALUES ($1,'receipt.v1')",
        [event],
      );
    });
    afterAll(async () => {
      await pool?.end();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
      }
    });
    it("upgrades graph v3 with v2 execution guards without changing legacy envelopes", async () => {
      const v2 = {
        kind: "condition-execution.v1",
        eventId: event,
        decision,
        action,
        failure: null,
      };
      await insert(1, { legacy: true });
      await insert(2, v2);
      await migrate();
      await expectV3();
      await insert(1, { legacy: true });
      await insert(2, v2);
    });
    it("accepts v3 outcomes and rejects malformed counterexamples", async () => {
      await insert(3, result);
      const ignored = {
        ...result,
        decision: {
          ...decision,
          outcome: "FALSE",
          sourcePort: "FALSE",
          targetNodeId: "end",
        },
        action: { nodeId: "action", status: "ignored", receipt: null },
      };
      await insert(3, ignored);
      const failure = {
        classification: "transient",
        code: "viacep_timeout",
        nodeId: "lookup",
      };
      await insert(3, {
        ...result,
        lookup: { ...lookup, status: "failed", address: null, failure },
        decision: null,
        action: { nodeId: "action", status: "pending", receipt: null },
        failure,
      });
      for (const bad of [
        { ...result, eventId: randomUUID() },
        { ...result, lookup: { ...lookup, address: { cep: "99999-999" } } },
        { ...result, lookup: { ...lookup, extra: true } },
        { ...result, decision: { ...decision, targetNodeId: "other" } },
        { ...result, action: { ...action, nodeId: "lookup" } },
        {
          ...result,
          failure: {
            classification: "permanent",
            code: "viacep_timeout",
            nodeId: "lookup",
          },
        },
        { ...ignored, decision },
      ])
        await expect(insert(3, bad)).rejects.toMatchObject({ code: "23514" });
    });
    it("persists valid receipt Unicode and rejects unrepresentable JSON at the database boundary", async () => {
      const withMessage = (message: string) => ({
        ...result,
        action: { ...action, receipt: { ...action.receipt, message } },
      });
      const value = withMessage("Olá 😀");
      const id = await insert(3, value);
      const persisted = await pool.query(
        "SELECT result FROM automation_executions WHERE id=$1",
        [id],
      );
      expect(persisted.rows[0].result).toEqual(value);
      // JSON.stringify escapes these code units; jsonb rejects them while parsing,
      // potentially before any CHECK constraint is evaluated.
      for (const message of ["before\0after", "\uD800", "\uDC00"]) {
        await expect(insert(3, withMessage(message))).rejects.toSatisfy(
          (error: { code?: string }) =>
            error.code === "22P05" || error.code === "22P02",
        );
      }
    });
    it("enforces strict non-found lookup peer-override precedence", async () => {
      const failures = {
        transient: {
          classification: "transient",
          code: "viacep_timeout",
          nodeId: "lookup",
        },
        unknown: {
          classification: "unknown",
          code: "viacep_unknown",
          nodeId: "lookup",
        },
        permanent: {
          classification: "permanent",
          code: "viacep_http_permanent",
          nodeId: "lookup",
        },
        exhausted: {
          classification: "exhausted",
          code: "retry_exhausted",
          nodeId: "lookup",
        },
      } as const;
      const envelope = (
        lookupFailure: { classification: string; code: string; nodeId: string },
        top: unknown,
      ) => ({
        ...result,
        lookup: {
          ...lookup,
          status: "failed",
          address: null,
          failure: lookupFailure,
        },
        decision: null,
        action: {
          nodeId: "action",
          status:
            top === lookupFailure &&
            lookupFailure.classification === "transient"
              ? "pending"
              : "not_executed",
          receipt: null,
        },
        failure: top,
      });
      for (const failure of Object.values(failures))
        await insert(3, envelope(failure, failure));
      const notFoundFailure = {
        classification: "permanent",
        code: "viacep_not_found",
        nodeId: "lookup",
      } as const;
      const notFound = {
        ...envelope(notFoundFailure, notFoundFailure),
        lookup: {
          ...lookup,
          status: "not_found",
          address: null,
          failure: notFoundFailure,
        },
      };
      await insert(3, notFound);
      await expect(
        insert(3, {
          ...notFound,
          failure: {
            classification: "exhausted",
            code: "event_peer_failure",
            nodeId: null,
          },
        }),
      ).rejects.toMatchObject({ code: "23514" });
      const pairs = [
        ["transient", "transient", false],
        ["transient", "unknown", true],
        ["transient", "permanent", true],
        ["transient", "exhausted", true],
        ["unknown", "transient", false],
        ["unknown", "unknown", false],
        ["unknown", "permanent", true],
        ["unknown", "exhausted", false],
        ["permanent", "transient", false],
        ["permanent", "unknown", false],
        ["permanent", "permanent", false],
        ["permanent", "exhausted", false],
        ["exhausted", "transient", false],
        ["exhausted", "unknown", false],
        ["exhausted", "permanent", false],
        ["exhausted", "exhausted", false],
      ] as const;
      for (const [from, to, accepted] of pairs) {
        const value = envelope(failures[from], {
          classification: to,
          code: "event_peer_failure",
          nodeId: null,
        });
        if (accepted) await insert(3, value);
        else
          await expect(
            insert(3, value),
            `${from} -> ${to}`,
          ).rejects.toMatchObject({ code: "23514" });
      }
      for (const top of [
        null,
        { classification: "permanent", code: "action_permanent", nodeId: null },
        {
          classification: "permanent",
          code: "event_peer_failure",
          nodeId: "action",
        },
        {
          classification: "permanent",
          code: "event_peer_failure",
          nodeId: null,
          extra: true,
        },
        { classification: null, code: "event_peer_failure", nodeId: null },
        { classification: "permanent", code: null, nodeId: null },
      ])
        await expect(
          insert(3, envelope(failures.unknown, top)),
        ).rejects.toMatchObject({ code: "23514" });
      for (const failure of [failures.unknown, failures.permanent])
        await expect(
          insert(3, envelope(failure, failures.exhausted)),
        ).rejects.toMatchObject({ code: "23514" });
    });
    it("enforces lookup and terminal immutability and non-null results", async () => {
      const id = await insert(3, result);
      await expect(
        pool.query("UPDATE automation_executions SET result=NULL WHERE id=$1", [
          id,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
      for (const changed of [
        { ...result, lookup: { ...lookup, address: { cep: "01001000" } } },
        {
          ...result,
          action: {
            ...action,
            receipt: { ...action.receipt, message: "changed" },
          },
        },
      ])
        await expect(
          pool.query("UPDATE automation_executions SET result=$2 WHERE id=$1", [
            id,
            JSON.stringify(changed),
          ]),
        ).rejects.toMatchObject({ code: "23514" });
    });
    it("handles fresh, v2, and post-016 pre-validation states", async () => {
      for (const stage of [0, 12, 16]) {
        const isolated = `state_${randomUUID().replaceAll("-", "")}`;
        await admin.query(`CREATE SCHEMA "${isolated}"`);
        const original = pool;
        pool = new pg.Pool({
          connectionString: process.env.DATABASE_URL,
          options: `-c search_path=${isolated}`,
        });
        try {
          for (let n = 1; n <= stage; n++) await migration(n);
          if (stage === 16) {
            const before = await pool.query(
              "SELECT count(*)::int AS count FROM pg_constraint WHERE conrelid='automation_executions'::regclass AND conname LIKE 'automation_execution%valid_v3' AND NOT convalidated",
            );
            expect(before.rows[0].count).toBe(3);
          }
          await migrate(isolated);
          await expectV3();
          await migrate(isolated);
          await expectV3();
        } finally {
          await pool.end();
          pool = original;
          await admin.query(`DROP SCHEMA "${isolated}" CASCADE`);
        }
      }
    });
    it("recovers missing and unvalidated v3 checks and reruns", async () => {
      await pool.query(
        "ALTER TABLE automation_executions DROP CONSTRAINT automation_execution_target_valid_v3",
      );
      await migrate();
      await expectV3();
      await pool.query(
        "ALTER TABLE automation_executions DROP CONSTRAINT automation_execution_target_valid_v3; ALTER TABLE automation_executions ADD CONSTRAINT automation_execution_target_valid_v3 CHECK (automation_target_guard_v3(schema_version,result) IS TRUE) NOT VALID",
      );
      await migrate();
      await expectV3();
      await migrate();
      await expectV3();
    });
  },
);
