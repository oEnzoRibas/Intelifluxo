import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import App from "./App";
import { getEvent } from "./api";
const id = "12345678-1234-1234-1234-123456789abc";
const profile = {
  profile: "local-development-only",
  limitations: ["no retries"],
};
const detail = {
  id,
  scope: "demo",
  content: { type: "receipt.v1", target: "local-receipt", message: "hello" },
  createdAt: "2026-01-01T00:00:00Z",
  publication: "pending",
  status: "accepted",
  result: null,
  retry: null,
};
const retry = {
  generation: 0,
  attempt: 1,
  outcome: "transient",
  delayMs: 1000,
  nextEligibleAt: "2026-01-01T00:00:01Z",
  reason: null,
};
function reply(data: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", window.location.pathname);
});
it.each([{}, { valor: 150, nested: { active: true }, empty: null }])(
  "preserves optional event data in the event detail",
  async (data) => {
    const event = { ...detail, content: { ...detail.content, data } };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => reply(event)),
    );
    await expect(getEvent(id, new AbortController().signal)).resolves.toEqual(
      event,
    );
  },
);
it.each([null, [], "value", 1])(
  "rejects non-object event data",
  async (data) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => reply({ ...detail, content: { ...detail.content, data } })),
    );
    await expect(
      getEvent(id, new AbortController().signal),
    ).rejects.toMatchObject({ kind: "invalid" });
  },
);
it.each([
  "2026-01-01t00:00:00z",
  "2026-01-01T12:34:56.123+05:30",
  "2026-01-01T12:34:56-08:00",
  "2016-12-31T23:59:60Z",
  "2017-01-01t05:29:60+05:30",
  "2000-02-29T00:00:00Z",
])(
  "accepts RFC 3339 timestamps in both event fields: %s",
  async (timestamp) => {
    const event = {
      ...detail,
      createdAt: timestamp,
      retry: { ...retry, nextEligibleAt: timestamp },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => reply(event)),
    );
    await expect(getEvent(id, new AbortController().signal)).resolves.toEqual(
      event,
    );
  },
);

it.each([
  "2026-02-30T00:00:00Z",
  "1900-02-29T00:00:00Z",
  "2026-01-01 00:00:00Z",
  "2026-01-01T00:00:00+0530",
  "2026-01-01T00:00:00+24:00",
  "2026-01-01T24:00:00Z",
  "2016-12-31T12:00:60Z",
  "2016-12-31T23:59:61Z",
  "2026-01-01T00:00:00Z\n",
])(
  "rejects malformed timestamps in either event field: %s",
  async (timestamp) => {
    for (const event of [
      { ...detail, createdAt: timestamp },
      { ...detail, retry: { ...retry, nextEligibleAt: timestamp } },
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => reply(event)),
      );
      await expect(
        getEvent(id, new AbortController().signal),
      ).rejects.toMatchObject({
        kind: "invalid",
      });
    }
  },
);
it("shows profile, idle and unavailable dependency states", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => reply(profile)),
  );
  render(<App />);
  expect(
    screen.getByRole("link", { name: "Skip to main content" }),
  ).toHaveAttribute("href", "#main");
  expect(
    screen.getByRole("navigation", { name: "Primary" }),
  ).toBeInTheDocument();
  expect(screen.getByText("No event selected.")).toBeInTheDocument();
  expect(screen.getAllByText("Unavailable")).toHaveLength(2);
  expect(await screen.findByText("local-development-only")).toBeInTheDocument();
  expect(screen.getByText("no retries")).toBeInTheDocument();
});
it("validates an ID and displays an event response", async () => {
  const fetcher = vi.fn((url: string) =>
    reply(url.endsWith("/status") ? profile : detail),
  );
  vi.stubGlobal("fetch", fetcher);
  render(<App />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Look up event" }));
  expect(screen.getByRole("alert")).toHaveTextContent("lowercase UUID");
  const input = screen.getByLabelText("Event ID");
  expect(input).toHaveAttribute("aria-invalid", "true");
  await user.type(input, id);
  await user.click(screen.getByRole("button", { name: "Look up event" }));
  expect(
    await screen.findByRole("heading", { name: "Event details" }),
  ).toBeInTheDocument();
  expect(screen.getByText("pending")).toBeInTheDocument();
  expect(screen.getByText("accepted")).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Event content" })).toHaveAttribute(
    "tabindex",
    "0",
  );
  expect(screen.getByRole("region", { name: "Event result" })).toHaveAttribute(
    "tabindex",
    "0",
  );
  expect(fetcher).toHaveBeenCalledWith(
    `/api/events/${id}`,
    expect.objectContaining({ credentials: "omit" }),
  );
});

