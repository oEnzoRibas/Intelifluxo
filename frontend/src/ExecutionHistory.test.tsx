import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import Automations from "./Automations";
import { fixed } from "./automation-api";
import { defaultGraph } from "./workflow-graph";

const id = "11111111-1111-1111-1111-111111111111";
const eventId = "22222222-2222-2222-2222-222222222222";
const definition = {
  id,
  scope: "tenant",
  revision: 1,
  name: "Receipt",
  active: false,
  ...fixed,
  graph: defaultGraph(),
  createdAt: "2026-01-01T00:00:00.000Z",
};
const receipt = {
  kind: "local-receipt.v1",
  eventId,
  message: "receipt message",
};
const base = {
  id,
  eventId,
  automationId: id,
  revision: 1,
  ...fixed,
  createdAt: definition.createdAt,
  status: "completed",
  retry: null,
};
const decision = {
  nodeId: "condition",
  outcome: "TRUE",
  sourcePort: "TRUE",
  targetNodeId: "action",
};
const result = {
  kind: "condition-execution.v1",
  eventId,
  decision,
  action: {
    nodeId: "action",
    status: "executed",
    receipt: { ...receipt, message: "PRIVATE_RECEIPT_VALUE" },
  },
  failure: null,
};
const v2 = (n: number, value: unknown, status = "completed") => ({
  ...base,
  id: `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`,
  schemaVersion: 2,
  result: value,
  status,
});
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
const history = () =>
  screen
    .getByRole("heading", { name: "Execution history" })
    .closest("section")!;
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("execution history interactions", () => {
  it("shows mixed v1 and v2 results, expanded decisions and event-level retry without receipt values", async () => {
    const items = [
      { ...base, result: receipt },
      v2(1, result),
      v2(
        2,
        {
          ...result,
          decision: {
            ...decision,
            outcome: "FALSE",
            sourcePort: "FALSE",
            targetNodeId: "end",
          },
          action: { nodeId: "action", status: "ignored", receipt: null },
        },
        "ignored",
      ),
      v2(
        3,
        {
          ...result,
          action: { nodeId: "action", status: "pending", receipt: null },
          failure: {
            classification: "transient",
            code: "action_transient",
            nodeId: "action",
          },
        },
        "retry_scheduled",
      ),
      v2(4, {
        ...result,
        action: { nodeId: "action", status: "not_executed", receipt: null },
        failure: {
          classification: "exhausted",
          code: "retry_exhausted",
          nodeId: "action",
        },
      }),
    ];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url).includes("/executions?")
        ? response({ items })
        : response(definition),
    );
    render(<Automations route={`#automations/${id}`} />);
    await screen.findAllByText("Decision TRUE → action");
    const rows = within(history()).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(5);
    expect(within(rows[0]).getByText(/receipt message/)).toBeInTheDocument();
    expect(
      within(rows[0]).getByRole("link", { name: eventId }),
    ).toHaveAttribute("href", `#explorer?eventId=${eventId}`);
    expect(rows[1]).toHaveTextContent("Action: executed · action");
    expect(rows[2]).toHaveTextContent("Decision FALSE → end");
    expect(rows[2]).toHaveTextContent("Action: ignored · action");
    for (const row of [rows[1], rows[2]]) {
      fireEvent.click(within(row).getByText("Execution details"));
      expect(within(row).getByText("Pinned revision: 1")).toBeVisible();
      expect(within(row).getByText("Condition node: condition")).toBeVisible();
    }
    expect(rows[3]).toHaveTextContent("Action: pending");
    expect(rows[3]).toHaveTextContent("Failure: transient · action_transient");
    expect(rows[3]).toHaveTextContent("Retry (event-level): retry scheduled");
    expect(rows[4]).toHaveTextContent("Action: not executed");
    expect(rows[4]).toHaveTextContent("Failure: exhausted · retry_exhausted");
    fireEvent.click(within(rows[4]).getByText("Execution details"));
    expect(within(rows[4]).getByText("Failure node: action")).toBeVisible();
    expect(history()).not.toHaveTextContent("PRIVATE_RECEIPT_VALUE");
  });

  it.each(["malformed", "unavailable"])(
    "sanitizes %s errors, retries and retains meaningful focus through loading and empty states",
    async (kind) => {
      let resolveRetry!: (value: Response) => void;
      let calls = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
        if (!String(url).includes("/executions?")) return response(definition);
        calls++;
        if (calls === 1)
          return kind === "malformed"
            ? response({
                items: [
                  v2(1, {
                    ...result,
                    failure: {
                      classification: "permanent",
                      code: "PRIVATE_PAYLOAD_VALUE",
                      nodeId: "action",
                    },
                  }),
                ],
              })
            : response({ error: "PRIVATE_PAYLOAD_VALUE" }, 503);
        return new Promise<Response>((resolve) => {
          resolveRetry = resolve;
        });
      });
      render(<Automations route={`#automations/${id}`} />);
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(
        kind === "malformed" ? "unexpected response" : "unavailable",
      );
      expect(history()).not.toHaveTextContent("PRIVATE_PAYLOAD_VALUE");
      const retry = within(history()).getByRole("button", { name: "Retry" });
      retry.focus();
      expect(retry).toHaveFocus();
      fireEvent.click(retry);
      expect(
        screen.getByRole("heading", { name: "Execution history" }),
      ).toHaveFocus();
      expect(
        within(history()).getByText("Loading history…"),
      ).toBeInTheDocument();
      resolveRetry(response({ items: [] }));
      expect(
        await within(history()).findByText("No executions yet."),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "Execution history" }),
      ).toHaveFocus();
      expect(calls).toBe(2);
    },
  );
});
