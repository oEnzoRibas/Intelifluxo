import { describe, expect, it, vi } from "vitest";
import {
  createRuntimeRelay,
  type RuntimeRelayOptions,
} from "../src/runtime-relay.js";
import { RuntimeResourceError } from "../src/runtime-resources.js";

function setup() {
  const events: string[] = [];
  const controller = new AbortController();
  const trace: string[] = [];
  let productionFailure: string | undefined;
  let probeFailure: string | undefined;
  let routedFailure: string | undefined;
  let abortAfterConfirm = false;
  let queryFailure = false;
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    events.push(
      sql.startsWith("SELECT")
        ? sql.includes("retry_publications")
          ? "select-retry"
          : "select-initial"
        : sql.includes("retry_publications")
          ? "update-retry"
          : "update-initial",
    );
    if (queryFailure) throw new RuntimeResourceError("QUERY");
    if (sql.startsWith("SELECT"))
      return {
        rows: sql.includes("retry_publications")
          ? [{ event_id: "event", generation: 2 }]
          : [{ event_id: "event" }],
      };
    expect(values?.[0]).toBe("event");
    return { rows: [] };
  });
  const channel = {
    assertQueue: vi.fn(async (name: string) => {
      events.push(
        name.startsWith("intelifluxo.probe.") ? "assert-probe" : "assert-queue",
      );
      return { queue: name, messageCount: 0, consumerCount: 0 };
    }),
    deleteQueue: vi.fn(async () => {
      events.push("delete-probe");
      return { messageCount: 0 };
    }),
    publish: vi.fn(async (_exchange: string, key: string) => {
      if (key.startsWith("intelifluxo.absent.")) {
        events.push("unrouted");
        if (probeFailure === "success")
          return { confirmed: true, routed: true };
        throw new RuntimeResourceError(
          (probeFailure ?? "AMQP_MANDATORY_RETURN") as "AMQP_MANDATORY_RETURN",
        );
      }
      if (key.startsWith("intelifluxo.probe.")) {
        events.push("routed");
        if (routedFailure)
          throw new RuntimeResourceError(
            routedFailure as "AMQP_MANDATORY_RETURN",
          );
      } else {
        events.push("publish");
        if (productionFailure)
          throw new RuntimeResourceError(
            productionFailure as "AMQP_CONFIRM_TIMEOUT",
          );
        if (abortAfterConfirm) controller.abort();
      }
      return { confirmed: true, routed: true };
    }),
  };
  const resources = {
    pg: async () => {
      events.push("pg");
      return { query };
    },
    amqp: async () => {
      events.push("amqp");
      return {
        createConfirmChannel: async () => {
          events.push("channel");
          return channel;
        },
      };
    },
  } as unknown as NonNullable<RuntimeRelayOptions["resources"]>;
  const relay = createRuntimeRelay({
    connectionString: "secret",
    amqpUrl: "secret",
    postForceSettlementMs: 10,
    resources,
    queue: "production",
    trace,
  });
  const scope = relay.createScope(controller.signal);
  return {
    events,
    controller,
    trace,
    channel,
    query,
    relay,
    scope,
    productionFailure: (value: string) => {
      productionFailure = value;
    },
    probeFailure: (value: string) => {
      probeFailure = value;
    },
    routedFailure: (value: string) => {
      routedFailure = value;
    },
    abortAfterConfirm: () => {
      abortAfterConfirm = true;
    },
    queryFailure: () => {
      queryFailure = true;
    },
  };
}

