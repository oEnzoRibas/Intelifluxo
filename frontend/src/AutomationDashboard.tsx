import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  listSummaries,
  validText,
  type SummaryPage,
  type AutomationSummary,
} from "./automation-api";

type Request = {
  q: string;
  active: string;
  cursor: string | null;
  history: (string | null)[];
  focus: boolean;
  serial: number;
};
type Result =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; page: SummaryPage };
const initial: Request = {
  q: "",
  active: "all",
  cursor: null,
  history: [],
  focus: false,
  serial: 0,
};

export default function AutomationDashboard({
  visible,
  onOpen,
}: {
  visible: boolean;
  onOpen: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [request, setRequest] = useState<Request>(initial);
  const [committed, setCommitted] = useState<Request>(initial);
  const [result, setResult] = useState<Result>({ kind: "loading" });
  const [wasVisible, setWasVisible] = useState(visible);
  if (wasVisible !== visible) {
    setWasVisible(visible);
    if (visible) setResult({ kind: "loading" });
  }
  const heading = useRef<HTMLHeadingElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);
  const userInitiated = useRef(false);
  useEffect(() => {
    if (!visible) {
      userInitiated.current = false;
      return;
    }
    const controller = new AbortController();
    const version = ++sequence.current;
    listSummaries(request, controller.signal)
      .then((page) => {
        if (controller.signal.aborted || version !== sequence.current) return;
        setCommitted(request);
        setResult({ kind: "ready", page });
        if (request.focus) heading.current?.focus();
        userInitiated.current = false;
      })
      .catch(() => {
        if (!controller.signal.aborted && version === sequence.current) {
          setResult({ kind: "error" });
          if (userInitiated.current) heading.current?.focus();
          userInitiated.current = false;
        }
      });
    return () => controller.abort();
  }, [request, visible]);
  function load(next: Omit<Request, "serial">) {
    sequence.current++;
    userInitiated.current = true;
    setResult({ kind: "loading" });
    setRequest((r) => ({ ...next, serial: r.serial + 1 }));
  }
  function search(e: FormEvent) {
    e.preventDefault();
    if (draft !== "" && !validText(draft, 200)) {
      setInvalid(true);
      input.current?.focus();
      return;
    }
    setInvalid(false);
    load({
      q: draft,
      active: request.active,
      cursor: null,
      history: [],
      focus: false,
    });
  }
  function reset() {
    setDraft("");
    setInvalid(false);
    load({ q: "", active: "all", cursor: null, history: [], focus: false });
  }
  function openLink(item: AutomationSummary) {
    return (
      <a
        className="dashboard-open"
        href={`#automations/${item.id}`}
        aria-label={`${item.name} — ${item.scope}`}
        onClick={onOpen}
      >
        {item.name}
        {(item.schemaVersion > 3 || item.workflowVersion > 3) &&
          " · Versão não compatível · somente leitura"}
      </a>
    );
  }
  return (
    <div hidden={!visible} className="dashboard">
      <p className="eyebrow">SEUS FLUXOS</p>
      <div className="heading">
        <div>
          <h1>Automações</h1>
          <p>Configure seus fluxos e acompanhe o resultado de cada execução.</p>
        </div>
        <a className="button-link" href="#automations/create">
          + Criar automação
        </a>
      </div>
      <p className="dashboard-limit">
        Ambiente local · utilize dados sintéticos. Sem autenticação ou
        isolamento entre usuários.
      </p>
      <div className="dashboard-controls">
        <form onSubmit={search} noValidate>
          <label htmlFor="dashboard-search">Buscar por nome ou contexto</label>
          <div className="form-row">
            <input
              id="dashboard-search"
              ref={input}
              value={draft}
              placeholder="Nome da automação ou contexto"
              onChange={(e) => {
                setDraft(e.target.value);
                setInvalid(false);
              }}
              aria-invalid={invalid}
              aria-describedby={invalid ? "search-error" : undefined}
            />
            <button>Buscar</button>
          </div>
          {invalid && (
            <p id="search-error" role="alert">
              Use até 200 caracteres ou deixe a busca em branco.
            </p>
          )}
        </form>
        <fieldset className="dashboard-status">
          <legend>Status</legend>
          {[
            ["all", "Todas"],
            ["true", "Ativas"],
            ["false", "Desativadas"],
          ].map(([value, label]) => (
            <label key={value}>
              <input
                type="radio"
                name="dashboard-status"
                value={value}
                checked={request.active === value}
                onChange={() => {
                  if (draft !== "" && !validText(draft, 200)) {
                    setInvalid(true);
                    input.current?.focus();
                    return;
                  }
                  setInvalid(false);
                  load({
                    q: draft,
                    active: value,
                    cursor: null,
                    history: [],
                    focus: false,
                  });
                }}
              />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        <button className="dashboard-reset" onClick={reset}>
          Limpar filtros
        </button>
      </div>
      <section
        className="dashboard-results"
        aria-labelledby="dashboard-results-heading"
        aria-busy={result.kind === "loading"}
      >
        <h2 id="dashboard-results-heading" ref={heading} tabIndex={-1}>
          Resultados
        </h2>
        <p className="muted">Resultados atuais, ordenados por identificador.</p>
        <p role="status" className="sr-only">
          {result.kind === "loading"
            ? "Carregando automações"
            : result.kind === "ready"
              ? "Resultados atualizados"
              : ""}
        </p>
        {result.kind === "loading" ? (
          <p>Carregando automações…</p>
        ) : result.kind === "error" ? (
          <div>
            <p role="alert">
              Não foi possível carregar as automações. Tente novamente.
            </p>
            <button onClick={() => load({ ...request, focus: true })}>
              Tentar novamente
            </button>
            <button onClick={reset}>Limpar filtros</button>
          </div>
        ) : (
          <>
            {result.page.items.length === 0 ? (
              <div className="dashboard-empty">
                {committed.cursor !== null ? (
                  <>
                    <h3>Fim dos resultados</h3>
                    <p>
                      A lista pode ter mudado. Volte ou atualize os resultados.
                    </p>
                  </>
                ) : committed.q || committed.active !== "all" ? (
                  <>
                    <h3>Nenhuma automação encontrada</h3>
                    <p>Tente outra busca ou limpe os filtros.</p>
                    <button onClick={reset}>Limpar filtros</button>
                  </>
                ) : (
                  <>
                    <h3>Crie sua primeira automação</h3>
                    <p>Escolha um modelo e configure as etapas para começar.</p>
                    <a className="button-link" href="#automations/create">
                      Criar automação
                    </a>
                  </>
                )}
              </div>
            ) : (
              <>
                <div className="dashboard-table">
                  <table>
                    <thead>
                      <tr>
                        {[
                          "Nome",
                          "Contexto",
                          "Status",
                          "Revisão",
                          "Schema",
                          "Workflow",
                        ].map((x) => (
                          <th scope="col" key={x}>
                            {x}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.page.items.map((item) => (
                        <tr key={item.id}>
                          <td>
                            <strong>{openLink(item)}</strong>
                            <br />
                            <small>Definição atual</small>
                          </td>
                          <td>{item.scope}</td>
                          <td>
                            <span
                              className={`dashboard-badge ${item.active ? "dashboard-active" : "dashboard-inactive"}`}
                            >
                              {item.active ? "Ativas" : "Desativadas"}
                            </span>
                          </td>
                          <td>{item.revision}</td>
                          <td>v{item.schemaVersion}</td>
                          <td>v{item.workflowVersion}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <ul className="dashboard-cards">
                  {result.page.items.map((item) => (
                    <li key={item.id}>
                      <h3>{openLink(item)}</h3>
                      <p>Definição atual</p>
                      <dl>
                        <dt>Contexto</dt>
                        <dd>{item.scope}</dd>
                        <dt>Status</dt>
                        <dd>
                          <span
                            className={`dashboard-badge ${item.active ? "dashboard-active" : "dashboard-inactive"}`}
                          >
                            {item.active ? "Ativas" : "Desativadas"}
                          </span>
                        </dd>
                        <dt>Revisão</dt>
                        <dd>{item.revision}</dd>
                        <dt>Schema</dt>
                        <dd>v{item.schemaVersion}</dd>
                        <dt>Workflow</dt>
                        <dd>v{item.workflowVersion}</dd>
                      </dl>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {(result.page.items.length > 0 || committed.cursor !== null) && (
              <div className="dashboard-pagination">
                <p>
                  {result.page.nextCursor
                    ? "Há mais resultados."
                    : "Fim dos resultados."}
                </p>
                <div>
                  <button
                    disabled={!committed.history.length}
                    onClick={() =>
                      load({
                        ...committed,
                        cursor: committed.history[committed.history.length - 1],
                        history: committed.history.slice(0, -1),
                        focus: true,
                      })
                    }
                  >
                    Anterior
                  </button>
                  <button
                    disabled={!result.page.nextCursor}
                    onClick={() =>
                      load({
                        ...committed,
                        cursor: result.page.nextCursor,
                        history: [...committed.history, committed.cursor],
                        focus: true,
                      })
                    }
                  >
                    Próxima
                  </button>
                  <button
                    onClick={() =>
                      load({
                        ...committed,
                        cursor: null,
                        history: [],
                        focus: true,
                      })
                    }
                  >
                    Atualizar lista
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
