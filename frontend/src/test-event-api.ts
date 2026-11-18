import { base, exactKeys, object, uuid } from "./api";
import { cepValid } from "./viacep-graph";
import { freezeEventData, validEventData, type EventData } from "./event-data";

/** Keep this whole value unchanged if the acceptance outcome is uncertain. */
export type TestEventIntent = Readonly<{
  scope: string;
  idempotencyKey: string;
  type: "receipt.v1";
  target: "local-receipt";
  message: string;
  data?: EventData;
}>;

export type Acceptance = { id: string; replay: boolean };
export class TestEventError extends Error {
  constructor(public kind: "conflict" | "validation" | "uncertain") {
    super(kind);
  }
}

export function newTestEventIntent(
  scope: string,
  message: string,
  cep?: string,
  eventData?: EventData,
): TestEventIntent {
  if (cep !== undefined && !cepValid(cep)) throw new Error("Invalid CEP");
  const data =
    cep === undefined ? eventData : { ...eventData, cep: cep.replace("-", "") };
  if (data !== undefined && !validEventData(data))
    throw new Error("Invalid event data");
  return Object.freeze({
    scope,
    idempotencyKey: crypto.randomUUID(),
    type: "receipt.v1" as const,
    target: "local-receipt" as const,
    message,
    ...(data === undefined ? {} : { data: freezeEventData(data) }),
  });
}

export async function sendTestEvent(
  intent: TestEventIntent,
  signal: AbortSignal,
): Promise<Acceptance> {
  let response: Response;
  try {
    response = await fetch(`${base}/events`, {
      method: "POST",
      credentials: "omit",
      signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(intent),
    });
  } catch {
    throw new TestEventError("uncertain");
  }
  if (response.status === 409) throw new TestEventError("conflict");
  if (response.status === 400) throw new TestEventError("validation");
  if (response.status !== 200 && response.status !== 202)
    throw new TestEventError("uncertain");
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new TestEventError("uncertain");
  }
  if (
    !object(value) ||
    !exactKeys(value, ["id", "replay"]) ||
    !uuid(value.id) ||
    value.replay !== (response.status === 200)
  )
    throw new TestEventError("uncertain");
  return value as Acceptance;
}