describe("owned relay adapter", () => {
  it("prepares resources and confirms initial and retry before updates; delegates cleanup", async () => {
    const f = setup();
    const dispose = vi.spyOn(f.scope, "dispose");
    expect(await f.relay.sweep(f.scope)).toBe(2);
    expect(f.events).toEqual([
      "pg",
      "amqp",
      "channel",
      "assert-probe",
      "unrouted",
      "routed",
      "delete-probe",
      "assert-queue",
      "select-initial",
      "publish",
      "update-initial",
      "select-retry",
      "publish",
      "update-retry",
    ]);
    expect(f.channel.assertQueue).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/^intelifluxo\.probe\./),
      { exclusive: true, autoDelete: true },
    );
    expect(f.channel.assertQueue).toHaveBeenNthCalledWith(2, "production", {
      durable: true,
    });
    expect(f.trace).toEqual([
      "confirm",
      "outbox-confirmed",
      "confirm",
      "outbox-confirmed",
    ]);
    expect(dispose).not.toHaveBeenCalled();
    await f.relay.disposeScope(f.scope);
    expect(dispose).toHaveBeenCalledOnce();
  });
  it("admits no work for an already aborted signal", async () => {
    const f = setup();
    f.controller.abort();
    const alreadyAborted = f.relay.createScope(f.controller.signal);
    await expect(f.relay.sweep(alreadyAborted)).rejects.toMatchObject({
      code: "ABORTED",
    });
    expect(f.events).toEqual([]);
    await f.relay.disposeScope(alreadyAborted);
    await f.relay.disposeScope(f.scope);
  });
  it.each([
    ["success", "AMQP_CONFORMANCE_MISMATCH"],
    ["AMQP_CONFIRM_TIMEOUT", "AMQP_CONFIRM_TIMEOUT"],
  ])("handles probe %s", async (input, code) => {
    const f = setup();
    f.probeFailure(input);
    await expect(f.relay.sweep(f.scope)).rejects.toMatchObject({ code });
    expect(f.events).toContain("delete-probe");
    expect(f.events).not.toContain("assert-queue");
    await f.relay.disposeScope(f.scope);
  });
  it.each([
    [
      "AMQP_CONFIRM_TIMEOUT",
      "AMQP_REPLY_TERMINAL",
      "AMQP_REPLY_TERMINAL",
      true,
    ],
    [
      "AMQP_REPLY_TERMINAL",
      "AMQP_CONFIRM_TIMEOUT",
      "AMQP_REPLY_TERMINAL",
      true,
    ],
    ["AMQP_CONFIRM_TIMEOUT", "CLEANUP_STUCK", "CLEANUP_STUCK", true],
    ["AMQP_REPLY_TERMINAL", "CLEANUP_STUCK", "CLEANUP_STUCK", true],
    ["CLEANUP_STUCK", "AMQP_REPLY_TERMINAL", "CLEANUP_STUCK", true],
    ["CLEANUP_STUCK", "CLEANUP_STUCK", "CLEANUP_STUCK", true],
    ["AMQP_REPLY_TERMINAL", "ADAPTER_MISMATCH", "AMQP_REPLY_TERMINAL", true],
    [
      "AMQP_CONFIRM_TIMEOUT",
      "AMQP_TRANSPORT_RESET",
      "AMQP_CONFIRM_TIMEOUT",
      false,
    ],
    [null, "AMQP_REPLY_TERMINAL", "AMQP_REPLY_TERMINAL", true],
    [null, "AMQP_TRANSPORT_RESET", "AMQP_TRANSPORT_RESET", false],
  ] as const)(
    "selects fixed probe failure for primary %s and delete %s",
    async (primary, cleanup, code, fatal) => {
      const f = setup();
      if (primary) {
        const error = new RuntimeResourceError(primary);
        error.message = "private primary message";
        f.channel.publish.mockRejectedValueOnce(error);
      }
      const deleteError = new RuntimeResourceError(cleanup);
      deleteError.message = "private cleanup message";
      f.channel.deleteQueue.mockRejectedValueOnce(deleteError);
      const error = await f.relay
        .sweep(f.scope)
        .catch((value: unknown) => value);
      expect(error).toBeInstanceOf(RuntimeResourceError);
      expect(error).toMatchObject({
        code,
        fatal,
        message: `runtime resource: ${code}`,
      });
      expect(String(error)).not.toContain("private");
      expect(error).not.toHaveProperty("cause");
      expect(f.channel.deleteQueue).toHaveBeenCalledOnce();
      expect(f.events).not.toContain("assert-queue");
      await f.relay.disposeScope(f.scope);
    },
  );
  it("skips probe deletion after abort and leaves scope cleanup to the lifecycle", async () => {
    const f = setup();
    f.channel.publish.mockImplementationOnce(async () => {
      f.controller.abort();
      throw new RuntimeResourceError("AMQP_CONFIRM_LOST");
    });
    await expect(f.relay.sweep(f.scope)).rejects.toMatchObject({
      code: "AMQP_CONFIRM_LOST",
    });
    expect(f.channel.deleteQueue).not.toHaveBeenCalled();
    vi.spyOn(f.scope, "dispose").mockRejectedValueOnce(
      new RuntimeResourceError("CLEANUP_STUCK"),
    );
    await expect(f.relay.disposeScope(f.scope)).rejects.toMatchObject({
      code: "CLEANUP_STUCK",
      fatal: true,
    });
  });
  it("fails closed without exposing an unexpected delete error", async () => {
    const f = setup();
    f.probeFailure("AMQP_CONFIRM_TIMEOUT");
    f.channel.deleteQueue.mockRejectedValueOnce(
      new Error("private driver data"),
    );
    await expect(f.relay.sweep(f.scope)).rejects.toMatchObject({
      code: "AMQP_UNKNOWN",
      fatal: true,
      message: "runtime resource: AMQP_UNKNOWN",
    });
    await f.relay.disposeScope(f.scope);
  });
  it("treats a routed probe return as a semantic mismatch", async () => {
    const f = setup();
    f.routedFailure("AMQP_MANDATORY_RETURN");
    await expect(f.relay.sweep(f.scope)).rejects.toMatchObject({
      code: "AMQP_CONFORMANCE_MISMATCH",
    });
    await f.relay.disposeScope(f.scope);
  });
  it.each(["AMQP_MANDATORY_RETURN", "AMQP_CONFIRM_TIMEOUT"])(
    "never updates on %s",
    async (code) => {
      const f = setup();
      f.productionFailure(code);
      await expect(f.relay.sweep(f.scope)).rejects.toMatchObject({ code });
      expect(f.events).not.toContain("update-initial");
      await f.relay.disposeScope(f.scope);
    },
  );
  it("does not update after abort between confirm and update", async () => {
    const f = setup();
    f.abortAfterConfirm();
    await expect(f.relay.sweep(f.scope)).rejects.toMatchObject({
      code: "ABORTED",
    });
    expect(f.events).not.toContain("update-initial");
    await f.relay.disposeScope(f.scope);
  });
  it("propagates query failures without logging data", async () => {
    const f = setup();
    f.queryFailure();
    const log = vi.spyOn(console, "error");
    await expect(f.relay.sweep(f.scope)).rejects.toMatchObject({
      code: "QUERY",
    });
    expect(f.events).not.toContain("publish");
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
    await f.relay.disposeScope(f.scope);
  });
});
