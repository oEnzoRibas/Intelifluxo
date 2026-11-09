import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Message } from "amqplib";
import pg from "pg";
import { api } from "../src/api.js";
import { handleMessage, processMessage } from "../src/worker.js";
import { connectBroker } from "../src/broker.js";
import { relayOnce } from "../src/relay.js";
import { scheduleOnce } from "../src/scheduler.js";
import { defaultGraph } from "../src/graph.js";

describe.skipIf(process.env.INTEGRATION !== "1")(
  "automation executions",
  () => {
    const schema = `test_${randomUUID().replaceAll("-", "")}`;
    let admin: pg.Pool, pool: pg.Pool;
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
        "005_automation_executions.sql",
      ])
        await pool.query(
          await readFile(
            new URL(`../migrations/${file}`, import.meta.url),
            "utf8",
          ),
        );
    });
    afterAll(async () => {
      await pool?.end();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
      }
    });
    it("keeps legacy acceptance free of context and executions when disabled", async () => {
      const app = api(pool, false);
      const accepted = await app.inject({
        method: "POST",
        url: "/events",
        payload: {
          scope: "off",
          idempotencyKey: "off",
          type: "receipt.v1",
          target: "local-receipt",
          message: "off",
        },
      });
      expect(accepted.statusCode).toBe(202);
      const id = accepted.json().id;
      for (const table of [
        "event_automation_context",
        "automation_executions",
      ]) {
        expect(
          (await pool.query(`SELECT 1 FROM ${table} WHERE event_id=$1`, [id]))
            .rowCount,
        ).toBe(0);
      }
      await app.close();
    });
    it("pins active matching revisions once and commits result with receipt", async () => {
      const app = api(pool, true);
      const config = {
        name: "test",
        schemaVersion: 1,
        trigger: { type: "receipt.v1" },
        action: { type: "record-receipt.v1" },
      };
      const graph = defaultGraph();
      graph.nodes[0].position.x = 123;
      const created = await app.inject({
        method: "POST",
        url: "/automations",
        payload: { ...config, scope: "demo", graph },
      });
      const automationId = created.json().id;
      const second = await app.inject({
        method: "POST",
        url: "/automations",
        payload: { ...config, scope: "demo" },
      });
      const other = await app.inject({
        method: "POST",
        url: "/automations",
        payload: { ...config, scope: "other" },
      });
      for (const id of [automationId, second.json().id, other.json().id])
        expect(
          (
            await app.inject({
              method: "PUT",
              url: `/automations/${id}`,
              payload: { ...config, active: true, expectedRevision: 1 },
            })
          ).statusCode,
        ).toBe(200);
      const payload = {
        scope: "demo",
        idempotencyKey: "key",
        type: "receipt.v1",
        target: "local-receipt",
        message: "hello",
      };
      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          app.inject({ method: "POST", url: "/events", payload }),
        ),
      );
      const accepted = responses.find(
        (response) => response.statusCode === 202,
      )!;
      expect(
        responses.filter((response) => response.statusCode === 202),
      ).toHaveLength(1);
      const eventId = accepted.json().id;
      expect(
        responses.every((response) => response.json().id === eventId),
      ).toBe(true);
      const list = () =>
        app.inject({ method: "GET", url: `/executions?eventId=${eventId}` });
      const initial = (await list()).json().items;
      expect(initial).toHaveLength(2);
      const first = initial.find(
        (item: { automationId: string }) => item.automationId === automationId,
      );
      expect(first).toMatchObject({
        eventId,
        automationId,
        revision: 2,
        status: "accepted",
        result: null,
      });
      expect(
        (
          await pool.query(
            "SELECT graph FROM automation_definition_revisions WHERE automation_id=$1 AND revision=$2",
            [automationId, first.revision],
          )
        ).rows[0].graph,
      ).toEqual(graph);
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `/automations/${automationId}`,
            payload: {
              ...config,
              name: "changed",
              active: false,
              expectedRevision: 2,
            },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ method: "POST", url: "/events", payload })).json(),
      ).toEqual({ id: eventId, replay: true });
      expect((await list()).json().items).toHaveLength(2);
      const dispatch = {
        content: Buffer.from(JSON.stringify({ version: 1, eventId })),
      } as Message;
      await expect(
        processMessage(pool, dispatch, async () => {
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(
        (await list())
          .json()
          .items.map((item: { status: string }) => item.status),
      ).toEqual(["accepted", "accepted"]);
      await processMessage(pool, dispatch);
      await processMessage(pool, dispatch);
      const completed = (await list()).json().items;
      expect(
        completed.every(
          (item: { status: string }) => item.status === "completed",
        ),
      ).toBe(true);
      const result = completed.find(
        (item: { automationId: string }) => item.automationId === automationId,
      );
      expect(result).toMatchObject({
        id: first.id,
        revision: 2,
        status: "completed",
        result: { kind: "local-receipt.v1", eventId, message: "hello" },
      });
      expect(
        (
          await app.inject({ method: "GET", url: `/executions/${result.id}` })
        ).json(),
      ).toEqual(result);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/executions?automationId=${automationId}`,
          })
        ).json().items,
      ).toHaveLength(1);
      for (const url of [
        "/executions",
        `/executions?eventId=${eventId}&automationId=${automationId}`,
        `/executions?eventId=${eventId}&extra=x`,
        "/executions/not-a-uuid",
      ])
        expect((await app.inject({ method: "GET", url })).statusCode).toBe(400);
      await app.close();
    });
    it("retains the pinned identity across retry and blocks unknown semantics", async () => {
      const app = api(pool, true);
      const config = {
        name: "retry",
        schemaVersion: 1,
        trigger: { type: "receipt.v1" },
        action: { type: "record-receipt.v1" },
      };
      const created = await app.inject({
        method: "POST",
        url: "/automations",
        payload: { ...config, scope: "retry" },
      });
      await app.inject({
        method: "PUT",
        url: `/automations/${created.json().id}`,
        payload: { ...config, active: true, expectedRevision: 1 },
      });
      const makeEvent = async (key: string) =>
        (
          await app.inject({
            method: "POST",
            url: "/events",
            payload: {
              scope: "retry",
              idempotencyKey: key,
              type: "receipt.v1",
              target: "local-receipt",
              message: key,
            },
          })
        ).json().id as string;
      const dispatch = (id: string, generation = 0) =>
        ({
          content: Buffer.from(
            JSON.stringify({ version: 1, eventId: id, generation }),
          ),
        }) as Message;
      const list = async (id: string) =>
        (
          await app.inject({ method: "GET", url: `/executions?eventId=${id}` })
        ).json().items[0];
      const id = await makeEvent("transient");
      const before = await list(id);
      await processMessage(pool, dispatch(id), undefined, {
        handler: async () => "transient",
      });
      expect(await list(id)).toMatchObject({
        id: before.id,
        revision: 2,
        status: "retry_scheduled",
      });
      await pool.query(
        "UPDATE retry_dispositions SET next_eligible_at=now() WHERE event_id=$1",
        [id],
      );
      expect(await scheduleOnce(pool, 100, id)).toBe(1);
      expect((await list(id)).status).toBe("retry_released");
      await processMessage(pool, dispatch(id, 1));
      expect(await list(id)).toMatchObject({
        id: before.id,
        revision: 2,
        status: "completed",
      });
      const unknown = await makeEvent("unknown");
      await pool.query(
        "UPDATE automation_executions SET action_type='future.v2' WHERE event_id=$1",
        [unknown],
      );
      await processMessage(pool, dispatch(unknown));
      expect(await list(unknown)).toMatchObject({
        status: "blocked",
        retry: { reason: "unknown" },
        result: null,
      });
      expect(
        (
          await pool.query("SELECT 1 FROM receipts WHERE event_id=$1", [
            unknown,
          ])
        ).rowCount,
      ).toBe(0);
      await app.close();
    });
    it("relays and redelivers a pinned execution through RabbitMQ", async () => {
      const app = api(pool, true);
      const connection = await connectBroker();
      const confirm = await connection.createConfirmChannel();
      const queue = `intelifluxo.test.${randomUUID()}`;
      try {
        const config = {
          name: "broker",
          schemaVersion: 1,
          trigger: { type: "receipt.v1" },
          action: { type: "record-receipt.v1" },
        };
        const created = await app.inject({
          method: "POST",
          url: "/automations",
          payload: { ...config, scope: "broker" },
        });
        await app.inject({
          method: "PUT",
          url: `/automations/${created.json().id}`,
          payload: { ...config, active: true, expectedRevision: 1 },
        });
        const accepted = await app.inject({
          method: "POST",
          url: "/events",
          payload: {
            scope: "broker",
            idempotencyKey: "broker",
            type: "receipt.v1",
            target: "local-receipt",
            message: "broker",
          },
        });
        const eventId = accepted.json().id;
        await confirm.assertQueue(queue, { durable: true });
        await pool.query(
          "UPDATE outbox SET confirmed_at=now() WHERE event_id<>$1",
          [eventId],
        );
        await relayOnce(pool, confirm, queue, [], eventId);
        const channel = await connection.createChannel();
        const message = await channel.get(queue, { noAck: false });
        if (!message) throw new Error("missing delivery");
        await handleMessage(pool, channel, message, undefined, undefined, {
          handler: async () => "transient",
        });
        expect(
          (
            await app.inject({
              method: "GET",
              url: `/executions?eventId=${eventId}`,
            })
          ).json().items[0].status,
        ).toBe("retry_scheduled");
        await pool.query(
          "UPDATE retry_dispositions SET next_eligible_at=now() WHERE event_id=$1",
          [eventId],
        );
        expect(await scheduleOnce(pool, 100, eventId)).toBe(1);
        expect(await relayOnce(pool, confirm, queue, [], eventId)).toBe(1);
        const retry = await channel.get(queue, { noAck: false });
        if (!retry) throw new Error("missing retry delivery");
        await expect(
          handleMessage(pool, channel, retry, async () => {
            throw new Error("after commit");
          }),
        ).rejects.toThrow("after commit");
        await channel.close();
        const next = await connection.createChannel();
        const redelivery = await next.get(queue, { noAck: false });
        if (!redelivery) throw new Error("missing redelivery");
        expect(redelivery.fields.redelivered).toBe(true);
        await handleMessage(pool, next, redelivery);
        const result = (
          await app.inject({
            method: "GET",
            url: `/executions?eventId=${eventId}`,
          })
        ).json().items;
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
          status: "completed",
          revision: 2,
          result: { eventId, message: "broker" },
        });
        await next.close();
      } finally {
        await confirm.deleteQueue(queue);
        await confirm.close();
        await connection.close();
        await app.close();
      }
    });
  },
);
