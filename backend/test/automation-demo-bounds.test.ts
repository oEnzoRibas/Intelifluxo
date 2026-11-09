import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Channel, ChannelModel } from "amqplib";
import { cleanup, withCleanup } from "../src/cleanup.js";
import {
  assertIsolatedQueue,
  demoCleanupSteps,
  deadline,
  deleteAttemptedQueue,
  isolatedQueue,
  queueDeclaration,
  watchedChannel,
} from "./automation-demo-bounds.js";

function cleanupFixture(
  overrides: Partial<
    Record<
      | "api"
      | "consumer"
      | "queue"
      | "confirm"
      | "broker"
      | "pool"
      | "schema"
      | "admin",
      () => Promise<unknown>
    >
  > = {},
  abort = vi.fn(),
) {
  const order: string[] = [];
  const step = (name: keyof typeof overrides) => async () => {
    order.push(name);
    await overrides[name]?.();
  };
  return {
    order,
    steps: demoCleanupSteps(
      {
        api: step("api"),
        consumer: step("consumer"),
        queue: step("queue"),
        confirm: step("confirm"),
        broker: step("broker"),
        pool: step("pool"),
        schema: step("schema"),
        admin: step("admin"),
      },
      abort,
    ),
  };
}

const expectedOrder = [
  "api",
  "consumer",
  "queue",
  "confirm",
  "broker",
  "pool",
  "schema",
  "admin",
];

