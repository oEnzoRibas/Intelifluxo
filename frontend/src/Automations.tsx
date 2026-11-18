import WorkflowBuilder from "./WorkflowBuilder";
import TestEventPanel from "./TestEventPanel";
import AutomationDashboard from "./AutomationDashboard";
import { automationRoute } from "./automation-route";
import { createViaCepTemplate } from "./viacep-graph";
import { useRuntimeStatus } from "./use-runtime-status";
import ViaCepResult from "./ViaCepResult";
import { conditionDraft, defaultGraph } from "./workflow-graph";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { ApiError, validId } from "./api";
import {
  ConflictError,
  UnsupportedDefinitionError,
  ValidationError,
  createDefinition,
  getDefinition,
  listExecutions,
  updateDefinition,
  validText,
  type Definition,
  type Execution,
} from "./automation-api";

type State<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "error"; message: string };
const message = (e: unknown) =>
  e instanceof UnsupportedDefinitionError
    ? "Versão de definição não compatível. Somente leitura: não é possível alterá-la."
    : e instanceof ApiError && e.kind === "invalid"
      ? "O serviço retornou uma resposta inesperada."
      : e instanceof ApiError && e.kind === "not-found"
        ? "Automação não encontrada."
        : "O serviço de automações está indisponível. Tente novamente.";
