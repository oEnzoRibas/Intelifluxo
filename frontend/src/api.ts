export type Profile = { profile: string; limitations: string[] };
export type Retry = {
  generation: number;
  attempt: number;
  outcome: "success" | "transient" | "permanent" | "unknown";
  delayMs: number | null;
  nextEligibleAt: string | null;
  reason: null | "permanent" | "unknown" | "exhausted";
};
export type EventDetail = {
  id: string;
  scope: string;
  content: {
    type: "receipt.v1";
    target: "local-receipt";
    message: string;
    data?: Record<string, unknown>;
  };
  createdAt: string;
  publication: "pending" | "confirmed";
  status:
    | "accepted"
    | "completed"
    | "retry_scheduled"
    | "retry_released"
    | "blocked";
  result: null | { kind: "local-receipt.v1"; eventId: string; message: string };
  retry: null | Retry;
};
export class ApiError extends Error {
  constructor(public kind: "not-found" | "unavailable" | "invalid") {
    super(kind);
  }
}
const base = (import.meta.env.VITE_API_BASE_URL ?? "/api").replace(/\/$/, "");
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const exactKeys = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length &&
  keys.every((key) => Object.hasOwn(v, key));
const uuid = (v: unknown) =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const integerAtLeast = (v: unknown, min: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= min;
const retryValid = (v: unknown, scope?: "event"): boolean =>
  v === null ||
  (object(v) &&
    exactKeys(v, [
      ...(scope ? ["scope"] : []),
      "generation",
      "attempt",
      "outcome",
      "delayMs",
      "nextEligibleAt",
      "reason",
    ]) &&
    (!scope || v.scope === scope) &&
    integerAtLeast(v.generation, 0) &&
    integerAtLeast(v.attempt, 1) &&
    (v.outcome === "success" ||
      v.outcome === "transient" ||
      v.outcome === "permanent" ||
      v.outcome === "unknown") &&
    (v.delayMs === null || integerAtLeast(v.delayMs, 1)) &&
    (v.nextEligibleAt === null || dateTime(v.nextEligibleAt)) &&
    (v.reason === null ||
      v.reason === "permanent" ||
      v.reason === "unknown" ||
      v.reason === "exhausted"));
const dateTime = (value: unknown): boolean => {
  if (typeof value !== "string") return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})t(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:z|([+-])(\d{2}):(\d{2}))$/i.exec(
      value,
    );
  if (!match || match[0] !== value) return false;
  const [
    ,
    year,
    month,
    day,
    hour,
    minute,
    second,
    sign,
    offsetHour,
    offsetMinute,
  ] = match;
  const y = Number(year),
    m = Number(month);
  const leapYear = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [
    0,
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][m];
  const offset =
    (Number(offsetHour ?? 0) * 60 + Number(offsetMinute ?? 0)) *
    (sign === "-" ? -1 : 1);
  const utcMinute =
    (((Number(hour) * 60 + Number(minute) - offset) % 1440) + 1440) % 1440;
  return (
    Number(month) >= 1 &&
    Number(month) <= 12 &&
    Number(day) >= 1 &&
    Number(day) <= days &&
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    (Number(second) <= 59 || (Number(second) === 60 && utcMinute === 1439)) &&
    Number(offsetHour ?? 0) <= 23 &&
    Number(offsetMinute ?? 0) <= 59
  );
};
async function get(path: string, signal: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      signal,
      headers: { Accept: "application/json" },
      credentials: "omit",
    });
  } catch {
    throw new ApiError("unavailable");
  }
  if (response.status === 404) throw new ApiError("not-found");
  if (!response.ok) throw new ApiError("unavailable");
  try {
    return await response.json();
  } catch {
    throw new ApiError("invalid");
  }
}
export async function getProfile(signal: AbortSignal): Promise<Profile> {
  const v = await get("/status", signal);
  if (
    !object(v) ||
    typeof v.profile !== "string" ||
    !Array.isArray(v.limitations) ||
    !v.limitations.every((x: unknown) => typeof x === "string")
  )
    throw new ApiError("invalid");
  return { profile: v.profile, limitations: v.limitations };
}
export async function getEvent(
  id: string,
  signal: AbortSignal,
): Promise<EventDetail> {
  const v = await get(`/events/${encodeURIComponent(id)}`, signal);
  if (
    !object(v) ||
    !exactKeys(v, [
      "id",
      "scope",
      "content",
      "createdAt",
      "publication",
      "status",
      "result",
      "retry",
    ]) ||
    v.id !== id ||
    typeof v.scope !== "string" ||
    !dateTime(v.createdAt) ||
    !object(v.content) ||
    !(
      exactKeys(v.content, ["type", "target", "message"]) ||
      (exactKeys(v.content, ["type", "target", "message", "data"]) &&
        object(v.content.data))
    ) ||
    v.content.type !== "receipt.v1" ||
    v.content.target !== "local-receipt" ||
    typeof v.content.message !== "string" ||
    !(
      v.result === null ||
      (object(v.result) &&
        exactKeys(v.result, ["kind", "eventId", "message"]) &&
        v.result.kind === "local-receipt.v1" &&
        uuid(v.result.eventId) &&
        typeof v.result.message === "string")
    ) ||
    (v.publication !== "pending" && v.publication !== "confirmed") ||
    (v.status !== "accepted" &&
      v.status !== "completed" &&
      v.status !== "retry_scheduled" &&
      v.status !== "retry_released" &&
      v.status !== "blocked") ||
    !retryValid(v.retry)
  )
    throw new ApiError("invalid");
  return v as EventDetail;
}
export const validId = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
export { object, exactKeys, uuid, integerAtLeast, dateTime, retryValid, base };
