import { afterEach, describe, expect, it, vi } from "vitest";
import { definition, saveGraph, updateDefinition } from "./automation-api";
import { conditionDraft, defaultGraph, graphValid } from "./workflow-graph";
import { edgeIdentity } from "./condition-contract";
import type { ConditionConfig } from "./condition-contract";

const raw = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  scope: "demo",
  revision: 1,
  name: "Receipt",
  active: false,
  schemaVersion: 1,
  trigger: { type: "receipt.v1" },
  action: { type: "record-receipt.v1" },
  createdAt: "2026-01-01T00:00:00.000Z",
  graph: defaultGraph(),
};
const config = { fieldPath: "data.value", operator: "exists" } as const;
afterEach(() => vi.restoreAllMocks());

describe("condition graph integration", () => {
  it("converts only inactive valid v1 graphs deterministically with collision-free IDs", () => {
    const graph = defaultGraph();
    graph.nodes[0].id = "condition";
    graph.nodes[1].id = "end";
    graph.edges = [{ source: "condition", target: "end" }];
    const converted = conditionDraft(graph, false, config);
    expect(conditionDraft(graph, false, config)).toEqual(converted);
    expect(converted.nodes.map((n) => n.id)).toEqual([
      "condition",
      "condition-1",
      "end",
      "end-1",
    ]);
    expect(converted.nodes[0].position).toEqual(graph.nodes[0].position);
    expect(graphValid(converted, true)).toBe(true);
    expect(new Set(converted.edges.map(edgeIdentity)).size).toBe(4);
    expect(() => conditionDraft(graph, true, config)).toThrow();
    expect(() => conditionDraft(converted, false, config)).toThrow();
  });
  it("accepts exact schema/graph pairs and rejects missing, malformed or unknown shapes", () => {
    const graph = conditionDraft(raw.graph, false, config);
    expect(definition(raw).graphSource).toBe("server");
    expect(definition({ ...raw, schemaVersion: 2, graph }).graphSource).toBe(
      "condition-v2",
    );
    expect(() => definition({ ...raw, graph })).toThrow();
    expect(() =>
      definition({ ...raw, schemaVersion: 2, graph: raw.graph }),
    ).toThrow();
    expect(() => definition({ ...raw, schemaVersion: 3, graph })).toThrow();
    const bad = structuredClone(graph);
    bad.edges[1].sourcePort = "FALSE";
    expect(() =>
      definition({ ...raw, schemaVersion: 2, graph: bad }),
    ).toThrow();
    const badConfig = structuredClone(graph);
    badConfig.nodes[1].config = {
      fieldPath: "constructor",
      operator: "exists",
    };
    expect(() =>
      definition({ ...raw, schemaVersion: 2, graph: badConfig }),
    ).toThrow();
  });
  it("saves a schema 2 graph and preserves it on activation", async () => {
    const graph = conditionDraft(raw.graph, false, config);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ...raw, schemaVersion: 2, graph, revision: 2 }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ...raw,
            schemaVersion: 2,
            graph,
            revision: 3,
            active: true,
          }),
        ),
      );
    const saved = await saveGraph(
      definition(raw),
      graph,
      new AbortController().signal,
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      schemaVersion: 2,
      graph,
      active: false,
      expectedRevision: 1,
    });
    await updateDefinition(saved, new AbortController().signal);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      schemaVersion: 2,
      graph,
      active: true,
      expectedRevision: 2,
    });
  });
  it.each<ConditionConfig>([
    { fieldPath: "data.value", operator: "exists" },
    {
      fieldPath: "data.value",
      operator: "equals",
      expectedType: "string",
      expectedValue: "hello",
    },
    {
      fieldPath: "data.value",
      operator: "equals",
      expectedType: "number",
      expectedValue: 42,
    },
    {
      fieldPath: "data.value",
      operator: "equals",
      expectedType: "boolean",
      expectedValue: false,
    },
    {
      fieldPath: "data.value",
      operator: "equals",
      expectedType: "null",
      expectedValue: null,
    },
  ])(
    "sends exact save and activation condition payloads %#",
    async (condition) => {
      const graph = conditionDraft(raw.graph, false, condition);
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(
            JSON.stringify({ ...raw, schemaVersion: 2, graph, revision: 2 }),
          ),
        );
      await saveGraph(definition(raw), graph, new AbortController().signal);
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
        expectedRevision: 1,
        active: false,
        name: raw.name,
        schemaVersion: 2,
        trigger: raw.trigger,
        action: raw.action,
        graph,
      });
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ...raw,
            schemaVersion: 2,
            graph,
            active: true,
            revision: 3,
          }),
        ),
      );
      await updateDefinition(
        definition({ ...raw, schemaVersion: 2, graph, revision: 2 }),
        new AbortController().signal,
      );
      expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
        expectedRevision: 2,
        active: true,
        name: raw.name,
        schemaVersion: 2,
        trigger: raw.trigger,
        action: raw.action,
        graph,
      });
    },
  );
  it("preserves schema and graph when deactivating", async () => {
    const graph = conditionDraft(raw.graph, false, config);
    const active = {
      ...raw,
      active: true,
      schemaVersion: 2,
      graph,
      revision: 4,
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ ...active, active: false, revision: 5 })),
      );
    await updateDefinition(definition(active), new AbortController().signal);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      expectedRevision: 4,
      active: false,
      name: raw.name,
      schemaVersion: 2,
      trigger: raw.trigger,
      action: raw.action,
      graph,
    });
  });
  it("does not write a legacy default without an explicit server graph", async () => {
    const old = { ...raw, graph: undefined };
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(
      updateDefinition(
        definition(JSON.parse(JSON.stringify(old))),
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
