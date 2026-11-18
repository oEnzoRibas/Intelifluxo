import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { execution, fixed } from "./automation-api";
import ViaCepResult from "./ViaCepResult";
import { newTestEventIntent, sendTestEvent } from "./test-event-api";
const id = "11111111-1111-4111-8111-111111111111";
const found = {
  kind: "viacep-condition-execution.v1",
  eventId: id,
  lookup: {
    nodeId: "lookup",
    kind: "viacep-address-result.v1",
    status: "found",
    cep: "01001000",
    address: { cep: "01001-000", localidade: "São Paulo" },
    failure: null,
  },
  decision: {
    nodeId: "condition",
    outcome: "TRUE",
    sourcePort: "TRUE",
    targetNodeId: "action",
  },
  action: {
    nodeId: "action",
    status: "executed",
    receipt: { kind: "local-receipt.v1", eventId: id, message: "recibo" },
  },
  failure: null,
};
const wrap = (result: unknown) => ({
  id,
  eventId: id,
  automationId: id,
  revision: 1,
  ...fixed,
  schemaVersion: 3,
  createdAt: "2026-01-01T00:00:00.000Z",
  status: "completed",
  retry: null,
  result,
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("strictly parses found, ignored, not found and failed v3 results", () => {
  const ignored = {
    ...found,
    decision: {
      ...found.decision,
      outcome: "FALSE",
      sourcePort: "FALSE",
      targetNodeId: "end",
    },
    action: { nodeId: "action", status: "ignored", receipt: null },
  };
  const failure = {
    classification: "permanent",
    code: "viacep_not_found",
    nodeId: "lookup",
  };
  const missing = {
    ...found,
    lookup: { ...found.lookup, status: "not_found", address: null, failure },
    decision: null,
    action: { nodeId: "action", status: "not_executed", receipt: null },
    failure,
  };
  const transient = {
    classification: "transient",
    code: "viacep_timeout",
    nodeId: "lookup",
  };
  const failed = {
    ...missing,
    lookup: { ...missing.lookup, status: "failed", failure: transient },
    action: { nodeId: "action", status: "pending", receipt: null },
    failure: transient,
  };
  for (const value of [found, ignored, missing, failed])
    expect(execution(wrap(value)).result).toEqual(value);
  expect(() => execution(wrap({ ...found, extra: true }))).toThrow();
  expect(() =>
    execution(
      wrap({
        ...found,
        lookup: {
          ...found.lookup,
          address: { ...found.lookup.address, extra: "x" },
        },
      }),
    ),
  ).toThrow();
  expect(() =>
    execution(
      wrap({
        ...failed,
        failure: { ...transient, classification: "permanent" },
      }),
    ),
  ).toThrow();
});
it("renders canonical CEP and receipt without absent address fields", () => {
  const result = execution(wrap(found)).result;
  if (!result || result.kind !== "viacep-condition-execution.v1") throw Error();
  render(<ViaCepResult result={result} />);
  expect(screen.getByText("01001000")).toBeVisible();
  expect(screen.getByText("São Paulo")).toBeVisible();
  expect(screen.queryByText("Logradouro")).toBeNull();
  expect(screen.getByText(/TRUE — atendida/)).toBeVisible();
  expect(screen.getByText("Recibo local: recibo")).toBeVisible();
});
it("posts only optional canonical CEP and preserves identity on retry", async () => {
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
    calls.push(String(options?.body));
    throw Error("offline");
  });
  const fixedIntent = newTestEventIntent("local", "test");
  const eventIntent = newTestEventIntent("local", "test", "01001-000");
  for (const intent of [fixedIntent, eventIntent, eventIntent])
    await expect(
      sendTestEvent(intent, new AbortController().signal),
    ).rejects.toThrow();
  expect(JSON.parse(calls[0])).not.toHaveProperty("data");
  expect(JSON.parse(calls[1]).data).toEqual({ cep: "01001000" });
  expect(calls[1]).toBe(calls[2]);
});
