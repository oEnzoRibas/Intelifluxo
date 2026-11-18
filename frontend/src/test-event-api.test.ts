import { afterEach, describe, expect, it, vi } from "vitest";
import {
  newTestEventIntent,
  sendTestEvent,
  TestEventError,
} from "./test-event-api";

const id = "12345678-1234-1234-1234-123456789abc";
afterEach(() => vi.unstubAllGlobals());

describe("test event acceptance", () => {
  it.each([
    [202, false],
    [200, true],
  ] as const)("recognizes %s acceptance", async (status, replay) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ id, replay }), { status }),
        ),
    );
    const intent = newTestEventIntent("demo", "hello");
    await expect(
      sendTestEvent(intent, new AbortController().signal),
    ).resolves.toEqual({ id, replay });
  });
  it("reuses the exact intent after an uncertain network outcome", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id, replay: true }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const intent = newTestEventIntent("demo", "hello");
    await expect(
      sendTestEvent(intent, new AbortController().signal),
    ).rejects.toMatchObject({ kind: "uncertain" });
    await sendTestEvent(intent, new AbortController().signal);
    expect(fetchMock.mock.calls[0][1].body).toBe(
      fetchMock.mock.calls[1][1].body,
    );
    expect(newTestEventIntent("demo", "hello").idempotencyKey).not.toBe(
      intent.idempotencyKey,
    );
  });
  it.each([
    [409, "conflict"],
    [400, "validation"],
    [500, "uncertain"],
  ] as const)("classifies %s honestly", async (status, kind) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status })),
    );
    await expect(
      sendTestEvent(
        newTestEventIntent("demo", "hello"),
        new AbortController().signal,
      ),
    ).rejects.toEqual(new TestEventError(kind));
  });
  it("treats malformed acceptance as uncertain", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 202 })),
    );
    await expect(
      sendTestEvent(
        newTestEventIntent("demo", "hello"),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: "uncertain" });
  });
});
