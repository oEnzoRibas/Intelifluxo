import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { transaction } from "./db.js";
import { insertManagedForm } from "./forms.js";
import { validForm } from "./forms-contract.js";
import { validEventData } from "./contract.js";

export function googleFormUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      u.hostname === "docs.google.com" &&
      !u.port &&
      !u.username &&
      !u.password &&
      /^\/forms\/d\/(?:e\/)?[A-Za-z0-9_-]+\/(?:edit|viewform)\/?$/.test(
        u.pathname,
      )
    );
  } catch {
    return false;
  }
}
export function publicBaseUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) &&
      u.pathname === "/"
    );
  } catch {
    return false;
  }
}
type Connection = {
  id: string;
  form_id: string;
  form_url: string;
  cep_question: string;
  message_question: string;
  public_base_url: string;
  token_hash: string | null;
  last_received_at: Date | null;
  last_event_id: string | null;
  title: string;
  city: string;
  published: boolean;
  revision: number;
};
const selection =
  "SELECT c.*,f.title,f.city,f.published,f.revision FROM google_form_connections c JOIN forms f ON f.id=c.form_id";
function output(c: Connection) {
  return {
    id: c.id,
    formId: c.form_id,
    formUrl: c.form_url,
    cepQuestion: c.cep_question,
    messageQuestion: c.message_question,
    publicBaseUrl: c.public_base_url,
    title: c.title,
    city: c.city,
    published: c.published,
    configured: !!c.token_hash,
    lastReceivedAt: c.last_received_at?.toISOString() ?? null,
    lastEventId: c.last_event_id,
  };
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export function googleFormScript(
  c: {
    id: string;
    public_base_url: string;
    cep_question: string;
    message_question: string;
  },
  token: string,
): string {
  const endpoint = `${c.public_base_url.replace(/\/$/, "")}/integrations/google-forms/${c.id}/submissions`;
  // JSON literals prevent question names or URLs from injecting Apps Script code.
  return `// InteliFluxo: cole no Apps Script vinculado ao seu Google Forms.
// Não publique este script: ele contém uma chave exclusiva desta conexão.
const IF_CONFIG = ${JSON.stringify({ endpoint, token, cepQuestion: c.cep_question, messageQuestion: c.message_question }, null, 2)};

function instalarInteliFluxo() {
  const form = FormApp.getActiveForm();
  if (!form) throw new Error('Abra este script pelo editor do Google Forms.');
  [IF_CONFIG.cepQuestion, IF_CONFIG.messageQuestion].filter(Boolean).forEach(function(title) {
    const matches = form.getItems().filter(function(item) { return item.getTitle() === title; });
    if (matches.length !== 1 || matches[0].getType() !== FormApp.ItemType.TEXT && matches[0].getType() !== FormApp.ItemType.PARAGRAPH_TEXT) throw new Error('Pergunta ausente, duplicada ou sem resposta textual: ' + title);
  });
  const exists = ScriptApp.getProjectTriggers().some(function(t) { return t.getHandlerFunction() === 'enviarAoInteliFluxo' && t.getTriggerSourceId() === form.getId(); });
  if (!exists) ScriptApp.newTrigger('enviarAoInteliFluxo').forForm(form).onFormSubmit().create();
}

function enviarAoInteliFluxo(e) {
  if (!e || !e.response) throw new Error('Envie uma resposta real ao formulário para testar.');
  enviarRespostaInteliFluxo_(e.response);
}

function enviarRespostaInteliFluxo_(response) {
  const items = response.getItemResponses();
  function answer(title) {
    if (!title) return '';
    const matches = items.filter(function(i) { return i.getItem().getTitle() === title; });
    if (matches.length !== 1 || typeof matches[0].getResponse() !== 'string') throw new Error('Resposta ausente ou ambígua: ' + title);
    return matches[0].getResponse();
  }
  const body = JSON.stringify({ responseId: response.getId(), cep: answer(IF_CONFIG.cepQuestion), message: answer(IF_CONFIG.messageQuestion) });
  for (let attempt = 0; attempt < 3; attempt++) {
    let status = 0;
    try {
      const result = UrlFetchApp.fetch(IF_CONFIG.endpoint, { method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + IF_CONFIG.token }, payload: body, muteHttpExceptions: true, followRedirects: false });
      status = result.getResponseCode();
      if (status === 200 || status === 202) return;
    } catch (err) { /* Não registre respostas nem a chave nos logs. */ }
    if (status >= 400 && status < 500 && status !== 429) throw new Error('Envio rejeitado pelo InteliFluxo (HTTP ' + status + '). Confira publicação, versão e campos.');
    if (attempt < 2) Utilities.sleep(1000 * (attempt + 1));
  }
  throw new Error('Envio não confirmado. A resposta continua no Google Forms. Use reenviarRespostasRecentes.');
}

function reenviarRespostasRecentes() {
  // Recupera até 20 respostas recentes. O mesmo responseId não cria outro evento.
  FormApp.getActiveForm().getResponses().slice(-20).forEach(enviarRespostaInteliFluxo_);
}
`;
}

export function googleFormsRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  writesEnabled: boolean,
) {
  const params = {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", format: "uuid" } },
  };
  app.get("/forms/google-connections", async () => ({
    items: (
      await pool.query<Connection>(
        `${selection} ORDER BY c.created_at DESC,c.id DESC LIMIT 100`,
      )
    ).rows.map(output),
  }));
  app.post<{
    Body: {
      title: string;
      city: string;
      formUrl: string;
      cepQuestion: string;
      messageQuestion: string;
      publicBaseUrl: string;
    };
  }>(
    "/forms/google-connections",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: [
            "title",
            "city",
            "formUrl",
            "cepQuestion",
            "messageQuestion",
            "publicBaseUrl",
          ],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 160 },
            city: { type: "string", minLength: 1, maxLength: 100 },
            formUrl: { type: "string", maxLength: 1024 },
            cepQuestion: { type: "string", minLength: 1, maxLength: 200 },
            messageQuestion: { type: "string", maxLength: 200 },
            publicBaseUrl: { type: "string", maxLength: 500 },
          },
        },
      },
    },
    async (req, reply) => {
      if (!writesEnabled)
        return reply.code(503).send({ error: "forms_disabled" });
      if (
        !validEventData(req.body) ||
        !googleFormUrl(req.body.formUrl) ||
        (req.body.publicBaseUrl && !publicBaseUrl(req.body.publicBaseUrl)) ||
        !req.body.cepQuestion.trim() ||
        (req.body.messageQuestion &&
          req.body.cepQuestion === req.body.messageQuestion)
      )
        return reply.code(400).send({ error: "invalid_google_connection" });
      const config = {
        title: req.body.title,
        city: req.body.city,
        description: "Entrada pelo Google Forms",
        fields: [
          {
            key: "cep",
            label: req.body.cepQuestion.slice(0, 80),
            type: "cep" as const,
            required: true,
          },
          {
            key: "observacao",
            label: "Mensagem do formulário",
            type: "textarea" as const,
            required: false,
          },
        ],
      };
      if (!validForm(config))
        return reply.code(400).send({ error: "invalid_form" });
      const connection = await transaction(pool, async (client) => {
        const form = await insertManagedForm(client, config);
        const id = randomUUID();
        await client.query(
          "INSERT INTO google_form_connections(id,form_id,form_url,cep_question,message_question,public_base_url) VALUES ($1,$2,$3,$4,$5,$6)",
          [
            id,
            form.id,
            req.body.formUrl,
            req.body.cepQuestion,
            req.body.messageQuestion,
            req.body.publicBaseUrl,
          ],
        );
        return (
          await client.query<Connection>(`${selection} WHERE c.id=$1`, [id])
        ).rows[0];
      });
      return reply.code(201).send(output(connection));
    },
  );
  app.post<{ Params: { id: string }; Body: { publicBaseUrl: string } }>(
    "/forms/google-connections/:id/setup",
    {
      schema: {
        params,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["publicBaseUrl"],
          properties: { publicBaseUrl: { type: "string", maxLength: 500 } },
        },
      },
    },
    async (req, reply) => {
      if (!writesEnabled)
        return reply.code(503).send({ error: "forms_disabled" });
      if (!publicBaseUrl(req.body.publicBaseUrl))
        return reply.code(400).send({ error: "invalid_google_connection" });
      const token = randomBytes(32).toString("base64url");
      const c = await transaction(pool, async (client) => {
        const updated = await client.query(
          "UPDATE google_form_connections SET token_hash=$2,public_base_url=$3,last_received_at=NULL WHERE id=$1 RETURNING id",
          [req.params.id, hash(token), req.body.publicBaseUrl],
        );
        if (!updated.rowCount) return null;
        return (
          await client.query<Connection>(`${selection} WHERE c.id=$1`, [
            req.params.id,
          ])
        ).rows[0];
      });
      if (!c) return reply.code(404).send({ error: "not_found" });
      return reply
        .header("Cache-Control", "no-store")
        .send({ script: googleFormScript(c, token) });
    },
  );
  app.post<{
    Params: { id: string };
    Body: { responseId: string; cep: string; message: string };
  }>(
    "/integrations/google-forms/:id/submissions",
    {
      schema: {
        params,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["responseId", "cep", "message"],
          properties: {
            responseId: { type: "string", minLength: 1, maxLength: 1024 },
            cep: { type: "string", maxLength: 9 },
            message: { type: "string", maxLength: 500 },
          },
        },
      },
    },
    async (req, reply) => {
      const c = (
        await pool.query<Connection>(`${selection} WHERE c.id=$1`, [
          req.params.id,
        ])
      ).rows[0];
      const auth = req.headers.authorization;
      const supplied =
        typeof auth === "string" &&
        auth.startsWith("Bearer ") &&
        auth.length <= 100
          ? hash(auth.slice(7))
          : hash("");
      if (
        !c?.token_hash ||
        !timingSafeEqual(
          Buffer.from(c.token_hash, "hex"),
          Buffer.from(supplied, "hex"),
        )
      )
        return reply.code(401).send({ error: "unauthorized" });
      const key = `google_${hash(req.body.responseId)}`;
      const prior = (
        await pool.query(
          "SELECT s.form_revision FROM form_submissions s JOIN events e ON e.id=s.event_id WHERE s.form_id=$1 AND e.idempotency_key=$2",
          [c.form_id, key],
        )
      ).rows[0];
      const accepted = await app.inject({
        method: "POST",
        url: `/forms/${c.form_id}/submissions`,
        payload: {
          expectedRevision: prior?.form_revision ?? c.revision,
          idempotencyKey: key,
          answers: { cep: req.body.cep, observacao: req.body.message },
        },
      });
      if (accepted.statusCode === 200 || accepted.statusCode === 202) {
        const event = accepted.json<{ id: string }>();
        await pool.query(
          "UPDATE google_form_connections SET last_received_at=now(),last_event_id=$2 WHERE id=$1",
          [c.id, event.id],
        );
      }
      return reply
        .code(accepted.statusCode)
        .type("application/json")
        .send(accepted.body);
    },
  );
}
