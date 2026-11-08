import Fastify from "fastify";
import type pg from "pg";
import { automationRoutes } from "./automations.js";
import { accept } from "./accept.js";
import { requestSchema, type Input } from "./contract.js";
import { executionRoutes } from "./executions.js";
import { automationSnapshotsEnabled } from "./config.js";

export function api(
  pool: pg.Pool,
  snapshotsEnabled = automationSnapshotsEnabled(
    process.env.AUTOMATION_SNAPSHOTS_ENABLED,
  ),
) {
  const app = Fastify({
    bodyLimit: 8192,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  automationRoutes(app, pool);
  executionRoutes(app, pool);
  app.get("/status", async () => ({
    profile: "local-development-only",
    limitations: [
      "no authentication, tenant isolation, or authorization/revocation serialization",
      "no capacity admission",
      "no publication ownership, fencing, or reaper",
      "no quarantine or repair",
      "no business DLQ; retries require manual scheduler and relay sweeps",
      "no external exactly-once effects",
    ],
  }));
  app.post<{ Body: Input }>(
    "/events",
    { schema: { body: requestSchema } },
    async (request, reply) => {
      const result = await accept(pool, request.body, snapshotsEnabled);
      if (result.conflict)
        return reply.code(409).send({ error: "idempotency_conflict" });
      return reply
        .code(result.replay ? 200 : 202)
        .send({ id: result.id, replay: result.replay });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/events/:id",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: {
            id: {
              type: "string",
              pattern:
                "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\\s\\S])",
            },
          },
        },
      },
    },
    async (request, reply) => {
      const result = await pool.query(
        `SELECT e.id,e.scope,e.content,e.created_at,o.confirmed_at,r.result,d.generation,d.attempt,d.outcome,d.state,d.delay_ms,d.next_eligible_at,d.reason,p.confirmed_at AS retry_confirmed_at,p.processed_at AS retry_processed_at,p.generation AS publication_generation
      FROM events e JOIN outbox o ON o.event_id=e.id LEFT JOIN receipts r ON r.event_id=e.id LEFT JOIN retry_dispositions d ON d.event_id=e.id LEFT JOIN retry_publications p ON p.event_id=e.id AND p.generation=d.generation WHERE e.id=$1`,
        [request.params.id],
      );
      if (!result.rowCount) return reply.code(404).send({ error: "not_found" });
      const row = result.rows[0];
      return {
        id: row.id,
        scope: row.scope,
        content: row.content,
        createdAt: row.created_at,
        publication: (
          row.publication_generation ? row.retry_confirmed_at : row.confirmed_at
        )
          ? "confirmed"
          : "pending",
        status:
          row.publication_generation && !row.retry_processed_at
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
    },
  );
  return app;
}
