import assert from "node:assert/strict";
import { assertDemoSafety } from "./demo-safety.js";

export function assertAutomationDemoSafety(env: NodeJS.ProcessEnv): void {
  assertDemoSafety(env);
  if (env.AUTOMATION_SNAPSHOTS_ENABLED !== "true")
    throw new Error("AUTOMATION_SNAPSHOTS_ENABLED must be explicitly true");
}

export function assertExecution(
  value: unknown,
  expected: {
    eventId: string;
    automationId: string;
    revision: number;
    status: string;
    executionId?: string;
    message?: string;
  },
): string {
  assert.ok(value && typeof value === "object", "execution must be an object");
  const item = value as Record<string, unknown>;
  assert.equal(typeof item.id, "string");
  assert.ok(item.id);
  if (expected.executionId) assert.equal(item.id, expected.executionId);
  assert.equal(item.eventId, expected.eventId);
  assert.equal(item.automationId, expected.automationId);
  assert.equal(item.revision, expected.revision);
  assert.equal(item.status, expected.status);
  assert.deepEqual(
    item.result,
    expected.message === undefined
      ? null
      : {
          kind: "local-receipt.v1",
          eventId: expected.eventId,
          message: expected.message,
        },
  );
  return item.id as string;
}
