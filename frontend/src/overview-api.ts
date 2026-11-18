const periods = {
  "24h": [86400, 24],
  "7d": [604800, 7],
  "30d": [2592000, 30],
} as const;
export type Period = keyof typeof periods;
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

const base = (import.meta.env.VITE_API_BASE_URL ?? "/api").replace(/\/$/, "");
export async function getOverview(
  period: Period,
  signal: AbortSignal,
): Promise<Overview> {
  const response = await fetch(`${base}/overview?period=${period}`, { signal });
  if (!response.ok) throw new Error("overview unavailable");
  return parseOverview(await response.json(), period);
}