it.each([
  { content: null },
  { content: { target: "local-receipt", message: "hello" } },
  { content: { ...detail.content, type: "other" } },
  { content: { ...detail.content, target: "other" } },
  { content: { ...detail.content, extra: true } },
  { content: { type: "demo", target: 1, message: "hello" } },
  { content: { type: "demo", target: "local-receipt", message: null } },
  { createdAt: "not a date" },
  { createdAt: "2026-02-30T00:00:00Z" },
  { result: {} },
  { result: { kind: "other", eventId: id, message: "hello" } },
  { result: { kind: "local-receipt.v1", eventId: "wrong", message: "hello" } },
  { result: { kind: "local-receipt.v1", eventId: id, message: 1 } },
  {
    result: {
      kind: "local-receipt.v1",
      eventId: id,
      message: "ok",
      extra: true,
    },
  },
  { extra: true },
  { retry: undefined },
  { retry: {} },
  { retry: { ...retry, extra: true } },
  { retry: { ...retry, generation: -1 } },
  { retry: { ...retry, attempt: 0 } },
  { retry: { ...retry, attempt: 1.5 } },
  { retry: { ...retry, outcome: null } },
  { retry: { ...retry, delayMs: 0 } },
  { retry: { ...retry, nextEligibleAt: "invalid" } },
  { retry: { ...retry, reason: "other" } },
])("rejects malformed event response %#", async (override) => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      reply(url.endsWith("/status") ? profile : { ...detail, ...override }),
    ),
  );
  render(<App />);
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Event ID"), id);
  await user.click(screen.getByRole("button", { name: "Look up event" }));
  expect(await screen.findByText(/Event lookup failed/)).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "Event details" }),
  ).not.toBeInTheDocument();
});

it("accepts a valid receipt", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      reply(
        url.endsWith("/status")
          ? profile
          : {
              ...detail,
              status: "completed",
              result: {
                kind: "local-receipt.v1",
                eventId: id,
                message: "done",
              },
            },
      ),
    ),
  );
  render(<App />);
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Event ID"), id);
  await user.click(screen.getByRole("button", { name: "Look up event" }));
  expect(
    await screen.findByRole("region", { name: "Event result" }),
  ).toHaveTextContent("done");
});

it.each([
  ["retry_scheduled", retry],
  [
    "blocked",
    {
      ...retry,
      outcome: "permanent",
      delayMs: null,
      nextEligibleAt: null,
      reason: "permanent",
    },
  ],
])("displays %s retry disposition", async (status, disposition) => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      reply(
        url.endsWith("/status")
          ? profile
          : { ...detail, status, retry: disposition },
      ),
    ),
  );
  render(<App />);
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Event ID"), id);
  await user.click(screen.getByRole("button", { name: "Look up event" }));
  expect(await screen.findByText(status)).toBeInTheDocument();
  expect(
    screen.getByRole("region", { name: "Retry disposition" }),
  ).toHaveTextContent(disposition.outcome);
  if (status === "retry_scheduled") {
    expect(
      screen.getByText(/schedule is persisted.*scheduler and relay sweeps/i),
    ).toBeInTheDocument();
  } else {
    expect(
      screen.queryByText(/schedule is persisted/i),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Retry disposition" }),
    ).toHaveTextContent("permanent");
  }
});

it.each(["pending", "confirmed"])(
  "shows retry_released with publication %s without implying completion",
  async (publication) => {
    const released = {
      ...detail,
      status: "retry_released",
      publication,
      retry: { ...retry, generation: 1 },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        reply(url.endsWith("/status") ? profile : released),
      ),
    );
    await expect(getEvent(id, new AbortController().signal)).resolves.toEqual(
      released,
    );
    render(<App />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Event ID"), id);
    await user.click(screen.getByRole("button", { name: "Look up event" }));
    expect(await screen.findByText("retry_released")).toBeInTheDocument();
    expect(screen.getByText(publication)).toBeInTheDocument();
    expect(screen.getByText(/processing has not completed/i)).toHaveTextContent(
      /preceding committed disposition/i,
    );
  },
);

