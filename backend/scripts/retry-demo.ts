// Isolated synthetic demonstration: handler scripting is internal, never HTTP input.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { withCleanup } from "../src/cleanup.js";
import { api } from "../src/api.js";
import { connectBroker } from "../src/broker.js";
import { relayOnce } from "../src/relay.js";
import { scheduleOnce } from "../src/scheduler.js";
import { handleMessage } from "../src/worker.js";

const schema = `demo_${randomUUID().replaceAll("-", "")}`;
const queue = `intelifluxo.demo.${randomUUID()}`;
const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let pool: pg.Pool | undefined;
let broker: Awaited<ReturnType<typeof connectBroker>> | undefined;
let confirm:
  | Awaited<ReturnType<NonNullable<typeof broker>["createConfirmChannel"]>>
  | undefined;
let consumer:
  Awaited<ReturnType<NonNullable<typeof broker>["createChannel"]>> | undefined;
let app: ReturnType<typeof api> | undefined;
let schemaOwned = false;
await withCleanup(
  async () => {
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
    consumer = await broker.createChannel();
    const activeApp = api(pool);
    app = activeApp;
    {
      const accepted = await activeApp.inject({
        method: "POST",
        url: "/events",
        payload: {
          scope: randomUUID(),
          idempotencyKey: randomUUID(),
          type: "receipt.v1",
          target: "local-receipt",
          message: "synthetic demo",
        },
      });
      if (accepted.statusCode !== 202) throw new Error("acceptance failed");
      const id = accepted.json().id as string;
      const query = async () =>
        (
          await activeApp.inject({ method: "GET", url: `/events/${id}` })
        ).json();
      console.log("submitted", JSON.stringify(await query()));
      console.log(
        "initial relay confirmed",
        await relayOnce(pool, confirm, queue),
      );
      const initial = await consumer.get(queue, { noAck: false });
      if (!initial) throw new Error("initial delivery missing");
      await handleMessage(pool, consumer, initial, undefined, undefined, {
        handler: async () => "transient",
        policy: { maxAttempts: 3, baseDelayMs: 2000, capDelayMs: 60000 },
      });
      console.log("persisted transient", JSON.stringify(await query()));
      const early = await scheduleOnce(pool);
      if (early !== 0) throw new Error("pre-due sweep was not a no-op");
      console.log("pre-due released", early);
      // Wait for PostgreSQL to report due, rather than using app time as authority.
      let due = false;
      for (let i = 0; i < 100; i++) {
        due = (
          await pool.query(
            "SELECT next_eligible_at <= clock_timestamp() AS due FROM retry_dispositions WHERE event_id=$1",
            [id],
          )
        ).rows[0].due;
        if (due) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!due) throw new Error("deadline did not become due");
      console.log("due released", await scheduleOnce(pool));
      console.log(
        "durable publication",
        JSON.stringify(
          (
            await pool.query(
              "SELECT generation,confirmed_at,processed_at FROM retry_publications WHERE event_id=$1",
              [id],
            )
          ).rows,
        ),
      );
      console.log(
        "retry relay confirmed",
        await relayOnce(pool, confirm, queue),
      );
      const retry = await consumer.get(queue, { noAck: false });
      if (!retry) throw new Error("retry delivery missing");
      console.log("broker retry dispatch", retry.content.toString());
      await handleMessage(pool, consumer, retry);
      console.log("final query", JSON.stringify(await query()));
      console.log(
        "final publication",
        JSON.stringify(
          (
            await pool.query(
              "SELECT generation,confirmed_at,processed_at FROM retry_publications WHERE event_id=$1",
              [id],
            )
          ).rows,
        ),
      );
    }
  },
  () => [
    [
      "app",
      async () => {
        await app?.close();
      },
    ],
    [
      "consumer channel",
      async () => {
        await consumer?.close();
      },
    ],
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
        if (schemaOwned) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      },
    ],
    [
      "admin pool",
      async () => {
        await admin.end();
      },
    ],
  ],
);
