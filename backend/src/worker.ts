import type pg from "pg";
import type { Channel, Message } from "amqplib";
import { transaction } from "./db.js";
import { queue } from "./config.js";
import { decideRetry, type Outcome, type RetryPolicy } from "./retry-policy.js";
import { evaluateCondition } from "./condition.js";
import { validateGraphV2 } from "./graph-v2.js";
import {
  emit,
  consoleTelemetry,
  lookupCode,
  classification,
  type TelemetrySink,
  type HttpClass,
} from "./worker-telemetry.js";
import { lookupViaCep } from "./viacep-transport.js";
import {
  prepareViaCepExecution,
  finalizeViaCepExecution,
  type PreparedViaCepExecution,
  type ViaCepLookup,
  type ViaCepEventAggregate,
} from "./viacep-execution.js";
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
  viacepTimeoutMs?: number;
  viacepLookup?: ViaCepLookup;
  viacepExternalExecutionEnabled?: boolean;
  telemetry?: TelemetrySink;
  now?: () => number;
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
  const sink = options.telemetry ?? consoleTelemetry;
  const now = options.now ?? (() => performance.now());
  const clock = () => {
    try {
      const n = now();
      return Number.isFinite(n) ? n : undefined;
    } catch {
      return undefined;
    }
  };
  const elapsed = (start: number | undefined) => {
    const end = clock();
    return start === undefined || end === undefined
      ? undefined
      : Math.max(0, end - start);
  };
  const eventId = dispatch.eventId as string;
  let callbackStarted: number | undefined;
  let callbackDuration: number | undefined;
  let lockStarted: number | undefined;
  let lockAcquired: number | undefined;
  const invariant = (): never => {
    emit(sink, {
      provider: "viacep",
      event: "execution_invariant",
      eventId,
      generation,
      code: "execution_invariant",
      classification: "unknown",
    });
    throw new Error("execution invariant");
  };
  let summary:
    | {
        event: "retry_scheduled" | "retry_exhausted" | "event_blocked";
        attempt: number;
        delayMs?: number;
        classification: "transient" | "permanent" | "unknown" | "exhausted";
      }
    | undefined;
  try {
    summary = await transaction(pool, async (client) => {
      // Callback starts after BEGIN. Lock timing includes query overhead and is approximate.
      callbackStarted = clock();
      try {
        lockStarted = clock();
        const event = await client.query(
          "SELECT id,content FROM events WHERE id=$1 FOR UPDATE",
          [dispatch.eventId],
        );
        lockAcquired = clock();
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
          if (!publication.rowCount)
            throw new Error("missing retry publication");
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
          `SELECT x.id,x.schema_version,x.trigger_type,x.action_type,x.result,x.result IS NULL AS result_is_sql_null,r.graph,r.graph IS NULL AS graph_is_sql_null,r.schema_version AS revision_version,r.trigger_type AS revision_trigger,r.action_type AS revision_action
       FROM automation_executions x LEFT JOIN automation_definition_revisions r
       ON r.automation_id=x.automation_id AND r.revision=x.revision WHERE x.event_id=$1 ORDER BY x.id`,
          [dispatch.eventId],
        );
        // Legacy evaluation produces only terminal condition/contract failures;
        // v3 transient outcomes remain in the prepared evaluator's own union.
        type LegacyFailure = {
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
          failure: LegacyFailure | null;
          prepared?: PreparedViaCepExecution;
        };
        const evaluateLegacy = (
          row: (typeof executions.rows)[number],
        ): Evaluation => {
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
        };
        const evaluations: Evaluation[] = [];
        for (const row of executions.rows) {
          if (row.schema_version !== 3) {
            const legacy = evaluateLegacy(row);
            if (legacy.failure?.code === "unsupported_execution_contract")
              emit(sink, {
                provider: "viacep",
                event: "unsupported_execution_contract",
                eventId,
                generation,
                code: "unsupported_execution_contract",
                classification: "unknown",
              });
            evaluations.push(legacy);
            continue;
          }
          const executionId =
            typeof row.id === "string" &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
              row.id,
            )
              ? row.id
              : undefined;
          const common = {
            provider: "viacep" as const,
            eventId,
            executionId,
            generation,
          };
          let called = false;
          const observedLookup: ViaCepLookup = async (cep, lookupOptions) => {
            if (!options.viacepExternalExecutionEnabled)
              return { status: "security_rejected" };
            called = true;
            emit(sink, {
              ...common,
              event: "lookup_attempted",
              attempt: ordinal,
            });
            const start = clock();
            let httpClass: HttpClass = "none";
            let bodyBytes: number | undefined;
            let status = "unknown";
            try {
              const result = options.viacepLookup
                ? await options.viacepLookup(cep, lookupOptions)
                : await lookupViaCep(cep, {
                    ...lookupOptions,
                    observe: (observation) => {
                      httpClass = observation.httpClass;
                      bodyBytes = observation.bodyBytes;
                    },
                  });
              status = result.status;
              return result;
            } finally {
              const outcome =
                status === "found"
                  ? "found"
                  : status === "not_found"
                    ? "not_found"
                    : "failed";
              const code =
                outcome === "found" ? "none" : lookupCode(`viacep_${status}`);
              const durationMs = elapsed(start);
              emit(sink, {
                ...common,
                event: "lookup_finished",
                attempt: ordinal,
                outcome,
                code:
                  code === "none" && outcome === "failed"
                    ? "viacep_unknown"
                    : code,
                classification:
                  outcome === "found"
                    ? "none"
                    : status === "timeout" ||
                        status === "transport" ||
                        status === "http_transient"
                      ? "transient"
                      : status === "not_found" ||
                          status === "http_permanent" ||
                          status === "invalid_response" ||
                          status === "security_rejected"
                        ? "permanent"
                        : "unknown",
                ...(durationMs === undefined ? {} : { durationMs }),
                httpClass,
                ...(bodyBytes === undefined ? {} : { bodyBytes }),
              });
            }
          };
          let prepared: PreparedViaCepExecution;
          try {
            prepared = await prepareViaCepExecution(
              {
                executionId: row.id,
                eventId: event.rows[0].id,
                eventContent: event.rows[0].content,
                graph: row.graph,
                schemaVersion: row.schema_version,
                triggerType: row.trigger_type,
                actionType: row.action_type,
                revisionVersion: row.revision_version,
                revisionTrigger: row.revision_trigger,
                revisionAction: row.revision_action,
                persistedResult: row.result,
                resultIsSqlNull: row.result_is_sql_null,
                timeoutMs: options.viacepTimeoutMs ?? 5000,
              },
              observedLookup,
            );
          } catch (error) {
            emit(sink, {
              ...common,
              event: "execution_invariant",
              code: "execution_invariant",
              classification: "unknown",
            });
            throw error;
          }
          if (prepared.kind === "unsupported")
            emit(sink, {
              ...common,
              event: "unsupported_execution_contract",
              code: "unsupported_execution_contract",
              classification: "unknown",
            });
          else if (!called) {
            const observation = prepared.lookup;
            const invalid =
              (observation.failure?.code === "invalid_cep" ||
                observation.failure?.code === "viacep_security_rejected") &&
              row.result_is_sql_null;
            emit(sink, {
              ...common,
              event: invalid ? "lookup_rejected" : "lookup_reused",
              outcome:
                observation.status === "found"
                  ? "found"
                  : observation.status === "not_found"
                    ? "not_found"
                    : "failed",
              code: lookupCode(observation.failure?.code),
              classification: classification(
                observation.failure?.classification,
              ),
            });
          }
          evaluations.push({
            id: row.id,
            version: 3,
            decision: null,
            actionId: null,
            failure: null,
            prepared,
          });
        }
        const actionOutcome = options.handler
          ? await options.handler()
          : "success";
        const rank: Record<Outcome, number> = {
          success: 0,
          transient: 1,
          unknown: 2,
          permanent: 3,
        };
        const maxOutcome = (a: Outcome, b: Outcome): Outcome =>
          rank[a] >= rank[b] ? a : b;
        const ownOutcomes: Outcome[] = evaluations.map((e) => {
          if (!e.prepared) return e.failure?.classification ?? "success";
          if (e.prepared.kind === "unsupported") return "unknown";
          const classification =
            e.prepared.failure?.classification ?? "success";
          if (classification === "exhausted") return invariant();
          return classification;
        });
        const outcome = ownOutcomes.reduce(maxOutcome, actionOutcome);
        const decision = decideRetry(
          options.policy ?? defaultPolicy,
          ordinal,
          outcome,
        );
        const result = {
          kind: "local-receipt.v1" as const,
          eventId: event.rows[0].id,
          message: event.rows[0].content.message,
        };
        // Finalize and serialize every result before issuing any result writes.
        const writes: Array<{ id: string; result: string }> = [];
        const receiptJson =
          decision.state === "completed" ? JSON.stringify(result) : null;
        for (const [index, evaluation] of evaluations.entries()) {
          if (evaluation.prepared) {
            const peerOutcome = ownOutcomes.reduce(
              (max, own, i) => (i === index ? max : maxOutcome(max, own)),
              "success" as Outcome,
            );
            let aggregate: ViaCepEventAggregate;
            if (decision.state === "completed") {
              aggregate = {
                state: "completed",
                outcome: "success",
                peerOutcome: "success",
                actionOutcome: "success",
                receipt: result,
              };
            } else if (decision.state === "scheduled") {
              aggregate = {
                state: "scheduled",
                outcome: "transient",
                peerOutcome,
                actionOutcome,
                receipt: null,
              };
            } else {
              if (outcome === "success") return invariant();
              aggregate = {
                state: "blocked",
                outcome,
                reason: decision.reason,
                peerOutcome,
                actionOutcome,
                receipt: null,
              };
            }
            let finalized;
            try {
              finalized = finalizeViaCepExecution(
                evaluation.prepared,
                aggregate,
              );
            } catch (error) {
              emit(sink, {
                provider: "viacep",
                event: "execution_invariant",
                eventId,
                generation,
                code: "execution_invariant",
                classification: "unknown",
              });
              throw error;
            }
            writes.push({
              id: evaluation.id,
              result: JSON.stringify(finalized),
            });
            continue;
          }
          if (evaluation.version === 1) {
            if (decision.state === "completed")
              writes.push({ id: evaluation.id, result: receiptJson! });
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
                    decision.state === "blocked" &&
                    decision.reason === "exhausted"
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
          writes.push({ id: evaluation.id, result: JSON.stringify(envelope) });
        }
        if (receiptJson !== null)
          await client.query(
            "INSERT INTO receipts(event_id,result) VALUES ($1,$2::jsonb) ON CONFLICT (event_id) DO NOTHING",
            [dispatch.eventId, receiptJson],
          );
        for (const write of writes)
          await client.query(
            "UPDATE automation_executions SET result=$2::jsonb WHERE id=$1",
            [write.id, write.result],
          );
        const missingV3 = await client.query(
          "SELECT 1 FROM automation_executions WHERE event_id=$1 AND schema_version=3 AND result IS NULL LIMIT 1",
          [dispatch.eventId],
        );
        if (missingV3.rowCount) return invariant();
        const state =
          decision.state === "scheduled" ? "retry_scheduled" : decision.state;
        const delay = decision.state === "scheduled" ? decision.delayMs : null;
        const reason = decision.state === "blocked" ? decision.reason : null;
        await client.query(
          `INSERT INTO retry_dispositions(event_id,generation,attempt,outcome,state,delay_ms,next_eligible_at,reason)
      VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $6::integer IS NULL THEN NULL ELSE clock_timestamp()+$6::integer * interval '1 millisecond' END,$7)
      ON CONFLICT (event_id) DO UPDATE SET generation=EXCLUDED.generation,attempt=EXCLUDED.attempt,outcome=EXCLUDED.outcome,state=EXCLUDED.state,delay_ms=EXCLUDED.delay_ms,next_eligible_at=EXCLUDED.next_eligible_at,reason=EXCLUDED.reason`,
          [
            dispatch.eventId,
            generation,
            ordinal,
            outcome,
            state,
            delay,
            reason,
          ],
        );
        if (generation > 0)
          await client.query(
            "UPDATE retry_publications SET processed_at=clock_timestamp() WHERE event_id=$1 AND generation=$2",
            [dispatch.eventId, generation],
          );
        if (beforeCommit) await beforeCommit();
        if (decision.state === "scheduled")
          return {
            event: "retry_scheduled" as const,
            attempt: ordinal,
            delayMs: decision.delayMs,
            classification: "transient" as const,
          };
        if (decision.state === "blocked")
          return {
            event:
              decision.reason === "exhausted"
                ? ("retry_exhausted" as const)
                : ("event_blocked" as const),
            attempt: ordinal,
            classification: decision.reason,
          };
        return undefined;
      } finally {
        callbackDuration = elapsed(callbackStarted);
      }
    });
    // Wrapper resolution includes COMMIT and release; lock-held duration is an approximation.
    const lockHeldMs = elapsed(lockAcquired);
    emit(sink, {
      provider: "viacep",
      event: "transaction_finished",
      eventId,
      generation,
      outcome: "committed",
      ...(callbackDuration === undefined
        ? {}
        : { durationMs: callbackDuration }),
      ...(lockStarted === undefined || lockAcquired === undefined
        ? {}
        : {
            lockWaitMs: Math.max(0, lockAcquired - lockStarted),
            ...(lockHeldMs === undefined ? {} : { lockHeldMs }),
          }),
    });
    // Best effort only: a crash after COMMIT can lose this record; the database is authoritative.
    if (summary)
      emit(sink, {
        provider: "viacep",
        eventId,
        generation,
        event: summary.event,
        code: summary.event,
        attempt: summary.attempt,
        classification: summary.classification,
        ...(summary.delayMs === undefined ? {} : { delayMs: summary.delayMs }),
      });
  } catch (error) {
    const lockHeldMs = elapsed(lockAcquired);
    emit(sink, {
      provider: "viacep",
      event: "transaction_finished",
      eventId,
      generation,
      outcome: "not_confirmed",
      code: "transaction_not_confirmed",
      ...(callbackDuration === undefined
        ? {}
        : { durationMs: callbackDuration }),
      ...(lockStarted === undefined || lockAcquired === undefined
        ? {}
        : {
            lockWaitMs: Math.max(0, lockAcquired - lockStarted),
            ...(lockHeldMs === undefined ? {} : { lockHeldMs }),
          }),
    });
    throw error;
  }
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
  options: WorkerOptions = {},
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
      void handleMessage(
        pool,
        channel,
        message,
        undefined,
        undefined,
        options,
      ).catch(() => {
        console.error("worker failed; closing channel without acknowledgement");
        void channel.close().catch(() => {});
      });
    },
    { noAck: false },
  );
}
