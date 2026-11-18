import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { api } from "../src/api.js";
import { defaultGraph } from "../src/graph.js";
import { viacepExternalExecutionEnabled } from "../src/config.js";

const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
it("parses the external execution gate strictly", () => {
  expect(viacepExternalExecutionEnabled(undefined)).toBe(false);
  expect(viacepExternalExecutionEnabled("false")).toBe(false);
  expect(viacepExternalExecutionEnabled("true")).toBe(true);
  for (const value of ["", "TRUE", " true", "1"])
    expect(() => viacepExternalExecutionEnabled(value)).toThrow(
      "VIACEP_EXTERNAL_EXECUTION_ENABLED",
    );
});
const graph = () => ({
  version: 3,
  nodes: [
    { id: "t", kind: "trigger", type: "receipt.v1", position: { x: 0, y: 0 } },
    {
      id: "l",
      kind: "lookup",
      type: "viacep-address.v1",
      position: { x: 1, y: 0 },
      config: { cep: { source: "fixed", value: "01001-000" } },
    },
    {
      id: "c",
      kind: "condition",
      type: "condition.v2",
      position: { x: 2, y: 0 },
      config: {
        input: { source: "step", nodeId: "l", fieldPath: "address.uf" },
        operator: "equals",
        expectedType: "string",
        expectedValue: "SP",
      },
    },
    {
      id: "a",
      kind: "action",
      type: "record-receipt.v1",
      position: { x: 3, y: 0 },
    },
    { id: "e", kind: "end", type: "end.v1", position: { x: 4, y: 0 } },
  ],
  edges: [
    { source: "t", target: "l" },
    { source: "l", target: "c" },
    { source: "c", target: "a", sourcePort: "TRUE" },
    { source: "c", target: "e", sourcePort: "FALSE" },
    { source: "a", target: "e" },
  ],
});
const body = () => ({
  scope: "demo",
  name: "test",
  schemaVersion: 3,
  trigger: { type: "receipt.v1" },
  action: { type: "record-receipt.v1" },
  graph: graph(),
});
const updateBody = () => {
  const { name, schemaVersion, trigger, action, graph } = body();
  return { name, schemaVersion, trigger, action, graph };
};
const graphV2 = () => ({
  version: 2,
  nodes: [
    { id: "t", kind: "trigger", type: "receipt.v1", position: { x: 0, y: 0 } },
    {
      id: "c",
      kind: "condition",
      type: "condition.v1",
      position: { x: 1, y: 0 },
      config: {
        fieldPath: "data.value",
        operator: "equals",
        expectedType: "number",
        expectedValue: 42,
      },
    },
    {
      id: "a",
      kind: "action",
      type: "record-receipt.v1",
      position: { x: 2, y: 0 },
    },
    { id: "e", kind: "end", type: "end.v1", position: { x: 3, y: 0 } },
  ],
  edges: [
    { source: "t", target: "c" },
    { source: "c", sourcePort: "TRUE", target: "a" },
    { source: "c", sourcePort: "FALSE", target: "e" },
    { source: "a", target: "e" },
  ],
});
function storage() {
  let row = {
    id,
    scope: "demo",
    revision: 1,
    name: "test",
    active: true,
    schema_version: 3,
    trigger_type: "receipt.v1",
    action_type: "record-receipt.v1",
    created_at: new Date("2025-01-01T00:00:00Z"),
    graph: graph(),
  };
  const query = vi.fn(async (sql: string, args: unknown[] = []) => {
    if (sql.startsWith("SELECT current_revision"))
      return { rowCount: 1, rows: [{ current_revision: row.revision }] };
    if (sql.startsWith("INSERT INTO automation_definition_revisions")) {
      row = {
        ...row,
        revision: args[1] as number,
        name: args[2] as string,
        active: args[3] as boolean,
        schema_version: args[4] as number,
        graph: JSON.parse(args[7] as string),
      };
    }
    if (sql.startsWith("SELECT d.id")) return { rowCount: 1, rows: [row] };
    return { rowCount: 1, rows: [] };
  });
  const client = { query, release: vi.fn() };
  return {
    pool: { connect: vi.fn(async () => client), query } as unknown as pg.Pool,
    query,
  };
}
const writes = (mock: ReturnType<typeof storage>) =>
  mock.query.mock.calls.filter(
    ([s]) => s.startsWith("INSERT") || s.startsWith("UPDATE"),
  );

