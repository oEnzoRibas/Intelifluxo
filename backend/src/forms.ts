import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { transaction } from "./db.js";
import { acceptInTransaction } from "./accept.js";
import {
  formData,
  formGraph,
  validForm,
  type FormConfig,
} from "./forms-contract.js";
import { validEventData } from "./contract.js";

type StoredForm = FormConfig & {
  google_connection_id?: string | null;
  id: string;
  automation_id: string;
  revision: number;
  published: boolean;
  created_at: Date;
  updated_at: Date;
};
const properties = {
  title: { type: "string", minLength: 1, maxLength: 160 },
  description: { type: "string", maxLength: 500 },
  city: { type: "string", minLength: 1, maxLength: 100 },
  fields: {
    type: "array",
    minItems: 1,
    maxItems: 12,
    items: {
      type: "object",
      additionalProperties: false,
      required: ["key", "label", "type", "required"],
      properties: {
        key: { type: "string", pattern: "^[a-z][a-z0-9_]{0,31}$" },
        label: { type: "string", minLength: 1, maxLength: 80 },
        type: { enum: ["text", "textarea", "email", "cep"] },
        required: { type: "boolean" },
      },
    },
  },
};
const params = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
};
function output(f: StoredForm) {
  return {
    source: f.google_connection_id ? "google-forms" : "native",
    id: f.id,
    automationId: f.automation_id,
    revision: f.revision,
    title: f.title,
    description: f.description,
    city: f.city,
    fields: f.fields,
    published: f.published,
    createdAt: f.created_at.toISOString(),
    updatedAt: f.updated_at.toISOString(),
  };
}
async function revision(
  client: pg.PoolClient,
  id: string,
  rev: number,
  config: FormConfig,
  active: boolean,
) {
  await client.query(
    "INSERT INTO automation_definition_revisions(automation_id,revision,name,active,schema_version,trigger_type,action_type,graph) VALUES ($1,$2,$3,$4,3,'receipt.v1','record-receipt.v1',$5::jsonb)",
    [id, rev, config.title, active, JSON.stringify(formGraph(config.city))],
  );
}
export async function insertManagedForm(
  client: pg.PoolClient,
  config: FormConfig,
) {
  const id = randomUUID(),
    automationId = randomUUID();
  await client.query(
    "INSERT INTO automation_definitions(id,scope,current_revision) VALUES ($1,$2,1)",
    [automationId, `form_${id.replaceAll("-", "")}`],
  );
  await revision(client, automationId, 1, config, false);
  return (
    await client.query<StoredForm>(
      "INSERT INTO forms(id,automation_id,title,description,city,fields) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING *",
      [
        id,
        automationId,
        config.title,
        config.description,
        config.city,
        JSON.stringify(config.fields),
      ],
    )
  ).rows[0];
}
export function formsRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  gates: {
    snapshots: boolean;
    conditions: boolean;
    writes: boolean;
    external: boolean;
  },
) {
  const writable = () => gates.snapshots && gates.conditions && gates.writes;
  app.get("/forms", async () => ({
    items: (
      await pool.query<StoredForm>(
        "SELECT f.*,c.id AS google_connection_id FROM forms f LEFT JOIN google_form_connections c ON c.form_id=f.id ORDER BY f.created_at DESC,f.id DESC LIMIT 100",
      )
    ).rows.map(output),
  }));
  app.get<{ Params: { id: string } }>(
    "/forms/:id",
    { schema: { params } },
    async (req, reply) => {
      const f = (
        await pool.query<StoredForm>("SELECT * FROM forms WHERE id=$1", [
          req.params.id,
        ])
      ).rows[0];
      return f ? output(f) : reply.code(404).send({ error: "not_found" });
    },
  );
  app.post<{ Body: FormConfig }>(
    "/forms",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: Object.keys(properties),
          properties,
        },
      },
    },
    async (req, reply) => {
      if (!writable()) return reply.code(503).send({ error: "forms_disabled" });
      if (!validForm(req.body))
        return reply.code(400).send({ error: "invalid_form" });
      const f = await transaction(pool, (client) =>
        insertManagedForm(client, req.body),
      );
      return reply.code(201).send(output(f));
    },
  );
  app.put<{
    Params: { id: string };
    Body: FormConfig & { expectedRevision: number; published: boolean };
  }>(
    "/forms/:id",
    {
      schema: {
        params,
        body: {
          type: "object",
          additionalProperties: false,
          required: [
            ...Object.keys(properties),
            "expectedRevision",
            "published",
          ],
          properties: {
            ...properties,
            expectedRevision: {
              type: "integer",
              minimum: 1,
              maximum: 2147483646,
            },
            published: { type: "boolean" },
          },
        },
      },
    },
    async (req, reply) => {
      if (!writable() || (req.body.published && !gates.external))
        return reply.code(503).send({ error: "forms_disabled" });
      if (!validForm(req.body))
        return reply.code(400).send({ error: "invalid_form" });
      const result = await transaction(pool, async (client) => {
        const f = (
          await client.query<StoredForm>(
            "SELECT * FROM forms WHERE id=$1 FOR UPDATE",
            [req.params.id],
          )
        ).rows[0];
        if (!f) return { error: "not_found" as const };
        if (f.revision !== req.body.expectedRevision)
          return { error: "revision_conflict" as const };
        const config = ({ title, description, city, fields }: FormConfig) => ({
          title,
          description,
          city,
          fields,
        });
        if (f.published && !isDeepStrictEqual(config(f), config(req.body)))
          return { error: "pause_before_edit" as const };
        const current = (
          await client.query<{ current_revision: number }>(
            "SELECT current_revision FROM automation_definitions WHERE id=$1 FOR UPDATE",
            [f.automation_id],
          )
        ).rows[0].current_revision;
        await revision(
          client,
          f.automation_id,
          current + 1,
          req.body,
          req.body.published,
        );
        await client.query(
          "UPDATE automation_definitions SET current_revision=$2 WHERE id=$1",
          [f.automation_id, current + 1],
        );
        const updated = (
          await client.query<StoredForm>(
            "UPDATE forms SET revision=revision+1,title=$2,description=$3,city=$4,fields=$5::jsonb,published=$6,updated_at=now() WHERE id=$1 RETURNING *",
            [
              f.id,
              req.body.title,
              req.body.description,
              req.body.city,
              JSON.stringify(req.body.fields),
              req.body.published,
            ],
          )
        ).rows[0];
        return { form: output(updated) };
      });
      if (result.error)
        return reply
          .code(result.error === "not_found" ? 404 : 409)
          .send(result);
      return result.form;
    },
  );
  app.post<{
    Params: { id: string };
    Body: {
      expectedRevision: number;
      idempotencyKey: string;
      answers: Record<string, string>;
    };
  }>(
    "/forms/:id/submissions",
    {
      schema: {
        params,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["expectedRevision", "idempotencyKey", "answers"],
          properties: {
            expectedRevision: { type: "integer", minimum: 1 },
            idempotencyKey: {
              type: "string",
              minLength: 1,
              maxLength: 128,
              pattern: "^[A-Za-z0-9_-]+$",
            },
            answers: {
              type: "object",
              maxProperties: 12,
              additionalProperties: { type: "string", maxLength: 500 },
            },
          },
        },
      },
    },
    async (req, reply) => {
      if (!writable() || !gates.external)
        return reply.code(503).send({ error: "forms_disabled" });
      const result = await transaction(pool, async (client) => {
        const f = (
          await client.query<StoredForm>(
            "SELECT * FROM forms WHERE id=$1 FOR SHARE",
            [req.params.id],
          )
        ).rows[0];
        if (!f) return { error: "not_found" as const };
        // Existing identities may be recovered after a form is paused or edited.
        const scope = `form_${f.id.replaceAll("-", "")}`;
        const previous = await client.query(
          "SELECT e.id,e.content FROM events e JOIN form_submissions s ON s.event_id=e.id WHERE s.form_id=$1 AND e.scope=$2 AND e.idempotency_key=$3",
          [f.id, scope, req.body.idempotencyKey],
        );
        if (previous.rowCount) {
          const row = previous.rows[0];
          const stored = row.content.data;
          if (
            stored.formRevision !== req.body.expectedRevision ||
            !isDeepStrictEqual(stored.answers, req.body.answers)
          )
            return { error: "idempotency_conflict" as const };
          return { id: row.id as string, replay: true };
        }
        if (!f.published) return { error: "form_paused" as const };
        if (f.revision !== req.body.expectedRevision)
          return { error: "revision_conflict" as const };
        const data = formData(f, req.body.answers);
        if (!data) return { error: "invalid_answers" as const };
        const definition = (
          await client.query(
            "SELECT r.active,r.graph,d.scope FROM automation_definitions d JOIN automation_definition_revisions r ON r.automation_id=d.id AND r.revision=d.current_revision WHERE d.id=$1 FOR SHARE OF d",
            [f.automation_id],
          )
        ).rows[0];
        if (
          !definition.active ||
          definition.scope !== scope ||
          !isDeepStrictEqual(definition.graph, formGraph(f.city))
        )
          return { error: "automation_changed" as const };
        const eventData = {
          ...data,
          formId: f.id,
          formRevision: f.revision,
        };
        if (!validEventData(eventData))
          return { error: "invalid_answers" as const };
        const accepted = await acceptInTransaction(
          client,
          {
            scope,
            idempotencyKey: req.body.idempotencyKey,
            type: "receipt.v1",
            target: "local-receipt",
            message: `Resposta: ${f.title}`,
            data: eventData,
          },
          true,
        );
        if (accepted.conflict)
          return { error: "idempotency_conflict" as const };
        await client.query(
          "INSERT INTO form_submissions(form_id,event_id,form_revision,fields) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING",
          [f.id, accepted.id, f.revision, JSON.stringify(f.fields)],
        );
        return { id: accepted.id, replay: accepted.replay };
      });
      if (result.error)
        return reply
          .code(
            result.error === "not_found"
              ? 404
              : result.error === "invalid_answers"
                ? 400
                : 409,
          )
          .send(result);
      return reply
        .code(result.replay ? 200 : 202)
        .send({ id: result.id, replay: result.replay });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/forms/:id/submissions",
    { schema: { params } },
    async (req, reply) => {
      const f = (
        await pool.query<StoredForm>("SELECT * FROM forms WHERE id=$1", [
          req.params.id,
        ])
      ).rows[0];
      if (!f) return reply.code(404).send({ error: "not_found" });
      const rows = await pool.query(
        "SELECT s.event_id AS id,s.form_revision AS revision,s.created_at AS \"createdAt\",s.fields,e.content->'data'->'answers' AS answers FROM form_submissions s JOIN events e ON e.id=s.event_id WHERE s.form_id=$1 ORDER BY s.created_at DESC,s.event_id DESC LIMIT 100",
        [f.id],
      );
      return { items: rows.rows };
    },
  );
}