it.each(["navigate", "clear"])(
  "invalidates pending lookup on %s even if it resolves late",
  async (action) => {
    for (const outcome of ["success", "error"]) {
      let resolve!: (response: Response) => void;
      let reject!: (error: Error) => void;
      let signal!: AbortSignal;
      const pending = new Promise<Response>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string, options: RequestInit) => {
          if (url.endsWith("/status")) return reply(profile);
          signal = options.signal as AbortSignal;
          return pending;
        }),
      );
      window.history.replaceState(null, "", "#explorer");
      const { unmount } = render(<App />);
      const user = userEvent.setup();
      await user.type(screen.getByLabelText("Event ID"), id);
      await user.click(screen.getByRole("button", { name: "Look up event" }));
      expect(screen.getByText("Loading event…")).toBeInTheDocument();
      if (action === "clear")
        await user.clear(screen.getByLabelText("Event ID"));
      else {
        await user.click(screen.getByRole("link", { name: "Overview" }));
        await screen.findByRole("heading", { name: "Operational Overview" });
      }
      expect(signal.aborted).toBe(true);
      await act(async () => {
        if (outcome === "success")
          resolve(new Response(JSON.stringify(detail)));
        else reject(new Error("late"));
      });
      expect(screen.getByText("No event selected.")).toBeInTheDocument();
      expect(screen.queryByText("accepted")).not.toBeInTheDocument();
      expect(screen.queryByText(/Event lookup failed/)).not.toBeInTheDocument();
      if (action === "navigate") {
        await user.click(screen.getByRole("link", { name: "Event Explorer" }));
        expect(
          await screen.findByText("No event selected."),
        ).toBeInTheDocument();
      }
      unmount();
    }
  },
);

it.each(["success", "error"])(
  "invalidates a pending lookup when edited to another nonempty ID, ignoring late %s",
  async (outcome) => {
    let resolve!: (response: Response) => void;
    let reject!: (error: Error) => void;
    let signal!: AbortSignal;
    const pending = new Promise<Response>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, options: RequestInit) => {
        if (url.endsWith("/status")) return reply(profile);
        signal = options.signal as AbortSignal;
        return pending;
      }),
    );
    render(<App />);
    const user = userEvent.setup();
    const input = screen.getByLabelText("Event ID");
    await user.type(input, id);
    await user.click(screen.getByRole("button", { name: "Look up event" }));
    fireEvent.change(input, { target: { value: ` ${id} ` } });
    expect(signal.aborted).toBe(false);
    expect(screen.getByText("Loading event…")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: `${id}a` } });
    expect(signal.aborted).toBe(true);
    expect(screen.getByText("No event selected.")).toBeInTheDocument();
    await act(async () => {
      if (outcome === "success") resolve(new Response(JSON.stringify(detail)));
      else reject(new Error("late"));
    });
    expect(screen.getByText("No event selected.")).toBeInTheDocument();
    expect(screen.queryByText("accepted")).not.toBeInTheDocument();
    expect(screen.queryByText(/Event lookup failed/)).not.toBeInTheDocument();
  },
);

it("clears a resolved snapshot when edited to another nonempty ID", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => reply(url.endsWith("/status") ? profile : detail)),
  );
  render(<App />);
  const user = userEvent.setup();
  const input = screen.getByLabelText("Event ID");
  await user.type(input, id);
  await user.click(screen.getByRole("button", { name: "Look up event" }));
  expect(await screen.findByText("accepted")).toBeInTheDocument();
  fireEvent.change(input, { target: { value: ` ${id} ` } });
  expect(screen.getByText("accepted")).toBeInTheDocument();
  fireEvent.change(input, { target: { value: `${id}a` } });
  expect(screen.getByText("No event selected.")).toBeInTheDocument();
  expect(screen.queryByText("accepted")).not.toBeInTheDocument();
});

it.each(["invalid JSON", "network rejection"])(
  "handles lookup %s",
  async (failure) => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url.endsWith("/status")
          ? reply(profile)
          : failure === "invalid JSON"
            ? Promise.resolve(new Response("{"))
            : Promise.reject(new Error("network")),
      ),
    );
    render(<App />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Event ID"), id);
    await user.click(screen.getByRole("button", { name: "Look up event" }));
    expect(await screen.findByText(/Event lookup failed/)).toBeInTheDocument();
  },
);

it("shows lookup loading and ignores an older response even if fetch ignores abort", async () => {
  let resolveOld!: (response: Response) => void;
  let resolveNew!: (response: Response) => void;
  const old = new Promise<Response>((resolve) => {
    resolveOld = resolve;
  });
  const newer = new Promise<Response>((resolve) => {
    resolveNew = resolve;
  });
  const secondId = "abcdefab-1234-1234-1234-123456789abc";
  let oldSignal!: AbortSignal;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, options: RequestInit) => {
      if (url.endsWith("/status")) return reply(profile);
      if (url.endsWith(id)) {
        oldSignal = options.signal as AbortSignal;
        return old;
      }
      return newer;
    }),
  );
  render(<App />);
  const user = userEvent.setup();
  const input = screen.getByLabelText("Event ID");
  await user.type(input, id);
  await user.click(screen.getByRole("button", { name: "Look up event" }));
  expect(screen.getByText("Loading event…")).toBeInTheDocument();
  await user.clear(input);
  await user.type(input, secondId);
  await user.click(screen.getByRole("button", { name: "Look up event" }));
  expect(oldSignal.aborted).toBe(true);
  await act(async () =>
    resolveNew(
      new Response(JSON.stringify({ ...detail, id: secondId, scope: "new" })),
    ),
  );
  expect(await screen.findByText("new")).toBeInTheDocument();
  await act(async () =>
    resolveOld(new Response(JSON.stringify({ ...detail, scope: "old" }))),
  );
  expect(screen.getByText("new")).toBeInTheDocument();
  expect(screen.queryByText("old")).not.toBeInTheDocument();
});

