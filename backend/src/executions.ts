import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { params } from "./automations.js";
import { executionResultStatus } from "./execution-result.js";
import {
  parseExecutionResultV3,
  type ExecutionResultV3,
} from "./execution-result-v3.js";
import { validateViaCepCorrespondence } from "./viacep-execution.js";

const uuid = params.properties.id;
const query = {
  type: "object",
  additionalProperties: false,
  properties: { eventId: uuid, automationId: uuid },
  oneOf: [{ required: ["eventId"] }, { required: ["automationId"] }],
};
const select = `SELECT x.id,x.event_id,x.automation_id,x.revision,x.schema_version,x.trigger_type,x.action_type,x.result,x.result IS NULL AS result_is_sql_null,x.created_at,
 d.generation,d.attempt,d.outcome,d.state,d.delay_ms,d.next_eligible_at,d.reason,p.generation AS publication_generation,p.processed_at,
 r.graph,r.schema_version AS revision_version,r.trigger_type AS revision_trigger,r.action_type AS revision_action,e.id AS pinned_event_id,e.content AS event_content
 FROM automation_executions x LEFT JOIN automation_definition_revisions r ON r.automation_id=x.automation_id AND r.revision=x.revision
 LEFT JOIN events e ON e.id=x.event_id LEFT JOIN retry_dispositions d ON d.event_id=x.event_id
 LEFT JOIN retry_publications p ON p.event_id=x.event_id AND p.generation=d.generation`;
