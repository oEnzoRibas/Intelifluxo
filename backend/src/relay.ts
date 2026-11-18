import type pg from "pg";
import type { ConfirmChannel } from "amqplib";
import { queue } from "./config.js";
import { conformanceGate, prepareQueue, publish } from "./broker.js";

// Deliberately a single sweep, single relay only. No ownership, fencing, or retry.
export async function relayOnce(
  pool: pg.Pool,
  channel: ConfirmChannel,
  name = queue,
  trace: string[] = [],
  eventId?: string,
): Promise<number> {
  await conformanceGate(channel);
  await prepareQueue(channel, name);
  return relaySweep(
    {
      query: (text, values) => pool.query(text, values),
      publishConfirmed: async (body) => {
        if (!(await publish(channel, name, body, trace)))
          throw new Error("mandatory publication was returned");
      },
      check: () => {},
    },
    trace,
    eventId,
  );
}

export interface RelaySweepDependencies {
  query(
    text: string,
    values: unknown[],
  ): Promise<{ rows: { event_id: string; generation?: number }[] }>;
  publishConfirmed(body: Buffer): Promise<void>;
  check(): void;
}

/** Business sweep shared by the legacy relay and the scope-owned runtime. */
export async function relaySweep(
  deps: RelaySweepDependencies,
  trace: string[] = [],
  eventId?: string,
): Promise<number> {
  const rows = await deps.query(
    "SELECT event_id FROM outbox WHERE confirmed_at IS NULL AND ($1::uuid IS NULL OR event_id=$1) ORDER BY event_id LIMIT 100",
    [eventId ?? null],
  );
  let count = 0;
  for (const row of rows.rows) {
    deps.check();
    await deps.publishConfirmed(
      Buffer.from(JSON.stringify({ version: 1, eventId: row.event_id })),
    );
    deps.check();
    await deps.query(
      "UPDATE outbox SET confirmed_at=now() WHERE event_id=$1 AND confirmed_at IS NULL",
      [row.event_id],
    );
    trace.push("outbox-confirmed");
    count++;
  }
  const retries = await deps.query(
    "SELECT event_id,generation FROM retry_publications WHERE confirmed_at IS NULL AND ($1::uuid IS NULL OR event_id=$1) ORDER BY event_id,generation LIMIT 100",
    [eventId ?? null],
  );
  for (const row of retries.rows) {
    deps.check();
    await deps.publishConfirmed(
      Buffer.from(
        JSON.stringify({
          version: 1,
          eventId: row.event_id,
          generation: row.generation,
        }),
      ),
    );
    deps.check();
    await deps.query(
      "UPDATE retry_publications SET confirmed_at=clock_timestamp() WHERE event_id=$1 AND generation=$2 AND confirmed_at IS NULL",
      [row.event_id, row.generation],
    );
    trace.push("outbox-confirmed");
    count++;
  }
  return count;
}
