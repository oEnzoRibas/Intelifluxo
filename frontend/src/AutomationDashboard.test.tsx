import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AutomationDashboard from "./AutomationDashboard";
import { parseSummaryPage } from "./automation-api";

const id = "00000000-0000-0000-0000-000000000001";
const item = {
  id,
  name: "Receipt",
  scope: "demo",
  active: true,
  revision: 2,
  schemaVersion: 1,
  workflowVersion: 2,
};
const response = (value: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
afterEach(() => vi.unstubAllGlobals());
describe("summary contract", () => {
  it("rejects unknown and malformed fields", () => {
    expect(
      parseSummaryPage({ items: [item], nextCursor: null }).items,
    ).toHaveLength(1);
    for (const value of [
      { items: [item], nextCursor: null, total: 1 },
      {
        items: [
          { ...item, id: id.toUpperCase().replace("00000000", "AAAAAAAA") },
        ],
        nextCursor: null,
      },
      { items: [{ ...item, workflowVersion: 3 }], nextCursor: null },
      { items: [{ ...item, revision: 2147483648 }], nextCursor: null },
      { items: [{ ...item, extra: 1 }], nextCursor: null },
      { items: Array(101).fill(item), nextCursor: null },
    ])
      expect(() => parseSummaryPage(value)).toThrow();
  });
});
describe("dashboard", () => {
  it("discards a late response after changing status", async () => {
    let resolveOld!: (value: Response) => void;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockImplementationOnce(() =>
        response({ items: [{ ...item, name: "New" }], nextCursor: null }),
      );
    vi.stubGlobal("fetch", fetcher);
    render(<AutomationDashboard visible onOpen={() => {}} />);
    fireEvent.click(screen.getByLabelText("Inactive"));
    await screen.findAllByText("New");
    resolveOld(
      await response({ items: [{ ...item, name: "Stale" }], nextCursor: null }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Stale")).not.toBeInTheDocument(),
    );
  });
  it("searches, filters and traverses live pages including an empty continuation", async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() =>
        response({
          items: [
            item,
            {
              ...item,
              id: "00000000-0000-0000-0000-000000000002",
              scope: "other",
            },
          ],
          nextCursor: id,
        }),
      )
      .mockImplementationOnce(() => response({ items: [item], nextCursor: id }))
      .mockImplementationOnce(() => response({ items: [item], nextCursor: id }))
      .mockImplementationOnce(() => response({ items: [], nextCursor: null }))
      .mockImplementationOnce(() =>
        response({ items: [item], nextCursor: null }),
      );
    vi.stubGlobal("fetch", fetcher);
    render(<AutomationDashboard visible onOpen={() => {}} />);
    await screen.findAllByText("other");
    expect(
      screen.getAllByRole("link", {
        name: /Open Builder for Receipt, demo/,
      })[0],
    ).toHaveAttribute("href", `#automations/${id}`);
    fireEvent.change(screen.getByLabelText("Search name or scope"), {
      target: { value: "demo" },
    });
    fireEvent.submit(
      screen.getByLabelText("Search name or scope").closest("form")!,
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(String(fetcher.mock.calls[1][0])).toContain("q=demo");
    await screen.findAllByText("Receipt");
    fireEvent.click(screen.getByLabelText("Active"));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(String(fetcher.mock.calls[2][0])).toContain("active=true");
    await screen.findAllByText("Receipt");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("No more current matches");
    expect(
      screen.getByRole("heading", { name: "Current results" }),
    ).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await screen.findAllByText("Receipt");
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });
  it("distinguishes error, retry and empty and validates search", async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response({}, 503))
      .mockImplementationOnce(() => response({ items: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetcher);
    render(<AutomationDashboard visible onOpen={() => {}} />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("No automations yet");
    const input = screen.getByLabelText("Search name or scope");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.submit(input.closest("form")!);
    expect(input).toHaveFocus();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      within(screen.getByRole("region", { name: "Current results" })).getByText(
        "No automations yet",
      ),
    ).toBeInTheDocument();
  });
});
