import type { FastifyInstance } from "fastify";
import type pg from "pg";

const periods = {
  "24h": [86400, 24],
  "7d": [604800, 7],
  "30d": [2592000, 30],
} as const;
type Period = keyof typeof periods;
type Status = "success" | "failed" | "skipped" | "pending_or_unknown";
type Execution = {
  executionId: string;
  automationId: string;
  automationName: string;
  revision: number;
  status: Status;
  createdAt: string;
};
export type Overview = {
  version: 1;
  period: Period;
  window: { start: string; end: string; timestamp: "createdAt" };
  automations: { total: number; active: number };
  executions: {
    total: number;
    success: number;
    failed: number;
    skipped: number;
    pendingOrUnknown: number;
    successRate: number | null;
    successRateDenominator: "success_plus_failed";
  };
  buckets: { start: string; end: string; executions: number }[];
  recent: Execution[];
  executionFailures: (Execution & { status: "failed" })[];
  eventAttention: {
    scope: "current";
    timestamp: "eventCreatedAt";
    items: {
      eventId: string;
      eventCreatedAt: string;
      status: "blocked" | "retry_scheduled";
    }[];
  };
  limitations: {
    completionTime: {
      value: null;
      reason: "completion_timestamp_not_persisted";
    };
    listLimit: 10;
  };
};

