import { describe, expect, it, vi } from "vitest";
import { content, type Input } from "../src/contract.js";
import { api } from "../src/api.js";
import type pg from "pg";
import { readFile } from "node:fs/promises";
import { requestSchema } from "../src/contract.js";
import { startWorker } from "../src/worker.js";
import type { Channel, ConsumeMessage } from "amqplib";
import { cleanup, withCleanup } from "./cleanup.js";

const input: Input = {
  scope: "scope",
  idempotencyKey: "key",
  type: "receipt.v1",
  target: "local-receipt",
  message: "hello",
};
describe("contract", () => {
  it("keeps the published request schema aligned with runtime validation", async () => {
    const schema = JSON.parse(
      await readFile(
        new URL("../schemas/event-request-v1.schema.json", import.meta.url),
        "utf8",
      ),
    );
    delete schema.$schema;
    delete schema.$id;
    expect(schema).toEqual(requestSchema);
  });
  it("compares only business content", () => {
    expect(content(input)).toEqual(
      content({ ...input, scope: "another", idempotencyKey: "other" }),
    );
    expect(content(input)).not.toEqual(
      content({ ...input, message: "changed" }),
    );
  });
  it("rejects unknown and invalid fields without calling storage", async () => {
    const app = api({} as pg.Pool);
    for (const body of [
      { ...input, extra: true },
      { ...input, type: "unknown" },
      { ...input, message: "x".repeat(1025) },
      { ...input, scope: 1 },
      { ...input, message: "\u0000" },
      { ...input, message: "\ud800" },
      { ...input, message: "\udc00" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/events",
        payload: body,
      });
      expect(response.statusCode).toBe(400);
    }
    await app.close();
  });
  it.each(["\n", "\r", "\r\n", "\u2028", "\u2029"])(
    "rejects trailing identifier terminator %j at the API boundary",
    async (terminator) => {
      const app = api({} as pg.Pool);
      try {
        for (const field of ["scope", "idempotencyKey"] as const) {
          const response = await app.inject({
            method: "POST",
            url: "/events",
            payload: { ...input, [field]: input[field] + terminator },
          });
          expect(response.statusCode).toBe(400);
        }
      } finally {
        await app.close();
      }
    },
  );
});

it("attempts all cleanup steps and reports every failure", async () => {
  const calls: string[] = [];
  const steps: Array<[string, () => Promise<void>]> = [
    "queue",
    "channel",
    "connection",
    "pool",
    "schema",
    "admin",
  ].map((name) => [
    name,
    async () => {
      calls.push(name);
      if (name === "queue" || name === "connection") throw new Error(name);
    },
  ]);
  const error = await cleanup(steps).catch((cause: unknown) => cause);
  expect(calls).toEqual([
    "queue",
    "channel",
    "connection",
    "pool",
    "schema",
    "admin",
  ]);
  expect(error).toBeInstanceOf(AggregateError);
  expect(
    (error as AggregateError).errors.map((item: Error) => item.message),
  ).toEqual(["Cleanup failed: queue", "Cleanup failed: connection"]);
});

it("closes the worker channel when the broker cancels its consumer", async () => {
  let callback!: (message: ConsumeMessage | null) => void;
  const close = vi.fn().mockResolvedValue(undefined);
  const channel = {
    assertQueue: vi.fn().mockResolvedValue(undefined),
    prefetch: vi.fn().mockResolvedValue(undefined),
    consume: vi.fn().mockImplementation((_queue, fn) => {
      callback = fn;
      return Promise.resolve({ consumerTag: "test" });
    }),
    close,
  } as unknown as Channel;
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await startWorker({} as pg.Pool, channel);
    callback(null);
    expect(close).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledOnce();
  } finally {
    log.mockRestore();
  }
});

it.each(["\n", "\r", "\r\n", "\u2028", "\u2029"])(
  "rejects encoded event ID trailing terminator %j without storage",
  async (terminator) => {
    const query = vi.fn();
    const app = api({ query } as unknown as pg.Pool);
    try {
      const id = "01234567-89ab-cdef-0123-456789abcdef";
      const response = await app.inject({
        method: "GET",
        url: `/events/${id}${encodeURIComponent(terminator)}`,
      });
      expect(response.statusCode).toBe(400);
      expect(query).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  },
);

it("preserves the primary failure and aggregates cleanup failures", async () => {
  const primary = new Error("primary");
  const calls: string[] = [];
  const error = await withCleanup(
    async () => {
      throw primary;
    },
    () => [
      [
        "queue",
        async () => {
          calls.push("queue");
          throw new Error("queue failure");
        },
      ],
      [
        "connection",
        async () => {
          calls.push("connection");
          throw new Error("connection failure");
        },
      ],
      [
        "schema",
        async () => {
          calls.push("schema");
        },
      ],
    ],
  ).catch((cause: unknown) => cause);
  expect(calls).toEqual(["queue", "connection", "schema"]);
  expect(error).toBeInstanceOf(AggregateError);
  if (!(error instanceof AggregateError)) throw new Error("expected aggregate");
  expect(error.cause).toBe(error.errors[1]);
  expect(error.errors[0]).toBe(primary);
  expect(error.errors[1].errors).toHaveLength(2);
});
