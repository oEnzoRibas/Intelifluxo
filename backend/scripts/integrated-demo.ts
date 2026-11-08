import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { api } from "../src/api.js";
import { withCleanup } from "../src/cleanup.js";
import { connectBroker, prepareQueue } from "../src/broker.js";
import { relayOnce } from "../src/relay.js";
import { scheduleOnce } from "../src/scheduler.js";
import { handleMessage } from "../src/worker.js";
import { assertDemoSafety } from "./demo-safety.js";
import { assertDemoTransition } from "./demo-assertions.js";

assertDemoSafety(process.env);
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
let queueOwned = false;
let id: string | undefined;
await withCleanup(
  async () => {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaOwned = true;
    console.log(`Retained schema: ${schema}`);
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    for (const file of [
      "001_init.sql",
      "002_retry_dispositions.sql",
      "003_retry_publications.sql",
    ]) {
      await pool.query(
        await readFile(
          new URL(`../migrations/${file}`, import.meta.url),
          "utf8",
        ),
      );
    }
    broker = await connectBroker();
    confirm = await broker.createConfirmChannel();
    consumer = await broker.createChannel();
    await prepareQueue(confirm, queue);
    queueOwned = true;
    console.log(`Temporary queue: ${queue}`);
    app = api(pool);
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${base}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: `demo-${randomUUID()}`,
        idempotencyKey: randomUUID(),
        type: "receipt.v1",
        target: "local-receipt",
        message: "synthetic integrated demo",
      }),
    });
    if (response.status !== 202)
      throw new Error(`API acceptance failed: ${response.status}`);
    const accepted = (await response.json()) as { id: string };
    id = accepted.id;
    console.log(`Event ID: ${id}`);
    console.log(`Temporary API URL (until demo exits): ${base}/events/${id}`);
    const query = async (
      expected: Parameters<typeof assertDemoTransition>[1],
    ) => {
      const result = await fetch(`${base}/events/${id}`);
      if (!result.ok) throw new Error(`GET failed: ${result.status}`);
      const body: unknown = await result.json();
      console.log(`${expected}: ${JSON.stringify(body)}`);
      assertDemoTransition(body, expected, id!);
    };
    await query("accepted");
    if ((await relayOnce(pool, confirm, queue, [], id)) !== 1)
      throw new Error("initial relay did not publish exactly once");
    console.log("initial relay: confirmed");
    await query("initial_confirmed");
    const first = await consumer.get(queue, { noAck: false });
    if (!first) throw new Error("initial delivery missing");
    await handleMessage(pool, consumer, first, undefined, undefined, {
      handler: async () => "transient",
      policy: { maxAttempts: 3, baseDelayMs: 5000, capDelayMs: 60000 },
    });
    await query("retry_scheduled");
    const early = await scheduleOnce(pool, 100, id);
    console.log(`pre-due scheduler released: ${early}`);
    if (early !== 0) throw new Error("pre-due sweep was not a no-op");
    let due = false;
    for (let i = 0; i < 300; i++) {
      due =
        (
          await pool.query(
            "SELECT next_eligible_at <= clock_timestamp() AS due FROM retry_dispositions WHERE event_id=$1",
            [id],
          )
        ).rows[0]?.due === true;
      if (due) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!due) throw new Error("deadline did not become due");
    const released = await scheduleOnce(pool, 100, id);
    console.log(`due scheduler released: ${released}`);
    if (released !== 1) throw new Error("due release failed");
    await query("retry_released");
    if ((await relayOnce(pool, confirm, queue, [], id)) !== 1)
      throw new Error("retry relay did not publish exactly once");
    console.log("retry relay: confirmed");
    await query("retry_confirmed");
    const retry = await consumer.get(queue, { noAck: false });
    if (!retry) throw new Error("retry delivery missing");
    await handleMessage(pool, consumer, retry);
    await query("completed");
  },
  () => [
    [
      "API",
      async () => {
        await app?.close();
      },
    ],
    [
      "consumer",
      async () => {
        await consumer?.close();
      },
    ],
    [
      "queue",
      async () => {
        if (queueOwned && confirm) await confirm.deleteQueue(queue);
      },
    ],
    [
      "confirm channel",
      async () => {
        await confirm?.close();
      },
    ],
    [
      "broker",
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
      "admin",
      async () => {
        await admin.end();
      },
    ],
    [
      "retention notice",
      async () => {
        if (schemaOwned)
          console.log(
            `Retained schema ${schema}${id ? ` with event ${id}` : " (possibly incomplete)"}; see backend README for safe manual cleanup.`,
          );
      },
    ],
  ],
);
