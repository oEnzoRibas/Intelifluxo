import { useEffect, useRef, useState, type FormEvent } from "react";
import { object, uuid } from "./api";
import { listEventExecutions, type Execution } from "./automation-api";
import ViaCepResult from "./ViaCepResult";
import {
  FormError,
  formError,
  formsRequest,
  getForm,
  savedForm,
  type FormConfig,
  type FormField,
  type FormIntent,
  type SavedForm,
  type Submission,
} from "./forms-api";
import "./forms.css";
import GoogleForms, { GoogleConnections } from "./GoogleForms";

const initial: FormConfig = {
  title: "",
  description: "",
  city: "Belo Horizonte",
  fields: [
    { key: "nome", label: "Nome", type: "text", required: true },
    { key: "cep", label: "CEP de entrega", type: "cep", required: true },
    {
      key: "observacao",
      label: "Observação",
      type: "textarea",
      required: false,
    },
  ],
};
function config(f: FormConfig): FormConfig {
  return {
    title: f.title,
    description: f.description,
    city: f.city,
    fields: f.fields,
  };
}
const terminal = (e: Execution) =>
  ["completed", "ignored", "blocked"].includes(e.status);

function Result({ form, eventId }: { form: SavedForm; eventId: string }) {
  const [execution, setExecution] = useState<Execution | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let count = 0;
    async function poll() {
      try {
        const items = await listEventExecutions(eventId, controller.signal);
        if (controller.signal.aborted) return;
        const current =
          items.find((e) => e.automationId === form.automationId) ?? null;
        setExecution(current);
        setError("");
        if ((!current || !terminal(current)) && ++count < 30)
          timer = setTimeout(poll, 2000);
      } catch {
        if (!controller.signal.aborted)
          setError(
            "Não foi possível consultar o resultado. Sua resposta já foi recebida; atualize apenas o resultado.",
          );
      }
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [eventId, form.automationId, refresh]);
  return (
    <section className="forms-result" aria-live="polite">
      <p className="eyebrow">RESPOSTA RECEBIDA</p>
      <h2>
        {execution?.status === "completed"
          ? "Consulta concluída"
          : execution?.status === "ignored"
            ? "Fora da cidade configurada"
            : execution?.status === "blocked"
              ? "A consulta precisa de atenção"
              : "Consultando o CEP…"}
      </h2>
      <p>
        {execution?.status === "completed"
          ? "A condição foi atendida e o recibo local foi registrado."
          : execution?.status === "ignored"
            ? `O endereço não atende à condição configurada. Nenhum recibo da automação foi registrado.`
            : "O envio foi aceito. Confira abaixo o resultado da automação vinculada."}
      </p>
      {execution?.result?.kind === "viacep-condition-execution.v1" && (
        <ViaCepResult result={execution.result} />
      )}
      {error && <p role="alert">{error}</p>}
      <button type="button" onClick={() => setRefresh((v) => v + 1)}>
        Atualizar resultado
      </button>
      <details>
        <summary>Identificação do envio</summary>
        <p className="forms-id">{eventId}</p>
      </details>
    </section>
  );
}

