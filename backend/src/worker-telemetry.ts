export type HttpClass =
  "none" | "1xx" | "2xx" | "3xx" | "4xx" | "5xx" | "other";
export type LookupCode =
  | "none"
  | "invalid_cep"
  | "viacep_not_found"
  | "viacep_timeout"
  | "viacep_transport"
  | "viacep_http_transient"
  | "viacep_http_permanent"
  | "viacep_invalid_response"
  | "viacep_security_rejected"
  | "viacep_unknown";
export type Classification =
  "none" | "transient" | "permanent" | "unknown" | "exhausted";
export type TelemetryRecord = {
  event:
    | "lookup_attempted"
    | "lookup_finished"
    | "lookup_reused"
    | "lookup_rejected"
    | "retry_scheduled"
    | "retry_exhausted"
    | "event_blocked"
    | "execution_invariant"
    | "unsupported_execution_contract"
    | "transaction_finished";
  provider: "viacep";
  eventId?: string;
  executionId?: string;
  generation?: number;
  attempt?: number;
  outcome?: "found" | "not_found" | "failed" | "committed" | "not_confirmed";
  classification?: Classification;
  code?:
    | LookupCode
    | "retry_scheduled"
    | "retry_exhausted"
    | "event_blocked"
    | "execution_invariant"
    | "unsupported_execution_contract"
    | "transaction_not_confirmed";
  httpClass?: HttpClass;
  bodyBytes?: number;
  durationMs?: number;
  lockWaitMs?: number;
  lockHeldMs?: number;
  delayMs?: number;
};
export type TelemetrySink = (record: TelemetryRecord) => void;
export const consoleTelemetry: TelemetrySink = (record) =>
  console.log(JSON.stringify(record));
export function emit(sink: TelemetrySink, record: TelemetryRecord): void {
  try {
    sink(record);
  } catch {
    /* Telemetry must not affect processing. */
  }
}
export function lookupCode(code: unknown): LookupCode {
  switch (code) {
    case "invalid_cep":
    case "viacep_not_found":
    case "viacep_timeout":
    case "viacep_transport":
    case "viacep_http_transient":
    case "viacep_http_permanent":
    case "viacep_invalid_response":
    case "viacep_security_rejected":
    case "viacep_unknown":
      return code;
    default:
      return "none";
  }
}
export function classification(value: unknown): Classification {
  switch (value) {
    case "transient":
    case "permanent":
    case "unknown":
    case "exhausted":
      return value;
    default:
      return "none";
  }
}
