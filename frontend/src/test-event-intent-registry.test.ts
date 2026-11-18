import { beforeEach, expect, it, vi } from "vitest";
import {
  acquireIntent,
  consumeIntent,
  intentSlot,
  readIntent,
  resetIntentRegistryForTests,
  resolveIntent,
  startPost,
  subscribeIntent,
  type IntentEnvelope,
  type StorageAdapter,
} from "./test-event-intent-registry";
const env = (
  owner = "11111111-1111-4111-8111-111111111111",
): IntentEnvelope => ({
  version: 1,
  definitionId: "definition",
  owner,
  intent: {
    scope: "scope",
    idempotencyKey: "22222222-2222-4222-8222-222222222222",
    type: "receipt.v1",
    target: "local-receipt",
    message: "hello",
  },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function storage() {
  const data = new Map<string, string>();
  const adapter: StorageAdapter = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
  return { data, source: () => adapter };
}
beforeEach(resetIntentRegistryForTests);
it("strictly validates versioned input context without discarding bad storage", () => {
  const s = storage();
  const context = {
    version: 1,
    definitionRevision: 1,
    inputContract: "viacep-event-data-cep-v1",
  };
  const saved = {
    ...env(),
    context,
    intent: { ...env().intent, data: { cep: "00000000" } },
  };
  s.data.set("slot", JSON.stringify(saved));
  expect(readIntent("slot", s.source).envelope).toEqual(saved);
  expect(Object.isFrozen(readIntent("slot", s.source).envelope?.context)).toBe(
    true,
  );
  for (const invalid of [
    { ...context, definitionRevision: 0 },
    { ...context, version: 2 },
    { ...context, inputContract: "unknown" },
    { ...context, extra: true },
    { ...context, inputContract: "viacep-fixed-v1" },
  ]) {
    resetIntentRegistryForTests();
    const raw = JSON.stringify({ ...saved, context: invalid });
    s.data.set("slot", raw);
    expect(readIntent("slot", s.source).persistence).toBe("invalid");
    expect(s.data.get("slot")).toBe(raw);
  }
});
it("joins POST across callers and unsubscribe/remount until actual settlement", async () => {
  const s = storage(),
    value = acquireIntent("slot", s.source, env).envelope!,
    d = deferred<string>(),
    factory = vi.fn(() => d.promise),
    listener = vi.fn();
  const unsubscribe = subscribeIntent("slot", listener),
    first = startPost("slot", value, factory);
  unsubscribe();
  const remounted = vi.fn();
  subscribeIntent("slot", remounted);
  const second = startPost("slot", value, factory);
  expect(first).toBe(second);
  await Promise.resolve();
  expect(factory).toHaveBeenCalledTimes(1);
  expect(resolveIntent("slot", s.source, value).removed).toBe(false);
  d.resolve("ok");
  await expect(second).resolves.toBe("ok");
  expect(listener).toHaveBeenCalledTimes(1);
  expect(remounted).toHaveBeenLastCalledWith(
    expect.objectContaining({ settlement: "fulfilled" }),
  );
});
it("never releases a never-settling POST", async () => {
  const s = storage(),
    value = acquireIntent("slot", s.source, env).envelope!,
    factory = vi.fn(() => new Promise<never>(() => {}));
  const first = startPost("slot", value, factory);
  await Promise.resolve();
  expect(startPost("slot", value, factory)).toBe(first);
  expect(factory).toHaveBeenCalledTimes(1);
  expect(readIntent("slot", s.source).settlement).toBe("pending");
});
it("preserves memory when storage recovers empty and after external removal", () => {
  const s = storage();
  let available = false;
  const source = () => {
    if (!available) throw Error("denied");
    return s.source();
  };
  const factory = vi.fn(env);
  expect(acquireIntent("slot", source, factory).persistence).toBe(
    "unavailable",
  );
  available = true;
  expect(readIntent("slot", source)).toMatchObject({
    envelope: env(),
    persistence: "empty",
  });
  expect(acquireIntent("slot", source, factory).envelope).toEqual(env());
  s.data.set("slot", JSON.stringify(env()));
  readIntent("slot", source);
  s.data.delete("slot");
  expect(readIntent("slot", source).envelope).toEqual(env());
  expect(factory).toHaveBeenCalledTimes(1);
});
it("hydrates and reports conflicts while compare-removing only matching values", () => {
  const s = storage();
  s.data.set("slot", JSON.stringify(env()));
  const factory = vi.fn(env);
  expect(acquireIntent("slot", s.source, factory)).toMatchObject({
    envelope: env(),
    persistence: "persisted",
  });
  expect(factory).not.toHaveBeenCalled();
  const other = env("33333333-3333-4333-8333-333333333333");
  s.data.set("slot", JSON.stringify(other));
  expect(readIntent("slot", s.source)).toMatchObject({
    envelope: env(),
    conflict: other,
    persistence: "conflict",
  });
  expect(resolveIntent("slot", s.source, other).removed).toBe(false);
  expect(resolveIntent("slot", s.source, env())).toEqual({
    removed: true,
    persistence: "conflict",
  });
  expect(JSON.parse(s.data.get("slot")!)).toEqual(other);
});
it("retains rejection for retry with same intent and clears on definitive resolution", async () => {
  const s = storage(),
    value = acquireIntent("slot", s.source, env).envelope!,
    d = deferred<string>();
  const first = startPost("slot", value, () => d.promise);
  d.reject(Error("uncertain"));
  await expect(first).rejects.toThrow("uncertain");
  expect(readIntent("slot", s.source)).toMatchObject({
    envelope: value,
    settlement: "rejected",
  });
  const retry = vi.fn(async () => "accepted");
  await expect(startPost("slot", value, retry)).resolves.toBe("accepted");
  expect(retry).toHaveBeenCalledTimes(1);
  expect(resolveIntent("slot", s.source, value)).toEqual({
    removed: true,
    persistence: "empty",
  });
  expect(s.data.has("slot")).toBe(false);
  expect(readIntent("slot", s.source).envelope).toBeNull();
});
it("reports remove failures and isolates subscribers", () => {
  const s = storage();
  subscribeIntent("slot", () => {
    throw Error("subscriber");
  });
  const value = acquireIntent("slot", s.source, env).envelope!;
  const badRemove = () => ({
    ...s.source(),
    removeItem: () => {
      throw Error("denied");
    },
  });
  expect(resolveIntent("slot", badRemove, value)).toEqual({
    removed: true,
    persistence: "unavailable",
  });
  expect(s.data.has("slot")).toBe(true);
});
import { intentRegistrySlotCountForTests } from "./test-event-intent-registry";

it("evicts resolved slots but retains a never-settling owner", async () => {
  const s = storage();
  const stop = subscribeIntent("done", () => {});
  const value = acquireIntent("done", s.source, env).envelope!;
  await startPost(
    "done",
    value,
    async () => ({ id: "id", replay: false }),
    s.source,
  );
  expect(intentRegistrySlotCountForTests()).toBe(1);
  stop();
  expect(intentRegistrySlotCountForTests()).toBe(1);
  consumeIntent("done", s.source, value);
  expect(intentRegistrySlotCountForTests()).toBe(0);
  const pending = acquireIntent("pending", s.source, env).envelope!;
  void startPost(
    "pending",
    pending,
    () => new Promise<never>(() => {}),
    s.source,
  );
  expect(intentRegistrySlotCountForTests()).toBe(1);
});

it("tombstones failed removal until storage recovers and isolates slots", async () => {
  const s = storage();
  let fail = true;
  const source = () => ({
    ...s.source(),
    removeItem: (key: string) => {
      if (fail) throw Error("denied");
      s.source().removeItem(key);
    },
  });
  const value = acquireIntent("a", source, env).envelope!;
  acquireIntent("b", source, env);
  await startPost(
    "a",
    value,
    async () => ({ id: "id", replay: false }),
    source,
  );
  const create = vi.fn(env);
  expect(acquireIntent("a", source, create)).toMatchObject({
    envelope: null,
    persistence: "unavailable",
  });
  expect(create).not.toHaveBeenCalled();
  expect(readIntent("b", source).envelope).toEqual(value);
  fail = false;
  expect(readIntent("a", source)).toMatchObject({
    envelope: null,
    persistence: "empty",
  });
  expect(s.data.has("a")).toBe(false);
  expect(acquireIntent("a", source, create).envelope).toBeNull();
  consumeIntent("a", source, value);
  expect(acquireIntent("a", source, create).envelope).toEqual(value);
});

it("separates scoped slots and rejects mismatched saved envelopes", () => {
  const s = storage();
  const a = intentSlot("definition", "scope"),
    b = intentSlot("definition", "other");
  const other = { ...env(), intent: { ...env().intent, scope: "other" } };
  expect(a).not.toBe(b);
  s.data.set(b, JSON.stringify(env()));
  expect(readIntent(b, s.source)).toMatchObject({
    envelope: null,
    conflict: env(),
    persistence: "conflict",
  });
  s.data.delete(b);
  expect(acquireIntent(a, s.source, env).envelope).toEqual(env());
  expect(acquireIntent(b, s.source, () => other).envelope).toEqual(other);
});

it("retains outcome without subscribers and retries failed tombstone cleanup until consumed", async () => {
  const s = storage();
  let fail = true;
  const source = () => ({
    ...s.source(),
    removeItem: (key: string) => {
      if (fail) throw Error("denied");
      s.source().removeItem(key);
    },
  });
  const slot = intentSlot("definition", "scope");
  const value = acquireIntent(slot, source, env).envelope!;
  const stop = subscribeIntent(slot, () => {}, source);
  const d = deferred<{ id: string; replay: boolean }>();
  const pending = startPost(slot, value, () => d.promise, source);
  stop();
  d.resolve({ id: "id", replay: false });
  await pending;
  expect(intentRegistrySlotCountForTests()).toBe(1);
  const listener = vi.fn();
  const off = subscribeIntent(slot, listener, source);
  expect(listener).toHaveBeenLastCalledWith(
    expect.objectContaining({
      outcome: expect.objectContaining({ envelope: value }),
      envelope: null,
    }),
  );
  const factory = vi.fn(env);
  expect(acquireIntent(slot, source, factory).envelope).toBeNull();
  consumeIntent(slot, source, value);
  off();
  expect(intentRegistrySlotCountForTests()).toBe(1);
  fail = false;
  expect(readIntent(slot, source).envelope).toBeNull();
  expect(intentRegistrySlotCountForTests()).toBe(0);
  expect(factory).not.toHaveBeenCalled();
});

it("does not broadcast consumption or clear a different outcome", async () => {
  const s = storage();
  const value = acquireIntent("slot", s.source, env).envelope!;
  const listener = vi.fn();
  subscribeIntent("slot", listener);
  await startPost(
    "slot",
    value,
    async () => ({ id: "id", replay: false }),
    s.source,
  );
  listener.mockClear();
  consumeIntent("slot", s.source, env("33333333-3333-4333-8333-333333333333"));
  expect(readIntent("slot", s.source).outcome?.envelope).toEqual(value);
  listener.mockClear();
  consumeIntent("slot", s.source, value);
  expect(listener).not.toHaveBeenCalled();
  expect(readIntent("slot", s.source).outcome).toBeNull();
});

it("evicts empty slots for invalid and conflicting reads and acquisitions", () => {
  const s = storage();
  const count = intentRegistrySlotCountForTests();
  for (let i = 0; i < 100; i++) {
    const invalid = `invalid-${i}`;
    s.data.set(invalid, "not json");
    expect(acquireIntent(invalid, s.source, env).persistence).toBe("invalid");
    const conflict = intentSlot(`definition-${i}`, "other");
    s.data.set(conflict, JSON.stringify(env()));
    expect(acquireIntent(conflict, s.source, env).persistence).toBe("conflict");
    expect(() =>
      acquireIntent(`bad-${i}`, s.source, () => ({ ...env(), owner: "bad" })),
    ).toThrow();
    expect(() =>
      acquireIntent(`throws-${i}`, s.source, () => {
        throw Error("factory");
      }),
    ).toThrow();
  }
  // Conflicting saved data is reported, not owned in memory.
  expect(intentRegistrySlotCountForTests()).toBe(count);
});

it("rejects malformed stored CEP data without adopting or replacing it", () => {
  const s = storage();
  const factory = vi.fn(env);
  for (const data of [
    null,
    [],
    "01001000",
    {},
    { cep: 1001000 },
    { cep: null },
    { cep: "" },
    { cep: "01001-000" },
    { cep: "01001000\n" },
    { cep: "01001000", extra: true },
  ]) {
    for (const inputContract of ["viacep-event-data-cep-v1"]) {
      resetIntentRegistryForTests();
      const raw = JSON.stringify({
        ...env(),
        context: { version: 1, definitionRevision: 1, inputContract },
        intent: { ...env().intent, data },
      });
      s.data.set("slot", raw);
      expect(acquireIntent("slot", s.source, factory)).toMatchObject({
        persistence: "invalid",
        envelope: null,
      });
      expect(s.data.get("slot")).toBe(raw);
      expect(factory).not.toHaveBeenCalled();
    }
  }
});

it("round-trips the exact normalized CEP envelope and omits fixed data", () => {
  const s = storage();
  const value: IntentEnvelope = {
    ...env(),
    context: {
      version: 1,
      definitionRevision: 2,
      inputContract: "viacep-event-data-cep-v1",
    },
    intent: { ...env().intent, data: { cep: "01001000" } },
  };
  expect(acquireIntent("slot", s.source, () => value).envelope).toEqual(value);
  resetIntentRegistryForTests();
  expect(readIntent("slot", s.source).envelope).toEqual(value);
  expect(JSON.parse(s.data.get("slot")!).intent.data).toEqual({
    cep: "01001000",
  });
  const fixed: IntentEnvelope = {
    ...env(),
    context: {
      version: 1,
      definitionRevision: 2,
      inputContract: "viacep-fixed-v1",
    },
  };
  expect(acquireIntent("fixed", s.source, () => fixed).envelope).toEqual(fixed);
  expect(JSON.parse(s.data.get("fixed")!).intent).not.toHaveProperty("data");
});
