import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api } from "../src/api.js";
import { connectBroker } from "../src/broker.js";
import { relayOnce } from "../src/relay.js";
import { handleMessage } from "../src/worker.js";
import { scheduleOnce } from "../src/scheduler.js";

describe.skipIf(process.env.INTEGRATION !== "1")(
  "condition worker broker path",
  () => {
    const schema = `condition_worker_${randomUUID().replaceAll("-", "")}`;
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
    afterAll(async () => {
      await pool?.end();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
      }
    });
    it("processes pre-graph v1 revisions alone and with both v2 branches", async () => {
      const app = api(pool, true, true);
      const broker = await connectBroker();
      const confirm = await broker.createConfirmChannel();
      const queue = `legacy-condition-worker.${randomUUID()}`;
      const legacyId = randomUUID();
      const scope = `legacy-${randomUUID()}`;
      try {
        // Insert as an old writer would: omit the later-added graph column.
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            "INSERT INTO automation_definitions(id,scope,current_revision) VALUES ($1,$2,1)",
            [legacyId, scope],
          );
          await client.query(
            `INSERT INTO automation_definition_revisions
             (automation_id,revision,name,active,schema_version,trigger_type,action_type)
             VALUES ($1,1,'legacy',true,1,'receipt.v1','record-receipt.v1')`,
            [legacyId],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
        expect(
          (
            await pool.query(
              "SELECT graph IS NULL AS absent FROM automation_definition_revisions WHERE automation_id=$1",
              [legacyId],
            )
          ).rows[0].absent,
        ).toBe(true);
        await confirm.assertQueue(queue, { durable: true });
        const process = async (key: string) => {
          const accepted = await app.inject({
            method: "POST",
            url: "/events",
            payload: {
              scope,
              idempotencyKey: key,
              type: "receipt.v1",
              target: "local-receipt",
              message: "hello",
              data: { value: 42 },
            },
          });
          expect(accepted.statusCode).toBe(202);
          const eventId = accepted.json().id;
          expect(await relayOnce(pool, confirm, queue, [], eventId)).toBe(1);
          const channel = await broker.createChannel();
          try {
            const message = await channel.get(queue, { noAck: false });
            if (!message) throw new Error("missing delivery");
            await handleMessage(pool, channel, message);
          } finally {
            await channel.close();
          }
          expect(
            (
              await pool.query(
                "SELECT result FROM receipts WHERE event_id=$1",
                [eventId],
              )
            ).rows,
          ).toMatchObject([
            { result: { kind: "local-receipt.v1", eventId, message: "hello" } },
          ]);
          const items = (
            await app.inject({
              method: "GET",
              url: `/executions?eventId=${eventId}`,
            })
          ).json().items;
          expect(
            items.find(
              (x: { automationId: string }) => x.automationId === legacyId,
            ),
          ).toMatchObject({
            revision: 1,
            schemaVersion: 1,
            status: "completed",
            result: { kind: "local-receipt.v1" },
          });
          return items;
        };
        expect(await process("legacy-only")).toHaveLength(1);
        const ids: string[] = [];
        for (const expectedValue of [42, 7]) {
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
                  expectedValue,
                },
              },
              {
                id: "a",
                kind: "action",
                type: "record-receipt.v1",
                position: { x: 2, y: 0 },
              },
              {
                id: "e",
                kind: "end",
                type: "end.v1",
                position: { x: 3, y: 0 },
              },
            ],
            edges: [
              { source: "t", target: "c" },
              { source: "c", sourcePort: "TRUE", target: "a" },
              { source: "c", sourcePort: "FALSE", target: "e" },
              { source: "a", target: "e" },
            ],
          };
          const config = {
            name: `condition-${expectedValue}`,
            schemaVersion: 2,
            trigger: { type: "receipt.v1" },
            action: { type: "record-receipt.v1" },
            graph,
          };
          const created = await app.inject({
            method: "POST",
            url: "/automations",
            payload: { ...config, scope },
          });
          expect(created.statusCode).toBe(201);
          const id = created.json().id;
          ids.push(id);
          expect(
            (
              await app.inject({
                method: "PUT",
                url: `/automations/${id}`,
                payload: { ...config, active: true, expectedRevision: 1 },
              })
            ).statusCode,
          ).toBe(200);
        }
        const items = await process("mixed");
        expect(items).toHaveLength(3);
        for (const [id, outcome, status] of [
          [ids[0], "TRUE", "completed"],
          [ids[1], "FALSE", "ignored"],
        ])
          expect(
            items.find((x: { automationId: string }) => x.automationId === id),
          ).toMatchObject({ status, result: { decision: { outcome } } });
      } finally {
        await confirm.deleteQueue(queue);
        await confirm.close();
        await broker.close();
        await app.close();
      }
    });
    it("persists TRUE and FALSE with baseline receipts through relay and redelivery", async () => {
      const app = api(pool, true, true);
      const broker = await connectBroker();
      const confirm = await broker.createConfirmChannel();
      const queue = `condition-worker.${randomUUID()}`;
      try {
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
        const config = {
          name: "test",
          schemaVersion: 2,
          trigger: { type: "receipt.v1" },
          action: { type: "record-receipt.v1" },
          graph,
        };
        const created = await app.inject({
          method: "POST",
          url: "/automations",
          payload: { ...config, scope: "worker" },
        });
        expect(created.statusCode).toBe(201);
        const id = created.json().id;
        expect(
          (
            await app.inject({
              method: "PUT",
              url: `/automations/${id}`,
              payload: { ...config, active: true, expectedRevision: 1 },
            })
          ).statusCode,
        ).toBe(200);
        const v1 = await app.inject({
          method: "POST",
          url: "/automations",
          payload: {
            scope: "worker",
            name: "v1",
            schemaVersion: 1,
            trigger: config.trigger,
            action: config.action,
          },
        });
        expect(v1.statusCode).toBe(201);
        expect(
          (
            await app.inject({
              method: "PUT",
              url: `/automations/${v1.json().id}`,
              payload: {
                name: "v1",
                schemaVersion: 1,
                trigger: config.trigger,
                action: config.action,
                active: true,
                expectedRevision: 1,
              },
            })
          ).statusCode,
        ).toBe(200);
        await confirm.assertQueue(queue, { durable: true });
        for (const [value, expected] of [
          [42, "TRUE"],
          [7, "FALSE"],
          ["wrong-type", "ERROR"],
        ] as const) {
          const accepted = await app.inject({
            method: "POST",
            url: "/events",
            payload: {
              scope: "worker",
              idempotencyKey: String(value),
              type: "receipt.v1",
              target: "local-receipt",
              message: "hello",
              data: { value },
            },
          });
          expect(accepted.statusCode).toBe(202);
          const eventId = accepted.json().id;
          if (value === 42) {
            const changedGraph = structuredClone(graph);
            changedGraph.nodes[1].config!.expectedValue = 7;
            expect(
              (
                await app.inject({
                  method: "PUT",
                  url: `/automations/${id}`,
                  payload: {
                    ...config,
                    graph: changedGraph,
                    active: false,
                    expectedRevision: 2,
                  },
                })
              ).statusCode,
            ).toBe(200);
          }
          expect(await relayOnce(pool, confirm, queue, [], eventId)).toBe(1);
          const channel = await broker.createChannel();
          const message = await channel.get(queue, { noAck: false });
          if (!message) throw new Error("missing delivery");
          await expect(
            handleMessage(pool, channel, message, async () => {
              throw new Error("crash");
            }),
          ).rejects.toThrow("crash");
          await channel.close();
          const next = await broker.createChannel();
          const redelivery = await next.get(queue, { noAck: false });
          if (!redelivery) throw new Error("missing redelivery");
          expect(redelivery.fields.redelivered).toBe(true);
          await handleMessage(pool, next, redelivery);
          await next.close();
          const items = (
            await app.inject({
              method: "GET",
              url: `/executions?eventId=${eventId}`,
            })
          ).json().items;
          const item = items.find(
            (x: { automationId: string }) => x.automationId === id,
          );
          const legacy = items.find(
            (x: { automationId: string }) => x.automationId === v1.json().id,
          );
          expect(legacy).toBeDefined();
          if (expected !== "ERROR")
            expect(legacy.result.kind).toBe("local-receipt.v1");
          if (value === 42) {
            expect(item.revision).toBe(2);
            expect(
              (
                await app.inject({
                  method: "PUT",
                  url: `/automations/${id}`,
                  payload: { ...config, active: true, expectedRevision: 3 },
                })
              ).statusCode,
            ).toBe(200);
          }
          if (expected === "ERROR") {
            expect(item).toMatchObject({
              status: "blocked",
              retry: {
                scope: "event",
                outcome: "permanent",
                reason: "permanent",
              },
              result: {
                decision: null,
                action: { status: "not_executed" },
                failure: {
                  classification: "permanent",
                  code: "condition_type_mismatch",
                },
              },
            });
          } else
            expect(item).toMatchObject({
              status: expected === "TRUE" ? "completed" : "ignored",
              result: {
                decision: { outcome: expected },
                action: {
                  status: expected === "TRUE" ? "executed" : "ignored",
                },
              },
            });
          expect(
            (
              await pool.query("SELECT 1 FROM receipts WHERE event_id=$1", [
                eventId,
              ])
            ).rowCount,
          ).toBe(expected === "ERROR" ? 0 : 1);
        }
        for (const finalOutcome of ["success", "transient"] as const) {
          const accepted = await app.inject({
            method: "POST",
            url: "/events",
            payload: {
              scope: "worker",
              idempotencyKey: `retry-${finalOutcome}`,
              type: "receipt.v1",
              target: "local-receipt",
              message: "retry",
              data: { value: 42 },
            },
          });
          expect(accepted.statusCode).toBe(202);
          const eventId = accepted.json().id;
          const channel = await broker.createChannel();
          try {
            expect(await relayOnce(pool, confirm, queue, [], eventId)).toBe(1);
            const first = await channel.get(queue, { noAck: false });
            if (!first) throw new Error("missing initial delivery");
            const policy = {
              maxAttempts: 2,
              baseDelayMs: 1000,
              capDelayMs: 1000,
            };
            await handleMessage(pool, channel, first, undefined, undefined, {
              policy,
              handler: async () => "transient",
            });
            const list = async () =>
              (
                await app.inject({
                  method: "GET",
                  url: `/executions?eventId=${eventId}`,
                })
              )
                .json()
                .items.find(
                  (x: { automationId: string }) => x.automationId === id,
                );
            expect(await list()).toMatchObject({
              status: "retry_scheduled",
              retry: { scope: "event", outcome: "transient" },
              result: {
                decision: { outcome: "TRUE" },
                action: { status: "pending" },
              },
            });
            await pool.query(
              "UPDATE retry_dispositions SET next_eligible_at=now() WHERE event_id=$1",
              [eventId],
            );
            expect(await scheduleOnce(pool, 100, eventId)).toBe(1);
            expect(await relayOnce(pool, confirm, queue, [], eventId)).toBe(1);
            const second = await channel.get(queue, { noAck: false });
            if (!second) throw new Error("missing retry delivery");
            await handleMessage(pool, channel, second, undefined, undefined, {
              policy,
              handler: async () => finalOutcome,
            });
            expect(await list()).toMatchObject(
              finalOutcome === "success"
                ? {
                    status: "completed",
                    result: { action: { status: "executed" }, failure: null },
                  }
                : {
                    status: "blocked",
                    retry: { scope: "event", reason: "exhausted" },
                    result: {
                      action: { status: "not_executed" },
                      failure: { code: "retry_exhausted" },
                    },
                  },
            );
          } finally {
            await channel.close();
          }
        }
        // Simulate an unsupported historical v1 execution without mutating its
        // immutable definition. This trigger bypass is confined to this test schema.
        for (const [value, outcome] of [
          [7, "unknown"],
          ["wrong", "permanent"],
        ] as const) {
          const accepted = await app.inject({
            method: "POST",
            url: "/events",
            payload: {
              scope: "worker",
              idempotencyKey: `peer-${value}`,
              type: "receipt.v1",
              target: "local-receipt",
              message: "peer",
              data: { value },
            },
          });
          expect(accepted.statusCode).toBe(202);
          const eventId = accepted.json().id;
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            await client.query(
              "ALTER TABLE automation_executions DISABLE TRIGGER execution_identity_immutable",
            );
            await client.query(
              "UPDATE automation_executions SET action_type='unsupported' WHERE event_id=$1 AND automation_id=$2",
              [eventId, v1.json().id],
            );
            await client.query(
              "ALTER TABLE automation_executions ENABLE TRIGGER execution_identity_immutable",
            );
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            client.release();
          }
          expect(await relayOnce(pool, confirm, queue, [], eventId)).toBe(1);
          const channel = await broker.createChannel();
          try {
            const message = await channel.get(queue, { noAck: false });
            if (!message) throw new Error("missing peer delivery");
            await handleMessage(pool, channel, message, undefined, undefined, {
              handler: async () => "transient",
            });
          } finally {
            await channel.close();
          }
          const items = (
            await app.inject({
              method: "GET",
              url: `/executions?eventId=${eventId}`,
            })
          ).json().items;
          const conditional = items.find(
            (x: { automationId: string }) => x.automationId === id,
          );
          expect(conditional.retry).toMatchObject({
            scope: "event",
            outcome,
            reason: outcome,
          });
          expect(conditional).toMatchObject(
            value === 7
              ? {
                  status: "ignored",
                  result: {
                    decision: { outcome: "FALSE" },
                    action: { status: "ignored" },
                    failure: null,
                  },
                }
              : {
                  status: "blocked",
                  result: {
                    failure: {
                      classification: "permanent",
                      code: "condition_type_mismatch",
                    },
                  },
                },
          );
        }
      } finally {
        await confirm.deleteQueue(queue);
        await confirm.close();
        await broker.close();
        await app.close();
      }
    });
  },
);