type Row = {
  id: string;
  event_id: string;
  automation_id: string;
  revision: number;
  schema_version: number;
  trigger_type: string;
  action_type: string;
  result: unknown;
  result_is_sql_null: boolean;
  created_at: Date;
  generation: number | null;
  attempt: number | null;
  outcome: string | null;
  state: string | null;
  delay_ms: number | null;
  next_eligible_at: Date | null;
  reason: string | null;
  publication_generation: number | null;
  processed_at: Date | null;
  graph: unknown;
  revision_version: number;
  revision_trigger: string;
  revision_action: string;
  event_content: unknown;
  pinned_event_id: string | null;
};
function output(row: Row) {
  const v3Result =
    row.schema_version === 3
      ? parseExecutionResultV3(row.result, row.event_id, row.result_is_sql_null)
      : null;
  const actionStatus =
    row.schema_version === 3
      ? (v3Result?.action.status ?? null)
      : executionResultStatus(
          row.schema_version,
          row.event_id,
          row.result,
          false,
        );
  if (v3Result) {
    if (row.pinned_event_id !== row.event_id)
      throw new Error("execution invariant");
    validateViaCepCorrespondence(
      {
        eventId: row.event_id,
        eventContent: row.event_content,
        graph: row.graph,
        schemaVersion: row.schema_version,
        triggerType: row.trigger_type,
        actionType: row.action_type,
        revisionVersion: row.revision_version,
        revisionTrigger: row.revision_trigger,
        revisionAction: row.revision_action,
      },
      v3Result,
    );
  }
  if (row.schema_version === 3) validateV3Disposition(row, v3Result);
  const ignored = actionStatus === "ignored";
  if (
    (row.state === "completed" && actionStatus !== "executed" && !ignored) ||
    (actionStatus === "executed" &&
      row.state !== null &&
      row.state !== "completed") ||
    (actionStatus === "pending" && row.state !== "retry_scheduled") ||
    (actionStatus === "not_executed" && row.state !== "blocked") ||
    (row.state !== null &&
      !["completed", "retry_scheduled", "blocked"].includes(row.state))
  )
    throw new Error("execution invariant");
  return {
    id: row.id,
    eventId: row.event_id,
    automationId: row.automation_id,
    revision: row.revision,
    schemaVersion: row.schema_version,
    trigger: { type: row.trigger_type },
    action: { type: row.action_type },
    createdAt: row.created_at.toISOString(),
    status: ignored
      ? "ignored"
      : (row.schema_version === 3
            ? row.state === "retry_scheduled" &&
              row.publication_generation !== null
            : row.publication_generation) && !row.processed_at
        ? "retry_released"
        : (row.state ?? (row.result ? "completed" : "accepted")),
    retry: row.state
      ? {
          scope: "event",
          generation: row.generation,
          attempt: row.attempt,
          outcome: row.outcome,
          delayMs: row.delay_ms,
          nextEligibleAt: row.next_eligible_at,
          reason: row.reason,
        }
      : null,
    result: row.schema_version === 3 ? v3Result : row.result,
  };
}
function validateV3Disposition(row: Row, result: ExecutionResultV3 | null) {
  const actionStatus = result?.action.status ?? null;
  const absent = (x: unknown) => x === null || x === undefined;
  if (row.state === null) {
    if (
      actionStatus !== null ||
      ![
        row.generation,
        row.attempt,
        row.outcome,
        row.delay_ms,
        row.next_eligible_at,
        row.reason,
        row.publication_generation,
        row.processed_at,
      ].every(absent)
    )
      throw new Error("execution invariant");
    return;
  }
  if (
    actionStatus === null ||
    !Number.isSafeInteger(row.generation) ||
    row.generation! < 0 ||
    !Number.isSafeInteger(row.attempt) ||
    row.attempt! < 1
  )
    throw new Error("execution invariant");
  const publicationAbsent = absent(row.publication_generation);
  if (
    (publicationAbsent && !absent(row.processed_at)) ||
    (!absent(row.processed_at) &&
      (!(row.processed_at instanceof Date) ||
        !Number.isFinite(row.processed_at.getTime()))) ||
    (!publicationAbsent &&
      (row.generation! <= 0 ||
        row.publication_generation !== row.generation ||
        (absent(row.processed_at) && row.state !== "retry_scheduled")))
  )
    throw new Error("execution invariant");
  if (row.state === "completed") {
    if (
      row.outcome !== "success" ||
      !absent(row.delay_ms) ||
      !absent(row.next_eligible_at) ||
      !absent(row.reason) ||
      !["executed", "ignored"].includes(actionStatus)
    )
      throw new Error("execution invariant");
  } else if (row.state === "retry_scheduled") {
    if (
      row.outcome !== "transient" ||
      !Number.isSafeInteger(row.delay_ms) ||
      row.delay_ms! <= 0 ||
      !(row.next_eligible_at instanceof Date) ||
      !Number.isFinite(row.next_eligible_at.getTime()) ||
      !absent(row.reason) ||
      !["pending", "ignored"].includes(actionStatus)
    )
      throw new Error("execution invariant");
  } else if (row.state === "blocked") {
    if (
      !(
        (row.outcome === "permanent" && row.reason === "permanent") ||
        (row.outcome === "unknown" && row.reason === "unknown") ||
        (row.outcome === "transient" && row.reason === "exhausted")
      ) ||
      !absent(row.delay_ms) ||
      !absent(row.next_eligible_at) ||
      !["not_executed", "ignored"].includes(actionStatus)
    )
      throw new Error("execution invariant");
  } else throw new Error("execution invariant");

  if (actionStatus === "ignored") {
    if (result?.failure !== null) throw new Error("execution invariant");
    return;
  }
  const classification = result?.failure?.classification ?? null;
  const unsupportedFallback =
    result?.lookup === null &&
    result.failure?.code === "unsupported_execution_contract" &&
    classification === "unknown";
  const expectedClassification =
    row.state === "completed"
      ? null
      : row.state === "retry_scheduled"
        ? "transient"
        : row.reason === "exhausted"
          ? "exhausted"
          : row.outcome;
  if (
    classification !== expectedClassification &&
    !(
      unsupportedFallback &&
      row.state === "blocked" &&
      row.outcome === "permanent"
    )
  )
    throw new Error("execution invariant");
}
export function executionRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get<{ Params: { id: string } }>(
    "/executions/:id",
    { schema: { params } },
    async (request, reply) => {
      const result = await pool.query<Row>(`${select} WHERE x.id=$1`, [
        request.params.id,
      ]);
      if (!result.rowCount) return reply.code(404).send({ error: "not_found" });
      try {
        return output(result.rows[0]);
      } catch {
        return reply.code(503).send({ error: "unavailable" });
      }
    },
  );
  app.get<{ Querystring: { eventId?: string; automationId?: string } }>(
    "/executions",
    { schema: { querystring: query } },
    async (request, reply) => {
      const eventFilter = request.query.eventId !== undefined;
      const result = await pool.query<Row>(
        `${select} WHERE x.${eventFilter ? "event_id" : "automation_id"}=$1 ORDER BY x.id LIMIT 100`,
        [eventFilter ? request.query.eventId : request.query.automationId],
      );
      try {
        return { items: result.rows.map(output) };
      } catch {
        return reply.code(503).send({ error: "unavailable" });
      }
    },
  );
}
