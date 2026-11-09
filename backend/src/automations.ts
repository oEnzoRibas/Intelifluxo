import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { validateGraphV2 } from "./graph-v2.js";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { transaction } from "./db.js";
import {
  defaultGraph,
  graphShape,
  graphSemantics,
  type Graph,
} from "./graph.js";

// PostgreSQL text cannot store NUL or unpaired UTF-16 surrogates.
const textPattern =
  "^(?=[\\s\\S]*\\S)(?:[^\\u0000\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])*(?![\\s\\S])";
const name = {
  type: "string",
  minLength: 1,
  maxLength: 200,
  pattern: textPattern,
};
const scope = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: textPattern,
};
const fixed = (value: string) => ({
  type: "object",
  additionalProperties: false,
  required: ["type"],
  properties: { type: { const: value } },
});
const fields = {
  name,
  schemaVersion: { enum: [1, 2] },
  trigger: fixed("receipt.v1"),
  action: fixed("record-receipt.v1"),
};
const graphSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "nodes", "edges"],
  properties: {
    version: { const: 1 },
    nodes: {
      type: "array",
      minItems: 2,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "type", "position"],
        properties: {
          id: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" },
          kind: { type: "string" },
          type: { type: "string" },
          position: {
            type: "object",
            additionalProperties: false,
            required: ["x", "y"],
            properties: {
              x: { type: "number", minimum: -10000, maximum: 10000 },
              y: { type: "number", minimum: -10000, maximum: 10000 },
            },
          },
        },
        oneOf: [
          {
            properties: {
              kind: { const: "trigger" },
              type: { const: "receipt.v1" },
            },
          },
          {
            properties: {
              kind: { const: "action" },
              type: { const: "record-receipt.v1" },
            },
          },
          {
            properties: {
              kind: { const: "condition" },
              type: { const: "condition-placeholder.v1" },
            },
          },
        ],
      },
    },
    edges: {
      type: "array",
      minItems: 1,
      maxItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source", "target"],
        properties: {
          source: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" },
          target: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" },
        },
      },
    },
  },
};
// Validation is performed by the graph validators; this schema also controls
// Fastify response serialization, so v2 config and ports must be declared.
const graphV2Schema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "nodes", "edges"],
  properties: {
    version: { const: 2 },
    nodes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "type", "position"],
        properties: {
          id: { type: "string" },
          kind: { type: "string" },
          type: { type: "string" },
          position: {
            type: "object",
            additionalProperties: false,
            required: ["x", "y"],
            properties: { x: { type: "number" }, y: { type: "number" } },
          },
          config: {
            type: "object",
            additionalProperties: true,
            properties: {
              fieldPath: { type: "string" },
              operator: { type: "string" },
              expectedType: { type: "string" },
              expectedValue: {},
            },
          },
        },
      },
    },
    edges: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source", "target"],
        properties: {
          source: { type: "string" },
          target: { type: "string" },
          sourcePort: { enum: ["TRUE", "FALSE"] },
        },
      },
    },
  },
};
const graphUnionSchema = { anyOf: [graphSchema, graphV2Schema] };
export const createSchema = {
  type: "object",
  additionalProperties: false,
  required: ["scope", ...Object.keys(fields)],
  properties: { scope, ...fields, graph: graphUnionSchema },
};
export const updateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expectedRevision", "active", ...Object.keys(fields)],
  properties: {
    expectedRevision: { type: "integer", minimum: 1, maximum: 2147483646 },
    active: { type: "boolean" },
    ...fields,
    graph: graphUnionSchema,
  },
};
export const params = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: {
      type: "string",
      pattern:
        "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\\s\\S])",
    },
  },
};
export const query = {
  type: "object",
  additionalProperties: false,
  required: ["scope"],
  properties: { scope },
};
export const response = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "scope",
    "revision",
    "name",
    "active",
    "schemaVersion",
    "trigger",
    "action",
    "createdAt",
    "graph",
  ],
  properties: {
    id: { type: "string" },
    scope,
    revision: { type: "integer" },
    name,
    active: { type: "boolean" },
    schemaVersion: { type: "integer" },
    trigger: fixed("receipt.v1"),
    action: fixed("record-receipt.v1"),
    createdAt: { type: "string" },
    graph: graphUnionSchema,
  },
};
type DefinitionGraph =
  Graph | { version: 2; nodes: unknown[]; edges: unknown[] };
