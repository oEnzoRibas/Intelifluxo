import { isDeepStrictEqual } from "node:util";

type Stage =
  | "accepted"
  | "initial_confirmed"
  | "retry_scheduled"
  | "retry_released"
  | "retry_confirmed"
  | "completed";

export function assertDemoTransition(
  value: unknown,
  stage: Stage,
  id: string,
): void {
  const scheduled = { generation: 0, attempt: 1, outcome: "transient" };
  const expected = {
    accepted: {
      status: "accepted",
      publication: "pending",
      retry: null,
      result: null,
    },
    initial_confirmed: {
      status: "accepted",
      publication: "confirmed",
      retry: null,
      result: null,
    },
    retry_scheduled: {
      status: "retry_scheduled",
      publication: "confirmed",
      retry: scheduled,
      result: null,
    },
    retry_released: {
      status: "retry_released",
      publication: "pending",
      retry: { ...scheduled, generation: 1 },
      result: null,
    },
    retry_confirmed: {
      status: "retry_released",
      publication: "confirmed",
      retry: { ...scheduled, generation: 1 },
      result: null,
    },
    completed: {
      status: "completed",
      publication: "confirmed",
      retry: { generation: 1, attempt: 2, outcome: "success" },
      result: {
        kind: "local-receipt.v1",
        eventId: id,
        message: "synthetic integrated demo",
      },
    },
  }[stage];
  const body = value as {
    id?: unknown;
    status?: unknown;
    publication?: unknown;
    retry?: {
      generation?: unknown;
      attempt?: unknown;
      outcome?: unknown;
    } | null;
    result?: unknown;
  } | null;
  const retry =
    body?.retry == null
      ? body?.retry
      : {
          generation: body.retry.generation,
          attempt: body.retry.attempt,
          outcome: body.retry.outcome,
        };
  if (
    body?.id !== id ||
    !isDeepStrictEqual(
      {
        status: body?.status,
        publication: body?.publication,
        retry,
        result: body?.result,
      },
      expected,
    )
  ) {
    throw new Error(
      `Unexpected ${stage} transition; stop other relays/schedulers`,
    );
  }
}
