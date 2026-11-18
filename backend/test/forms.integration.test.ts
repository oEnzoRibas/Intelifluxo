import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { Message } from "amqplib";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api } from "../src/api.js";
import { processMessage } from "../src/worker.js";
import type { FormConfig } from "../src/forms-contract.js";

describe.skipIf(process.env.INTEGRATION !== "1")(
  "form lifecycle and event acceptance PostgreSQL",
  () => {
    const schema = `forms_${randomUUID().replaceAll("-", "")}`;
    let admin: pg.Pool, pool: pg.Pool, app: ReturnType<typeof api>;
    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        options: `-c search_path=${schema}`,
      });
      const dir = new URL("../migrations/", import.meta.url);
      for (const name of (await readdir(dir))
        .filter((n) => n.endsWith(".sql"))
        .sort())
        await pool.query(await readFile(new URL(name, dir), "utf8"));
      await pool.query(await readFile(new URL("019_forms.sql", dir), "utf8"));
      app = api(pool, true, true, true, true);
    });
    afterAll(async () => {
      await app?.close();
      await pool?.end();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
      }
    });
    const config: FormConfig = {
      title: "Entrega BH",
      description: "Teste sintético",
      city: "Belo Horizonte",
      fields: [
        { key: "cep", label: "CEP", type: "cep", required: true },
        { key: "nome", label: "Nome", type: "text", required: true },
      ],
    };
    async function create() {
      const response = await app.inject({
        method: "POST",
        url: "/forms",
        payload: config,
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json();
    }
    async function change(
      f: { id: string; revision: number },
      published: boolean,
      patch = {},
    ) {
      return app.inject({
        method: "PUT",
        url: `/forms/${f.id}`,
        payload: {
          ...config,
          expectedRevision: f.revision,
          published,
          ...patch,
        },
      });
    }
    it("creates drafts, publishes, isolates matching, deduplicates concurrent sends and recovers after pause", async () => {
      const first = await create(),
        second = await create();
      const other = await change(second, true);
      expect(other.statusCode).toBe(200);
      const send = {
        expectedRevision: first.revision,
        idempotencyKey: randomUUID(),
        answers: { cep: "30140-071", nome: "Pessoa teste" },
      };
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/forms/${first.id}/submissions`,
            payload: send,
          })
        ).json().error,
      ).toBe("form_paused");
      const liveResponse = await change(first, true);
      expect(liveResponse.statusCode, liveResponse.body).toBe(200);
      const live = liveResponse.json();
      send.expectedRevision = live.revision;
      const submits = await Promise.all(
        [1, 2].map(() =>
          app.inject({
            method: "POST",
            url: `/forms/${first.id}/submissions`,
            payload: send,
          }),
        ),
      );
      expect(submits.map((r) => r.statusCode).sort()).toEqual([200, 202]);
      const eventId = submits[0].json().id;
      expect(submits[1].json().id).toBe(eventId);
      const executions = (
        await pool.query(
          "SELECT automation_id FROM automation_executions WHERE event_id=$1",
          [eventId],
        )
      ).rows;
      expect(executions).toEqual([{ automation_id: first.automationId }]);
      expect(
        (
          await pool.query("SELECT * FROM form_submissions WHERE event_id=$1", [
            eventId,
          ])
        ).rowCount,
      ).toBe(1);
      const conflict = await app.inject({
        method: "POST",
        url: `/forms/${first.id}/submissions`,
        payload: {
          ...send,
          answers: { ...send.answers, nome: "Outra pessoa" },
        },
      });
      expect(conflict.statusCode).toBe(409);
      expect(
        (await change(live, true, { city: "São Paulo" })).json().error,
      ).toBe("pause_before_edit");
      const paused = await change(live, false);
      expect(paused.statusCode).toBe(200);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/forms/${first.id}/submissions`,
            payload: send,
          })
        ).statusCode,
      ).toBe(200);
      expect((await change(live, true)).json().error).toBe("revision_conflict");
      await processMessage(
        pool,
        {
          content: Buffer.from(JSON.stringify({ version: 1, eventId })),
        } as Message,
        undefined,
        {
          viacepExternalExecutionEnabled: true,
          viacepLookup: async (cep) => ({
            status: "found",
            address: { cep, localidade: "Belo Horizonte", uf: "MG" },
          }),
        },
      );
      const execution = (
        await pool.query(
          "SELECT result FROM automation_executions WHERE event_id=$1",
          [eventId],
        )
      ).rows[0];
      expect(execution.result).toMatchObject({
        decision: { outcome: "TRUE" },
        action: { status: "executed" },
        lookup: { address: { localidade: "Belo Horizonte" } },
      });
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/forms/${first.id}/submissions`,
          })
        ).json().items,
      ).toHaveLength(1);
    });
    it("rejects stale and invalid answers, rolls back on failure and pauses external writes with gates", async () => {
      const form = (await change(await create(), true)).json();
      const submit = (
        answers: Record<string, string>,
        revision = form.revision,
      ) =>
        app.inject({
          method: "POST",
          url: `/forms/${form.id}/submissions`,
          payload: {
            expectedRevision: revision,
            idempotencyKey: randomUUID(),
            answers,
          },
        });
      expect((await submit({ cep: "30140071" })).statusCode).toBe(400);
      expect((await submit({ cep: "123", nome: "Teste" })).statusCode).toBe(
        400,
      );
      expect(
        (await submit({ cep: "30140071", nome: "Teste", extra: "x" }))
          .statusCode,
      ).toBe(400);
      expect(
        (await submit({ cep: "30140071", nome: "Teste" }, 1)).statusCode,
      ).toBe(409);
      const disabled = api(pool, true, true, true, false);
      expect(
        (
          await disabled.inject({
            method: "POST",
            url: `/forms/${form.id}/submissions`,
            payload: {
              expectedRevision: form.revision,
              idempotencyKey: randomUUID(),
              answers: { cep: "30140071", nome: "Teste" },
            },
          })
        ).statusCode,
      ).toBe(503);
      await disabled.close();
      expect(
        (
          await pool.query("SELECT * FROM form_submissions WHERE form_id=$1", [
            form.id,
          ])
        ).rowCount,
      ).toBe(0);
    });
    it("keeps FALSE results and field labels tied to the submitted revision", async () => {
      const form = (await change(await create(), true)).json();
      const accepted = await app.inject({
        method: "POST",
        url: `/forms/${form.id}/submissions`,
        payload: {
          expectedRevision: form.revision,
          idempotencyKey: randomUUID(),
          answers: { cep: "01001000", nome: "Teste fora de BH" },
        },
      });
      expect(accepted.statusCode).toBe(202);
      const eventId = accepted.json().id;
      const paused = (await change(form, false)).json();
      expect(
        (
          await change(paused, false, {
            fields: [
              { ...config.fields[0] },
              { ...config.fields[1], label: "Nome alterado" },
            ],
          })
        ).statusCode,
      ).toBe(200);
      await processMessage(
        pool,
        {
          content: Buffer.from(JSON.stringify({ version: 1, eventId })),
        } as Message,
        undefined,
        {
          viacepExternalExecutionEnabled: true,
          viacepLookup: async (cep) => ({
            status: "found",
            address: { cep, localidade: "São Paulo", uf: "SP" },
          }),
        },
      );
      const execution = (
        await pool.query(
          "SELECT result FROM automation_executions WHERE event_id=$1",
          [eventId],
        )
      ).rows[0];
      expect(execution.result).toMatchObject({
        decision: { outcome: "FALSE" },
        action: { status: "ignored" },
      });
      const history = (
        await app.inject({
          method: "GET",
          url: `/forms/${form.id}/submissions`,
        })
      ).json().items[0];
      expect(history.fields[1].label).toBe("Nome");
      expect(history.revision).toBe(form.revision);
    });
    it("rolls acceptance back when recording the form submission fails", async () => {
      const form = (await change(await create(), true)).json();
      const key = randomUUID();
      await pool.query(
        "CREATE FUNCTION reject_form_submission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rollback'; END $$; CREATE TRIGGER reject_submission BEFORE INSERT ON form_submissions FOR EACH ROW EXECUTE FUNCTION reject_form_submission()",
      );
      try {
        const response = await app.inject({
          method: "POST",
          url: `/forms/${form.id}/submissions`,
          payload: {
            expectedRevision: form.revision,
            idempotencyKey: key,
            answers: { cep: "30140071", nome: "Rollback teste" },
          },
        });
        expect(response.statusCode).toBe(500);
        expect(
          (
            await pool.query("SELECT id FROM events WHERE idempotency_key=$1", [
              key,
            ])
          ).rowCount,
        ).toBe(0);
      } finally {
        await pool.query(
          "DROP TRIGGER reject_submission ON form_submissions; DROP FUNCTION reject_form_submission()",
        );
      }
    });
    it("connects future Google Forms, authenticates webhooks, deduplicates responses and revokes old keys", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/forms/google-connections",
        payload: {
          title: "Google teste",
          city: "Belo Horizonte",
          formUrl: "https://docs.google.com/forms/d/example/edit",
          cepQuestion: "CEP",
          messageQuestion: "Observação",
          publicBaseUrl: "",
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const connection = created.json();
      expect(connection.configured).toBe(false);
      expect(created.body).not.toContain("token_hash");
      const setup = await app.inject({
        method: "POST",
        url: `/forms/google-connections/${connection.id}/setup`,
        payload: { publicBaseUrl: "https://integration.example.test" },
      });
      expect(setup.statusCode).toBe(200);
      const script = setup.json().script as string;
      const settings = JSON.parse(
        script.match(/const IF_CONFIG = ([\s\S]*?);\n/)![1],
      ) as { token: string };
      const f = (
        await app.inject({ method: "GET", url: `/forms/${connection.formId}` })
      ).json();
      const { title, description, city, fields } = f;
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `/forms/${f.id}`,
            payload: {
              title,
              description,
              city,
              fields,
              expectedRevision: f.revision,
              published: true,
            },
          })
        ).statusCode,
      ).toBe(200);
      const url = `/integrations/google-forms/${connection.id}/submissions`;
      const payload = {
        responseId: "google-response-stable-id",
        cep: "30140-071",
        message: "Resposta de teste",
      };
      expect(
        (await app.inject({ method: "POST", url, payload })).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "POST",
            url,
            headers: { authorization: "Bearer wrong" },
            payload,
          })
        ).statusCode,
      ).toBe(401);
      const headers = { authorization: `Bearer ${settings.token}` };
      const accepted = await app.inject({
        method: "POST",
        url,
        headers,
        payload,
      });
      expect(accepted.statusCode, accepted.body).toBe(202);
      const replay = await app.inject({
        method: "POST",
        url,
        headers,
        payload,
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json().id).toBe(accepted.json().id);
      expect(
        (
          await app.inject({
            method: "POST",
            url,
            headers,
            payload: { ...payload, message: "Alterada" },
          })
        ).statusCode,
      ).toBe(409);
      const listed = await app.inject({
        method: "GET",
        url: "/forms/google-connections",
      });
      expect(listed.json().items[0].lastEventId).toBe(accepted.json().id);
      expect(listed.body).not.toContain(settings.token);
      expect(listed.body).not.toContain("token_hash");
      const rotated = await app.inject({
        method: "POST",
        url: `/forms/google-connections/${connection.id}/setup`,
        payload: { publicBaseUrl: "https://integration.example.test" },
      });
      expect(rotated.statusCode).toBe(200);
      expect(
        (await app.inject({ method: "POST", url, headers, payload }))
          .statusCode,
      ).toBe(401);
      const entry = (
        await app.inject({ method: "GET", url: "/forms/google-connections" })
      ).json().items[0];
      expect(entry.lastReceivedAt).toBeNull();
      const invalid = await app.inject({
        method: "POST",
        url: `/forms/google-connections/${connection.id}/setup`,
        payload: { publicBaseUrl: "http://localhost:3000" },
      });
      expect(invalid.statusCode).toBe(400);
    });
    it("detects an independently changed automation rather than silently sending to it", async () => {
      const form = (await change(await create(), true)).json();
      const definition = (
        await app.inject({
          method: "GET",
          url: `/automations/${form.automationId}`,
        })
      ).json();
      const { name, schemaVersion, trigger, action, graph } = definition;
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `/automations/${form.automationId}`,
            payload: {
              name,
              schemaVersion,
              trigger,
              action,
              graph,
              active: false,
              expectedRevision: definition.revision,
            },
          })
        ).statusCode,
      ).toBe(200);
      const response = await app.inject({
        method: "POST",
        url: `/forms/${form.id}/submissions`,
        payload: {
          expectedRevision: form.revision,
          idempotencyKey: randomUUID(),
          answers: { cep: "30140071", nome: "Teste" },
        },
      });
      expect(response.json().error).toBe("automation_changed");
    });
  },
);
