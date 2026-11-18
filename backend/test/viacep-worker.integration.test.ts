import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { api } from "../src/api.js";
import { connectBroker } from "../src/broker.js";
import { relayOnce } from "../src/relay.js";
import { scheduleOnce } from "../src/scheduler.js";
import { handleMessage } from "../src/worker.js";

const graph = {
  version: 3,
  nodes: [
    {
      id: "trigger",
      kind: "trigger",
      type: "receipt.v1",
      position: { x: 0, y: 0 },
    },
    {
      id: "lookup",
      kind: "lookup",
      type: "viacep-address.v1",
      position: { x: 0, y: 0 },
      config: { cep: { source: "fixed", value: "01001-000" } },
    },
    {
      id: "condition",
      kind: "condition",
      type: "condition.v2",
      position: { x: 0, y: 0 },
      config: {
        input: { source: "step", nodeId: "lookup", fieldPath: "address.uf" },
        operator: "equals",
        expectedType: "string",
        expectedValue: "SP",
      },
    },
    {
      id: "action",
      kind: "action",
      type: "record-receipt.v1",
      position: { x: 0, y: 0 },
    },
    { id: "end", kind: "end", type: "end.v1", position: { x: 0, y: 0 } },
  ],
  edges: [
    { source: "trigger", target: "lookup" },
    { source: "lookup", target: "condition" },
    { source: "condition", sourcePort: "TRUE", target: "action" },
    { source: "condition", sourcePort: "FALSE", target: "end" },
    { source: "action", target: "end" },
  ],
};