describe("ViaCEP definition API", () => {
  it("permits inactive saves and deactivation but rejects activation when outbound is disabled", async () => {
    const mock = storage();
    const app = api(mock.pool, false, true, true, false);
    const activation = await app.inject({
      method: "PUT",
      url: `/automations/${id}`,
      payload: { ...updateBody(), expectedRevision: 1, active: true },
    });
    expect(activation.statusCode).toBe(400);
    expect(activation.json()).toMatchObject({
      issues: [{ code: "viacep_external_execution_disabled" }],
    });
    expect(writes(mock)).toHaveLength(0);
    const deactivation = await app.inject({
      method: "PUT",
      url: `/automations/${id}`,
      payload: { ...updateBody(), expectedRevision: 1, active: false },
    });
    expect(deactivation.statusCode).toBe(200);
    const save = await app.inject({
      method: "PUT",
      url: `/automations/${id}`,
      payload: { ...updateBody(), expectedRevision: 2, active: false },
    });
    expect(save.statusCode).toBe(200);
    const created = await app.inject({
      method: "POST",
      url: "/automations",
      payload: body(),
    });
    expect(created.statusCode).toBe(201);
    await app.close();
  });
  it.each([
    [2, graphV2()],
    [1, defaultGraph()],
  ])(
    "rejects active v3 to v%i downgrade without writes",
    async (version, replacement) => {
      const mock = storage();
      const app = api(mock.pool, false, true, true, true);
      const input = updateBody();
      const result = await app.inject({
        method: "PUT",
        url: `/automations/${id}`,
        payload: {
          ...input,
          schemaVersion: version,
          graph: replacement,
          expectedRevision: 1,
          active: true,
        },
      });
      expect(result.statusCode).toBe(400);
      expect(result.json()).toMatchObject({
        error: "validation_failed",
        issues: [{ code: "execution_schema_mismatch" }],
      });
      expect(writes(mock)).toHaveLength(0);
      await app.close();
    },
  );
  it("allows an inactive full v3 to v2 replacement only with both gates enabled", async () => {
    for (const [conditions, viacep] of [
      [false, false],
      [false, true],
      [true, false],
      [true, true],
    ]) {
      const mock = storage();
      const app = api(mock.pool, false, conditions, viacep, true);
      const input = updateBody();
      const result = await app.inject({
        method: "PUT",
        url: `/automations/${id}`,
        payload: {
          ...input,
          schemaVersion: 2,
          graph: graphV2(),
          expectedRevision: 1,
          active: false,
        },
      });
      expect(result.statusCode).toBe(conditions && viacep ? 200 : 400);
      if (conditions && viacep) {
        expect(result.json()).toMatchObject({
          revision: 2,
          schemaVersion: 2,
          active: false,
          graph: graphV2(),
        });
        expect(writes(mock)).toHaveLength(2);
      } else {
        expect(writes(mock)).toHaveLength(0);
      }
      await app.close();
    }
  });
  it("checks conflicts first and still rejects graph/schema mismatch on updates", async () => {
    const mock = storage();
    const app = api(mock.pool, false, true, true, true);
    const input = updateBody();
    const payload = {
      ...input,
      schemaVersion: 2,
      graph: defaultGraph(),
      expectedRevision: 2,
      active: false,
    };
    const conflict = await app.inject({
      method: "PUT",
      url: `/automations/${id}`,
      payload,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: "revision_conflict" });
    const mismatch = await app.inject({
      method: "PUT",
      url: `/automations/${id}`,
      payload: { ...payload, expectedRevision: 1 },
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json()).toMatchObject({
      error: "validation_failed",
      issues: [{ code: "execution_schema_mismatch" }],
    });
    expect(writes(mock)).toHaveLength(0);
    await app.close();
  });
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    "enforces update gates conditions=%s viacep=%s",
    async (conditions, viacep) => {
      const mock = storage();
      const app = api(mock.pool, false, conditions, viacep, true);
      const {
        name,
        schemaVersion,
        trigger,
        action,
        graph: definitionGraph,
      } = body();
      const result = await app.inject({
        method: "PUT",
        url: `/automations/${id}`,
        payload: {
          name,
          schemaVersion,
          trigger,
          action,
          graph: definitionGraph,
          expectedRevision: 1,
          active: true,
        },
      });
      expect(result.statusCode).toBe(conditions && viacep ? 200 : 400);
      if (!conditions || !viacep) expect(writes(mock)).toHaveLength(0);
      await app.close();
    },
  );
  it("rejects an invalid ViaCEP startup flag", () => {
    const previous = process.env.VIACEP_WRITES_ENABLED;
    try {
      process.env.VIACEP_WRITES_ENABLED = "TRUE";
      expect(() => api({} as pg.Pool, false, false)).toThrow(
        "VIACEP_WRITES_ENABLED",
      );
    } finally {
      if (previous === undefined) delete process.env.VIACEP_WRITES_ENABLED;
      else process.env.VIACEP_WRITES_ENABLED = previous;
    }
  });
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    "enforces create gates conditions=%s viacep=%s",
    async (conditions, viacep) => {
      const mock = storage();
      const app = api(mock.pool, false, conditions, viacep, true);
      const result = await app.inject({
        method: "POST",
        url: "/automations",
        payload: body(),
      });
      expect(result.statusCode).toBe(conditions && viacep ? 201 : 400);
      if (conditions && viacep) {
        expect(result.json().graph).toEqual(graph());
        expect(result.json().active).toBe(false);
      } else expect(writes(mock)).toHaveLength(0);
      await app.close();
    },
  );
  it("roundtrips updates and reads with gates off", async () => {
    const mock = storage();
    const app = api(mock.pool, false, true, true, true);
    const {
      name,
      schemaVersion,
      trigger,
      action,
      graph: definitionGraph,
    } = body();
    const data = {
      name,
      schemaVersion,
      trigger,
      action,
      graph: definitionGraph,
    };
    const updated = await app.inject({
      method: "PUT",
      url: `/automations/${id}`,
      payload: { ...data, expectedRevision: 1, active: true },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().graph).toEqual(graph());
    await app.close();
    const readApp = api(mock.pool, false, false, false);
    const result = await readApp.inject({
      method: "GET",
      url: `/automations/${id}`,
    });
    expect(result.json().graph).toEqual(graph());
    await readApp.close();
  });
  it("checks stale revisions before semantic and gate validation, and permits unchanged deactivation", async () => {
    const mock = storage();
    const app = api(mock.pool, false, false, false);
    const {
      name,
      schemaVersion,
      trigger,
      action,
      graph: definitionGraph,
    } = body();
    const data = {
      name,
      schemaVersion,
      trigger,
      action,
      graph: definitionGraph,
    };
    const invalid = graph();
    invalid.edges[0].target = "e";
    const conflict = await app.inject({
      method: "PUT",
      url: `/automations/${id}`,
      payload: { ...data, graph: invalid, expectedRevision: 2, active: true },
    });
    expect(conflict.statusCode).toBe(409);
    expect(writes(mock)).toHaveLength(0);
    const blocked = await app.inject({
      method: "PUT",
      url: `/automations/${id}`,
      payload: { ...data, expectedRevision: 1, active: true },
    });
    expect(blocked.statusCode).toBe(400);
    expect(writes(mock)).toHaveLength(0);
    const deactivated = await app.inject({
      method: "PUT",
      url: `/automations/${id}`,
      payload: { ...data, expectedRevision: 1, active: false },
    });
    expect(deactivated.statusCode).toBe(200);
    expect(deactivated.json().graph).toEqual(graph());
    await app.close();
  });
  it("rejects malformed graphs, configs, topology and endpoint fields without writes", async () => {
    const mock = storage();
    const app = api(mock.pool, false, true, true, true);
    const invalid = graph();
    invalid.edges[0].target = "e";
    const badConfig = graph();
    Object.assign(badConfig.nodes[1].config!, { url: "https://example.test" });
    const badRef = graph();
    badRef.nodes[2].config!.input!.nodeId = "t";
    const cases = [
      { ...body(), graph: null },
      { ...body(), graph: undefined },
      { ...body(), schemaVersion: 2 },
      { ...body(), graph: invalid },
      { ...body(), graph: badConfig },
      { ...body(), graph: badRef },
      { ...body(), action: { type: "record-receipt.v1", url: "x" } },
    ];
    for (const payload of cases) {
      const r = await app.inject({
        method: "POST",
        url: "/automations",
        payload,
      });
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
      expect(r.json().issues.length).toBeLessThanOrEqual(50);
    }
    expect(writes(mock)).toHaveLength(0);
    await app.close();
  });
  it("publishes v3 shape, versions, and exact configs", () => {
    const document = JSON.parse(
      readFileSync(
        new URL("../schemas/automation-v1.schema.json", import.meta.url),
        "utf8",
      ),
    );
    const validate = new Ajv({ strict: false }).compile(
      document.definitions.create,
    );
    const input = body();
    expect(validate(input)).toBe(true);
    const extra = body();
    Object.assign(extra.graph.nodes[1].config!, { url: "x" });
    expect(validate(extra)).toBe(false);
    expect(validate({ ...body(), graph: undefined })).toBe(false);
    expect(validate({ ...body(), schemaVersion: 2 })).toBe(false);
  });
});
