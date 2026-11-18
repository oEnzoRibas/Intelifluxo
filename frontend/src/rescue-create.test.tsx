import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import Automations from "./Automations";
import { defaultGraph } from "./workflow-graph";
import { conditionGraphValid } from "./condition-contract";
import { runtimeStatus } from "./test-runtime-status-fixture";

vi.mock("./AutomationDashboard", () => ({ default: () => null }));
const id = "11111111-1111-1111-1111-111111111111";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.location.hash = "";
});
it("creates in the local context and opens the returned builder", async () => {
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url, options) => {
      if (String(url).endsWith("/runtime/status")) {
        const status = runtimeStatus();
        status.capabilities.conditionsWrites = true;
        return new Response(JSON.stringify(status));
      }
      return new Response(
        JSON.stringify({
          id,
          scope: "local",
          revision: 1,
          name: "Teste",
          active: false,
          schemaVersion: 1,
          trigger: { type: "receipt.v1" },
          action: { type: "record-receipt.v1" },
          graph: defaultGraph(),
          createdAt: "2026-01-01T00:00:00.000Z",
          ...JSON.parse(String(options?.body)),
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
  render(<Automations route="#automations/create" />);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Criar desativada" }),
    ).toBeEnabled(),
  );
  fireEvent.change(screen.getByLabelText("Nome da automação"), {
    target: { value: "Teste" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Criar desativada" }));
  await waitFor(() =>
    expect(window.location.hash).toBe(`#automations/${id}/builder`),
  );
  const writes = fetcher.mock.calls.filter(
    ([, options]) => options?.method === "POST",
  );
  expect(writes).toHaveLength(1);
  const payload = JSON.parse(String(writes[0][1]?.body));
  expect(payload).toMatchObject({
    scope: "local",
    name: "Teste",
    schemaVersion: 2,
    trigger: { type: "receipt.v1" },
    action: { type: "record-receipt.v1" },
  });
  expect(conditionGraphValid(payload.graph)).toBe(true);
});
