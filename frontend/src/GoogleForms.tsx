import { useEffect, useState, type FormEvent } from "react";
import { object } from "./api";
import { formError, formsRequest, getForm } from "./forms-api";

type Connection = {
  id: string;
  formId: string;
  formUrl: string;
  cepQuestion: string;
  messageQuestion: string;
  publicBaseUrl: string;
  title: string;
  city: string;
  published: boolean;
  configured: boolean;
  lastReceivedAt: string | null;
  lastEventId: string | null;
};
function state(c: Connection) {
  return !c.configured
    ? "Aguardando configuração"
    : !c.published
      ? "Recebimento pausado"
      : c.lastReceivedAt
        ? "Recebeu resposta autenticada"
        : "Aguardando primeira resposta";
}
export function GoogleConnections() {
  const [items, setItems] = useState<Connection[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void formsRequest("/google-connections", controller.signal)
      .then((v) => {
        if (object(v) && Array.isArray(v.items))
          setItems(v.items as Connection[]);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(formError(e));
      });
    return () => controller.abort();
  }, []);
  return (
    <section className="forms-sheet">
      <div className="heading">
        <div>
          <p className="eyebrow">FORMULÁRIOS EXTERNOS</p>
          <h2>Google Forms</h2>
          <p>
            Já tem um formulário? Conecte o link e escolha a pergunta que contém
            o CEP quando quiser.
          </p>
        </div>
        <a className="button-link" href="#forms/connect">
          Conectar Google Forms
        </a>
      </div>
      {error && <p role="alert">{error}</p>}
      {items.map((c) => (
        <article key={c.id} className="forms-connection">
          <span
            className={`forms-badge ${c.lastReceivedAt && c.published ? "is-live" : ""}`}
          >
            {state(c)}
          </span>
          <h3>
            <a href={`#forms/google/${c.id}`}>{c.title}</a>
          </h3>
          <p className="forms-note">
            CEP: {c.cepQuestion} · cidade: {c.city}
          </p>
          <a href={`#forms/google/${c.id}`}>Configurar conexão</a>
        </article>
      ))}
      {!items.length && !error && (
        <p className="forms-note">
          Nenhuma conexão cadastrada. Não é necessário ter um formulário agora:
          esta opção fica disponível para novas conexões.
        </p>
      )}
    </section>
  );
}
export default function GoogleForms({
  connectionId,
}: {
  connectionId?: string;
}) {
  const [connections, setConnections] = useState<Connection[]>([]),
    [refresh, setRefresh] = useState(0);
  const [title, setTitle] = useState(""),
    [city, setCity] = useState("Belo Horizonte"),
    [url, setUrl] = useState(""),
    [cep, setCep] = useState("CEP"),
    [message, setMessage] = useState(""),
    [publicUrl, setPublicUrl] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [script, setScript] = useState("");
  const connection = connections.find((c) => c.id === connectionId);
  useEffect(() => {
    if (!connectionId) return;
    const controller = new AbortController();
    void formsRequest("/google-connections", controller.signal)
      .then((v) => {
        if (object(v) && Array.isArray(v.items)) {
          const items = v.items as Connection[];
          setConnections(items);
          const c = items.find((c) => c.id === connectionId);
          if (c) setPublicUrl(c.publicBaseUrl);
          else
            setError("Conexão não encontrada nesta lista de até 100 conexões.");
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(formError(e));
      });
    return () => controller.abort();
  }, [connectionId, refresh]);
  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await formsRequest(
        "/google-connections",
        new AbortController().signal,
        "POST",
        {
          title: title.trim(),
          city: city.trim(),
          formUrl: url.trim(),
          cepQuestion: cep,
          messageQuestion: message,
          publicBaseUrl: publicUrl.trim(),
        },
      );
      if (!object(result) || typeof result.id !== "string") throw new Error();
      window.location.hash = `#forms/google/${result.id}`;
    } catch (err) {
      setError(formError(err));
    } finally {
      setBusy(false);
    }
  }
  async function setup() {
    if (!connection) return;
    if (
      connection.configured &&
      !window.confirm(
        "Gerar um novo script invalida a chave anterior. Será necessário substituir o código no Apps Script. Continuar?",
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      const result = await formsRequest(
        `/google-connections/${connection.id}/setup`,
        new AbortController().signal,
        "POST",
        { publicBaseUrl: publicUrl.trim() },
      );
      if (!object(result) || typeof result.script !== "string")
        throw new Error();
      setScript(result.script);
      setRefresh((v) => v + 1);
    } catch (err) {
      setError(formError(err));
    } finally {
      setBusy(false);
    }
  }
  async function toggle() {
    if (!connection) return;
    setBusy(true);
    setError("");
    try {
      const f = await getForm(connection.formId, new AbortController().signal);
      const { title, description, city, fields } = f;
      await formsRequest(`/${f.id}`, new AbortController().signal, "PUT", {
        title,
        description,
        city,
        fields,
        expectedRevision: f.revision,
        published: !f.published,
      });
      setRefresh((v) => v + 1);
    } catch (err) {
      setError(formError(err));
    } finally {
      setBusy(false);
    }
  }
  function download() {
    const blob = new Blob([script], { type: "text/plain;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "InteliFluxo-GoogleForms.gs";
    link.click();
    URL.revokeObjectURL(link.href);
  }
  return (
    <div className="forms-page">
      <a href="#forms">← Formulários</a>
      <p className="eyebrow">CONECTAR UMA ENTRADA EXISTENTE</p>
      <h1>
        {connectionId
          ? (connection?.title ?? "Google Forms")
          : "Conectar Google Forms"}
      </h1>
      <p>
        Continue usando as perguntas e o link do seu Google Forms. Cada nova
        resposta pode iniciar a consulta de CEP no InteliFluxo.
      </p>
      <p className="forms-note">
        A conexão exige um script autorizado pelo dono do formulário e uma
        entrada HTTPS pública protegida. Apenas colar o link não autoriza a
        leitura das respostas.
      </p>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {!connectionId ? (
        <form className="forms-sheet" onSubmit={create}>
          <fieldset className="forms-inputs" disabled={busy}>
            <legend>1. Formulário e mapeamento</legend>
            <label htmlFor="google-title">
              Nome da conexão
              <input
                id="google-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                maxLength={160}
                placeholder="Ex.: Pedidos do Google Forms"
              />
            </label>
            <label htmlFor="google-url">
              Link do Google Forms
              <input
                id="google-url"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                required
                placeholder="https://docs.google.com/forms/d/.../edit"
              />
            </label>
            <p className="forms-note">
              Use o link completo de edição ou preenchimento. Se tiver um link
              curto forms.gle, abra-o e copie o endereço completo.
            </p>
            <label htmlFor="google-cep">
              Título exato da pergunta do CEP
              <input
                id="google-cep"
                value={cep}
                onChange={(e) => setCep(e.target.value)}
                required
                maxLength={200}
              />
            </label>
            <label htmlFor="google-message">
              Título da pergunta de mensagem (opcional)
              <input
                id="google-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                maxLength={200}
                placeholder="Ex.: Observação"
              />
            </label>
            <p className="forms-note">
              As perguntas mapeadas devem ser textuais e ter títulos únicos.
              Perguntas não mapeadas não são enviadas ao InteliFluxo.
            </p>
            <label htmlFor="google-city">
              Registrar recibo quando a cidade for
              <input
                id="google-city"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                required
                maxLength={100}
              />
            </label>
            <label htmlFor="google-public">
              Endereço HTTPS público da integração (pode configurar depois)
              <input
                id="google-public"
                type="url"
                value={publicUrl}
                onChange={(e) => setPublicUrl(e.target.value)}
                placeholder="https://integracao.seu-dominio.com"
              />
            </label>
          </fieldset>
          <button className="primary-button" disabled={busy}>
            {busy ? "Salvando…" : "Cadastrar conexão"}
          </button>
        </form>
      ) : (
        connection && (
          <>
            <section className="forms-sheet">
              <span className="forms-badge">{state(connection)}</span>
              <p>
                <a href={connection.formUrl} target="_blank" rel="noreferrer">
                  Abrir Google Forms original
                </a>
              </p>
              <p>
                CEP: <strong>{connection.cepQuestion}</strong> · Cidade:{" "}
                <strong>{connection.city}</strong>
              </p>
              <p className="forms-note">
                O cadastro não modifica nem importa automaticamente o
                formulário. Instale o script abaixo e envie uma resposta real
                para validar a integração.
              </p>
              <h2>2. Preparar a entrada pública</h2>
              <label className="forms-inputs" htmlFor="google-public-setup">
                Endereço HTTPS público da integração
                <input
                  id="google-public-setup"
                  type="url"
                  value={publicUrl}
                  onChange={(e) => setPublicUrl(e.target.value)}
                  placeholder="https://integracao.seu-dominio.com"
                />
              </label>
              <p className="forms-note">
                O Google não acessa localhost. No proxy/hospedagem,
                disponibilize somente o POST /integrations/google-forms/
                {connection.id}/submissions. Preserve o cabeçalho Authorization
                e mantenha as rotas administrativas privadas.
              </p>
              <button
                disabled={busy || !publicUrl}
                onClick={() => void setup()}
              >
                {connection.configured
                  ? "Gerar novo script e substituir chave"
                  : "Gerar script de integração"}
              </button>
              {script && (
                <div className="forms-setup">
                  <h3>Script gerado para esta conexão</h3>
                  <p className="notice">
                    O arquivo contém uma chave de acesso. Guarde-o de forma
                    privada; não publique no GitHub ou em capturas.
                  </p>
                  <button onClick={download}>Baixar script .gs</button>
                  <details>
                    <summary>Exibir código privado para copiar</summary>
                    <textarea
                      readOnly
                      value={script}
                      rows={14}
                      aria-label="Código privado do Apps Script"
                    />
                  </details>
                </div>
              )}
            </section>
            <section className="forms-sheet">
              <h2>3. Autorizar no Google Forms</h2>
              <ol>
                <li>
                  Abra o formulário no editor do Google Forms e abra o editor do
                  Apps Script.
                </li>
                <li>
                  Cole o arquivo gerado no projeto vinculado ao formulário.
                </li>
                <li>
                  Execute <code>instalarInteliFluxo</code> e autorize sua conta
                  Google. A função instala o gatilho de envio uma única vez.
                </li>
                <li>
                  Ative o recebimento abaixo e preencha uma resposta real pelo
                  Google Forms.
                </li>
                <li>
                  Volte aqui e atualize o estado. O primeiro evento autenticado
                  confirma o recebimento; o resultado da automação fica em
                  Respostas.
                </li>
              </ol>
              <div className="forms-actions">
                <button
                  disabled={busy || !connection.configured}
                  className="primary-button"
                  onClick={() => void toggle()}
                >
                  {connection.published
                    ? "Pausar recebimento"
                    : "Ativar recebimento"}
                </button>
                <button
                  disabled={busy}
                  onClick={() => setRefresh((v) => v + 1)}
                >
                  Atualizar estado
                </button>
                <a href={`#forms/${connection.formId}/responses`}>
                  Respostas e resultados
                </a>
                <a href={`#forms/${connection.formId}/edit`}>
                  Configurar cidade e automação
                </a>
              </div>
              {connection.lastReceivedAt && (
                <p>
                  Última resposta autenticada:{" "}
                  {new Date(connection.lastReceivedAt).toLocaleString("pt-BR")}.
                  Isso confirma o recebimento, não a conclusão da consulta.
                </p>
              )}
            </section>
          </>
        )
      )}
    </div>
  );
}
