import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import pg from "pg";
import type { ChannelModel, ConfirmChannel } from "amqplib";
import { api } from "../src/api.js";
import { database } from "../src/db.js";
import { connectBroker, conformanceGate, publish } from "../src/broker.js";
import { relayOnce } from "../src/relay.js";
import { handleMessage, processMessage, startWorker } from "../src/worker.js";
import { cleanup } from "./cleanup.js";

// Explicit opt-in only: these tests require disposable dedicated services and queue.
describe.skipIf(process.env.INTEGRATION !== "1")(
  "real PostgreSQL and RabbitMQ",
  () => {
    let pool: pg.Pool;
    let connection: ChannelModel;
    let confirm: ConfirmChannel;
    let admin: pg.Pool;
    let schemaCreated = false;
    const schema = `test_${randomUUID().replaceAll("-", "")}`;
    const queue = `intelifluxo.test.${randomUUID()}`;
    beforeAll(async () => {
      admin = database();
      await admin.query(`CREATE SCHEMA "${schema}"`);
      schemaCreated = true;
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
          new URL("../migrations/002_retry_dispositions.sql", import.meta.url),
          "utf8",
        ),
      );
      await pool.query(
        await readFile(
          new URL("../migrations/003_retry_publications.sql", import.meta.url),
          "utf8",
        ),
      );
      for (const file of [
        "004_automation_definitions.sql",
        "005_automation_executions.sql",
      ])
        await pool.query(
          await readFile(
            new URL(`../migrations/${file}`, import.meta.url),
            "utf8",
          ),
        );
      connection = await connectBroker();
      confirm = await connection.createConfirmChannel();
    });
    afterAll(async () => {
      await cleanup([
        ["delete run queue", async () => confirm?.deleteQueue(queue)],
        ["close confirm channel", async () => confirm?.close()],
        ["close broker connection", async () => connection?.close()],
        ["close test pool", async () => pool?.end()],
        [
          "drop run schema",
          async () => {
            if (admin && schemaCreated)
              await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          },
        ],
        ["close admin pool", async () => admin?.end()],
      ]);
    });
    it("runs migrations on fresh and 001 schemas and preserves legacy receipts", async () => {
      for (const existing of [false, true]) {
        const migrationSchema = `test_${randomUUID().replaceAll("-", "")}`;
        await admin.query(`CREATE SCHEMA "${migrationSchema}"`);
        const migrationPool = new pg.Pool({
          connectionString: process.env.DATABASE_URL,
          options: `-c search_path=${migrationSchema}`,
        });
        try {
          const id = randomUUID();
          if (existing) {
            await migrationPool.query(
              await readFile(
                new URL("../migrations/001_init.sql", import.meta.url),
                "utf8",
              ),
            );
            await migrationPool.query(
              "INSERT INTO events(id,scope,idempotency_key,content) VALUES ($1,$2,$3,$4)",
              [
                id,
                "legacy",
                "key",
                {
                  type: "receipt.v1",
                  target: "local-receipt",
                  message: "legacy",
                },
              ],
            );
            await migrationPool.query(
              "INSERT INTO receipts(event_id,result) VALUES ($1,$2)",
              [
                id,
                { kind: "local-receipt.v1", eventId: id, message: "legacy" },
              ],
            );
            await migrationPool.query(
              "INSERT INTO outbox(event_id,confirmed_at) VALUES ($1,now())",
              [id],
            );
          }
          for (let i = 0; i < 2; i++) {
            execFileSync(
              process.execPath,
              ["node_modules/tsx/dist/cli.mjs", "src/migrate.ts"],
              {
                cwd: process.cwd(),
                env: {
                  ...process.env,
                  PGOPTIONS: `-c search_path=${migrationSchema}`,
                },
              },
            );
          }
          expect(
            (
              await migrationPool.query(
                "SELECT to_regclass('events') AS events, to_regclass('retry_dispositions') AS retry",
              )
            ).rows[0],
          ).toEqual({ events: "events", retry: "retry_dispositions" });
          if (existing) {
            const app = api(migrationPool);
            try {
              expect(
                (
                  await app.inject({ method: "GET", url: `/events/${id}` })
                ).json(),
              ).toMatchObject({
                status: "completed",
                retry: null,
                result: { eventId: id },
              });
              let called = false;
              await processMessage(
                migrationPool,
                {
                  content: Buffer.from(
                    JSON.stringify({ version: 1, eventId: id }),
                  ),
                } as never,
                undefined,
                {
                  handler: async () => {
                    called = true;
                    return "success";
                  },
                },
              );
              expect(called).toBe(false);
              expect(
                (await migrationPool.query("SELECT * FROM retry_dispositions"))
                  .rowCount,
              ).toBe(0);
              expect(
                (await migrationPool.query("SELECT * FROM receipts")).rowCount,
              ).toBe(1);
            } finally {
              await app.close();
            }
          }
        } finally {
          await migrationPool.end();
          await admin.query(`DROP SCHEMA "${migrationSchema}" CASCADE`);
        }
      }
    }, 30000);
    it("persists disposition atomically, deduplicates and exposes the committed state", async () => {
      const app = api(pool);
      const channel = await connection.createChannel();
      await channel.assertQueue(queue, { durable: true });
      try {
        for (const [outcome, maxAttempts, expected, reason] of [
          ["transient", 3, "retry_scheduled", null],
          ["transient", 1, "blocked", "exhausted"],
          ["permanent", 3, "blocked", "permanent"],
          ["unknown", 3, "blocked", "unknown"],
        ] as const) {
          const response = await app.inject({
            method: "POST",
            url: "/events",
            payload: {
              scope: randomUUID(),
              idempotencyKey: randomUUID(),
              type: "receipt.v1",
              target: "local-receipt",
              message: "test",
            },
          });
          const id = response.json().id as string;
          const body = Buffer.from(JSON.stringify({ version: 1, eventId: id }));
          channel.sendToQueue(queue, body);
          const delivery = await channel.get(queue, { noAck: false });
          if (!delivery) throw new Error("missing delivery");
          let calls = 0;
          const options = {
            handler: async () => {
              calls++;
              return outcome;
            },
            policy: { maxAttempts, baseDelayMs: 1000, capDelayMs: 60000 },
          };
          await expect(
            handleMessage(
              pool,
              channel,
              delivery,
              undefined,
              async () => {
                throw new Error("rollback");
              },
              options,
            ),
          ).rejects.toThrow("rollback");
          expect(
            (
              await pool.query(
                "SELECT * FROM retry_dispositions WHERE event_id=$1",
                [id],
              )
            ).rowCount,
          ).toBe(0);
          expect(
            (await pool.query("SELECT * FROM receipts WHERE event_id=$1", [id]))
              .rowCount,
          ).toBe(0);
          await handleMessage(
            pool,
            channel,
            delivery,
            async () => {
              const query = await app.inject({
                method: "GET",
                url: `/events/${id}`,
              });
              expect(query.json()).toMatchObject({
                status: expected,
                result: null,
                retry: {
                  generation: 0,
                  attempt: 1,
                  outcome,
                  reason,
                  delayMs: expected === "retry_scheduled" ? 1000 : null,
                },
              });
              expect(query.json().retry.nextEligibleAt === null).toBe(
                expected !== "retry_scheduled",
              );
            },
            undefined,
            options,
          );
          channel.sendToQueue(queue, body);
          const duplicate = await channel.get(queue, { noAck: false });
          if (!duplicate) throw new Error("missing duplicate");
          await handleMessage(
            pool,
            channel,
            duplicate,
            undefined,
            undefined,
            options,
          );
          expect(calls).toBe(2);
          const beforeFuture = await pool.query(
            "SELECT * FROM retry_dispositions WHERE event_id=$1",
            [id],
          );
          channel.sendToQueue(
            queue,
            Buffer.from(
              JSON.stringify({ version: 1, eventId: id, generation: 1 }),
            ),
          );
          const future = await channel.get(queue, { noAck: false });
          if (!future) throw new Error("missing future delivery");
          await expect(
            handleMessage(pool, channel, future, undefined, undefined, options),
          ).rejects.toThrow("unexpected generation");
          channel.nack(future, false, false);
          const rows = await pool.query(
            "SELECT * FROM retry_dispositions WHERE event_id=$1",
            [id],
          );
          expect(rows.rowCount).toBe(1);
          expect(rows.rows).toEqual(beforeFuture.rows);
          expect(calls).toBe(2);
          expect(
            (await pool.query("SELECT * FROM receipts WHERE event_id=$1", [id]))
              .rowCount,
          ).toBe(0);
          // Model a later persisted generation to exercise a stale delivery;
          // 2A.1 itself does not advance or republish generations.
          await pool.query(
            "UPDATE retry_dispositions SET generation=1 WHERE event_id=$1",
            [id],
          );
          const beforeStale = await pool.query(
            "SELECT * FROM retry_dispositions WHERE event_id=$1",
            [id],
          );
          channel.sendToQueue(queue, body);
          const stale = await channel.get(queue, { noAck: false });
          if (!stale) throw new Error("missing stale delivery");
          await expect(
            handleMessage(pool, channel, stale, undefined, undefined, options),
          ).rejects.toThrow("unexpected generation");
          channel.nack(stale, false, false);
          expect(
            (
              await pool.query(
                "SELECT * FROM retry_dispositions WHERE event_id=$1",
                [id],
              )
            ).rows,
          ).toEqual(beforeStale.rows);
          expect(
            (await pool.query("SELECT * FROM receipts WHERE event_id=$1", [id]))
              .rowCount,
          ).toBe(0);
          expect(calls).toBe(2);
          await pool.query("DELETE FROM outbox WHERE event_id=$1", [id]);
        }
      } finally {
        await channel.close();
        await app.close();
      }
    });
    it("brackets transient scheduling with DB wall time and rereads before acknowledging redelivery", async () => {
      const app = api(pool);
      const firstChannel = await connection.createChannel();
      const secondChannel = await connection.createChannel();
      const isolated = await confirm.assertQueue("", { exclusive: true });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let processing: Promise<void> | undefined;
      try {
        const response = await app.inject({
          method: "POST",
          url: "/events",
          payload: {
            scope: randomUUID(),
            idempotencyKey: randomUUID(),
            type: "receipt.v1",
            target: "local-receipt",
            message: "transient redelivery",
          },
        });
        expect(response.statusCode).toBe(202);
        const id = response.json().id as string;
        const policy = { maxAttempts: 3, baseDelayMs: 1234, capDelayMs: 60000 };
        let calls = 0;
        const options = {
          policy,
          handler: async () => {
            calls++;
            return "transient" as const;
          },
        };
        confirm.sendToQueue(
          isolated.queue,
          Buffer.from(JSON.stringify({ version: 1, eventId: id })),
        );
        await confirm.waitForConfirms();
        const delivery = await firstChannel.get(isolated.queue, {
          noAck: false,
        });
        if (!delivery) throw new Error("missing initial transient delivery");
        expect(delivery.fields.redelivered).toBe(false);
        const before = (
          await pool.query("SELECT clock_timestamp()::text AS time")
        ).rows[0].time as string;
        let arrived!: () => void;
        const atBarrier = new Promise<void>((resolve) => {
          arrived = resolve;
        });
        processing = handleMessage(
          pool,
          firstChannel,
          delivery,
          async () => {
            arrived();
            await held;
          },
          undefined,
          options,
        );
        await Promise.race([
          atBarrier,
          processing.then(() => {
            throw new Error("processing completed before the barrier");
          }),
        ]);
        const after = (
          await pool.query("SELECT clock_timestamp()::text AS time")
        ).rows[0].time as string;
        const initial = await pool.query(
          "SELECT * FROM retry_dispositions WHERE event_id=$1",
          [id],
        );
        expect(initial.rowCount).toBe(1);
        expect(initial.rows[0]).toMatchObject({
          generation: 0,
          attempt: 1,
          outcome: "transient",
          state: "retry_scheduled",
          delay_ms: policy.baseDelayMs,
          reason: null,
        });
        const bounds = await pool.query(
          `SELECT next_eligible_at >= $2::timestamptz + $4::integer * interval '1 millisecond' AS lower_ok,
                  next_eligible_at <= $3::timestamptz + $4::integer * interval '1 millisecond' AS upper_ok
           FROM retry_dispositions WHERE event_id=$1`,
          [id, before, after, policy.baseDelayMs],
        );
        expect(bounds.rows).toEqual([{ lower_ok: true, upper_ok: true }]);
        const initialOutbox = await pool.query(
          "SELECT * FROM outbox WHERE event_id=$1",
          [id],
        );
        expect(initialOutbox.rowCount).toBe(1);
        await firstChannel.close();
        release();
        await processing.catch(() => {}); // An ack on the closed channel cannot reach the broker.
        const redelivery = await secondChannel.get(isolated.queue, {
          noAck: false,
        });
        if (!redelivery) throw new Error("missing transient redelivery");
        expect(redelivery.fields.redelivered).toBe(true);
        expect(redelivery.content.equals(delivery.content)).toBe(true);

        // Observe the actual transaction's authoritative read and commit, not a mock result.
        const client = await pool.connect();
        const querySpy = vi.spyOn(client, "query");
        const ackSpy = vi.spyOn(secondChannel, "ack");
        const observedPool = {
          connect: async () => client,
        } as unknown as pg.Pool;
        try {
          await handleMessage(
            observedPool,
            secondChannel,
            redelivery,
            async () => {
              expect(ackSpy).not.toHaveBeenCalled();
              expect(
                (
                  await pool.query(
                    "SELECT * FROM retry_dispositions WHERE event_id=$1",
                    [id],
                  )
                ).rows,
              ).toEqual(initial.rows);
            },
            undefined,
            options,
          );
          const readIndex = querySpy.mock.calls.findIndex(
            ([sql]) =>
              typeof sql === "string" &&
              sql.startsWith(
                "SELECT generation,attempt,state FROM retry_dispositions",
              ),
          );
          const commitIndex = querySpy.mock.calls.findIndex(
            ([sql]) => sql === "COMMIT",
          );
          expect(readIndex).toBeGreaterThanOrEqual(0);
          expect(commitIndex).toBeGreaterThan(readIndex);
          expect(ackSpy).toHaveBeenCalledTimes(1);
          expect(ackSpy).toHaveBeenCalledWith(redelivery);
          expect(querySpy.mock.invocationCallOrder[commitIndex]).toBeLessThan(
            ackSpy.mock.invocationCallOrder[0],
          );
        } finally {
          querySpy.mockRestore();
          ackSpy.mockRestore();
        }
        expect(calls).toBe(1);
        expect(
          (
            await pool.query(
              "SELECT * FROM retry_dispositions WHERE event_id=$1",
              [id],
            )
          ).rows,
        ).toEqual(initial.rows);
        expect(
          (await pool.query("SELECT * FROM outbox WHERE event_id=$1", [id]))
            .rows,
        ).toEqual(initialOutbox.rows);
        expect(
          (await pool.query("SELECT * FROM receipts WHERE event_id=$1", [id]))
            .rowCount,
        ).toBe(0);
        expect(await secondChannel.get(isolated.queue, { noAck: false })).toBe(
          false,
        );
        await pool.query("DELETE FROM outbox WHERE event_id=$1", [id]);
      } finally {
        release();
        await processing?.catch(() => {});
        await firstChannel.close().catch(() => {});
        await secondChannel.close();
        await confirm.deleteQueue(isolated.queue);
        await app.close();
      }
    }, 30000);
    it("proves mandatory return precedes confirm and routed confirm has no return on adapter path", async () => {
      await conformanceGate(confirm);
      const trace: string[] = [];
      expect(
        await publish(
          confirm,
          `missing.${randomUUID()}`,
          Buffer.from("probe"),
          trace,
        ),
      ).toBe(false);
      expect(trace).toEqual(["return", "confirm"]);
      const probe = await confirm.assertQueue("", { exclusive: true });
      const routed: string[] = [];
      expect(
        await publish(confirm, probe.queue, Buffer.from("probe"), routed),
      ).toBe(true);
      expect(routed).toEqual(["confirm"]);
      await confirm.deleteQueue(probe.queue);
    });
    it("rejects unsupported strings without writing acceptance rows", async () => {
      const app = api(pool);
      const scope = randomUUID();
      try {
        for (const message of ["a\0b", "\ud800", "\udc00", "a\ud800b"]) {
          const response = await app.inject({
            method: "POST",
            url: "/events",
            payload: {
              scope,
              idempotencyKey: randomUUID(),
              type: "receipt.v1",
              target: "local-receipt",
              message,
            },
          });
          expect(response.statusCode).toBe(400);
        }
        for (const terminator of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
          for (const field of ["scope", "idempotencyKey"] as const) {
            const response = await app.inject({
              method: "POST",
              url: "/events",
              payload: {
                scope,
                idempotencyKey: randomUUID(),
                type: "receipt.v1",
                target: "local-receipt",
                message: "invalid identifier",
                [field]:
                  field === "scope" ? scope + terminator : `key${terminator}`,
              },
            });
            expect(response.statusCode).toBe(400);
          }
        }
        const rows = await pool.query(
          `SELECT
          (SELECT count(*) FROM events WHERE scope LIKE $1 || '%') AS events,
          (SELECT count(*) FROM target_snapshots t JOIN events e ON e.id=t.event_id WHERE e.scope LIKE $1 || '%') AS targets,
          (SELECT count(*) FROM audit a JOIN events e ON e.id=a.event_id WHERE e.scope LIKE $1 || '%') AS audit,
          (SELECT count(*) FROM outbox o JOIN events e ON e.id=o.event_id WHERE e.scope LIKE $1 || '%') AS outbox`,
          [scope],
        );
        expect(rows.rows[0]).toEqual({
          events: "0",
          targets: "0",
          audit: "0",
          outbox: "0",
        });
        const valid = await app.inject({
          method: "POST",
          url: "/events",
          payload: {
            scope,
            idempotencyKey: randomUUID(),
            type: "receipt.v1",
            target: "local-receipt",
            message: "supplementary: 😀",
          },
        });
        expect(valid.statusCode).toBe(202);
        const id = valid.json().id;
        for (const table of [
          "outbox",
          "audit",
          "target_snapshots",
          "event_automation_context",
        ]) {
          await pool.query(`DELETE FROM ${table} WHERE event_id=$1`, [id]);
        }
        await pool.query("DELETE FROM events WHERE id=$1", [id]);
      } finally {
        await app.close();
      }
    });
    it("rolls back at target, audit and outbox write boundaries", async () => {
      const app = api(pool);
      const scope = randomUUID();
      try {
        await pool.query(
          `CREATE FUNCTION test_fail_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$`,
        );
        for (const table of ["target_snapshots", "audit", "outbox"]) {
          await pool.query(
            `CREATE TRIGGER test_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION test_fail_write()`,
          );
          try {
            const response = await app.inject({
              method: "POST",
              url: "/events",
              payload: {
                scope,
                idempotencyKey: randomUUID(),
                type: "receipt.v1",
                target: "local-receipt",
                message: "rollback",
              },
            });
            expect(response.statusCode).toBe(500);
            const counts = await pool.query(
              `SELECT (SELECT count(*) FROM events WHERE scope=$1) AS events, (SELECT count(*) FROM target_snapshots t JOIN events e ON e.id=t.event_id WHERE e.scope=$1) AS targets, (SELECT count(*) FROM audit a JOIN events e ON e.id=a.event_id WHERE e.scope=$1) AS audit, (SELECT count(*) FROM outbox o JOIN events e ON e.id=o.event_id WHERE e.scope=$1) AS outbox`,
              [scope],
            );
            expect(counts.rows[0]).toEqual({
              events: "0",
              targets: "0",
              audit: "0",
              outbox: "0",
            });
          } finally {
            await pool.query(`DROP TRIGGER test_fail ON ${table}`);
          }
        }
      } finally {
        await app.close();
      }
    });
    it("serializes concurrent differing content as acceptance and conflict", async () => {
      const app = api(pool);
      const body = {
        scope: randomUUID(),
        idempotencyKey: randomUUID(),
        type: "receipt.v1",
        target: "local-receipt",
        message: "one",
      };
      try {
        const responses = await Promise.all(
          [body, { ...body, message: "two" }].map((payload) =>
            app.inject({ method: "POST", url: "/events", payload }),
          ),
        );
        expect(responses.map((r) => r.statusCode).sort()).toEqual([202, 409]);
        const rows = await pool.query(
          `SELECT (SELECT count(*) FROM events WHERE scope=$1) AS events, (SELECT count(*) FROM target_snapshots t JOIN events e ON e.id=t.event_id WHERE e.scope=$1) AS targets, (SELECT count(*) FROM audit a JOIN events e ON e.id=a.event_id WHERE e.scope=$1) AS audit, (SELECT count(*) FROM outbox o JOIN events e ON e.id=o.event_id WHERE e.scope=$1) AS outbox`,
          [body.scope],
        );
        expect(rows.rows[0]).toEqual({
          events: "1",
          targets: "1",
          audit: "1",
          outbox: "1",
        });
        const id = responses.find((r) => r.statusCode === 202)!.json().id;
        await pool.query("DELETE FROM outbox WHERE event_id=$1", [id]);
      } finally {
        await app.close();
      }
    });
    it("serializes concurrent identical keys and preserves pending acceptance without a broker", async () => {
      const app = api(pool);
      const body = {
        scope: randomUUID(),
        idempotencyKey: randomUUID(),
        type: "receipt.v1",
        target: "local-receipt",
        message: "offline",
      };
      try {
        // API acceptance has no broker dependency; explicitly attempt an unreachable broker separately.
        const saved = process.env.AMQP_URL;
        process.env.AMQP_URL = "amqp://127.0.0.1:1";
        try {
          await expect(connectBroker()).rejects.toThrow();
        } finally {
          process.env.AMQP_URL = saved;
        }
        const responses = await Promise.all(
          Array.from({ length: 5 }, () =>
            app.inject({ method: "POST", url: "/events", payload: body }),
          ),
        );
        expect(responses.map((response) => response.statusCode).sort()).toEqual(
          [200, 200, 200, 200, 202],
        );
        const ids = new Set(responses.map((response) => response.json().id));
        expect(ids.size).toBe(1);
        const id = [...ids][0];
        const persisted = await pool.query(
          "SELECT o.confirmed_at, r.event_id AS receipt FROM outbox o LEFT JOIN receipts r ON r.event_id=o.event_id WHERE o.event_id=$1",
          [id],
        );
        expect(persisted.rows).toEqual([{ confirmed_at: null, receipt: null }]);
        // A relay attempt with a disconnected channel cannot mark this row confirmed.
        const disconnected = await connection.createConfirmChannel();
        await disconnected.close();
        await expect(relayOnce(pool, disconnected, queue)).rejects.toThrow();
        const afterFailure = await pool.query(
          "SELECT confirmed_at FROM outbox WHERE event_id=$1",
          [id],
        );
        expect(afterFailure.rows).toEqual([{ confirmed_at: null }]);
        const queried = await app.inject({
          method: "GET",
          url: `/events/${id}`,
        });
        expect(queried.json()).toMatchObject({
          status: "accepted",
          publication: "pending",
          result: null,
        });
        // This synthetic row is not part of the later relay test's work set.
        await pool.query("DELETE FROM outbox WHERE event_id=$1", [id]);
        await pool.query("DELETE FROM audit WHERE event_id=$1", [id]);
        await pool.query("DELETE FROM target_snapshots WHERE event_id=$1", [
          id,
        ]);
        await pool.query(
          "DELETE FROM event_automation_context WHERE event_id=$1",
          [id],
        );
        await pool.query("DELETE FROM events WHERE id=$1", [id]);
      } finally {
        await app.close();
      }
    });
    it("HTTP acceptance, replay, conflict, relay, commit before ack and redelivery", async () => {
      const app = api(pool);
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string")
        throw new Error("no listening address");
      const url = `http://127.0.0.1:${address.port}/events`;
      const body = {
        scope: randomUUID(),
        idempotencyKey: randomUUID(),
        type: "receipt.v1",
        target: "local-receipt",
        message: "synthetic",
      };
      const post = (value: object) =>
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(value),
        });
      try {
        const first = await post(body);
        expect(first.status).toBe(202);
        const accepted = (await first.json()) as { id: string };
        const replay = await post(body);
        expect(replay.status).toBe(200);
        expect(await replay.json()).toEqual({ id: accepted.id, replay: true });
        expect((await post({ ...body, message: "different" })).status).toBe(
          409,
        );
        const initial = (await (
          await fetch(`${url}/${accepted.id}`)
        ).json()) as { status: string; publication: string };
        expect(initial).toMatchObject({
          status: "accepted",
          publication: "pending",
        });
        const count = await pool.query(
          "SELECT (SELECT count(*) FROM events WHERE id=$1) AS events,(SELECT count(*) FROM target_snapshots WHERE event_id=$1) AS targets,(SELECT count(*) FROM audit WHERE event_id=$1) AS audit,(SELECT count(*) FROM outbox WHERE event_id=$1) AS outbox",
          [accepted.id],
        );
        expect(count.rows[0]).toEqual({
          events: "1",
          targets: "1",
          audit: "1",
          outbox: "1",
        });
        const trace: string[] = [];
        await relayOnce(pool, confirm, queue, trace);
        expect(trace).toEqual(["confirm", "outbox-confirmed"]);
        const failingChannel = await connection.createChannel();
        const failingDelivery = await failingChannel.get(queue, {
          noAck: false,
        });
        if (!failingDelivery) throw new Error("missing initial delivery");
        await expect(
          handleMessage(
            pool,
            failingChannel,
            failingDelivery,
            undefined,
            async () => {
              throw new Error("synthetic pre-commit failure");
            },
          ),
        ).rejects.toThrow("synthetic pre-commit failure");
        expect(
          (
            await pool.query("SELECT * FROM receipts WHERE event_id=$1", [
              accepted.id,
            ])
          ).rowCount,
        ).toBe(0);
        await failingChannel.close();
        const firstChannel = await connection.createChannel();
        const delivery = await firstChannel.get(queue, { noAck: false });
        if (!delivery) throw new Error("missing delivery");
        expect(delivery.fields.redelivered).toBe(true);
        expect(JSON.parse(delivery.content.toString()).eventId).toBe(
          accepted.id,
        );
        let arrived!: () => void;
        const atBarrier = new Promise<void>((resolve) => {
          arrived = resolve;
        });
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const processing = handleMessage(
          pool,
          firstChannel,
          delivery,
          async () => {
            arrived();
            await held;
          },
        );
        await atBarrier;
        const result = await pool.query(
          "SELECT result FROM receipts WHERE event_id=$1",
          [accepted.id],
        );
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].result).toEqual({
          kind: "local-receipt.v1",
          eventId: accepted.id,
          message: "synthetic",
        });
        await firstChannel.close();
        release();
        // ack on closed channel may either throw or be ignored; it cannot reach the broker.
        await processing.catch(() => {});
        const secondChannel = await connection.createChannel();
        const redelivery = await secondChannel.get(queue, { noAck: false });
        if (!redelivery) throw new Error("missing redelivery");
        expect(redelivery.fields.redelivered).toBe(true);
        await handleMessage(pool, secondChannel, redelivery);
        const receipts = await pool.query(
          "SELECT result FROM receipts WHERE event_id=$1",
          [accepted.id],
        );
        expect(receipts.rows).toEqual(result.rows);
        const completed = await (await fetch(`${url}/${accepted.id}`)).json();
        expect(completed).toMatchObject({
          status: "completed",
          publication: "confirmed",
          result: result.rows[0].result,
        });
        await secondChannel.close();
      } finally {
        await app.close();
      }
    }, 30000);
    it("smoke: HTTP through the real worker consumer and back to query", async () => {
      const app = api(pool);
      const worker = await connection.createChannel();
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string")
        throw new Error("no listening address");
      const url = `http://127.0.0.1:${address.port}/events`;
      try {
        await startWorker(pool, worker, queue);
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            scope: randomUUID(),
            idempotencyKey: randomUUID(),
            type: "receipt.v1",
            target: "local-receipt",
            message: "smoke",
          }),
        });
        expect(response.status).toBe(202);
        const { id } = (await response.json()) as { id: string };
        await relayOnce(pool, confirm, queue);
        let state: { status: string; result: unknown } | undefined;
        for (let i = 0; i < 100; i++) {
          state = (await (await fetch(`${url}/${id}`)).json()) as typeof state;
          if (state?.status === "completed") break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(state).toMatchObject({
          status: "completed",
          result: { kind: "local-receipt.v1", eventId: id, message: "smoke" },
        });
      } finally {
        await worker.close();
        await app.close();
      }
    }, 15000);
  },
);