it.each([true, false])(
  "keeps retry keyboard focus through loading and outcome (success: %s)",
  async (success) => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((r) => {
      resolve = r;
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("{}"))
        .mockReturnValueOnce(pending),
    );
    render(<App />);
    const user = userEvent.setup();
    const retry = await screen.findByRole("button", { name: "Retry" });
    await user.tab();
    while (document.activeElement !== retry) await user.tab();
    await user.keyboard("{Enter}");
    expect(retry).toHaveFocus();
    expect(retry).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Loading service profile…")).toBeInTheDocument();
    await act(async () =>
      resolve(new Response(JSON.stringify(success ? profile : {}))),
    );
    await waitFor(() =>
      expect(retry).toHaveAttribute("aria-disabled", "false"),
    );
    expect(retry).toHaveFocus();
    expect(
      screen.getByText(
        success ? "local-development-only" : /Service profile unavailable/,
      ),
    ).toBeInTheDocument();
  },
);
it("shows not found and lookup API failure", async () => {
  let status = 404;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      url.endsWith("/status") ? reply(profile) : reply({}, status),
    ),
  );
  render(<App />);
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Event ID"), id);
  await user.click(screen.getByRole("button", { name: "Look up event" }));
  expect(
    await screen.findByText("No event found for this ID."),
  ).toBeInTheDocument();
  status = 500;
  await user.click(screen.getByRole("button", { name: "Look up event" }));
  expect(await screen.findByText(/Event lookup failed/)).toBeInTheDocument();
});
it("shows loading, retry and rejects malformed responses", async () => {
  let resolve!: (value: Response) => void;
  const pending = new Promise<Response>((r) => {
    resolve = r;
  });
  const fetcher = vi
    .fn()
    .mockReturnValueOnce(pending)
    .mockImplementation(() => reply(profile));
  vi.stubGlobal("fetch", fetcher);
  render(<App />);
  expect(screen.getByText("Loading service profile…")).toBeInTheDocument();
  resolve(new Response("{}"));
  expect(
    await screen.findByText(/Service profile unavailable/),
  ).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(screen.getByText("local-development-only")).toBeInTheDocument(),
  );
});

it("navigates between overview and explorer and preserves the lookup in memory", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => reply(url.endsWith("/status") ? profile : detail)),
  );
  render(<App />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("link", { name: "Event Explorer" }));
  expect(
    await screen.findByRole("heading", { name: "Event Explorer" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Event Explorer" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(
    screen.getByText(/does not provide event discovery/),
  ).toBeInTheDocument();
  await user.type(screen.getByLabelText("Event ID"), id);
  await user.click(screen.getByRole("button", { name: "Look up event" }));
  expect(await screen.findByText("accepted")).toBeInTheDocument();
  await user.click(screen.getByRole("link", { name: "Overview" }));
  expect(
    await screen.findByRole("heading", { name: "Operational Overview" }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("link", { name: "Event Explorer" }));
  expect(await screen.findByDisplayValue(id)).toBeInTheDocument();
  expect(screen.getByText("accepted")).toBeInTheDocument();
});

it("returns to Overview on Back to the initial hashless URL", async () => {
  window.history.replaceState(null, "", window.location.pathname);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => reply(profile)),
  );
  render(<App />);
  await userEvent.click(screen.getByRole("link", { name: "Event Explorer" }));
  expect(
    await screen.findByRole("heading", { name: "Event Explorer" }),
  ).toBeInTheDocument();
  act(() => window.history.back());
  expect(
    await screen.findByRole("heading", { name: "Operational Overview" }),
  ).toBeInTheDocument();
  expect(window.location.hash).toBe("");
  expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

it.each(["accepted", "completed", "retry_scheduled", "blocked"])(
  "shows %s and persisted retry fields in Explorer",
  async (status) => {
    window.location.hash = "#explorer";
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        reply(url.endsWith("/status") ? profile : { ...detail, status, retry }),
      ),
    );
    render(<App />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Event ID"), id);
    await user.click(screen.getByRole("button", { name: "Look up event" }));
    expect(await screen.findByText(status)).toBeInTheDocument();
    const disposition = screen.getByRole("region", {
      name: "Retry disposition",
    });
    for (const field of [
      "generation",
      "attempt",
      "outcome",
      "delayMs",
      "nextEligibleAt",
      "reason",
    ])
      expect(disposition).toHaveTextContent(field);
    expect(screen.getByText("pending")).toBeInTheDocument();
  },
);
