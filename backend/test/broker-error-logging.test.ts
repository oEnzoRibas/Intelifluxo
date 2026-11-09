import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Channel } from "amqplib";
import { brokerErrorType } from "../src/broker.js";
import { connectDemoBroker, watchedChannel } from "./automation-demo-bounds.js";

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("amqplib", () => ({ default: { connect } }));

describe("broker error logging", () => {
  it("emits only allowlisted types, not messages, URLs, credentials, stacks or custom fields", () => {
    const error = Object.assign(new Error("amqp://user:password@host/secret"), {
      secret: "private",
      stack: "sensitive stack",
    });
    expect(brokerErrorType(error)).toBe("Error");
    error.name = "amqp://user:password@host/secret";
    expect(brokerErrorType(error)).toBe("other error");
    expect(brokerErrorType({ message: "password" })).toBe("unknown error");
    expect(brokerErrorType(new TypeError("secret"))).toBe("TypeError");
  });

  it("logs only fixed text and allowlisted types from actual demo handlers", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const connection = new EventEmitter();
      const channel = new EventEmitter();
      connect.mockResolvedValueOnce(connection);
      expect(await connectDemoBroker()).toBe(connection);
      expect(await watchedChannel(Promise.resolve(channel as Channel))).toBe(
        channel,
      );
      const error = Object.assign(
        new TypeError("amqp://user:password@host/secret"),
        {
          stack: "sensitive stack",
          secret: "private credential",
        },
      );
      connection.emit("error", error);
      channel.emit("error", error);
      error.name = "amqp://user:password@host/secret";
      connection.emit("error", error);
      channel.emit("error", { message: "password" });
      expect(log.mock.calls).toEqual([
        ["broker connection error:", "TypeError"],
        ["broker channel error:", "TypeError"],
        ["broker connection error:", "other error"],
        ["broker channel error:", "unknown error"],
      ]);
    } finally {
      log.mockRestore();
    }
  });
});
