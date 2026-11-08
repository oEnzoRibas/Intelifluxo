import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { transaction } from "./db.js";

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
  schemaVersion: { const: 1 },
  trigger: fixed("receipt.v1"),
  action: fixed("record-receipt.v1"),
};
export const createSchema = {
  type: "object",
  additionalProperties: false,
  required: ["scope", ...Object.keys(fields)],
  properties: { scope, ...fields },
};
export const updateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expectedRevision", "active", ...Object.keys(fields)],
  properties: {
    expectedRevision: { type: "integer", minimum: 1, maximum: 2147483646 },
    active: { type: "boolean" },
    ...fields,
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
  },
};
type Input = {
  name: string;
  schemaVersion: 1;
  trigger: { type: "receipt.v1" };
  action: { type: "record-receipt.v1" };
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
};
const select = `SELECT d.id,d.scope,r.revision,r.name,r.active,r.schema_version,r.trigger_type,r.action_type,r.created_at FROM automation_definitions d JOIN automation_definition_revisions r ON r.automation_id=d.id AND r.revision=d.current_revision`;
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
  };
}
async function insertRevision(
  client: pg.PoolClient,
  id: string,
  revision: number,
  input: Input,
  active: boolean,
) {
  await client.query(
    `INSERT INTO automation_definition_revisions (automation_id,revision,name,active,schema_version,trigger_type,action_type) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      id,
      revision,
      input.name,
      active,
      input.schemaVersion,
      input.trigger.type,
      input.action.type,
    ],
  );
}
export function automationRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.post<{ Body: Create }>(
    "/automations",
    { schema: { body: createSchema, response: { 201: response } } },
    async (request, reply) => {
      const id = randomUUID();
      const row = await transaction(pool, async (client) => {
        await client.query(
          "INSERT INTO automation_definitions(id,scope,current_revision) VALUES ($1,$2,1)",
          [id, request.body.scope],
        );
        await insertRevision(client, id, 1, request.body, false);
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
    { schema: { params, body: updateSchema, response: { 200: response } } },
    async (request, reply) => {
      const result = await transaction(pool, async (client) => {
        const current = await client.query<{ current_revision: number }>(
          "SELECT current_revision FROM automation_definitions WHERE id=$1 FOR UPDATE",
          [request.params.id],
        );
        if (!current.rowCount) return { error: "not_found" as const };
        if (current.rows[0].current_revision !== request.body.expectedRevision)
          return { error: "revision_conflict" as const };
        const next = request.body.expectedRevision + 1;
        await insertRevision(
          client,
          request.params.id,
          next,
          request.body,
          request.body.active,
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
      if ("error" in result)
        return reply
          .code(result.error === "not_found" ? 404 : 409)
          .send({ error: result.error });
      return output(result.row);
    },
  );
}
