import { describe, expect, it } from "vitest";
import { definition } from "./automation-api";
import { defaultGraph, graphValid } from "./workflow-graph";

const legacy = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  scope: "demo",
  revision: 1,
  name: "Receipt",
  active: false,
  schemaVersion: 1,
  trigger: { type: "receipt.v1" },
  action: { type: "record-receipt.v1" },
  createdAt: "2026-01-01T00:00:00.000Z",
};
describe("transitional graph reader", () => {
  it("materializes legacy defaults without implying persistence", () => {
    expect(definition(legacy)).toMatchObject({
      graph: defaultGraph(),
      graphSource: "legacy-default",
    });
    expect(definition({ ...legacy, graph: defaultGraph() }).graphSource).toBe(
      "server",
    );
  });
  it("accepts a placeholder draft but never an active one", () => {
    const graph = defaultGraph();
    graph.nodes.push({
      id: "condition",
      kind: "condition",
      type: "condition-placeholder.v1",
      position: { x: 160, y: 0 },
    });
    graph.edges = [
      { source: "trigger", target: "condition" },
      { source: "condition", target: "action" },
    ];
    expect(graphValid(graph)).toBe(true);
    expect(graphValid(graph, true)).toBe(false);
    expect(() => definition({ ...legacy, active: true, graph })).toThrow();
  });
  it("rejects unknown versions, invalid topology, extra keys and bounds", () => {
    expect(graphValid({ ...defaultGraph(), version: 2 })).toBe(false);
    expect(
      graphValid({
        ...defaultGraph(),
        edges: [{ source: "action", target: "trigger" }],
      }),
    ).toBe(false);
    expect(graphValid({ ...defaultGraph(), extra: true })).toBe(false);
    const graph = defaultGraph();
    graph.nodes[0].position.x = 10001;
    expect(graphValid(graph)).toBe(false);
  });
});

it("accepts the backend golden default graph as a persisted response", async () => {
  const fixture = await import(
    "../../backend/test/fixtures/graph-v1-default.json"
  );
  expect(definition({ ...legacy, graph: fixture.default })).toMatchObject({
    graph: fixture.default,
    graphSource: "server",
  });
});
