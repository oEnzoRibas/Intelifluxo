import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import type { ChannelModel, ConfirmChannel } from "amqplib";
import { cleanup } from "./cleanup.js";
import { api } from "../src/api.js";
import { connectBroker } from "../src/broker.js";
import { relayOnce } from "../src/relay.js";
import { scheduleOnce } from "../src/scheduler.js";
import { handleMessage } from "../src/worker.js";

describe.skipIf(process.env.INTEGRATION !== "1")(
  "retry scheduler with real services",
  () => {
    const schema = `test_${randomUUID().replaceAll("-", "")}`;
    const queue = `intelifluxo.test.${randomUUID()}`;
    let admin: pg.Pool,
      pool: pg.Pool,
      broker: ChannelModel,
      confirm: ConfirmChannel;
    let schemaOwned = false;
    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      schemaOwned = true;
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        options: `-c search_path=${schema}`,
      });
      for (const file of [
        "001_init.sql",
        "002_retry_dispositions.sql",
        "003_retry_publications.sql",
      ])
        await pool.query(
          await readFile(
            new URL(`../migrations/${file}`, import.meta.url),
            "utf8",
          ),
        );
      broker = await connectBroker();
      confirm = await broker.createConfirmChannel();
    });
    afterAll(async () => {
      await cleanup([
        [
          "queue",
          async () => {
            if (confirm) await confirm.deleteQueue(queue);
          },
        ],
        [
          "confirm channel",
          async () => {
            await confirm?.close();
          },
        ],
        [
          "connection",
          async () => {
            await broker?.close();
          },
        ],
        [
          "pool",
          async () => {
            await pool?.end();
          },
        ],
        [
          "schema",
          async () => {
            if (schemaOwned)
              await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
          },
        ],
        [
          "admin pool",
          async () => {
            await admin?.end();
          },
        ],
      ]);
    });
    it("releases once, recovers publication, and deduplicates retry after restart", async () => {
      const app = api(pool);
      const consumer = await broker.createChannel();
      try {
        const response = await app.inject({
          method: "POST",
          url: "/events",
          payload: {
            scope: randomUUID(),
            idempotencyKey: randomUUID(),
            type: "receipt.v1",
            target: "local-receipt",
            message: "synthetic",
          },
        });
        expect(response.statusCode).toBe(202);
        const id = response.json().id as string;
        expect(await relayOnce(pool, confirm, queue)).toBe(1);
        const initial = await consumer.get(queue, { noAck: false });
        if (!initial) throw new Error("missing initial delivery");
        const options = {
          handler: async () => "transient" as const,
          policy: { maxAttempts: 3, baseDelayMs: 60000, capDelayMs: 60000 },
        };
        await handleMessage(
          pool,
          consumer,
          initial,
          undefined,
          undefined,
          options,
        );
        expect(await scheduleOnce(pool)).toBe(0);
        expect(
          (
            await pool.query(
              "SELECT generation,state FROM retry_dispositions WHERE event_id=$1",
              [id],
            )
          ).rows,
        ).toEqual([{ generation: 0, state: "retry_scheduled" }]);
        await pool.query(
          "UPDATE retry_dispositions SET next_eligible_at=clock_timestamp()-interval '1 second' WHERE event_id=$1",
          [id],
        );
        const sweeps = await Promise.all(
          Array.from({ length: 5 }, () => scheduleOnce(pool)),
        );
        expect(sweeps.reduce((a, b) => a + b, 0)).toBe(1);
        expect(await scheduleOnce(pool)).toBe(0);
        expect(
          (
            await pool.query(
              "SELECT generation,confirmed_at,processed_at FROM retry_publications WHERE event_id=$1",
              [id],
            )
          ).rows,
        ).toEqual([{ generation: 1, confirmed_at: null, processed_at: null }]);
        expect(
          (await app.inject({ method: "GET", url: `/events/${id}` })).json(),
        ).toMatchObject({ status: "retry_released", publication: "pending" });
        const closed = await broker.createConfirmChannel();
        await closed.close();
        await expect(relayOnce(pool, closed, queue)).rejects.toThrow();
        expect(
          (
            await pool.query(
              "SELECT confirmed_at FROM retry_publications WHERE event_id=$1",
              [id],
            )
          ).rows[0].confirmed_at,
        ).toBeNull();
        // Inject a confirm failure only for the retry publication, after the
        // actual conformance probes have passed on the connected channel.
        const confirmFailure = new Proxy(confirm, {
          get(target, key) {
            if (key === "sendToQueue")
              return (
                name: string,
                body: Buffer,
                opts: object,
                callback: (error: Error | null) => void,
              ) => {
                if (body.toString().includes('"generation":1')) {
                  callback(new Error("synthetic confirm failure"));
                  return true;
                }
                return target.sendToQueue(name, body, opts, callback);
              };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        await expect(relayOnce(pool, confirmFailure, queue)).rejects.toThrow(
          "synthetic confirm failure",
        );
        expect(
          (
            await pool.query(
              "SELECT confirmed_at FROM retry_publications WHERE event_id=$1",
              [id],
            )
          ).rows[0].confirmed_at,
        ).toBeNull();
        // Simulate a process/DB failure after the broker has confirmed the real
        // publication but before its outbox update: the next relay republishes.
        const ambiguousPool = new Proxy(pool, {
          get(target, key) {
            if (key === "query")
              return (...args: unknown[]) => {
                if (
                  typeof args[0] === "string" &&
                  args[0].startsWith(
                    "UPDATE retry_publications SET confirmed_at",
                  )
                )
                  throw new Error("synthetic post-confirm failure");
                return (
                  target.query as (...values: unknown[]) => unknown
                ).apply(target, args);
              };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        await expect(relayOnce(ambiguousPool, confirm, queue)).rejects.toThrow(
          "synthetic post-confirm failure",
        );
        expect(
          (
            await pool.query(
              "SELECT confirmed_at FROM retry_publications WHERE event_id=$1",
              [id],
            )
          ).rows[0].confirmed_at,
        ).toBeNull();
        // A new pool reconstructs both sweep and relay state from PostgreSQL.
        const restarted = new pg.Pool({
          connectionString: process.env.DATABASE_URL,
          options: `-c search_path=${schema}`,
        });
        try {
          expect(await scheduleOnce(restarted)).toBe(0);
          expect(await relayOnce(restarted, confirm, queue)).toBe(1);
        } finally {
          await restarted.end();
        }
        const delivery = await consumer.get(queue, { noAck: false });
        if (!delivery) throw new Error("missing retry delivery");
        expect(JSON.parse(delivery.content.toString())).toEqual({
          version: 1,
          eventId: id,
          generation: 1,
        });
        let calls = 0;
        const success = {
          handler: async () => {
            calls++;
            return "success" as const;
          },
        };
        await handleMessage(
          pool,
          consumer,
          delivery,
          undefined,
          undefined,
          success,
        );
        const duplicate = await consumer.get(queue, { noAck: false });
        if (!duplicate) throw new Error("missing duplicate");
        expect(duplicate.content.equals(delivery.content)).toBe(true);
        await handleMessage(
          pool,
          consumer,
          duplicate,
          undefined,
          undefined,
          success,
        );
        expect(calls).toBe(1);
        expect(
          (
            await pool.query(
              "SELECT generation,attempt,state FROM retry_dispositions WHERE event_id=$1",
              [id],
            )
          ).rows,
        ).toEqual([{ generation: 1, attempt: 2, state: "completed" }]);
        expect(
          (
            await pool.query(
              "SELECT count(*) FROM receipts WHERE event_id=$1",
              [id],
            )
          ).rows[0].count,
        ).toBe("1");
        expect(
          (await app.inject({ method: "GET", url: `/events/${id}` })).json(),
        ).toMatchObject({
          status: "completed",
          publication: "confirmed",
          retry: { generation: 1, attempt: 2, outcome: "success" },
        });
      } finally {
        await cleanup([
          ["consumer channel", () => consumer.close()],
          ["app", () => app.close()],
        ]);
      }
    }, 30000);

    it("fails closed for an older retry without its exact processed marker", async () => {
      const app = api(pool);
      const consumer = await broker.createChannel();
      try {
        const response = await app.inject({
          method: "POST",
          url: "/events",
          payload: {
            scope: randomUUID(),
            idempotencyKey: randomUUID(),
            type: "receipt.v1",
            target: "local-receipt",
            message: "missing evidence",
          },
        });
        const id = response.json().id as string;
        expect(response.statusCode).toBe(202);
        expect(await relayOnce(pool, confirm, queue)).toBe(1);
        const initial = await consumer.get(queue, { noAck: false });
        if (!initial) throw new Error("missing initial delivery");
        let calls = 0;
        const options = {
          handler: async () => {
            calls++;
            return "transient" as const;
          },
        };
        await handleMessage(
          pool,
          consumer,
          initial,
          undefined,
          undefined,
          options,
        );
        await pool.query(
          "UPDATE retry_dispositions SET next_eligible_at=clock_timestamp()-interval '1 second' WHERE event_id=$1",
          [id],
        );
        expect(await scheduleOnce(pool)).toBe(1);
        expect(await relayOnce(pool, confirm, queue)).toBe(1);
        const stale = await consumer.get(queue, { noAck: false });
        if (!stale) throw new Error("missing retry delivery");
        // Deliberately violate scheduler invariants to model insufficient evidence.
        await pool.query(
          "UPDATE retry_dispositions SET generation=2,next_eligible_at=clock_timestamp()+interval '1 day' WHERE event_id=$1",
          [id],
        );
        await pool.query(
          "INSERT INTO retry_publications(event_id,generation,confirmed_at,processed_at) VALUES ($1,2,clock_timestamp(),clock_timestamp())",
          [id],
        );
        const before = (
          await pool.query(
            "SELECT * FROM retry_publications WHERE event_id=$1 ORDER BY generation",
            [id],
          )
        ).rows;
        const ack = vi.spyOn(consumer, "ack");
        await expect(
          handleMessage(pool, consumer, stale, undefined, undefined, options),
        ).rejects.toThrow("unexpected generation");
        expect(ack).not.toHaveBeenCalled();
        expect(calls).toBe(1);
        expect(
          (
            await pool.query(
              "SELECT * FROM retry_publications WHERE event_id=$1 ORDER BY generation",
              [id],
            )
          ).rows,
        ).toEqual(before);
        ack.mockRestore();
        consumer.nack(stale, false, false);
      } finally {
        await cleanup([
          ["consumer channel", () => consumer.close()],
          ["app", () => app.close()],
        ]);
      }
    }, 30000);

    it("acks evidenced older generations after locked reread and commit without stopping consumption", async () => {
      const app = api(pool);
      const consumer = await broker.createChannel();
      let calls = 0;
      const options = {
        handler: async () => {
          calls++;
          return "transient" as const;
        },
        policy: { maxAttempts: 3, baseDelayMs: 60000, capDelayMs: 60000 },
      };
      try {
        const response = await app.inject({
          method: "POST",
          url: "/events",
          payload: {
            scope: randomUUID(),
            idempotencyKey: randomUUID(),
            type: "receipt.v1",
            target: "local-receipt",
            message: "old duplicates",
          },
        });
        const id = response.json().id as string;
        expect(response.statusCode).toBe(202);
        expect(await relayOnce(pool, confirm, queue)).toBe(1);
        const initial = await consumer.get(queue, { noAck: false });
        if (!initial) throw new Error("missing initial delivery");
        await handleMessage(
          pool,
          consumer,
          initial,
          undefined,
          undefined,
          options,
        );
        await pool.query(
          "UPDATE retry_dispositions SET next_eligible_at=clock_timestamp()-interval '1 second' WHERE event_id=$1",
          [id],
        );
        expect(await scheduleOnce(pool)).toBe(1);
        expect(await relayOnce(pool, confirm, queue)).toBe(1);
        const firstRetry = await consumer.get(queue, { noAck: false });
        if (!firstRetry) throw new Error("missing first retry");
        await handleMessage(
          pool,
          consumer,
          firstRetry,
          undefined,
          undefined,
          options,
        );
        await pool.query(
          "UPDATE retry_dispositions SET next_eligible_at=clock_timestamp()-interval '1 second' WHERE event_id=$1",
          [id],
        );
        expect(await scheduleOnce(pool)).toBe(1);
        expect(calls).toBe(2);

        const snapshot = async () =>
          Promise.all(
            [
              "retry_dispositions",
              "retry_publications",
              "receipts",
              "outbox",
            ].map(
              async (table) =>
                (
                  await pool.query(
                    `SELECT * FROM ${table} WHERE event_id=$1 ORDER BY 1`,
                    [id],
                  )
                ).rows,
            ),
          );
        const before = await snapshot();
        const ackSpy = vi.spyOn(consumer, "ack");
        const deliveries: Promise<void>[] = [];
        let resolveDelivery: (() => void) | undefined;
        let rejectDelivery: ((error: unknown) => void) | undefined;
        await consumer.consume(
          queue,
          (message) => {
            if (!message) {
              rejectDelivery?.(new Error("consumer cancelled"));
              return;
            }
            const work = (async () => {
              const client = await pool.connect();
              const querySpy = vi.spyOn(client, "query");
              const observedPool = {
                connect: async () => client,
              } as unknown as pg.Pool;
              const ackCount = ackSpy.mock.calls.length;
              try {
                await handleMessage(
                  observedPool,
                  consumer,
                  message,
                  async () => {
                    expect(ackSpy).toHaveBeenCalledTimes(ackCount);
                    expect(await snapshot()).toEqual(before);
                  },
                  undefined,
                  options,
                );
                const lock = querySpy.mock.calls.findIndex(
                  ([sql]) =>
                    typeof sql === "string" &&
                    sql.includes("FROM events WHERE id=$1 FOR UPDATE"),
                );
                const evidence = querySpy.mock.calls.findIndex(
                  ([sql]) =>
                    typeof sql === "string" &&
                    sql.startsWith("SELECT 1 FROM retry_publications"),
                );
                const commit = querySpy.mock.calls.findIndex(
                  ([sql]) => sql === "COMMIT",
                );
                expect(lock).toBeGreaterThanOrEqual(0);
                expect(evidence).toBeGreaterThan(lock);
                expect(commit).toBeGreaterThan(evidence);
                expect(ackSpy).toHaveBeenCalledTimes(ackCount + 1);
                expect(ackSpy).toHaveBeenLastCalledWith(message);
                expect(querySpy.mock.invocationCallOrder[commit]).toBeLessThan(
                  ackSpy.mock.invocationCallOrder[ackCount],
                );
              } finally {
                querySpy.mockRestore();
              }
            })();
            deliveries.push(work);
            void work.then(
              () => resolveDelivery?.(),
              (error: unknown) => rejectDelivery?.(error),
            );
          },
          { noAck: false },
        );
        // The third delivery demonstrates the same consumer survives both old duplicates.
        for (const body of [
          initial.content,
          firstRetry.content,
          initial.content,
        ]) {
          const received = new Promise<void>((resolve, reject) => {
            resolveDelivery = resolve;
            rejectDelivery = reject;
          });
          confirm.sendToQueue(queue, body, { persistent: true });
          await confirm.waitForConfirms();
          await received;
        }
        await Promise.all(deliveries);
        expect(calls).toBe(2);
        expect(await snapshot()).toEqual(before);
        ackSpy.mockRestore();
      } finally {
        await cleanup([
          ["consumer channel", () => consumer.close()],
          ["app", () => app.close()],
        ]);
      }
    }, 30000);
  },
);