const versionOf = (graph: unknown): unknown =>
  graph && typeof graph === "object"
    ? (graph as { version?: unknown }).version
    : undefined;
function shape(graph: unknown, trigger: string, action: string) {
  return versionOf(graph) === 2
    ? validateGraphV2(graph, trigger, action, true)
    : graphShape(graph);
}
function semantics(
  graph: DefinitionGraph,
  active: boolean,
  trigger: string,
  action: string,
) {
  return graph.version === 2
    ? validateGraphV2(graph, trigger, action)
    : graphSemantics(graph, active, trigger, action);
}
const issue = (code: string, path = "/graph") => [{ code, path }];
type Input = {
  name: string;
  schemaVersion: 1 | 2;
  trigger: { type: "receipt.v1" };
  action: { type: "record-receipt.v1" };
  graph?: DefinitionGraph;
};
type Create = Input & { scope: string };
type Update = Input & { expectedRevision: number; active: boolean };
type Row = {
  id: string;
  scope: string;
  revision: number;
  name: string;
  active: boolean;
  schema_version: number;
  trigger_type: string;
  action_type: string;
  created_at: Date;
  graph: DefinitionGraph | null;
};
const select = `SELECT d.id,d.scope,r.revision,r.name,r.active,r.schema_version,r.trigger_type,r.action_type,r.created_at,r.graph FROM automation_definitions d JOIN automation_definition_revisions r ON r.automation_id=d.id AND r.revision=d.current_revision`;
function output(row: Row) {
  return {
    id: row.id,
    scope: row.scope,
    revision: row.revision,
    name: row.name,
    active: row.active,
    schemaVersion: row.schema_version,
    trigger: { type: row.trigger_type },
    action: { type: row.action_type },
    createdAt: row.created_at.toISOString(),
    graph: row.graph ?? defaultGraph(),
  };
}
async function insertRevision(
  client: pg.PoolClient,
  id: string,
  revision: number,
  input: Input,
  active: boolean,
  graph: DefinitionGraph,
) {
  await client.query(
    `INSERT INTO automation_definition_revisions (automation_id,revision,name,active,schema_version,trigger_type,action_type,graph) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id,
      revision,
      input.name,
      active,
      input.schemaVersion,
      input.trigger.type,
      input.action.type,
      JSON.stringify(graph),
    ],
  );
}
export function automationRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  conditionsEnabled = false,
) {
  // Graph shape is validated separately to preserve graph-specific error codes.
  const bodySchema = (schema: typeof createSchema | typeof updateSchema) => ({
    ...schema,
    properties: { ...schema.properties, graph: {} },
  });
  app.post<{ Body: Create }>(
    "/automations",
    { schema: { body: bodySchema(createSchema), response: { 201: response } } },
    async (request, reply) => {
      if (request.body.schemaVersion === 2 && request.body.graph === undefined)
        return reply.code(400).send({
          error: "validation_failed",
          issues: issue("graph_required"),
        });
      const graph =
        request.body.graph === undefined ? defaultGraph() : request.body.graph;
      const issues = shape(
        graph,
        request.body.trigger.type,
        request.body.action.type,
      );
      if (issues.length)
        return reply.code(400).send({ error: "validation_failed", issues });
      const semantic = semantics(
        graph,
        false,
        request.body.trigger.type,
        request.body.action.type,
      );
      if (semantic.length)
        return reply
          .code(400)
          .send({ error: "validation_failed", issues: semantic });
      if (graph.version !== request.body.schemaVersion)
        return reply.code(400).send({
          error: "validation_failed",
          issues: issue("execution_schema_mismatch"),
        });
      if (graph.version === 2 && !conditionsEnabled)
        return reply.code(400).send({
          error: "validation_failed",
          issues: issue("conditions_disabled"),
        });
      const id = randomUUID();
      const row = await transaction(pool, async (client) => {
        await client.query(
          "INSERT INTO automation_definitions(id,scope,current_revision) VALUES ($1,$2,1)",
          [id, request.body.scope],
        );
        await insertRevision(client, id, 1, request.body, false, graph);
        return (await client.query<Row>(`${select} WHERE d.id=$1`, [id]))
          .rows[0];
      });
      return reply.code(201).send(output(row));
    },
  );
  app.get<{ Querystring: { scope: string } }>(
    "/automations",
    {
      schema: {
        querystring: query,
        response: {
          200: {
            type: "object",
            required: ["items"],
            properties: { items: { type: "array", items: response } },
          },
        },
      },
    },
    async (request) => {
      const rows = await pool.query<Row>(
        `${select} WHERE d.scope=$1 ORDER BY d.id LIMIT 100`,
        [request.query.scope],
      );
      return { items: rows.rows.map(output) };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/automations/:id",
    { schema: { params, response: { 200: response } } },
    async (request, reply) => {
      const result = await pool.query<Row>(`${select} WHERE d.id=$1`, [
        request.params.id,
      ]);
      if (!result.rowCount) return reply.code(404).send({ error: "not_found" });
      return output(result.rows[0]);
    },
  );
  app.put<{ Params: { id: string }; Body: Update }>(
    "/automations/:id",
    {
      schema: {
        params,
        body: bodySchema(updateSchema),
        response: { 200: response },
      },
    },
    async (request, reply) => {
      if (request.body.graph !== undefined) {
        const issues = shape(
          request.body.graph,
          request.body.trigger.type,
          request.body.action.type,
        );
        if (issues.length)
          return reply.code(400).send({ error: "validation_failed", issues });
      }
      const result = await transaction(pool, async (client) => {
        const current = await client.query<{ current_revision: number }>(
          "SELECT current_revision FROM automation_definitions WHERE id=$1 FOR UPDATE",
          [request.params.id],
        );
        if (!current.rowCount) return { error: "not_found" as const };
        if (current.rows[0].current_revision !== request.body.expectedRevision)
          return { error: "revision_conflict" as const };
        const existing = await client.query<Row>(`${select} WHERE d.id=$1`, [
          request.params.id,
        ]);
        if (
          request.body.graph === undefined &&
          (request.body.schemaVersion === 2 ||
            existing.rows[0].schema_version === 2)
        )
          return { issues: issue("graph_required") };
        const graph =
          request.body.graph ?? existing.rows[0].graph ?? defaultGraph();
        const issues = semantics(
          graph,
          request.body.active,
          request.body.trigger.type,
          request.body.action.type,
        );
        if (issues.length) return { issues };
        if (graph.version !== request.body.schemaVersion)
          return { issues: issue("execution_schema_mismatch") };
        if (
          existing.rows[0].schema_version === 2 &&
          graph.version === 1 &&
          request.body.active
        )
          return { issues: issue("execution_schema_mismatch") };
        if (
          !conditionsEnabled &&
          (graph.version === 2 || existing.rows[0].schema_version === 2) &&
          (request.body.active ||
            !isDeepStrictEqual(graph, existing.rows[0].graph) ||
            graph.version !== existing.rows[0].schema_version)
        )
          return { issues: issue("conditions_disabled") };
        const next = request.body.expectedRevision + 1;
        await insertRevision(
          client,
          request.params.id,
          next,
          request.body,
          request.body.active,
          graph,
        );
        await client.query(
          "UPDATE automation_definitions SET current_revision=$2 WHERE id=$1",
          [request.params.id, next],
        );
        return {
          row: (
            await client.query<Row>(`${select} WHERE d.id=$1`, [
              request.params.id,
            ])
          ).rows[0],
        };
      });
      if ("issues" in result && result.issues)
        return reply
          .code(400)
          .send({ error: "validation_failed", issues: result.issues });
      if ("error" in result)
        return reply
          .code(result.error === "not_found" ? 404 : 409)
          .send({ error: result.error });
      return output(result.row);
    },
  );
}
