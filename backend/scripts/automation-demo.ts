import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { api } from "../src/api.js";
import { withCleanup } from "../src/cleanup.js";
import { connectBroker } from "../src/broker.js";
import {
  demoCleanupSteps,
  connectDemoBroker,
  deadline,
  queueDeclaration,
  watchedChannel,
  destroyBroker,
  isolatedQueue,
} from "../test/automation-demo-bounds.js";
import { relayOnce } from "../src/relay.js";
import { handleMessage } from "../src/worker.js";
import {
  assertAutomationDemoSafety,
  assertExecution,
} from "./automation-demo-assertions.js";

assertAutomationDemoSafety(process.env);
const schema = `demo_${randomUUID().replaceAll("-", "")}`;
const queue = isolatedQueue();
const admin = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10000,
  statement_timeout: 10000,
});
let pool: pg.Pool | undefined;
let broker: Awaited<ReturnType<typeof connectBroker>> | undefined;
let confirm:
  | Awaited<ReturnType<NonNullable<typeof broker>["createConfirmChannel"]>>
  | undefined;
let consumer:
  Awaited<ReturnType<NonNullable<typeof broker>["createChannel"]>> | undefined;
let app: ReturnType<typeof api> | undefined;
let schemaOwned = false;
const declaration = queueDeclaration(queue);
await withCleanup(
  async () => {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaOwned = true;
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${schema}`,
      connectionTimeoutMillis: 10000,
      statement_timeout: 10000,
    });
    for (const file of [
      "001_init.sql",
      "002_retry_dispositions.sql",
      "003_retry_publications.sql",
      "004_automation_definitions.sql",
      "005_automation_executions.sql",
    ])
      await pool.query(
        await readFile(
          new URL(`../migrations/${file}`, import.meta.url),
          "utf8",
        ),
      );
    broker = await connectDemoBroker();
    confirm = await deadline(
      "confirm channel",
      () => watchedChannel(broker!.createConfirmChannel()),
      undefined,
      () => destroyBroker(broker),
    );
    consumer = await deadline(
      "consumer channel",
      () => watchedChannel(broker!.createChannel()),
      undefined,
      () => destroyBroker(broker),
    );
    await declaration.declare(confirm, () => destroyBroker(broker));
    app = api(pool);
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    const request = async (
      path: string,
      status: number,
      method = "GET",
      body?: unknown,
    ): Promise<{
      id: string;
      active: boolean;
      revision: number;
      status: string;
      publication: string;
      result: unknown;
      items: unknown[];
    }> => {
      const response = await fetch(`${base}${path}`, {
        method,
        signal: AbortSignal.timeout(10000),
        ...(body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
      });
      assert.equal(
        response.status,
        status,
        `${method} ${path} returned ${response.status}`,
      );
      return response.json();
    };
    const scope = `demo-${randomUUID()}`;
    const config = {
      name: "Disposable receipt demo",
      schemaVersion: 1,
      trigger: { type: "receipt.v1" },
      action: { type: "record-receipt.v1" },
    };
    const automation = await request("/automations", 201, "POST", {
      ...config,
      scope,
    });
    assert.equal(automation.active, false);
    assert.equal(automation.revision, 1);
    assert.equal(typeof automation.id, "string");
    const submit = (message: string) =>
      request("/events", 202, "POST", {
        scope,
        idempotencyKey: randomUUID(),
        type: "receipt.v1",
        target: "local-receipt",
        message,
      });
    const inactive = await submit("inactive snapshot");
    assert.deepEqual(
      (await request(`/executions?eventId=${inactive.id}`, 200)).items,
      [],
    );
    const active = await request(`/automations/${automation.id}`, 200, "PUT", {
      ...config,
      active: true,
      expectedRevision: automation.revision,
    });
    assert.equal(active.id, automation.id);
    assert.equal(active.active, true);
    assert.equal(active.revision, 2);
    const message = "synthetic automation demo";
    const event = await submit(message);
    const initial = (await request(`/executions?eventId=${event.id}`, 200))
      .items;
    assert.equal(initial.length, 1);
    const expected = {
      eventId: event.id,
      automationId: automation.id,
      revision: 2,
    };
    const executionId = assertExecution(initial[0], {
      ...expected,
      status: "accepted",
    });
    assert.equal(
      await deadline(
        "relay",
        () => relayOnce(pool!, confirm!, queue, [], event.id),
        undefined,
        () => destroyBroker(broker),
      ),
      1,
    );
    const delivery = await deadline(
      "get delivery",
      () => consumer!.get(queue, { noAck: false }),
      undefined,
      () => destroyBroker(broker),
    );
    assert.ok(delivery, "delivery missing");
    await handleMessage(pool, consumer, delivery);
    const eventResult = await request(`/events/${event.id}`, 200);
    assert.equal(eventResult.id, event.id);
    assert.equal(eventResult.status, "completed");
    assert.equal(eventResult.publication, "confirmed");
    assert.deepEqual(eventResult.result, {
      kind: "local-receipt.v1",
      eventId: event.id,
      message,
    });
    const history = (
      await request(`/executions?automationId=${automation.id}`, 200)
    ).items;
    assert.equal(history.length, 1);
    assertExecution(history[0], {
      ...expected,
      executionId,
      status: "completed",
      message,
    });
    assert.deepEqual(
      await request(`/executions/${executionId}`, 200),
      history[0],
    );
    assert.deepEqual(
      (await request(`/executions?eventId=${event.id}`, 200)).items,
      history,
    );
    assert.deepEqual(
      (await request(`/executions?eventId=${inactive.id}`, 200)).items,
      [],
    );
    console.log(
      "Automation demo passed: inactive snapshot, revision activation, HTTP event, RabbitMQ relay/worker, persisted event and execution result.",
    );
  },
  () =>
    demoCleanupSteps(
      {
        api: async () => {
          await app?.close();
        },
        consumer: async () => {
          await consumer?.close();
        },
        queue: async () => {
          await declaration.cleanup();
        },
        confirm: async () => {
          await confirm?.close();
        },
        broker: async () => {
          await broker?.close();
        },
        pool: async () => {
          await pool?.end();
        },
        schema: async () => {
          if (schemaOwned)
            await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        },
        admin: async () => {
          await admin.end();
        },
      },
      () => destroyBroker(broker),
    ),
);
