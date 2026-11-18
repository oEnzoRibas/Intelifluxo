import { afterEach, expect, it, vi } from "vitest";
import { createDefinition } from "./automation-api";
import { createViaCepTemplate } from "./viacep-graph";

afterEach(() => vi.restoreAllMocks());
it("posts the inactive v3 example through the existing create API", async () => {
  const graph = createViaCepTemplate();
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        id: "11111111-1111-4111-8111-111111111111",
        scope: "local",
        revision: 1,
        name: "CEP",
        active: false,
        schemaVersion: 3,
        graph,
        trigger: { type: "receipt.v1" },
        action: { type: "record-receipt.v1" },
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    ),
  );
  await createDefinition("local", "CEP", new AbortController().signal, graph);
  expect(fetcher.mock.calls[0][1]?.method).toBe("POST");
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
    scope: "local",
    name: "CEP",
    schemaVersion: 3,
    graph,
    trigger: { type: "receipt.v1" },
    action: { type: "record-receipt.v1" },
  });
});
