import type { FastifyInstance } from "fastify";
import type pg from "pg";

const textPattern =
  "^(?=[\\s\\S]*\\S)(?:[^\\u0000\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])*(?![\\s\\S])";
const uuidPattern =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\\s\\S])";
const text = (maxLength: number) => ({
  type: "string",
  minLength: 1,
  maxLength,
  pattern: textPattern,
});
const uuid = { type: "string", pattern: uuidPattern };
export const listQuery = {
  type: "object",
  additionalProperties: false,
  properties: {
    scope: text(128),
    q: text(200),
    active: { enum: ["true", "false"] },
    limit: { type: "string", pattern: "^(?:[1-9][0-9]?|100)(?![\\s\\S])" },
    cursor: uuid,
  },
};
export const listResponse = {
  type: "object",
  additionalProperties: false,
  required: ["items", "nextCursor"],
  properties: {
    items: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "name",
          "scope",
          "active",
          "revision",
          "schemaVersion",
          "workflowVersion",
        ],
        properties: {
          id: uuid,
          name: text(200),
          scope: text(128),
          active: { type: "boolean" },
          revision: { type: "integer", minimum: 1, maximum: 2147483647 },
          schemaVersion: { enum: [1, 2] },
          workflowVersion: { enum: [1, 2] },
        },
      },
    },
    nextCursor: { anyOf: [uuid, { type: "null" }] },
  },
};
type SummaryRow = {
  id: string;
  name: string;
  scope: string;
  active: boolean;
  revision: number;
  schema_version: number;
  workflow_version: number;
};
const validText = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  [...value].length <= max &&
  new RegExp(textPattern).test(value);
const validUuid = (value: unknown): value is string =>
  typeof value === "string" && new RegExp(uuidPattern).test(value);

export function automationListRoute(app: FastifyInstance, pool: pg.Pool) {
  app.get<{ Querystring: Record<string, unknown> }>(
    "/automations/list",
    { schema: { response: { 200: listResponse } } },
    async (request, reply) => {
      const input = request.query;
      const invalid: string[] = [];
      for (const [key, value] of Object.entries(input)) {
        let valid = false;
        if (key === "scope") valid = validText(value, 128);
        if (key === "q") valid = validText(value, 200);
        if (key === "active") valid = value === "true" || value === "false";
        if (key === "limit")
          valid =
            typeof value === "string" &&
            /^(?:[1-9][0-9]?|100)(?![\s\S])/.test(value);
        if (key === "cursor") valid = validUuid(value);
        if (!valid)
          invalid.push(`/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`);
      }
      if (invalid.length)
        return reply.code(400).send({
          error: "validation_failed",
          issues: [...new Set(invalid)]
            .sort()
            .map((path) => ({ code: "invalid_shape", path })),
        });
      const values: unknown[] = [];
      const predicates: string[] = [];
      const bind = (value: unknown) => {
        values.push(value);
        return `$${values.length}`;
      };
      if (input.cursor !== undefined)
        predicates.push(`d.id > ${bind(input.cursor)}::uuid`);
      if (input.scope !== undefined)
        predicates.push(`d.scope = ${bind(input.scope)}::text`);
      if (input.active !== undefined)
        predicates.push(`r.active = ${bind(input.active === "true")}::boolean`);
      if (typeof input.q === "string") {
        const parameter = bind(`%${input.q.replace(/[!%_]/g, "!$&")}%`);
        predicates.push(
          `(r.name ILIKE ${parameter}::text ESCAPE '!' OR d.scope ILIKE ${parameter}::text ESCAPE '!')`,
        );
      }
      const limit = input.limit === undefined ? 25 : Number(input.limit);
      const sql = `SELECT d.id,d.scope,r.name,r.active,r.revision,r.schema_version, CASE WHEN r.graph IS NULL THEN 1 ELSE (r.graph->>'version')::integer END AS workflow_version FROM automation_definitions d JOIN automation_definition_revisions r ON r.automation_id=d.id AND r.revision=d.current_revision${predicates.length ? ` WHERE ${predicates.join(" AND ")}` : ""} ORDER BY d.id ASC LIMIT ${bind(limit + 1)}::integer`;
      const started = Date.now();
      try {
        const result = await pool.query<SummaryRow>(sql, values);
        for (const row of result.rows) {
          if (
            !validUuid(row.id) ||
            !validText(row.name, 200) ||
            !validText(row.scope, 128) ||
            typeof row.active !== "boolean" ||
            !Number.isInteger(row.revision) ||
            row.revision < 1 ||
            row.revision > 2147483647 ||
            ![1, 2].includes(row.schema_version) ||
            ![1, 2].includes(row.workflow_version)
          )
            throw new Error("invalid summary invariant");
        }
        const items = result.rows.slice(0, limit).map((row) => ({
          id: row.id,
          name: row.name,
          scope: row.scope,
          active: row.active,
          revision: row.revision,
          schemaVersion: row.schema_version,
          workflowVersion: row.workflow_version,
        }));
        request.log.info(
          {
            route: "/automations/list",
            durationMs: Date.now() - started,
            returnedRows: items.length,
          },
          "automation list completed",
        );
        return {
          items,
          nextCursor:
            result.rows.length > limit ? items[items.length - 1].id : null,
        };
      } catch {
        request.log.error(
          {
            route: "/automations/list",
            category: "storage_or_invariant",
            durationMs: Date.now() - started,
          },
          "automation list unavailable",
        );
        return reply.code(503).send({ error: "unavailable" });
      }
    },
  );
}
