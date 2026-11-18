import { randomUUID } from "node:crypto";
import pg from "pg";
import amqp from "amqplib";
import { describe, expect, it } from "vitest";
import { createRuntimeRelay } from "../src/runtime-relay.js";
import { ownedAmqp, ownedPg } from "../src/runtime-resources.js";

// Both URLs MUST point to disposable isolated services, never shared infrastructure.
describe.skipIf(
  process.env.INTEGRATION !== "1" || process.env.RUNTIME_RELAY_ISOLATED !== "1",
)("real relay lifecycle on disposable services", () => {
  it("confirms only its filtered fixture and leaves a sentinel unpublished", async () => {
    const connectionString = process.env.DATABASE_URL;
    const amqpUrl = process.env.AMQP_URL;
    if (!connectionString || !amqpUrl)
      throw new Error("test configuration missing");
    const eventId = randomUUID();
    const sentinel = randomUUID();
    const retrySentinel = randomUUID();
    const name = `intelifluxo.test.${randomUUID()}`;
    const db = new pg.Client({ connectionString });
    await db.connect();
    let broker: Awaited<ReturnType<typeof amqp.connect>> | undefined;
    try {
      broker = await amqp.connect(amqpUrl);
      const channel = await broker.createChannel();
      try {
        await channel.assertQueue(name, { durable: true });
        await db.query(
          "INSERT INTO events(id,scope,idempotency_key,content) VALUES ($1::uuid,$1::uuid::text,$1::uuid::text,'{}'),($2::uuid,$2::uuid::text,$2::uuid::text,'{}'),($3::uuid,$3::uuid::text,$3::uuid::text,'{}')",
          [eventId, sentinel, retrySentinel],
        );
        await db.query("INSERT INTO outbox(event_id) VALUES ($1),($2)", [
          eventId,
          sentinel,
        ]);
        await db.query(
          "INSERT INTO retry_dispositions(event_id,generation,attempt,outcome,state,delay_ms,next_eligible_at) VALUES ($1,1,1,'transient','retry_scheduled',1000,clock_timestamp())",
          [retrySentinel],
        );
        await db.query(
          "INSERT INTO retry_publications(event_id,generation) VALUES ($1,1)",
          [retrySentinel],
        );
        const relay = createRuntimeRelay({
          connectionString,
          amqpUrl,
          queue: name,
          eventId,
          postForceSettlementMs: 2000,
          resources: {
            amqp: ownedAmqp,
            pg: async (scope, url) => {
              const client = await ownedPg(scope, url);
              return {
                query: async <T>(text: string, values?: unknown[]) => {
                  // Fail before executing if either business selection is not narrowly scoped.
                  if (text.startsWith("SELECT event_id")) {
                    expect(text).toMatch(
                      /WHERE confirmed_at IS NULL AND \(\$1::uuid IS NULL OR event_id=\$1\)/,
                    );
                    expect(values).toEqual([eventId]);
                  } else {
                    expect(text).toMatch(
                      /^UPDATE (outbox|retry_publications) SET /,
                    );
                    expect(values?.[0]).toBe(eventId);
                  }
                  return client.query<T>(text, values);
                },
              };
            },
          },
        });
        const scope = relay.createScope(new AbortController().signal);
        try {
          expect(await relay.sweep(scope)).toBe(1);
        } finally {
          await relay.disposeScope(scope);
        }
        const rows = await db.query(
          "SELECT event_id, confirmed_at IS NOT NULL AS confirmed FROM outbox WHERE event_id = ANY($1::uuid[]) ORDER BY event_id",
          [[eventId, sentinel]],
        );
        expect(rows.rows).toHaveLength(2);
        expect(rows.rows).toEqual(
          expect.arrayContaining([
            { event_id: eventId, confirmed: true },
            { event_id: sentinel, confirmed: false },
          ]),
        );
        const retryRows = await db.query(
          "SELECT generation,confirmed_at,processed_at FROM retry_publications WHERE event_id=$1",
          [retrySentinel],
        );
        expect(retryRows.rows).toEqual([
          { generation: 1, confirmed_at: null, processed_at: null },
        ]);
        const message = await channel.get(name, { noAck: true });
        expect(message && JSON.parse(message.content.toString())).toEqual({
          version: 1,
          eventId,
        });
        expect(await channel.get(name, { noAck: true })).toBe(false);
      } finally {
        await db.query("DELETE FROM retry_publications WHERE event_id=$1", [
          retrySentinel,
        ]);
        await db.query("DELETE FROM retry_dispositions WHERE event_id=$1", [
          retrySentinel,
        ]);
        await db.query("DELETE FROM outbox WHERE event_id = ANY($1::uuid[])", [
          [eventId, sentinel],
        ]);
        await db.query("DELETE FROM events WHERE id = ANY($1::uuid[])", [
          [eventId, sentinel, retrySentinel],
        ]);
        await channel.deleteQueue(name);
        await channel.close();
      }
    } finally {
      await broker?.close();
      await db.end();
    }
  }, 30_000);
});