// PostgreSQL's JSON timestamptz rendering otherwise depends on the session timezone.
const utc = (value: string) =>
  `to_char(${value} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
// A single statement gives every section the same snapshot and clock. Buckets group
// executions once, then left join the generated series to retain empty buckets.
export const overviewSql = `WITH bounds AS (
 SELECT statement_timestamp() AS finish, statement_timestamp() - ($1::integer * interval '1 second') AS start
), executions AS (
 SELECT x.id, x.automation_id, x.revision, r.name, x.created_at,
 CASE
   WHEN x.schema_version=1 AND x.result->>'kind'='local-receipt.v1' THEN 'success'
   WHEN ((x.schema_version=2 AND x.result->>'kind'='condition-execution.v1') OR (x.schema_version=3 AND x.result->>'kind'='viacep-condition-execution.v1')) AND x.result->'action'->>'status'='executed' THEN 'success'
   WHEN ((x.schema_version=2 AND x.result->>'kind'='condition-execution.v1') OR (x.schema_version=3 AND x.result->>'kind'='viacep-condition-execution.v1')) AND x.result->'action'->>'status'='ignored' THEN 'skipped'
   WHEN ((x.schema_version=2 AND x.result->>'kind'='condition-execution.v1') OR (x.schema_version=3 AND x.result->>'kind'='viacep-condition-execution.v1')) AND x.result->'action'->>'status'='not_executed' THEN 'failed'
   ELSE 'pending_or_unknown' END AS status
 FROM automation_executions x JOIN automation_definition_revisions r ON r.automation_id=x.automation_id AND r.revision=x.revision
 CROSS JOIN bounds b WHERE x.created_at >= b.start AND x.created_at < b.finish
), counts AS (
 SELECT count(*)::integer AS total, count(*) FILTER (WHERE status='success')::integer AS success,
 count(*) FILTER (WHERE status='failed')::integer AS failed, count(*) FILTER (WHERE status='skipped')::integer AS skipped,
 count(*) FILTER (WHERE status='pending_or_unknown')::integer AS pending_or_unknown FROM executions
), automation_counts AS (
 SELECT count(*)::integer AS total, count(*) FILTER (WHERE r.active)::integer AS active
 FROM automation_definitions d JOIN automation_definition_revisions r ON r.automation_id=d.id AND r.revision=d.current_revision
), bucket_counts AS (
 SELECT floor(extract(epoch FROM (e.created_at-b.start)) * $2::integer / $1::integer)::integer AS n, count(*)::integer AS total
 FROM executions e CROSS JOIN bounds b GROUP BY 1
), buckets AS (
 SELECT n, b.start + n * ($1::double precision / $2::integer) * interval '1 second' AS start,
 b.start + (n+1) * ($1::double precision / $2::integer) * interval '1 second' AS finish, coalesce(c.total,0) AS total
 FROM bounds b CROSS JOIN generate_series(0,$2::integer-1) n LEFT JOIN bucket_counts c USING(n)
)
SELECT jsonb_build_object(
 'version', 1, 'period', $3::text,
 'window', jsonb_build_object('start', ${utc("b.start")}, 'end', ${utc("b.finish")}, 'timestamp', 'createdAt'),
 'automations', jsonb_build_object('total', a.total, 'active', a.active),
 'executions', jsonb_build_object('total', c.total, 'success', c.success, 'failed', c.failed, 'skipped', c.skipped, 'pendingOrUnknown', c.pending_or_unknown,
 'successRate', CASE WHEN c.success+c.failed=0 THEN NULL ELSE c.success::double precision/(c.success+c.failed) END, 'successRateDenominator', 'success_plus_failed'),
 'buckets', (SELECT jsonb_agg(jsonb_build_object('start', ${utc("k.start")}, 'end', ${utc("k.finish")}, 'executions', k.total) ORDER BY k.n) FROM buckets k),
 'recent', COALESCE((SELECT jsonb_agg(jsonb_build_object('executionId', t.id, 'automationId', t.automation_id, 'automationName', t.name, 'revision', t.revision, 'status', t.status, 'createdAt', ${utc("t.created_at")}) ORDER BY t.created_at DESC, t.id DESC) FROM (SELECT * FROM executions ORDER BY created_at DESC,id DESC LIMIT 10) t), '[]'::jsonb),
 'executionFailures', COALESCE((SELECT jsonb_agg(jsonb_build_object('executionId', t.id, 'automationId', t.automation_id, 'automationName', t.name, 'revision', t.revision, 'status', t.status, 'createdAt', ${utc("t.created_at")}) ORDER BY t.created_at DESC, t.id DESC) FROM (SELECT * FROM executions WHERE status='failed' ORDER BY created_at DESC,id DESC LIMIT 10) t), '[]'::jsonb),
 'eventAttention', jsonb_build_object('scope', 'current', 'timestamp', 'eventCreatedAt', 'items', COALESCE((SELECT jsonb_agg(jsonb_build_object('eventId', t.id, 'eventCreatedAt', ${utc("t.created_at")}, 'status', t.state) ORDER BY t.created_at DESC, t.id DESC) FROM (SELECT e.id, e.created_at, d.state FROM retry_dispositions d JOIN events e ON e.id=d.event_id WHERE d.state IN ('blocked','retry_scheduled') ORDER BY e.created_at DESC,e.id DESC LIMIT 10) t), '[]'::jsonb)),
 'limitations', jsonb_build_object('completionTime', jsonb_build_object('value', NULL, 'reason', 'completion_timestamp_not_persisted'), 'listLimit', 10)
) AS overview FROM bounds b CROSS JOIN counts c CROSS JOIN automation_counts a`;

type Obj = Record<string, unknown>;
function object(value: unknown, keys: string[]): Obj {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error("invalid overview");
  return value as Obj;
}
function check(ok: boolean): void {
  if (!ok) throw new Error("invalid overview");
}
function count(x: unknown): x is number {
  return typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
}
function timestamp(x: unknown): x is string {
  return (
    typeof x === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(x) &&
    Number.isFinite(Date.parse(x)) &&
    new Date(x).toISOString() === `${x.slice(0, 23)}Z`
  );
}
function identifier(x: unknown): boolean {
  return (
    typeof x === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x)
  );
}
function list(value: unknown, max: number): unknown[] {
  check(Array.isArray(value) && value.length <= max);
  return value as unknown[];
}
function execution(value: unknown, failure = false): void {
  const x = object(value, [
    "executionId",
    "automationId",
    "automationName",
    "revision",
    "status",
    "createdAt",
  ]);
  check(
    identifier(x.executionId) &&
      identifier(x.automationId) &&
      typeof x.automationName === "string" &&
      count(x.revision) &&
      x.revision > 0 &&
      timestamp(x.createdAt) &&
      (failure
        ? x.status === "failed"
        : ["success", "failed", "skipped", "pending_or_unknown"].includes(
            x.status as string,
          )),
  );
}
// Reject unknown keys as well as malformed values; callers must never send raw DB JSON.
export function parseOverview(
  value: unknown,
  expectedPeriod?: Period,
): Overview {
  const x = object(value, [
    "version",
    "period",
    "window",
    "automations",
    "executions",
    "buckets",
    "recent",
    "executionFailures",
    "eventAttention",
    "limitations",
  ]);
  check(
    x.version === 1 &&
      typeof x.period === "string" &&
      Object.hasOwn(periods, x.period) &&
      (expectedPeriod === undefined || x.period === expectedPeriod),
  );
  const period = x.period as Period;
  const window = object(x.window, ["start", "end", "timestamp"]);
  check(
    timestamp(window.start) &&
      timestamp(window.end) &&
      window.timestamp === "createdAt" &&
      Date.parse(window.end as string) - Date.parse(window.start as string) ===
        periods[period][0] * 1000,
  );
  const a = object(x.automations, ["total", "active"]);
  check(count(a.total) && count(a.active) && a.active <= a.total);
  const e = object(x.executions, [
    "total",
    "success",
    "failed",
    "skipped",
    "pendingOrUnknown",
    "successRate",
    "successRateDenominator",
  ]);
  check(
    count(e.total) &&
      count(e.success) &&
      count(e.failed) &&
      count(e.skipped) &&
      count(e.pendingOrUnknown),
  );
  const total = e.total as number,
    success = e.success as number,
    failed = e.failed as number;
  check(
    total ===
      success +
        failed +
        (e.skipped as number) +
        (e.pendingOrUnknown as number) &&
      e.successRateDenominator === "success_plus_failed" &&
      (success + failed === 0
        ? e.successRate === null
        : typeof e.successRate === "number" &&
          e.successRate >= 0 &&
          e.successRate <= 1 &&
          Math.abs(e.successRate - success / (success + failed)) < 1e-12),
  );
  const buckets = list(x.buckets, periods[period][1]);
  check(buckets.length === periods[period][1]);
  let bucketTotal = 0;
  const start = Date.parse(window.start as string),
    step = (periods[period][0] * 1000) / buckets.length;
  buckets.forEach((value, i) => {
    const b = object(value, ["start", "end", "executions"]);
    check(
      timestamp(b.start) &&
        timestamp(b.end) &&
        Date.parse(b.start as string) === start + i * step &&
        Date.parse(b.end as string) === start + (i + 1) * step &&
        count(b.executions),
    );
    bucketTotal += b.executions as number;
  });
  check(bucketTotal === total);
  list(x.recent, 10).forEach((item) => execution(item));
  list(x.executionFailures, 10).forEach((item) => execution(item, true));
  const attention = object(x.eventAttention, ["scope", "timestamp", "items"]);
  check(
    attention.scope === "current" && attention.timestamp === "eventCreatedAt",
  );
  list(attention.items, 10).forEach((item) => {
    const event = object(item, ["eventId", "eventCreatedAt", "status"]);
    check(
      identifier(event.eventId) &&
        timestamp(event.eventCreatedAt) &&
        (event.status === "blocked" || event.status === "retry_scheduled"),
    );
  });
  const limitations = object(x.limitations, ["completionTime", "listLimit"]);
  const completion = object(limitations.completionTime, ["value", "reason"]);
  check(
    limitations.listLimit === 10 &&
      completion.value === null &&
      completion.reason === "completion_timestamp_not_persisted",
  );
  return x as unknown as Overview;
}

export function overviewRoute(app: FastifyInstance, pool: pg.Pool) {
  app.get<{ Querystring: Record<string, unknown> }>(
    "/overview",
    {
      preHandler: async (request, reply) => {
        if (
          request.headers["transfer-encoding"] !== undefined ||
          (request.headers["content-length"] !== undefined &&
            request.headers["content-length"] !== "0")
        )
          return reply.code(400).send({ error: "body_not_allowed" });
      },
    },
    async (request, reply) => {
      const invalid = Object.entries(request.query).filter(
        ([key, value]) =>
          key !== "period" ||
          typeof value !== "string" ||
          !Object.hasOwn(periods, value),
      );
      if (invalid.length)
        return reply.code(400).send({
          error: "validation_failed",
          issues: invalid
            .map(([key]) => ({
              code: "invalid_shape",
              path: `/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
            }))
            .sort((a, b) => a.path.localeCompare(b.path)),
        });
      const period = (request.query.period ?? "24h") as Period;
      const [seconds, buckets] = periods[period];
      try {
        const result = await pool.query(overviewSql, [
          seconds,
          buckets,
          period,
        ]);
        check(result.rows.length === 1);
        return parseOverview(result.rows[0].overview, period);
      } catch {
        request.log.error(
          { route: "/overview", category: "storage" },
          "overview unavailable",
        );
        return reply.code(503).send({ error: "unavailable" });
      }
    },
  );
}
