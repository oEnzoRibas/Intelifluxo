import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { createSchema } from "../src/automations.js";
import {
  defaultGraph,
  graphSemantics,
  graphShape,
  type Graph,
} from "../src/graph.js";
const validate = (g: Graph, active = false) =>
  graphSemantics(g, active, "receipt.v1", "record-receipt.v1");
const placeholder = (): Graph => ({
  version: 1,
  nodes: [
    defaultGraph().nodes[0],
    {
      id: "condition",
      kind: "condition",
      type: "condition-placeholder.v1",
      position: { x: 1, y: -1 },
    },
    defaultGraph().nodes[1],
  ],
  edges: [
    { source: "trigger", target: "condition" },
    { source: "condition", target: "action" },
  ],
});
describe("graph v1 validation", () => {
  it("accepts either order and blocks placeholder activation", () => {
    const g = placeholder();
    expect(graphShape(g)).toEqual([]);
    expect(validate(g)).toEqual([]);
    expect(validate(g, true)).toEqual([
      {
        code: "non_executable_graph",
        path: "/graph/nodes/1",
        nodeId: "condition",
      },
    ]);
    g.nodes.reverse();
    g.edges.reverse();
    expect(validate(g)).toEqual([]);
  });
  it("rejects shapes, unknown types and versions", () => {
    expect(graphShape(null)[0].code).toBe("invalid_shape");
    expect(graphShape({ version: 2, nodes: null, edges: null })[0].code).toBe(
      "unsupported_graph_version",
    );
    const g = defaultGraph();
    (g.nodes[0] as { type: string }).type = "http";
    expect(graphShape(g)[0].code).toBe("unsupported_node_type");
    g.nodes[0].position.x = Infinity;
    expect(graphShape(g)[0].code).toBe("invalid_shape");
  });
  it("checks a present unsupported version before v1 root shape", () => {
    for (const graph of [
      { version: 2 },
      { version: 2, nodes: [], edges: [], extra: true },
      { version: null, extra: true },
    ])
      expect(graphShape(graph)).toEqual([
        { code: "unsupported_graph_version", path: "/graph/version" },
      ]);
    expect(graphShape({ nodes: [], edges: [] })).toEqual([
      { code: "invalid_shape", path: "/graph" },
    ]);
  });
  it("keeps published node schema and server kind/type allowlists in parity", async () => {
    const app = Fastify();
    app.post(
      "/",
      { schema: { body: createSchema.properties.graph } },
      async () => ({ ok: true }),
    );
    const kinds = ["trigger", "action", "condition", "other"];
    const types = [
      "receipt.v1",
      "record-receipt.v1",
      "condition-placeholder.v1",
      "other",
    ];
    for (const kind of kinds)
      for (const type of types) {
        const g = defaultGraph();
        const node = { id: "test", kind, type, position: { x: 0, y: 0 } };
        const graph = { ...g, nodes: [node, g.nodes[1]] };
        const allowed =
          (kind === "trigger" && type === "receipt.v1") ||
          (kind === "action" && type === "record-receipt.v1") ||
          (kind === "condition" && type === "condition-placeholder.v1");
        expect(graphShape(graph).length === 0, `${kind}/${type} server`).toBe(
          allowed,
        );
        expect(
          (await app.inject({ method: "POST", url: "/", payload: graph }))
            .statusCode === 200,
          `${kind}/${type} schema`,
        ).toBe(allowed);
      }
    await app.close();
  });
  it("orders semantic stages and rejects identity, cycle and topology failures", () => {
    const duplicate = defaultGraph();
    duplicate.nodes[1].id = "trigger";
    expect(
      validate(duplicate).some((i) => i.code === "duplicate_node_id"),
    ).toBe(true);
    const dangling = defaultGraph();
    dangling.edges[0].target = "missing";
    expect(validate(dangling)[0].code).toBe("dangling_edge");
    const cycle = defaultGraph();
    cycle.edges.push({ source: "action", target: "trigger" });
    expect(validate(cycle)[0].code).toBe("cycle_detected");
    const disconnected = defaultGraph();
    disconnected.edges = [];
    expect(validate(disconnected)[0].code).toBe("invalid_topology");
    expect(
      graphSemantics(defaultGraph(), false, "other", "record-receipt.v1")[0]
        .code,
    ).toBe("projection_mismatch");
  });
});
