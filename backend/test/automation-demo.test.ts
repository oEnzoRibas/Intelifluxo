import { describe, expect, it } from "vitest";
import {
  assertAutomationDemoSafety,
  assertExecution,
} from "../scripts/automation-demo-assertions.js";

describe("disposable automation demo", () => {
  const env = {
    DEMO_LOCAL: "1",
    DATABASE_URL: "postgres://local:local@127.0.0.1/db",
    AMQP_URL: "amqp://localhost",
    AUTOMATION_SNAPSHOTS_ENABLED: "true",
  };
  it("requires the local guard and an explicit snapshot flag", () => {
    expect(() => assertAutomationDemoSafety(env)).not.toThrow();
    expect(() =>
      assertAutomationDemoSafety({
        ...env,
        AUTOMATION_SNAPSHOTS_ENABLED: undefined,
      }),
    ).toThrow();
    expect(() =>
      assertAutomationDemoSafety({
        ...env,
        AUTOMATION_SNAPSHOTS_ENABLED: "false",
      }),
    ).toThrow();
    expect(() =>
      assertAutomationDemoSafety({
        ...env,
        DATABASE_URL: "postgres://remote/db",
      }),
    ).toThrow();
  });
  it("validates identity, pinned revision, status and persisted result", () => {
    const expected = {
      eventId: "event",
      automationId: "automation",
      revision: 2,
      executionId: "execution",
      status: "completed",
      message: "hello",
    };
    const value = {
      id: "execution",
      eventId: "event",
      automationId: "automation",
      revision: 2,
      status: "completed",
      result: { kind: "local-receipt.v1", eventId: "event", message: "hello" },
    };
    expect(assertExecution(value, expected)).toBe("execution");
    for (const bad of [
      { ...value, id: "other" },
      { ...value, eventId: "other" },
      { ...value, automationId: "other" },
      { ...value, revision: 1 },
      { ...value, status: "accepted" },
      { ...value, result: null },
    ])
      expect(() => assertExecution(bad, expected)).toThrow();
  });
});
