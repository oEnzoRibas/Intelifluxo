import type pg from "pg";
import type { Channel, Message } from "amqplib";
import { transaction } from "./db.js";
import { queue } from "./config.js";
import { decideRetry, type Outcome, type RetryPolicy } from "./retry-policy.js";
import { evaluateCondition } from "./condition.js";
import { validateGraphV2 } from "./graph-v2.js";
import {
  defaultGraph,
  graphShape,
  graphSemantics,
  type Graph,
} from "./graph.js";

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
      `SELECT x.id,x.schema_version,x.trigger_type,x.action_type,r.graph,r.graph IS NULL AS graph_is_sql_null,r.schema_version AS revision_version,r.trigger_type AS revision_trigger,r.action_type AS revision_action
       FROM automation_executions x LEFT JOIN automation_definition_revisions r
       ON r.automation_id=x.automation_id AND r.revision=x.revision WHERE x.event_id=$1 ORDER BY x.id`,
      [dispatch.eventId],
    );
    type Failure = {
      classification: "permanent" | "unknown";
      code: string;
      nodeId: string | null;
    };
    type Evaluation = {
      id: string;
      version: number;
      decision: {
        nodeId: string;
        outcome: string;
        sourcePort: string;
        targetNodeId: string;
      } | null;
      actionId: string | null;
      failure: Failure | null;
    };
    const evaluations: Evaluation[] = executions.rows.map((row) => {
      const bad = (): Evaluation => ({
        id: row.id,
        version: row.schema_version,
        decision: null,
        actionId: null,
        failure: {
          classification: "unknown",
          code: "unsupported_execution_contract",
          nodeId: null,
        },
      });
      if (
        row.trigger_type !== "receipt.v1" ||
        row.action_type !== "record-receipt.v1" ||
        row.revision_version !== row.schema_version ||
        row.revision_trigger !== row.trigger_type ||
        row.revision_action !== row.action_type
      )
        return bad();
      if (row.schema_version === 1) {
        const graph = row.graph_is_sql_null ? defaultGraph() : row.graph;
        if (
          graphShape(graph).length ||
          graphSemantics(
            graph as Graph,
            true,
            row.trigger_type,
            row.action_type,
          ).length
        )
          return bad();
        return {
          id: row.id,
          version: 1,
          decision: null,
          actionId: null,
          failure: null,
        };
      }
      if (
        row.schema_version !== 2 ||
        validateGraphV2(row.graph, row.trigger_type, row.action_type).length
      )
        return bad();
      const nodes = row.graph.nodes as Array<{
        id: string;
        kind: string;
        config?: unknown;
      }>;
      const condition = nodes.find((n) => n.kind === "condition")!;
      const action = nodes.find((n) => n.kind === "action")!;
      const end = nodes.find((n) => n.kind === "end")!;
      const evaluated = evaluateCondition(
        condition.config,
        event.rows[0].content,
      );
      if (!evaluated.ok)
        return {
          id: row.id,
          version: 2,
          decision: null,
          actionId: action.id,
          failure: {
            classification: "permanent",
            code: evaluated.code,
            nodeId: condition.id,
          },
        };
      const branch = evaluated.value ? "TRUE" : "FALSE";
      return {
        id: row.id,
        version: 2,
        decision: {
          nodeId: condition.id,
          outcome: branch,
          sourcePort: branch,
          targetNodeId: evaluated.value ? action.id : end.id,
        },
        actionId: action.id,
        failure: null,
      };
    });
    const actionOutcome = options.handler ? await options.handler() : "success";
    const outcome: Outcome =
      evaluations.some((e) => e.failure?.classification === "permanent") ||
      actionOutcome === "permanent"
        ? "permanent"
        : evaluations.some((e) => e.failure?.classification === "unknown") ||
            actionOutcome === "unknown"
          ? "unknown"
          : actionOutcome;
    const decision = decideRetry(
      options.policy ?? defaultPolicy,
      ordinal,
      outcome,
    );
    const result = {
      kind: "local-receipt.v1",
      eventId: event.rows[0].id,
      message: event.rows[0].content.message,
    };
    if (decision.state === "completed") {
      await client.query(
        "INSERT INTO receipts(event_id,result) VALUES ($1,$2::jsonb) ON CONFLICT (event_id) DO NOTHING",
        [dispatch.eventId, JSON.stringify(result)],
      );
    }
    for (const evaluation of evaluations) {
      if (evaluation.version === 1) {
        if (decision.state === "completed")
          await client.query(
            "UPDATE automation_executions SET result=$2::jsonb WHERE id=$1",
            [evaluation.id, JSON.stringify(result)],
          );
        continue;
      }
      if (evaluation.version !== 2) continue;
      const ignored = evaluation.decision?.outcome === "FALSE";
      const completed = decision.state === "completed";
      const scheduled = decision.state === "scheduled";
      const ownFailure = evaluation.failure;
      const failure =
        ignored || completed
          ? null
          : (ownFailure ?? {
              classification: scheduled
                ? "transient"
                : decision.state === "blocked"
                  ? decision.reason
                  : "unknown",
              code:
                decision.state === "blocked" && decision.reason === "exhausted"
                  ? "retry_exhausted"
                  : actionOutcome !== "success" && outcome === actionOutcome
                    ? `action_${actionOutcome}`
                    : "event_peer_failure",
              nodeId:
                actionOutcome !== "success" && outcome === actionOutcome
                  ? evaluation.actionId
                  : null,
            });
      const envelope = {
        kind: "condition-execution.v1",
        eventId: event.rows[0].id,
        decision: evaluation.decision,
        action: {
          nodeId: evaluation.actionId,
          status: ignored
            ? "ignored"
            : completed
              ? "executed"
              : scheduled && evaluation.decision
                ? "pending"
                : "not_executed",
          receipt: completed && !ignored ? result : null,
        },
        failure,
      };
      await client.query(
        "UPDATE automation_executions SET result=$2::jsonb WHERE id=$1",
        [evaluation.id, JSON.stringify(envelope)],
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