describe.skipIf(process.env.INTEGRATION !== "1")(
  "ViaCEP pinned worker service path",
  () => {
    const schema = `viacep_worker_${randomUUID().replaceAll("-", "")}`;
    const queue = `viacep-worker.${randomUUID()}`;
    let admin: pg.Pool, pool: pg.Pool;
    let broker: Awaited<ReturnType<typeof connectBroker>>;
    let channel: Awaited<ReturnType<typeof broker.createConfirmChannel>>;
    let app: ReturnType<typeof api>;
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
      app = api(pool, true);
      broker = await connectBroker();
      channel = await broker.createConfirmChannel();
      await channel.assertQueue(queue, { durable: true });
    });
    afterAll(async () => {
      const errors: unknown[] = [];
      const attempt = async (action: () => Promise<unknown>) => {
        try {
          await action();
        } catch (error) {
          errors.push(error);
        }
      };
      if (channel) {
        await attempt(() => channel.deleteQueue(queue));
        await attempt(() => channel.close());
      }
      if (broker) await attempt(() => broker.close());
      if (app) await attempt(() => app.close());
      if (pool) await attempt(() => pool.end());
      if (admin) {
        await attempt(() =>
          admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`),
        );
        await attempt(() => admin.end());
      }
      if (errors.length)
        throw new AggregateError(errors, "integration cleanup failed");
    });
    async function setup() {
      const automation = randomUUID(),
        scope = randomUUID();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "INSERT INTO automation_definitions(id,scope,current_revision) VALUES ($1,$2,1)",
          [automation, scope],
        );
        await client.query(
          "INSERT INTO automation_definition_revisions (automation_id,revision,name,active,schema_version,trigger_type,action_type,graph) VALUES ($1,1,'pinned',true,3,'receipt.v1','record-receipt.v1',$2)",
          [automation, JSON.stringify(graph)],
        );
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
      const response = await app.inject({
        method: "POST",
        url: "/events",
        payload: {
          scope,
          idempotencyKey: randomUUID(),
          type: "receipt.v1",
          target: "local-receipt",
          message: "hello",
        },
      });
      expect(response.statusCode).toBe(202);
      const eventId: string = response.json().id;
      expect(await relayOnce(pool, channel, queue, [], eventId)).toBe(1);
      return { eventId, automation };
    }
    async function delivery() {
      const msg = await channel.get(queue, { noAck: false });
      if (!msg) throw new Error("missing delivery");
      return msg;
    }
    // Closing the processing channel requeues any unacknowledged delivery. A
    // fresh channel's bounded basic.get therefore checks broker ACK, not just DB state.
    async function processAndVerifyAck(
      options: Parameters<typeof handleMessage>[5],
    ) {
      const worker = await broker.createChannel();
      try {
        const msg = await worker.get(queue, { noAck: false });
        if (!msg) throw new Error("missing delivery");
        await handleMessage(pool, worker, msg, undefined, undefined, options);
      } finally {
        await worker.close();
      }
      const probe = await broker.createChannel();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const message = await Promise.race([
          probe.get(queue, { noAck: false }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("broker ACK check timed out")),
              5000,
            );
          }),
        ]);
        expect(message).toBe(false);
      } finally {
        clearTimeout(timer);
        await probe.close();
      }
    }
    const found = (uf: string) => ({
      status: "found" as const,
      address: { cep: "01001-000", uf, logradouro: "" },
    });
    it.each([
      ["SP", "TRUE", "executed", "completed"],
      ["RJ", "FALSE", "ignored", "ignored"],
    ] as const)(
      "persists and reads found %s",
      async (uf, outcome, action, status) => {
        const { eventId, automation } = await setup();
        const lookup = vi.fn(async () => found(uf));
        await processAndVerifyAck({
          viacepExternalExecutionEnabled: true,
          viacepLookup: lookup,
          viacepTimeoutMs: 1234,
        });
        expect(lookup).toHaveBeenCalledWith("01001000", { timeoutMs: 1234 });
        const result = await pool.query(
          "SELECT id,result FROM automation_executions WHERE event_id=$1",
          [eventId],
        );
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].result).toMatchObject({
          lookup: {
            status: "found",
            address: { cep: "01001-000", uf, logradouro: "" },
          },
          decision: { outcome },
          action: { status: action },
        });
        expect(Object.keys(result.rows[0].result.lookup).sort()).toEqual([
          "address",
          "cep",
          "failure",
          "kind",
          "nodeId",
          "status",
        ]);
        expect(result.rows[0].result.lookup.address).not.toHaveProperty(
          "complemento",
        );
        expect(
          (
            await pool.query(
              "SELECT state FROM retry_dispositions WHERE event_id=$1",
              [eventId],
            )
          ).rows[0].state,
        ).toBe("completed");
        expect(
          (
            await pool.query("SELECT 1 FROM receipts WHERE event_id=$1", [
              eventId,
            ])
          ).rowCount,
        ).toBe(1);
        const list = await app.inject({
          method: "GET",
          url: `/executions?eventId=${eventId}`,
        });
        expect(list.statusCode).toBe(200);
        expect(
          list
            .json()
            .items.find(
              (x: { automationId: string }) => x.automationId === automation,
            ),
        ).toMatchObject({ status, result: result.rows[0].result });
        const detail = await app.inject({
          method: "GET",
          url: `/executions/${result.rows[0].id}`,
        });
        expect(detail.statusCode).toBe(200);
        expect(detail.json()).toMatchObject({
          status,
          result: result.rows[0].result,
        });
      },
    );
    it("persists retry delays and generations, manually releases eligibility, and blocks the third timeout", async () => {
      const { eventId } = await setup();
      const lookup = vi.fn(async () => ({ status: "timeout" as const }));
      for (let generation = 0; generation < 3; generation++) {
        await processAndVerifyAck({
          viacepExternalExecutionEnabled: true,
          viacepLookup: lookup,
          viacepTimeoutMs: 1234,
        });
        const d = (
          await pool.query(
            "SELECT * FROM retry_dispositions WHERE event_id=$1",
            [eventId],
          )
        ).rows[0];
        expect(d).toMatchObject({
          generation,
          attempt: generation + 1,
          state: generation === 2 ? "blocked" : "retry_scheduled",
          delay_ms: generation === 2 ? null : 1000 * (generation + 1),
        });
        if (generation < 2) {
          // Exercise the scheduler release path without waiting for wall-clock delay
          // or starting the worker consumer loop.
          await pool.query(
            "UPDATE retry_dispositions SET next_eligible_at=now() WHERE event_id=$1",
            [eventId],
          );
          expect(await scheduleOnce(pool, 100, eventId)).toBe(1);
          expect(await relayOnce(pool, channel, queue, [], eventId)).toBe(1);
        }
      }
      expect(lookup).toHaveBeenCalledTimes(3);
      const publications = (
        await pool.query(
          "SELECT generation, processed_at FROM retry_publications WHERE event_id=$1 ORDER BY generation",
          [eventId],
        )
      ).rows;
      expect(publications.map((p) => p.generation)).toEqual([1, 2]);
      expect(publications.every((p) => p.processed_at instanceof Date)).toBe(
        true,
      );
      expect(
        (
          await pool.query(
            "SELECT * FROM retry_publications WHERE event_id=$1 ORDER BY generation",
            [eventId],
          )
        ).rows,
      ).toHaveLength(2);
      expect(
        (
          await pool.query(
            "SELECT result FROM automation_executions WHERE event_id=$1",
            [eventId],
          )
        ).rows[0].result.failure.classification,
      ).toBe("exhausted");
      expect(
        (
          await pool.query("SELECT 1 FROM receipts WHERE event_id=$1", [
            eventId,
          ])
        ).rowCount,
      ).toBe(0);
    });
    it("rolls back before commit and queries again on redelivery", async () => {
      const { eventId } = await setup();
      const worker = await broker.createChannel();
      const lookup = vi.fn(async () => found("SP"));
      try {
        const msg = await worker.get(queue, { noAck: false });
        if (!msg) throw new Error("missing delivery");
        await expect(
          handleMessage(
            pool,
            worker,
            msg,
            undefined,
            async () => {
              throw new Error("injected crash");
            },
            {
              viacepExternalExecutionEnabled: true,
              viacepLookup: lookup,
              viacepTimeoutMs: 1234,
            },
          ),
        ).rejects.toThrow("injected crash");
        expect(
          (
            await pool.query(
              "SELECT result FROM automation_executions WHERE event_id=$1",
              [eventId],
            )
          ).rows[0].result,
        ).toBeNull();
        expect(
          (
            await pool.query(
              "SELECT 1 FROM retry_dispositions WHERE event_id=$1",
              [eventId],
            )
          ).rowCount,
        ).toBe(0);
        expect(
          (
            await pool.query("SELECT 1 FROM receipts WHERE event_id=$1", [
              eventId,
            ])
          ).rowCount,
        ).toBe(0);
      } finally {
        await worker.close();
      }
      const redelivery = await delivery();
      expect(redelivery.fields.redelivered).toBe(true);
      await handleMessage(pool, channel, redelivery, undefined, undefined, {
        viacepExternalExecutionEnabled: true,
        viacepLookup: lookup,
        viacepTimeoutMs: 1234,
      });
      expect(lookup).toHaveBeenCalledTimes(2);
      expect(
        (
          await pool.query(
            "SELECT state FROM retry_dispositions WHERE event_id=$1",
            [eventId],
          )
        ).rows[0].state,
      ).toBe("completed");
      expect(
        (
          await pool.query("SELECT 1 FROM receipts WHERE event_id=$1", [
            eventId,
          ])
        ).rowCount,
      ).toBe(1);
    });
    it("reuses a found observation after a transient peer outcome", async () => {
      const { eventId } = await setup();
      const lookup = vi.fn(async () => found("SP"));
      await processAndVerifyAck({
        viacepExternalExecutionEnabled: true,
        viacepLookup: lookup,
        viacepTimeoutMs: 1234,
        handler: async () => "transient",
      });
      const original = (
        await pool.query(
          "SELECT result FROM automation_executions WHERE event_id=$1",
          [eventId],
        )
      ).rows[0].result.lookup;
      expect(original.status).toBe("found");
      await pool.query(
        "UPDATE retry_dispositions SET next_eligible_at=now() WHERE event_id=$1",
        [eventId],
      );
      expect(await scheduleOnce(pool, 100, eventId)).toBe(1);
      expect(await relayOnce(pool, channel, queue, [], eventId)).toBe(1);
      lookup.mockClear();
      await processAndVerifyAck({
        viacepExternalExecutionEnabled: true,
        viacepLookup: lookup,
        viacepTimeoutMs: 1234,
        handler: async () => "success",
      });
      expect(lookup).not.toHaveBeenCalled();
      expect(
        (
          await pool.query(
            "SELECT result FROM automation_executions WHERE event_id=$1",
            [eventId],
          )
        ).rows[0].result.lookup,
      ).toEqual(original);
      expect(
        (
          await pool.query(
            "SELECT state FROM retry_dispositions WHERE event_id=$1",
            [eventId],
          )
        ).rows[0].state,
      ).toBe("completed");
    });
    it("fails closed on corrupt JSON null without acknowledging", async () => {
      const { eventId } = await setup();
      // Simulate historical corruption in the disposable schema only.
      await pool.query(
        "ALTER TABLE automation_executions DROP CONSTRAINT automation_execution_result_valid_v3",
      );
      await pool.query(
        "ALTER TABLE automation_executions DROP CONSTRAINT automation_execution_target_valid_v3",
      );
      await pool.query(
        "UPDATE automation_executions SET result='null'::jsonb WHERE event_id=$1",
        [eventId],
      );
      const worker = await broker.createChannel();
      const lookup = vi.fn(async () => found("SP"));
      try {
        const msg = await worker.get(queue, { noAck: false });
        if (!msg) throw new Error("missing delivery");
        await expect(
          handleMessage(pool, worker, msg, undefined, undefined, {
            viacepExternalExecutionEnabled: true,
            viacepLookup: lookup,
            viacepTimeoutMs: 1234,
          }),
        ).rejects.toThrow();
        expect(lookup).not.toHaveBeenCalled();
        expect(
          (
            await pool.query(
              "SELECT 1 FROM retry_dispositions WHERE event_id=$1",
              [eventId],
            )
          ).rowCount,
        ).toBe(0);
        expect(
          (
            await pool.query("SELECT 1 FROM receipts WHERE event_id=$1", [
              eventId,
            ])
          ).rowCount,
        ).toBe(0);
      } finally {
        await worker.close();
      }
      const redelivery = await delivery();
      expect(redelivery.fields.redelivered).toBe(true);
      channel.nack(redelivery, false, false);
    });
  },
);
