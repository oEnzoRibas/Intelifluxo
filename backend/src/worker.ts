import type pg from "pg";
import type { Channel, Message } from "amqplib";
import { transaction } from "./db.js";
import { queue } from "./config.js";
import { decideRetry, type Outcome, type RetryPolicy } from "./retry-policy.js";

// Internal test seam only. Neither the HTTP request nor the dispatch selects outcomes.
export type WorkerOptions = {
  handler?: () => Promise<Outcome>;
  policy?: RetryPolicy;
};
const defaultPolicy: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  capDelayMs: 60000,
};

export async function processMessage(
  pool: pg.Pool,
  message: Message,
  beforeCommit?: () => Promise<void>,
  options: WorkerOptions = {},
): Promise<void> {
  const data: unknown = JSON.parse(message.content.toString("utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("invalid dispatch");
  const dispatch = data as Record<string, unknown>;
  const keys = Object.keys(dispatch).sort().join(",");
  if (
    (keys !== "eventId,version" && keys !== "eventId,generation,version") ||
    dispatch.version !== 1 ||
    typeof dispatch.eventId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      dispatch.eventId,
    ) ||
    (dispatch.generation !== undefined &&
      (!Number.isSafeInteger(dispatch.generation) ||
        (dispatch.generation as number) < 0 ||
        (dispatch.generation as number) > 2147483647))
  )
    throw new Error("invalid dispatch");
  const generation = (dispatch.generation as number | undefined) ?? 0;
  await transaction(pool, async (client) => {
    const event = await client.query(
      "SELECT id,content FROM events WHERE id=$1 FOR UPDATE",
      [dispatch.eventId],
    );
    if (!event.rowCount) throw new Error("unknown event");
    const prior = await client.query(
      "SELECT generation,attempt,state FROM retry_dispositions WHERE event_id=$1",
      [dispatch.eventId],
    );
    let ordinal = 1;
    if (prior.rowCount) {
      const disposition = prior.rows[0];
      if (generation < disposition.generation) {
        const evidence = await client.query(
          generation === 0
            ? "SELECT 1 FROM retry_publications WHERE event_id=$1 AND generation=1"
            : "SELECT 1 FROM retry_publications WHERE event_id=$1 AND generation=$2 AND processed_at IS NOT NULL",
          generation === 0
            ? [dispatch.eventId]
            : [dispatch.eventId, generation],
        );
        if (!evidence.rowCount) throw new Error("unexpected generation");
        return;
      }
      if (generation !== disposition.generation)
        throw new Error("unexpected generation");
      if (generation === 0) return;
      const publication = await client.query(
        "SELECT processed_at FROM retry_publications WHERE event_id=$1 AND generation=$2",
        [dispatch.eventId, generation],
      );
      if (!publication.rowCount) throw new Error("missing retry publication");
      if (publication.rows[0].processed_at) return;
      if (disposition.state !== "retry_scheduled")
        throw new Error("unexpected retry state");
      ordinal = disposition.attempt + 1;
    } else if (generation !== 0) throw new Error("unexpected generation");
    if (
      !prior.rowCount &&
      (
        await client.query("SELECT 1 FROM receipts WHERE event_id=$1", [
          dispatch.eventId,
        ])
      ).rowCount
    )
      return;
    const executions = await client.query(
      "SELECT id,schema_version,trigger_type,action_type FROM automation_executions WHERE event_id=$1",
      [dispatch.eventId],
    );
    const supported = executions.rows.every(
      (row) =>
        row.schema_version === 1 &&
        row.trigger_type === "receipt.v1" &&
        row.action_type === "record-receipt.v1",
    );
    const outcome = supported
      ? options.handler
        ? await options.handler()
        : "success"
      : "unknown";
    const decision = decideRetry(
      options.policy ?? defaultPolicy,
      ordinal,
      outcome,
    );
    if (decision.state === "completed") {
      const result = {
        kind: "local-receipt.v1",
        eventId: event.rows[0].id,
        message: event.rows[0].content.message,
      };
      await client.query(
        "INSERT INTO receipts(event_id,result) VALUES ($1,$2::jsonb) ON CONFLICT (event_id) DO NOTHING",
        [dispatch.eventId, JSON.stringify(result)],
      );
      await client.query(
        "UPDATE automation_executions SET result=$2::jsonb WHERE event_id=$1",
        [dispatch.eventId, JSON.stringify(result)],
      );
    }
    const state =
      decision.state === "scheduled" ? "retry_scheduled" : decision.state;
    const delay = decision.state === "scheduled" ? decision.delayMs : null;
    const reason = decision.state === "blocked" ? decision.reason : null;
    await client.query(
      `INSERT INTO retry_dispositions(event_id,generation,attempt,outcome,state,delay_ms,next_eligible_at,reason)
      VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $6::integer IS NULL THEN NULL ELSE clock_timestamp()+$6::integer * interval '1 millisecond' END,$7)
      ON CONFLICT (event_id) DO UPDATE SET generation=EXCLUDED.generation,attempt=EXCLUDED.attempt,outcome=EXCLUDED.outcome,state=EXCLUDED.state,delay_ms=EXCLUDED.delay_ms,next_eligible_at=EXCLUDED.next_eligible_at,reason=EXCLUDED.reason`,
      [dispatch.eventId, generation, ordinal, outcome, state, delay, reason],
    );
    if (generation > 0)
      await client.query(
        "UPDATE retry_publications SET processed_at=clock_timestamp() WHERE event_id=$1 AND generation=$2",
        [dispatch.eventId, generation],
      );
    if (beforeCommit) await beforeCommit();
  });
}

// Test hook runs after COMMIT and before ack; production does not supply it.
export async function handleMessage(
  pool: pg.Pool,
  channel: Channel,
  message: Message,
  afterCommit?: () => Promise<void>,
  beforeCommit?: () => Promise<void>,
  options?: WorkerOptions,
): Promise<void> {
  await processMessage(pool, message, beforeCommit, options);
  if (afterCommit) await afterCommit();
  channel.ack(message);
}

export async function startWorker(
  pool: pg.Pool,
  channel: Channel,
  name = queue,
): Promise<void> {
  await channel.assertQueue(name, { durable: true });
  await channel.prefetch(1);
  await channel.consume(
    name,
    (message) => {
      if (!message) {
        console.error("worker consumer cancelled by broker; closing channel");
        void channel.close().catch(() => {});
        return;
      }
      void handleMessage(pool, channel, message).catch(() => {
        console.error("worker failed; closing channel without acknowledgement");
        void channel.close().catch(() => {});
      });
    },
    { noAck: false },
  );
}