type Recovery = { intent: FormIntent; eventId?: string };
function restore(id: string): Recovery | null {
  try {
    const v: unknown = JSON.parse(
      sessionStorage.getItem(`form-send:${id}`) ?? "null",
    );
    if (
      object(v) &&
      object(v.intent) &&
      Number.isInteger(v.intent.expectedRevision) &&
      uuid(v.intent.idempotencyKey) &&
      object(v.intent.answers) &&
      Object.values(v.intent.answers).every((a) => typeof a === "string") &&
      (v.eventId === undefined || uuid(v.eventId))
    )
      return v as Recovery;
  } catch {
    /* An unavailable browser store must not prevent filling the form. */
  }
  return null;
}
function Fill({ form }: { form: SavedForm }) {
  const [recovery, setRecovery] = useState<Recovery | null>(() =>
    restore(form.id),
  );
  const [answers, setAnswers] = useState<Record<string, string>>(
    () => restore(form.id)?.intent.answers ?? {},
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const posting = useRef(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  function remember(value: Recovery | null) {
    setRecovery(value);
    try {
      if (value)
        sessionStorage.setItem(`form-send:${form.id}`, JSON.stringify(value));
      else sessionStorage.removeItem(`form-send:${form.id}`);
    } catch {
      /* In-memory recovery remains available. */
    }
  }
  async function send(e: FormEvent) {
    e.preventDefault();
    if (posting.current || recovery?.eventId) return;
    const pending = recovery ?? {
      intent: {
        expectedRevision: form.revision,
        idempotencyKey: crypto.randomUUID(),
        answers: { ...answers },
      },
    };
    remember(pending);
    posting.current = true;
    setBusy(true);
    setError("");
    const abort = new AbortController();
    controller.current = abort;
    const timeout = setTimeout(() => abort.abort(), 15000);
    try {
      const result = await formsRequest(
        `/${form.id}/submissions`,
        abort.signal,
        "POST",
        pending.intent,
      );
      if (!object(result) || !uuid(result.id)) throw new Error("invalid");
      remember({ ...pending, eventId: String(result.id) });
    } catch (err) {
      if (err instanceof FormError && err.code === "invalid_answers")
        remember(null);
      setError(formError(err));
    } finally {
      clearTimeout(timeout);
      posting.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="forms-fill">
      <a className="forms-brand" href="#forms">
        ✳ InteliFluxo · Formulários
      </a>
      <section className="forms-sheet">
        <p className="eyebrow">CONSULTA DE ENDEREÇO</p>
        <h1>{form.title}</h1>
        <p>
          {form.description ||
            "Informe seus dados e o CEP para consultar a região de entrega."}
        </p>
        <p className="forms-note">
          Ambiente local de demonstração. Use dados fictícios. O CEP será
          consultado no ViaCEP; as demais respostas ficam neste ambiente.
        </p>
        {!form.published && !recovery && (
          <p role="status" className="notice">
            Este formulário está pausado e não recebe respostas.
          </p>
        )}
        {recovery?.eventId ? (
          <>
            <Result form={form} eventId={recovery.eventId} />
            <button
              type="button"
              onClick={() => {
                remember(null);
                setAnswers({});
                setError("");
              }}
            >
              Preencher novamente
            </button>
          </>
        ) : (
          <form onSubmit={send}>
            <fieldset
              disabled={busy || !!recovery || !form.published}
              className="forms-inputs"
            >
              <legend className="sr-only">Suas respostas</legend>
              {form.fields.map((field) => (
                <label key={field.key} htmlFor={`answer-${field.key}`}>
                  {field.label}
                  {field.required ? " *" : " (opcional)"}
                  {field.type === "textarea" ? (
                    <textarea
                      id={`answer-${field.key}`}
                      value={answers[field.key] ?? ""}
                      required={field.required}
                      maxLength={500}
                      onChange={(e) =>
                        setAnswers((a) => ({
                          ...a,
                          [field.key]: e.target.value,
                        }))
                      }
                    />
                  ) : (
                    <input
                      id={`answer-${field.key}`}
                      type={field.type === "email" ? "email" : "text"}
                      inputMode={field.type === "cep" ? "numeric" : undefined}
                      pattern={
                        field.type === "cep" ? "[0-9]{5}-?[0-9]{3}" : undefined
                      }
                      placeholder={
                        field.type === "cep" ? "30140-071" : undefined
                      }
                      maxLength={field.type === "cep" ? 9 : 500}
                      required={field.required}
                      value={answers[field.key] ?? ""}
                      onChange={(e) =>
                        setAnswers((a) => ({
                          ...a,
                          [field.key]: e.target.value,
                        }))
                      }
                    />
                  )}
                </label>
              ))}
            </fieldset>
            {error && (
              <p className="notice" role="alert">
                {error}
              </p>
            )}
            {recovery && (
              <p className="forms-note">
                Respostas preservadas para recuperar o mesmo envio, sem criar
                outro evento. Se a versão mudou, recarregue o formulário antes
                de preencher novamente.
              </p>
            )}
            <button
              className="primary-button"
              type="submit"
              disabled={busy || (!form.published && !recovery)}
            >
              {busy
                ? "Enviando…"
                : recovery
                  ? "Recuperar o mesmo envio"
                  : "Enviar e consultar CEP"}
            </button>
            {recovery && !busy && (
              <button
                type="button"
                onClick={() => {
                  if (
                    window.confirm(
                      "Se o envio anterior foi recebido, preencher novamente poderá criar outra resposta. Deseja iniciar um novo preenchimento?",
                    )
                  ) {
                    remember(null);
                    setError("");
                    window.location.reload();
                  }
                }}
              >
                Iniciar outro preenchimento
              </button>
            )}
          </form>
        )}
        <p className="forms-note">
          A condição verifica se a cidade é {form.city}. A ação disponível
          registra um recibo local.
        </p>
      </section>
    </div>
  );
}

function Editor({ existing }: { existing: SavedForm | null }) {
  const [draft, setDraft] = useState<FormConfig>(() =>
    existing ? config(existing) : structuredClone(initial),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const locked = existing?.published ?? false;
  const dirty =
    !!existing && JSON.stringify(draft) !== JSON.stringify(config(existing));
  async function save(published = false) {
    setBusy(true);
    setError("");
    try {
      const saved = savedForm(
        await formsRequest(
          existing ? `/${existing.id}` : "",
          new AbortController().signal,
          existing ? "PUT" : "POST",
          {
            ...draft,
            title: draft.title.trim(),
            city: draft.city.trim(),
            ...(existing
              ? { expectedRevision: existing.revision, published }
              : {}),
          },
        ),
      );
      window.location.hash = `#forms/${saved.id}/edit`;
      if (existing) window.dispatchEvent(new Event("forms-updated"));
    } catch (err) {
      setError(formError(err));
    } finally {
      setBusy(false);
    }
  }
  function updateField(index: number, patch: Partial<FormField>) {
    setDraft((d) => ({
      ...d,
      fields: d.fields.map((f, i) => (i === index ? { ...f, ...patch } : f)),
    }));
  }
  return (
    <>
      <a href="#forms">← Formulários</a>
      <div className="heading">
        <div>
          <p className="eyebrow">EDITOR DE FORMULÁRIO</p>
          <h1>{existing ? existing.title : "Um novo ponto de entrada"}</h1>
          <p>
            Crie os campos. Cada resposta inicia a consulta de CEP e a decisão
            por cidade.
          </p>
        </div>
      </div>
      {existing && (
        <section className="forms-toolbar">
          <span className={`forms-badge ${locked ? "is-live" : ""}`}>
            {locked ? "Recebendo respostas" : "Rascunho / pausado"}
          </span>
          <span>Versão {existing.revision}</span>
          <a href={`#forms/${existing.id}/fill`}>Abrir formulário</a>
          <a href={`#forms/${existing.id}/responses`}>Respostas</a>
        </section>
      )}
      <div className="forms-editor-grid">
        <form
          className="forms-sheet"
          onSubmit={(e) => {
            e.preventDefault();
            void save(false);
          }}
        >
          {locked && (
            <p className="forms-note">
              Pause o recebimento antes de editar. Respostas anteriores
              continuam vinculadas à versão original.
            </p>
          )}
          <fieldset className="forms-inputs" disabled={busy || locked}>
            <legend>1. Apresentação</legend>
            <label htmlFor="form-title">
              Título do formulário
              <input
                id="form-title"
                value={draft.title}
                maxLength={160}
                required
                onChange={(e) =>
                  setDraft((d) => ({ ...d, title: e.target.value }))
                }
                placeholder="Ex.: Solicitar entrega em Belo Horizonte"
              />
            </label>
            <label htmlFor="form-description">
              Descrição
              <textarea
                id="form-description"
                value={draft.description}
                maxLength={500}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, description: e.target.value }))
                }
              />
            </label>
          </fieldset>
          <fieldset className="forms-inputs" disabled={busy || locked}>
            <legend>2. Campos do formulário</legend>
            <p className="forms-note">
              O CEP é obrigatório e alimenta a consulta. Adicione até 12 campos
              no total.
            </p>
            {draft.fields.map((field, index) => (
              <div className="forms-field" key={field.key}>
                <label htmlFor={`label-${field.key}`}>
                  Nome do campo {index + 1}
                  <input
                    id={`label-${field.key}`}
                    value={field.label}
                    maxLength={80}
                    required
                    onChange={(e) =>
                      updateField(index, { label: e.target.value })
                    }
                  />
                </label>
                <div className="forms-field-options">
                  <label htmlFor={`type-${field.key}`}>
                    Tipo
                    <select
                      id={`type-${field.key}`}
                      value={field.type}
                      disabled={field.key === "cep"}
                      onChange={(e) =>
                        updateField(index, {
                          type: e.target.value as FormField["type"],
                        })
                      }
                    >
                      {field.key === "cep" ? (
                        <option value="cep">CEP</option>
                      ) : (
                        <>
                          <option value="text">Texto curto</option>
                          <option value="textarea">Texto longo</option>
                          <option value="email">E-mail</option>
                        </>
                      )}
                    </select>
                  </label>
                  <label className="forms-check">
                    <input
                      type="checkbox"
                      checked={field.required}
                      disabled={field.key === "cep"}
                      onChange={(e) =>
                        updateField(index, { required: e.target.checked })
                      }
                    />
                    Obrigatório
                  </label>
                  {field.key !== "cep" && (
                    <button
                      type="button"
                      aria-label={`Remover ${field.label || `campo ${index + 1}`}`}
                      onClick={() =>
                        setDraft((d) => ({
                          ...d,
                          fields: d.fields.filter((_, i) => i !== index),
                        }))
                      }
                    >
                      Remover
                    </button>
                  )}
                </div>
              </div>
            ))}
            <button
              type="button"
              disabled={draft.fields.length >= 12}
              onClick={() =>
                setDraft((d) => ({
                  ...d,
                  fields: [
                    ...d.fields,
                    {
                      key: `f_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
                      label: "Novo campo",
                      type: "text",
                      required: false,
                    },
                  ],
                }))
              }
            >
              + Adicionar campo
            </button>
          </fieldset>
          <fieldset className="forms-inputs" disabled={busy || locked}>
            <legend>3. Automação vinculada</legend>
            <label htmlFor="form-city">
              Registrar recibo quando a cidade for
              <input
                id="form-city"
                value={draft.city}
                maxLength={100}
                required
                onChange={(e) =>
                  setDraft((d) => ({ ...d, city: e.target.value }))
                }
              />
            </label>
            <p className="forms-note">
              Use o nome completo retornado pelo ViaCEP. Exemplo: Belo
              Horizonte. Se a cidade for diferente, a automação finaliza sem
              registrar o recibo.
            </p>
          </fieldset>
          {error && (
            <p className="notice" role="alert">
              {error}
            </p>
          )}
          <div className="forms-actions">
            {!locked && (
              <button className="primary-button" disabled={busy} type="submit">
                {busy
                  ? "Salvando…"
                  : existing
                    ? "Salvar rascunho"
                    : "Criar formulário"}
              </button>
            )}
            {existing && (
              <button
                type="button"
                disabled={busy || dirty}
                onClick={() => void save(!locked)}
              >
                {locked ? "Pausar recebimento" : "Publicar formulário"}
              </button>
            )}
          </div>
          {dirty && (
            <p className="forms-note">Salve as alterações antes de publicar.</p>
          )}
        </form>
        <aside className="forms-preview">
          <p className="eyebrow">PRÉVIA DOS CAMPOS</p>
          <h2>{draft.title || "Seu formulário"}</h2>
          <p>{draft.description || "A descrição aparece aqui."}</p>
          {draft.fields.map((f) => (
            <div key={f.key} className="forms-preview-field">
              <strong>
                {f.label || "Campo sem nome"}
                {f.required && " *"}
              </strong>
              <div>
                {f.type === "cep"
                  ? "00000-000"
                  : f.type === "email"
                    ? "nome@exemplo.com"
                    : "Resposta"}
              </div>
            </div>
          ))}
          <p className="forms-note">
            CEP preenchido → ViaCEP → cidade igual a {draft.city || "…"} →
            recibo local.
          </p>
          {existing && (
            <>
              <label htmlFor="form-link">
                Link de preenchimento
                <input
                  id="form-link"
                  readOnly
                  value={`${window.location.href.split("#")[0]}#forms/${existing.id}/fill`}
                />
              </label>
              <p className="forms-note">
                Este link funciona neste computador. Para receber respostas
                externas, será necessário hospedar a aplicação com autenticação
                e proteção de acesso.
              </p>
            </>
          )}
        </aside>
      </div>
    </>
  );
}

function ResponseResult({
  form,
  eventId,
}: {
  form: SavedForm;
  eventId: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Recolher resultado" : "Ver resultado da automação"}
      </button>
      {open && <Result form={form} eventId={eventId} />}
    </>
  );
}
function Responses({ form }: { form: SavedForm }) {
  const [items, setItems] = useState<Submission[]>([]),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    void formsRequest(`/${form.id}/submissions`, c.signal)
      .then((v) => {
        if (object(v) && Array.isArray(v.items)) {
          setItems(v.items as Submission[]);
          setError("");
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(formError(e));
      });
    return () => c.abort();
  }, [form.id, refresh]);
  return (
    <>
      <a href={`#forms/${form.id}/edit`}>← Voltar ao formulário</a>
      <h1>Respostas · {form.title}</h1>
      <p>
        Até 100 respostas mais recentes. Cada envio mantém a versão do
        formulário usada no preenchimento.
      </p>
      <div className="forms-actions">
        <button onClick={() => setRefresh((v) => v + 1)}>
          Atualizar respostas
        </button>
        <a href={`#automations/${form.automationId}`}>
          Ver execuções da automação
        </a>
      </div>
      {error && <p role="alert">{error}</p>}
      {!items.length && !error && (
        <div className="forms-sheet">
          <h2>Aguardando a primeira resposta</h2>
          <a href={`#forms/${form.id}/fill`}>Preencher formulário</a>
        </div>
      )}
      {items.map((item) => (
        <article className="forms-sheet" key={item.id}>
          <p className="eyebrow">
            VERSÃO {item.revision} ·{" "}
            {new Date(item.createdAt).toLocaleString("pt-BR")}
          </p>
          <dl>
            {Object.entries(item.answers).map(([key, value]) => (
              <div key={key}>
                <dt>{item.fields?.find((f) => f.key === key)?.label ?? key}</dt>
                <dd>{value || "Não informado"}</dd>
              </div>
            ))}
          </dl>
          <a href={`#explorer?eventId=${item.id}`}>Ver evento</a>
          <ResponseResult form={form} eventId={item.id} />
        </article>
      ))}
    </>
  );
}

function List() {
  const [items, setItems] = useState<SavedForm[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    const c = new AbortController();
    void formsRequest("", c.signal)
      .then((v) => {
        if (!object(v) || !Array.isArray(v.items)) throw new Error();
        setItems(
          v.items.map(savedForm).filter((f) => f.source !== "google-forms"),
        );
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(formError(e));
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, []);
  return (
    <>
      <div className="heading">
        <div>
          <p className="eyebrow">ENTRADAS QUE VIRAM AÇÕES</p>
          <h1>Formulários</h1>
          <p>
            Crie uma entrada para cada fluxo. As respostas chegam à automação
            com o CEP preenchido.
          </p>
        </div>
        <a className="button-link primary-button" href="#forms/create">
          + Criar formulário
        </a>
      </div>
      <p className="forms-note">
        Formulários locais, persistidos neste ambiente. Cada formulário usa um
        contexto próprio de automação. Use dados fictícios.
      </p>
      <GoogleConnections />
      {loading && <p role="status">Carregando formulários…</p>}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {!loading && !error && !items.length && (
        <section className="forms-sheet forms-empty">
          <span aria-hidden="true">▤</span>
          <h2>O próximo fluxo começa aqui</h2>
          <p>
            Monte os campos, escolha a cidade e receba sua primeira resposta.
          </p>
          <a className="button-link" href="#forms/create">
            Criar meu primeiro formulário
          </a>
        </section>
      )}
      <div className="forms-grid">
        {items.map((f) => (
          <article className="forms-sheet" key={f.id}>
            <span className={`forms-badge ${f.published ? "is-live" : ""}`}>
              {f.published ? "Recebendo respostas" : "Rascunho / pausado"}
            </span>
            <h2>
              <a href={`#forms/${f.id}/edit`}>{f.title}</a>
            </h2>
            <p>
              {f.description || "Consulta de endereço com decisão por cidade."}
            </p>
            <p className="forms-note">
              {f.fields.length} campos · cidade: {f.city}
            </p>
            <div className="forms-actions">
              <a href={`#forms/${f.id}/edit`}>Gerenciar</a>
              <a href={`#forms/${f.id}/fill`}>Preencher</a>
              <a href={`#forms/${f.id}/responses`}>Respostas</a>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}

export default function Forms({ route }: { route: string }) {
  const match = /^#forms\/([0-9a-f-]{36})\/(edit|fill|responses)$/.exec(route);
  const [form, setForm] = useState<SavedForm | null>(null),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0);
  const id = match?.[1];
  const mode = match?.[2];
  useEffect(() => {
    const reload = () => setRefresh((v) => v + 1);
    window.addEventListener("forms-updated", reload);
    return () => window.removeEventListener("forms-updated", reload);
  }, []);
  useEffect(() => {
    if (!id || !uuid(id)) return;
    const c = new AbortController();
    void getForm(id, c.signal)
      .then((f) => {
        setForm(f);
        setError("");
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(formError(e));
      });
    return () => c.abort();
  }, [id, refresh]);
  if (route === "#forms" || route === "#forms/")
    return (
      <div className="forms-page">
        <List />
      </div>
    );
  if (route === "#forms/connect") return <GoogleForms />;
  if (/^#forms\/google\/[0-9a-f-]{36}$/.test(route))
    return <GoogleForms connectionId={route.split("/")[2]} />;
  if (route === "#forms/create")
    return (
      <div className="forms-page">
        <Editor existing={null} />
      </div>
    );
  if (!match)
    return (
      <p>
        Endereço de formulário inválido.{" "}
        <a href="#forms">Voltar aos formulários</a>
      </p>
    );
  if (error)
    return (
      <p className="notice" role="alert">
        {error} <a href="#forms">Voltar</a>
      </p>
    );
  if (!form || form.id !== id)
    return <p role="status">Carregando formulário…</p>;
  return mode === "fill" ? (
    <Fill key={form.id} form={form} />
  ) : (
    <div className="forms-page">
      {mode === "responses" ? (
        <Responses form={form} />
      ) : (
        <Editor key={`${form.id}:${form.revision}`} existing={form} />
      )}
    </div>
  );
}