describe("disposable AMQP safety", () => {
  it("uses unique project-prefixed queue names, never reserved names", () => {
    const first = isolatedQueue();
    expect(first).not.toBe(isolatedQueue());
    expect(() => assertIsolatedQueue(first)).not.toThrow();
    expect(() => assertIsolatedQueue("amq.gen-example")).toThrow();
    expect(() =>
      assertIsolatedQueue("intelifluxo.automation.not-a-uuid"),
    ).toThrow();
  });
  it("times out a stalled operation and invokes the abort hook", async () => {
    const abort = vi.fn();
    await expect(
      deadline("stalled", () => new Promise(() => {}), 10, abort),
    ).rejects.toThrow("stalled timed out");
    expect(abort).toHaveBeenCalledOnce();
  });
  it("continues to schema cleanup after a stalled broker cleanup", async () => {
    vi.useFakeTimers();
    try {
      const abort = vi.fn();
      const schema = vi.fn(async () => {});
      const fixture = cleanupFixture(
        { broker: () => new Promise(() => {}), schema },
        abort,
      );
      const result = cleanup(fixture.steps);
      const assertion = expect(result).rejects.toThrow("Cleanup failed");
      await vi.advanceTimersByTimeAsync(2000);
      await assertion;
      expect(abort).toHaveBeenCalledOnce();
      expect(schema).toHaveBeenCalledOnce();
      expect(fixture.order).toEqual(expectedOrder);
    } finally {
      vi.useRealTimers();
    }
  });
  it("deletes a server-created queue after declaration response times out and destroys the original connection", async () => {
    vi.useFakeTimers();
    try {
      const queue = isolatedQueue();
      const server = new Set<string>();
      const originalDestroyed = vi.fn();
      const cleanupDestroyed = vi.fn();
      const deleteQueue = vi.fn(async (name: string) => {
        server.delete(name);
      });
      const fresh = {
        connection: { stream: { destroy: cleanupDestroyed } },
        createChannel: async () =>
          Object.assign(new EventEmitter(), { deleteQueue }),
        close: async () => {},
      } as unknown as ChannelModel;
      const channel = Object.assign(new EventEmitter(), {
        assertQueue: async () => {
          server.add(queue);
          await new Promise(() => {});
        },
      });
      const declaration = queueDeclaration(queue);
      const schema = vi.fn(async () => {});
      const fixture = cleanupFixture(
        { queue: () => declaration.cleanup(async () => fresh), schema },
        originalDestroyed,
      );
      const run = withCleanup(
        async () =>
          declaration.declare(
            await watchedChannel(
              Promise.resolve(channel as unknown as Channel),
            ),
            originalDestroyed,
            10,
          ),
        () => fixture.steps,
      );
      const assertion = expect(run).rejects.toThrow("declare queue timed out");
      await vi.advanceTimersByTimeAsync(10);
      await assertion;
      expect(originalDestroyed).toHaveBeenCalled();
      expect(schema).toHaveBeenCalledOnce();
      expect(fixture.order).toEqual(expectedOrder);
      expect(deleteQueue).toHaveBeenCalledWith(queue);
      expect(server.has(queue)).toBe(false);
      expect(cleanupDestroyed).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("bounds a stalled fresh-connection deletion and destroys it", async () => {
    vi.useFakeTimers();
    try {
      const destroy = vi.fn();
      const fresh = {
        connection: { stream: { destroy } },
        createChannel: async () =>
          Object.assign(new EventEmitter(), {
            deleteQueue: () => new Promise(() => {}),
          }),
      } as unknown as ChannelModel;
      const deletion = deleteAttemptedQueue(isolatedQueue(), async () => fresh);
      const assertion = expect(deletion).rejects.toThrow(
        "delete attempted queue timed out",
      );
      await vi.advanceTimersByTimeAsync(2000);
      await assertion;
      expect(destroy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("cleans a server-created queue after channel error and lost RPC response", async () => {
    const queue = isolatedQueue();
    const server = new Set<string>();
    const failure = new Error("declaration response lost");
    const original = Object.assign(new EventEmitter(), {
      assertQueue: async () => {
        server.add(queue);
        original.emit("error", failure);
        throw failure;
      },
    });
    const deletion = vi.fn(async (name: string) => server.delete(name));
    const fresh = {
      connection: { stream: { destroy: vi.fn() } },
      createChannel: async () =>
        Object.assign(new EventEmitter(), { deleteQueue: deletion }),
      close: async () => {},
    } as unknown as ChannelModel;
    const schema = vi.fn(async () => {});
    const declaration = queueDeclaration(queue);
    const fixture = cleanupFixture({
      queue: () => declaration.cleanup(async () => fresh),
      schema,
    });
    await expect(
      withCleanup(
        async () =>
          declaration.declare(
            await watchedChannel(
              Promise.resolve(original as unknown as Channel),
            ),
            vi.fn(),
          ),
        () => fixture.steps,
      ),
    ).rejects.toBe(failure);
    expect(deletion).toHaveBeenCalledWith(queue);
    expect(server.has(queue)).toBe(false);
    expect(schema).toHaveBeenCalledOnce();
    expect(fixture.order).toEqual(expectedOrder);
  });
  it("continues the production sequence after queue deletion fails", async () => {
    const queue = isolatedQueue();
    const declaration = queueDeclaration(queue);
    const failure = new Error("delete failed");
    const fresh = {
      connection: { stream: { destroy: vi.fn() } },
      createChannel: async () =>
        Object.assign(new EventEmitter(), {
          deleteQueue: async () => {
            throw failure;
          },
        }),
    } as unknown as ChannelModel;
    await declaration.declare(
      { assertQueue: async () => ({}) } as unknown as Channel,
      vi.fn(),
    );
    const fixture = cleanupFixture({
      queue: () => declaration.cleanup(async () => fresh),
    });
    await expect(cleanup(fixture.steps)).rejects.toThrow("Cleanup failed");
    expect(fixture.order).toEqual(expectedOrder);
  });
  it("bounds channel creation and handles a late rejection", async () => {
    vi.useFakeTimers();
    try {
      let reject!: (error: Error) => void;
      const pending = new Promise<Channel>((_, fail) => {
        reject = fail;
      });
      const destroy = vi.fn();
      const fresh = {
        connection: { stream: { destroy } },
        createChannel: () => pending,
      } as unknown as ChannelModel;
      const result = deleteAttemptedQueue(isolatedQueue(), async () => fresh);
      const assertion = expect(result).rejects.toThrow(
        "delete attempted queue timed out",
      );
      await vi.advanceTimersByTimeAsync(2000);
      await assertion;
      reject(new Error("late channel failure"));
      await Promise.resolve();
      expect(destroy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("tolerates a queue already absent without masking other failures", async () => {
    const destroy = vi.fn();
    const failure = { code: 404, classId: 50, methodId: 40 };
    const channel = Object.assign(new EventEmitter(), {
      deleteQueue: async () => {
        channel.emit(
          "error",
          Object.assign(new Error("server close"), failure),
        );
        throw failure;
      },
    });
    const fresh = {
      connection: { stream: { destroy } },
      createChannel: async () => channel,
      close: async () => {},
    } as unknown as ChannelModel;
    await expect(
      deleteAttemptedQueue(isolatedQueue(), async () => fresh),
    ).resolves.toBeUndefined();
    failure.methodId = 10;
    await expect(
      deleteAttemptedQueue(isolatedQueue(), async () => fresh),
    ).rejects.toBe(failure);
    failure.methodId = 40;
    failure.code = 403;
    await expect(
      deleteAttemptedQueue(isolatedQueue(), async () => fresh),
    ).rejects.toBe(failure);
  });

  it("destroys a cleanup connection that arrives after the deadline", async () => {
    vi.useFakeTimers();
    try {
      const destroy = vi.fn();
      const createChannel = vi.fn();
      let resolve!: (value: ChannelModel) => void;
      const pending = new Promise<ChannelModel>((done) => {
        resolve = done;
      });
      const deletion = deleteAttemptedQueue(isolatedQueue(), () => pending);
      const assertion = expect(deletion).rejects.toThrow(
        "delete attempted queue timed out",
      );
      await vi.advanceTimersByTimeAsync(2000);
      await assertion;
      resolve({
        connection: { stream: { destroy } },
        createChannel,
      } as unknown as ChannelModel);
      await Promise.resolve();
      expect(destroy).toHaveBeenCalledOnce();
      expect(createChannel).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
