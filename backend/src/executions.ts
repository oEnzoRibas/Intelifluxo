import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { params } from "./automations.js";

const uuid = params.properties.id;
const query = {
  type: "object",
  additionalProperties: false,
  properties: { eventId: uuid, automationId: uuid },
  oneOf: [{ required: ["eventId"] }, { required: ["automationId"] }],
};
const select = `SELECT x.id,x.event_id,x.automation_id,x.revision,x.schema_version,x.trigger_type,x.action_type,x.result,x.created_at,
 d.generation,d.attempt,d.outcome,d.state,d.delay_ms,d.next_eligible_at,d.reason,p.generation AS publication_generation,p.processed_at
 FROM automation_executions x LEFT JOIN retry_dispositions d ON d.event_id=x.event_id
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
};
function output(row: Row) {
  return {
    id: row.id,
    eventId: row.event_id,
    automationId: row.automation_id,
    revision: row.revision,
    schemaVersion: row.schema_version,
    trigger: { type: row.trigger_type },
    action: { type: row.action_type },
    createdAt: row.created_at.toISOString(),
    status:
      row.publication_generation && !row.processed_at
        ? "retry_released"
        : (row.state ?? (row.result ? "completed" : "accepted")),
    retry: row.state
      ? {
          generation: row.generation,
          attempt: row.attempt,
          outcome: row.outcome,
          delayMs: row.delay_ms,
          nextEligibleAt: row.next_eligible_at,
          reason: row.reason,
        }
      : null,
    result: row.result,
  };
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
      return output(result.rows[0]);
    },
  );
  app.get<{ Querystring: { eventId?: string; automationId?: string } }>(
    "/executions",
    { schema: { querystring: query } },
    async (request) => {
      const eventFilter = request.query.eventId !== undefined;
      const result = await pool.query<Row>(
        `${select} WHERE x.${eventFilter ? "event_id" : "automation_id"}=$1 ORDER BY x.id LIMIT 100`,
        [eventFilter ? request.query.eventId : request.query.automationId],
      );
      return { items: result.rows.map(output) };
    },
  );
}