export default function Automations({ route }: { route: string }) {
  const { status: runtime, effective } = useRuntimeStatus();
  const viacepWritesAllowed =
    !!runtime &&
    !effective.stale &&
    runtime.capabilities.viacepWrites &&
    runtime.capabilities.conditionsWrites;
  const viacepAllowed =
    viacepWritesAllowed && !!runtime?.capabilities.viacepExternalExecution;
  const conditionWritesAllowed =
    !!runtime && !effective.stale && runtime.capabilities.conditionsWrites;
  const [createKind, setCreateKind] = useState<"condition" | "viacep">(
    "condition",
  );
  const scope = "local"; // Local routing context.
  const [name, setName] = useState("");
  const [validation, setValidation] = useState("");
  const [detail, setDetail] = useState<State<Definition>>({ kind: "loading" });
  const [history, setHistory] = useState<State<Execution[]>>({
    kind: "loading",
  });
  const [refresh, setRefresh] = useState(0);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [pending, setPending] = useState(false);
  const [builderBlocked, setBuilderBlocked] = useState(false);
  const [refreshingDetail, setRefreshingDetail] = useState(false);
  const [mutationError, setMutationError] = useState("");
  const mutation = useRef<AbortController | null>(null);
  const detailReadVersion = useRef(0);
  const reportBuilderState = useCallback((blocked: boolean) => {
    if (blocked) {
      detailReadVersion.current++;
      setRefreshingDetail(false);
    }
    setBuilderBlocked(blocked);
  }, []);
  const nameInput = useRef<HTMLInputElement>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const focusDetailOnRecovery = useRef(false);
  const historyHeading = useRef<HTMLHeadingElement>(null);
  const { id, builder } = automationRoute(route);
  const create = id === "create";
  // A hash can change through browser history or a direct link, not just our
  // list links. Never show the previous route's snapshot under a new ID.
  const [previousId, setPreviousId] = useState(id);
  if (previousId !== id) {
    setPreviousId(id);
    setDetail({ kind: "loading" });
    setHistory({ kind: "loading" });
  }
  useEffect(() => {
    setPending(false);
    setMutationError("");
    setValidation("");
    setRefreshingDetail(false);
    return () => {
      mutation.current?.abort();
      mutation.current = null;
      focusDetailOnRecovery.current = false;
    };
  }, [route]);
  useEffect(() => {
    if (!id || create) return;
    const controller = new AbortController();
    if (!validId(id)) {
      return () => controller.abort();
    }
    const readVersion = ++detailReadVersion.current;
    getDefinition(id, controller.signal)
      .then((data) => {
        if (
          !controller.signal.aborted &&
          readVersion === detailReadVersion.current
        ) {
          setDetail({ kind: "ready", data });
          setRefreshingDetail(false);
          if (focusDetailOnRecovery.current) {
            focusDetailOnRecovery.current = false;
            detailHeading.current?.focus();
          }
        }
      })
      .catch((e) => {
        if (
          !controller.signal.aborted &&
          readVersion === detailReadVersion.current
        ) {
          setDetail({ kind: "error", message: message(e) });
          setRefreshingDetail(false);
          focusDetailOnRecovery.current = false;
        }
      });
    return () => controller.abort();
  }, [id, create, refresh]);
  useEffect(() => {
    if (!id || create || !validId(id)) return;
    const controller = new AbortController();
    listExecutions(id, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setHistory({ kind: "ready", data });
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setHistory({ kind: "error", message: message(e) });
      });
    return () => controller.abort();
  }, [id, create, refresh, historyRefresh]);
  function reload(preserveDetail = false) {
    if (pending) return;
    setMutationError("");
    if (id && !create) {
      if (preserveDetail) setRefreshingDetail(true);
      else setDetail({ kind: "loading" });
      setHistory({ kind: "loading" });
    }
    setRefresh((x) => x + 1);
  }
  async function createAutomation(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    if (createKind === "condition" && !conditionWritesAllowed) {
      setValidation("A criação de condições está indisponível neste ambiente.");
      return;
    }
    if (createKind === "viacep" && !viacepWritesAllowed) {
      setValidation("A criação ViaCEP está indisponível neste ambiente.");
      return;
    }
    if (!validText(scope, 128) || !validText(name, 200)) {
      setValidation("Informe um nome válido com até 200 caracteres.");
      nameInput.current?.focus();
      return;
    }
    setValidation("");
    setMutationError("");
    setPending(true);
    const controller = new AbortController();
    mutation.current = controller;
    try {
      const d = await createDefinition(
        scope,
        name,
        controller.signal,
        createKind === "viacep"
          ? createViaCepTemplate()
          : conditionDraft(defaultGraph(), false, {
              fieldPath: "message",
              operator: "contains",
              expectedType: "string",
              expectedValue: "pedido",
            }),
      );
      if (!controller.signal.aborted) {
        setDetail({ kind: "loading" });
        setHistory({ kind: "loading" });
        window.location.hash = `#automations/${d.id}/builder`;
      }
    } catch (err) {
      if (!controller.signal.aborted)
        setMutationError(
          `${message(err)} A criação pode ter sido concluída; consulte a lista antes de tentar novamente.`,
        );
    } finally {
      if (!controller.signal.aborted) {
        setPending(false);
        mutation.current = null;
      }
    }
  }
  async function toggle(d: Definition) {
    if (
      !window.confirm(
        `${d.active ? "Desativar" : "Ativar"} ${d.name} na revisão ${d.revision}?`,
      )
    )
      return;
    // A read that began before this write cannot establish its outcome, even
    // when the write fails or its response is delayed.
    detailReadVersion.current++;
    setRefreshingDetail(false);
    setPending(true);
    setMutationError("");
    const controller = new AbortController();
    mutation.current = controller;
    try {
      const updated = await updateDefinition(d, controller.signal);
      if (!controller.signal.aborted)
        setDetail({ kind: "ready", data: updated });
    } catch (err) {
      if (!controller.signal.aborted) {
        if (err instanceof ConflictError) {
          setMutationError(
            "Conflito de revisão: a definição foi alterada. Recarregue antes de tentar novamente.",
          );
        } else if (err instanceof ValidationError) {
          setMutationError(
            err.issues.some(
              (issue) => issue.code === "viacep_external_execution_disabled",
            )
              ? "Execução externa ViaCEP indisponível. Solicite autorização antes de ativar."
              : err.issues.some((issue) => issue.code === "viacep_disabled")
                ? "A edição ViaCEP está indisponível neste ambiente."
                : err.issues.some(
                      (issue) => issue.code === "conditions_disabled",
                    )
                  ? "A edição de condições está indisponível neste ambiente."
                  : "O serviço rejeitou a atualização. Recarregue antes de tentar novamente.",
          );
        } else
          setMutationError(
            `${message(err)} A atualização pode ter sido concluída; recarregue antes de tentar novamente.`,
          );
      }
    } finally {
      if (!controller.signal.aborted) {
        setPending(false);
        mutation.current = null;
      }
    }
  }
  return (
    <div className="automations">
      <AutomationDashboard
        visible={!id}
        onOpen={() => {
          focusDetailOnRecovery.current = true;
        }}
      />
      {id &&
        (create ? (
          <>
            <h1>Criar automação</h1>
            <p>
              Escolha um modelo, configure as etapas e acompanhe cada teste.
            </p>
            <form
              className="panel automation-create"
              onSubmit={createAutomation}
              noValidate
            >
              <fieldset className="automation-type-options" disabled={pending}>
                <legend>Tipo de automação</legend>
                <label>
                  <input
                    type="radio"
                    name="create-kind"
                    aria-label="Condição guiada"
                    checked={createKind === "condition"}
                    disabled={!conditionWritesAllowed}
                    onChange={() => setCreateKind("condition")}
                  />{" "}
                  <span>
                    <strong>Condição guiada</strong>
                    <small>
                      Verifique um dado do evento e registre um recibo quando a
                      condição for atendida.
                    </small>
                  </span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="create-kind"
                    aria-label="Consultar CEP e decidir"
                    disabled={!viacepWritesAllowed}
                    aria-describedby={
                      !viacepWritesAllowed
                        ? "viacep-create-unavailable"
                        : undefined
                    }
                    checked={createKind === "viacep"}
                    onChange={() => setCreateKind("viacep")}
                  />{" "}
                  <span>
                    <strong>Consultar CEP e decidir</strong>
                    <small>
                      Busque um endereço no ViaCEP e decida a partir do estado,
                      cidade ou outro campo.
                    </small>
                  </span>
                </label>
              </fieldset>
              {createKind === "condition" && (
                <p>
                  {conditionWritesAllowed
                    ? 'Exemplo inicial: registrar um recibo quando a mensagem contém "pedido". Você pode alterar a regra no editor.'
                    : "A criação de condições está indisponível ou aguardando confirmação do ambiente."}
                </p>
              )}
              {!viacepWritesAllowed && (
                <p id="viacep-create-unavailable">
                  A criação ViaCEP está indisponível neste ambiente ou o estado
                  do aplicativo não está atualizado.
                </p>
              )}
              {createKind === "viacep" && (
                <p>
                  Exemplo: CEP fixo 01001000 e UF igual a SP. Revise a consulta
                  e a condição antes de ativar.
                </p>
              )}
              <p className="muted">Ambiente local · dados sintéticos</p>
              <label htmlFor="automation-name">Nome da automação</label>
              <input
                id="automation-name"
                ref={nameInput}
                value={name}
                placeholder="Ex.: Validar endereço de entrega"
                disabled={pending}
                onChange={(e) => setName(e.target.value)}
                aria-invalid={!!validation && !validText(name, 200)}
                aria-describedby={
                  validation && !validText(name, 200)
                    ? "create-error"
                    : undefined
                }
              />
              <p>Escolha um nome que ajude a identificar esta automação.</p>
              <p>
                A automação será criada desativada. Configure e salve antes de
                ativar.
              </p>
              {validation && (
                <p role="alert" id="create-error">
                  {validation}
                </p>
              )}
              {mutationError && <p role="alert">{mutationError}</p>}
              <div className="form-row">
                <button
                  className="primary-button"
                  disabled={
                    pending ||
                    (createKind === "viacep"
                      ? !viacepWritesAllowed
                      : !conditionWritesAllowed)
                  }
                >
                  {pending ? "Criando…" : "Criar desativada"}
                </button>
                <a href="#automations">Cancelar</a>
              </div>
            </form>
          </>
        ) : (
          <>
            <p>
              <a
                href="#automations"
                onClick={(event) => {
                  if (
                    builderBlocked &&
                    !window.confirm(
                      "Descartar alterações locais e sair do editor?",
                    )
                  )
                    event.preventDefault();
                }}
              >
                ← Automações
              </a>
            </p>
            <h1 ref={detailHeading} tabIndex={-1}>
              {builder
                ? detail.kind === "ready" && detail.data.schemaVersion === 3
                  ? "Editor ViaCEP"
                  : "Editor de condição"
                : "Detalhes da automação"}
            </h1>
            {!validId(id) ? (
              <p role="alert">Identificador de automação inválido.</p>
            ) : detail.kind === "loading" ? (
              <p role="status">Carregando automação…</p>
            ) : detail.kind === "error" ? (
              <section className="panel">
                <p role="alert">{detail.message}</p>
                <button
                  onClick={() => {
                    focusDetailOnRecovery.current = true;
                    reload();
                  }}
                >
                  Recarregar
                </button>
              </section>
            ) : (
              <>
                <section className="panel">
                  <h2>{detail.data.name}</h2>
                  <p>
                    {detail.data.active ? "Ativa" : "Desativada"} · revisão{" "}
                    {detail.data.revision}
                  </p>
                  {!builder && (
                    <p>
                      Contexto:{" "}
                      {detail.data.scope === "local"
                        ? "Ambiente local"
                        : detail.data.scope}
                    </p>
                  )}
                  {refreshingDetail && (
                    <p role="status">Atualizando automação.</p>
                  )}
                  {!builder && (
                    <p>
                      <a href={`#automations/${id}/builder`}>
                        {detail.data.schemaVersion === 3
                          ? "Abrir editor ViaCEP"
                          : "Abrir editor de condição"}
                      </a>
                    </p>
                  )}
                  {builder && (
                    <p>
                      <a
                        href={`#automations/${id}`}
                        onClick={(event) => {
                          if (
                            builderBlocked &&
                            !window.confirm(
                              "Descartar alterações locais e sair do editor?",
                            )
                          )
                            event.preventDefault();
                        }}
                      >
                        Testar na página da automação
                      </a>{" "}
                      ·{" "}
                      {builderBlocked
                        ? "Salve ou descarte as alterações antes de testar."
                        : detail.data.active
                          ? "Pronta para testar."
                          : "Ative a automação antes de testar."}
                    </p>
                  )}
                  <button
                    disabled={
                      pending ||
                      !!mutationError ||
                      builderBlocked ||
                      (!detail.data.active &&
                        detail.data.schemaVersion === 3 &&
                        !viacepAllowed)
                    }
                    onClick={() => toggle(detail.data)}
                  >
                    {pending
                      ? "Salvando…"
                      : detail.data.active
                        ? "Desativar"
                        : "Ativar"}
                  </button>
                  <button
                    disabled={pending || builderBlocked || refreshingDetail}
                    onClick={() => reload(true)}
                  >
                    Atualizar automação
                  </button>
                  {detail.data.schemaVersion === 3 && !viacepAllowed && (
                    <p className="notice">
                      Consulta externa indisponível neste ambiente. Configure e
                      salve o fluxo; ativação e teste dependem da habilitação da
                      execução ViaCEP.
                    </p>
                  )}
                  {mutationError && (
                    <>
                      <p role="alert">{mutationError}</p>
                      <button
                        disabled={builderBlocked}
                        onClick={() => {
                          setMutationError("");
                          reload();
                        }}
                      >
                        Recarregar
                      </button>
                    </>
                  )}
                </section>
                {builder && (
                  <WorkflowBuilder
                    key={`${detail.data.id}-${detail.data.revision}`}
                    definition={detail.data}
                    onDirty={reportBuilderState}
                    busy={pending || !!mutationError}
                    onSaved={(updated) => {
                      detailReadVersion.current++;
                      setDetail({ kind: "ready", data: updated });
                    }}
                  />
                )}
                {!builder && (
                  <TestEventPanel
                    key={detail.data.id}
                    definition={detail.data}
                    onExecutionTerminal={() => setHistoryRefresh((x) => x + 1)}
                    blocked={
                      builderBlocked ||
                      pending ||
                      !!mutationError ||
                      refreshingDetail
                    }
                  />
                )}
                {!builder && (
                  <>
                    <section className="panel" aria-live="polite">
                      <h2 ref={historyHeading} tabIndex={-1}>
                        Histórico recente
                      </h2>
                      <p className="muted">
                        Lista limitada a até 100 execuções; a ordem não é
                        garantida.
                      </p>
                      {history.kind === "loading" ? (
                        <p>Carregando histórico…</p>
                      ) : history.kind === "error" ? (
                        <>
                          <p role="alert">{history.message}</p>
                          <button
                            disabled={pending}
                            onClick={() => {
                              historyHeading.current?.focus();
                              setHistory({ kind: "loading" });
                              setHistoryRefresh((x) => x + 1);
                            }}
                          >
                            Tentar novamente
                          </button>
                        </>
                      ) : history.data.length === 0 ? (
                        <p>Nenhuma execução retornada nesta lista limitada.</p>
                      ) : (
                        <>
                          <div className="table-wrap">
                            <table>
                              <thead>
                                <tr>
                                  <th>Status da execução</th>
                                  <th>Revisão</th>
                                  <th>Criada em · UTC</th>
                                  <th>Resultado</th>
                                  <th>Evento</th>
                                </tr>
                              </thead>
                              <tbody>
                                {history.data.map((x) => (
                                  <tr key={x.id}>
                                    <td data-label="Status da execução">
                                      <strong>
                                        {
                                          {
                                            accepted: "Recebida",
                                            completed: "Concluída",
                                            ignored: "Ignorada",
                                            retry_scheduled:
                                              "Nova tentativa agendada",
                                            retry_released:
                                              "Nova tentativa liberada",
                                            blocked: "Bloqueada",
                                          }[x.status]
                                        }
                                      </strong>
                                    </td>
                                    <td data-label="Revisão">{x.revision}</td>
                                    <td data-label="Criada em · UTC">
                                      {new Intl.DateTimeFormat("pt-BR", {
                                        dateStyle: "short",
                                        timeStyle: "medium",
                                        timeZone: "UTC",
                                      }).format(new Date(x.createdAt))}{" "}
                                      UTC
                                    </td>
                                    <td data-label="Resultado">
                                      {x.result?.kind ===
                                      "viacep-condition-execution.v1" ? (
                                        <ViaCepResult result={x.result} />
                                      ) : x.result?.kind ===
                                        "condition-execution.v1" ? (
                                        <div
                                          className={`execution-result execution-result--${x.result.action.status}`}
                                        >
                                          <div>
                                            {x.result.decision
                                              ? `Condição: ${x.result.decision.outcome === "TRUE" ? "verdadeira" : "falsa"}`
                                              : "Decisão indisponível"}
                                          </div>
                                          <div>
                                            Ação:{" "}
                                            {
                                              {
                                                executed: "executada",
                                                ignored: "ignorada",
                                                pending: "pendente",
                                                not_executed: "não executada",
                                              }[x.result.action.status]
                                            }
                                          </div>
                                          {x.result.failure && (
                                            <div>Falha na execução</div>
                                          )}
                                        </div>
                                      ) : x.result ? (
                                        "Comprovante registrado"
                                      ) : (
                                        "Indisponível"
                                      )}
                                      <details>
                                        <summary>Detalhes da execução</summary>
                                        <p>ID do evento: {x.eventId}</p>
                                        <p>Revisão utilizada: {x.revision}</p>
                                        {x.result?.kind ===
                                          "condition-execution.v1" &&
                                          x.result.decision && (
                                            <p>
                                              Nó da condição:{" "}
                                              {x.result.decision.nodeId}
                                            </p>
                                          )}
                                        {x.result?.kind ===
                                          "condition-execution.v1" &&
                                          x.result.failure && (
                                            <p>
                                              Falha:{" "}
                                              {x.result.failure.classification}{" "}
                                              · {x.result.failure.code}
                                              {x.result.failure.nodeId &&
                                                ` · nó: ${x.result.failure.nodeId}`}
                                            </p>
                                          )}
                                      </details>
                                    </td>
                                    <td data-label="Evento">
                                      <a
                                        href={`#explorer?eventId=${encodeURIComponent(x.eventId)}`}
                                      >
                                        Abrir evento
                                      </a>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <p className="muted">
                            Até 100 execuções; a API não oferece paginação,
                            ordenação por mais recentes ou data de atualização.
                            Atualize para consultar o estado atual.
                          </p>
                        </>
                      )}
                      <button
                        disabled={pending || builderBlocked}
                        onClick={() => {
                          setHistory({ kind: "loading" });
                          setHistoryRefresh((x) => x + 1);
                        }}
                      >
                        Atualizar histórico
                      </button>
                    </section>
                    <section className="panel">
                      <h2>Revisões</h2>
                      <p>
                        O histórico de revisões não está disponível na API
                        atual. Revisão atual: {detail.data.revision}.
                      </p>
                    </section>
                  </>
                )}
              </>
            )}
          </>
        ))}
    </div>
  );
}
