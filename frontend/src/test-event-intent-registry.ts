import { exactKeys, object, uuid } from "./api";
import { freezeEventData, validEventData } from "./event-data";
import {
  TestEventError,
  type Acceptance,
  type TestEventIntent,
} from "./test-event-api";

export type IntentEnvelope = Readonly<{
  version: 1;
  definitionId: string;
  owner: string;
  intent: TestEventIntent;
  context?: Readonly<{
    version: 1;
    definitionRevision: number;
    inputContract:
      | "flat-v1"
      | "viacep-fixed-v1"
      | "viacep-event-data-cep-v1"
      | "event-data-v1";
  }>;
}>;
export type StorageAdapter = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;
export type Persistence =
  | "persisted"
  | "empty"
  | "invalid"
  | "unavailable"
  | "conflict";
export type Settlement = "idle" | "pending" | "fulfilled" | "rejected";
export type Snapshot = Readonly<{
  outcome: Outcome | null;
  envelope: IntentEnvelope | null;
  settlement: Settlement;
  persistence: Persistence;
  conflict: IntentEnvelope | null;
}>;
type Outcome = {
  envelope: IntentEnvelope;
  result:
    | { kind: "accepted"; acceptance: Acceptance }
    | { kind: "validation" | "conflict" };
};
type Entry = {
  outcome: Outcome | null;
  tombstone: IntentEnvelope | null;
  envelope: IntentEnvelope | null;
  settlement: Settlement;
  persistence: Persistence;
  conflict: IntentEnvelope | null;
  promise: Promise<unknown> | null;
  subscribers: Set<(state: Snapshot) => void>;
};
const entries = new Map<string, Entry>();
const slotPrefix = "intelifluxo:test-event-intent:v2:";
/** Versioned, unambiguous identity; legacy definition-only keys are never migrated. */
export function intentSlot(definitionId: string, scope: string): string {
  return slotPrefix + JSON.stringify([definitionId, scope]);
}
function matchesSlot(slot: string, envelope: IntentEnvelope): boolean {
  // Opaque legacy slots remain usable only by their original callers.
  return (
    !slot.startsWith(slotPrefix) ||
    slot === intentSlot(envelope.definitionId, envelope.intent.scope)
  );
}
function entry(slot: string): Entry {
  let value = entries.get(slot);
  if (!value) {
    value = {
      outcome: null,
      tombstone: null,
      envelope: null,
      settlement: "idle",
      persistence: "empty",
      conflict: null,
      promise: null,
      subscribers: new Set(),
    };
    entries.set(slot, value);
  }
  return value;
}
function snapshot(e: Entry): Snapshot {
  return Object.freeze({
    outcome: e.outcome,
    envelope: e.envelope,
    settlement: e.settlement,
    persistence: e.persistence,
    conflict: e.conflict,
  });
}
function evict(slot: string, e: Entry) {
  if (
    entries.get(slot) === e &&
    !e.envelope &&
    !e.promise &&
    !e.tombstone &&
    !e.outcome &&
    !e.subscribers.size
  )
    entries.delete(slot);
}
export function intentRegistrySlotCountForTests() {
  return entries.size;
}
function notify(e: Entry) {
  const state = snapshot(e);
  for (const subscriber of [...e.subscribers]) {
    try {
      subscriber(state);
    } catch {
      /* A subscriber cannot affect ownership. */
    }
  }
}
function freeze(value: IntentEnvelope): IntentEnvelope {
  return Object.freeze({
    ...value,
    ...(value.context ? { context: Object.freeze({ ...value.context }) } : {}),
    intent: Object.freeze({
      ...value.intent,
      ...(value.intent.data
        ? { data: freezeEventData(value.intent.data) }
        : {}),
    }),
  });
}
export function sameIntentEnvelope(
  a: IntentEnvelope,
  b: IntentEnvelope,
): boolean {
  return (
    a.version === b.version &&
    a.definitionId === b.definitionId &&
    a.owner === b.owner &&
    a.context?.version === b.context?.version &&
    a.context?.definitionRevision === b.context?.definitionRevision &&
    a.context?.inputContract === b.context?.inputContract &&
    a.intent.scope === b.intent.scope &&
    a.intent.idempotencyKey === b.intent.idempotencyKey &&
    a.intent.type === b.intent.type &&
    a.intent.target === b.intent.target &&
    a.intent.message === b.intent.message &&
    JSON.stringify(a.intent.data) === JSON.stringify(b.intent.data)
  );
}
function parseValue(value: unknown): IntentEnvelope | null {
  try {
    if (
      !object(value) ||
      !(
        exactKeys(value, ["version", "definitionId", "owner", "intent"]) ||
        exactKeys(value, [
          "version",
          "definitionId",
          "owner",
          "intent",
          "context",
        ])
      ) ||
      value.version !== 1 ||
      typeof value.definitionId !== "string" ||
      !uuid(value.owner)
    )
      return null;
    if ("context" in value) {
      const c = value.context;
      if (
        !object(c) ||
        !exactKeys(c, ["version", "definitionRevision", "inputContract"]) ||
        c.version !== 1 ||
        !Number.isSafeInteger(c.definitionRevision) ||
        (c.definitionRevision as number) < 1 ||
        ![
          "flat-v1",
          "viacep-fixed-v1",
          "viacep-event-data-cep-v1",
          "event-data-v1",
        ].includes(c.inputContract as string)
      )
        return null;
      if (
        c.inputContract !== "event-data-v1" &&
        (c.inputContract === "viacep-event-data-cep-v1") !==
          (object(value.intent) && "data" in value.intent)
      )
        return null;
    }
    const i = value.intent;
    if (
      !object(i) ||
      !(
        exactKeys(i, [
          "scope",
          "idempotencyKey",
          "type",
          "target",
          "message",
        ]) ||
        exactKeys(i, [
          "scope",
          "idempotencyKey",
          "type",
          "target",
          "message",
          "data",
        ])
      ) ||
      ("data" in i &&
        (!validEventData(i.data) ||
          (!(
            object(value.context) &&
            value.context.inputContract === "event-data-v1"
          ) &&
            (!object(i.data) ||
              !exactKeys(i.data, ["cep"]) ||
              typeof i.data.cep !== "string" ||
              !/^[0-9]{8}$(?![\s\S])/.test(i.data.cep))))) ||
      typeof i.scope !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$(?![\s\S])/.test(i.scope) ||
      !uuid(i.idempotencyKey) ||
      i.type !== "receipt.v1" ||
      i.target !== "local-receipt" ||
      typeof i.message !== "string" ||
      [...i.message].length < 1 ||
      [...i.message].length > 1024 ||
      i.message.includes("\0") ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
        i.message,
      )
    )
      return null;
    return freeze(value as IntentEnvelope);
  } catch {
    return null;
  }
}
function parse(raw: string): IntentEnvelope | null {
  try {
    return parseValue(JSON.parse(raw));
  } catch {
    return null;
  }
}
/** Pass a getter so even access to window.sessionStorage may fail safely. Slot is the storage key. */
export type StorageSource = () => StorageAdapter;
function read(
  slot: string,
  storage: StorageSource,
  broadcast: boolean,
): Snapshot {
  const e = entry(slot);
  e.conflict = null;
  try {
    let raw = storage().getItem(slot);
    let saved = raw === null ? null : parse(raw);
    if (e.tombstone) {
      if (saved && sameIntentEnvelope(saved, e.tombstone)) {
        storage().removeItem(slot);
        raw = storage().getItem(slot);
        if (raw !== null) throw new Error("Storage removal failed");
        saved = null;
      } else if (raw !== null) {
        e.persistence = saved ? "conflict" : "invalid";
        e.conflict = saved;
        if (broadcast) notify(e);
        const state = snapshot(e);
        evict(slot, e);
        return state;
      }
      e.tombstone = null;
    }
    if (raw !== null && !saved) e.persistence = "invalid";
    else if (!saved) e.persistence = "empty";
    else if (
      !matchesSlot(slot, saved) ||
      !!e.outcome ||
      (e.envelope && !sameIntentEnvelope(e.envelope, saved))
    ) {
      e.persistence = "conflict";
      e.conflict = saved;
    } else {
      if (!e.envelope) {
        e.envelope = saved;
        e.settlement = "idle";
      }
      e.persistence = "persisted";
    }
  } catch {
    e.persistence = "unavailable";
  }
  if (broadcast) notify(e);
  const state = snapshot(e);
  evict(slot, e);
  return state;
}
export function readIntent(slot: string, storage: StorageSource): Snapshot {
  return read(slot, storage, true);
}
/** Never calls factory when a valid unresolved intent already exists. */
export function acquireIntent(
  slot: string,
  storage: StorageSource,
  factory: () => IntentEnvelope,
): Snapshot {
  const current = readIntent(slot, storage);
  if (
    current.envelope ||
    current.outcome ||
    entries.get(slot)?.tombstone ||
    current.persistence === "conflict" ||
    current.persistence === "invalid"
  )
    return current;
  const e = entry(slot);
  let proposed: IntentEnvelope;
  try {
    const parsed = parseValue(factory());
    if (!parsed || !matchesSlot(slot, parsed))
      throw new Error("Invalid intent envelope");
    proposed = parsed;
  } catch (error) {
    evict(slot, e);
    throw error;
  }
  e.outcome = null;
  e.envelope = proposed;
  e.settlement = "idle";
  try {
    storage().setItem(slot, JSON.stringify(proposed));
    // Verify rather than claiming persistence after a silently ignored write.
    return readIntent(slot, storage);
  } catch {
    e.persistence = "unavailable";
    notify(e);
    return snapshot(e);
  }
}
/** The promise is shared until the actual request settles, independent of subscribers. */
export function startPost<T>(
  slot: string,
  envelope: IntentEnvelope,
  factory: () => Promise<T>,
  storage?: StorageSource,
): Promise<T> {
  const e = entry(slot);
  if (!e.envelope || !sameIntentEnvelope(e.envelope, envelope))
    throw new Error("Intent does not own slot");
  if (e.promise) return e.promise as Promise<T>;
  e.settlement = "pending";
  const promise = Promise.resolve()
    .then(factory)
    .then(
      (result) => {
        if (e.promise === promise) {
          e.promise = null;
          e.settlement = "fulfilled";
          if (storage) {
            e.outcome = {
              envelope,
              result: { kind: "accepted", acceptance: result as Acceptance },
            };
            resolveIntent(slot, storage, envelope);
          } else notify(e);
        }
        return result;
      },
      (error: unknown) => {
        if (e.promise === promise) {
          e.promise = null;
          e.settlement = "rejected";
          if (
            storage &&
            error instanceof TestEventError &&
            error.kind !== "uncertain"
          ) {
            e.outcome = { envelope, result: { kind: error.kind } };
            resolveIntent(slot, storage, envelope);
          } else notify(e);
        }
        throw error;
      },
    );
  e.promise = promise;
  notify(e);
  return promise;
}
/** Call only for a definitive outcome, after the POST has settled. */
export function resolveIntent(
  slot: string,
  storage: StorageSource,
  envelope: IntentEnvelope,
): { removed: boolean; persistence: Persistence } {
  const e = entry(slot);
  if (!e.envelope || !sameIntentEnvelope(e.envelope, envelope) || e.promise)
    return { removed: false, persistence: e.persistence };
  let persistence: Persistence = "empty";
  try {
    const adapter = storage();
    const raw = adapter.getItem(slot);
    const saved = raw === null ? null : parse(raw);
    if (saved && sameIntentEnvelope(saved, envelope)) {
      adapter.removeItem(slot);
      if (adapter.getItem(slot) !== null)
        throw new Error("Storage removal failed");
    } else if (raw !== null) {
      persistence = saved ? "conflict" : "invalid";
      e.conflict = saved;
    }
  } catch {
    persistence = "unavailable";
    e.tombstone = envelope;
  }
  e.envelope = null;
  e.settlement = "idle";
  e.persistence = persistence;
  // A conflicting record remains in storage and must not be adopted here.
  if (persistence !== "conflict") e.conflict = null;
  notify(e);
  evict(slot, e);
  return { removed: true, persistence };
}
export function subscribeIntent(
  slot: string,
  subscriber: (state: Snapshot) => void,
  storage?: StorageSource,
): () => void {
  const e = entry(slot);
  e.subscribers.add(subscriber);
  if (storage) readIntent(slot, storage);
  return () => {
    e.subscribers.delete(subscriber);
    evict(slot, e);
  };
}
/** Acknowledge the displayed outcome. Failed removal stays tombstoned until a later
 * read, subscribe, acquire or consume retries it. Without another lifecycle call,
 * the tombstone remains in memory indefinitely (fail closed). */
export function consumeIntent(
  slot: string,
  storage: StorageSource,
  envelope: IntentEnvelope,
): void {
  const e = entries.get(slot);
  if (!e?.outcome || !sameIntentEnvelope(e.outcome.envelope, envelope)) return;
  e.outcome = null;
  // Consumption is private to the caller; already-delivered outcomes remain local.
  read(slot, storage, false);
  evict(slot, e);
}
/** Test isolation only; never call in application code while requests may be running. */
export function resetIntentRegistryForTests(): void {
  entries.clear();
}
