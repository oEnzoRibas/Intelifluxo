import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";

import {
  listEventExecutions,
  type Definition,
  type Execution,
} from "./automation-api";

import { getEvent, type EventDetail } from "./api";

import {
  newTestEventIntent,
  sendTestEvent,
  type Acceptance,
} from "./test-event-api";

import {
  acquireIntent,
  consumeIntent,
  intentSlot,
  startPost,
  subscribeIntent,
  type IntentEnvelope,
  type Snapshot,
} from "./test-event-intent-registry";

import { useRuntimeStatus } from "./use-runtime-status";

import { effectiveRuntime } from "./runtime-status";
import { cepValid } from "./viacep-graph";
import ViaCepResult from "./ViaCepResult";
import {
  conditionTestField,
  testEventData,
  readTestField,
  type FieldValue,
} from "./test-event-fields";
import type { EventData } from "./event-data";

type Result =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "accepted"; acceptance: Acceptance }
  | { kind: "conflict" | "validation" | "uncertain" | "message" };

type Reads = {
  loading: boolean;

  event: EventDetail | null;

  executions: Execution[] | null;

  eventError: boolean;

  executionsError: boolean;

  loaded: boolean;
};

const emptyReads: Reads = {
  loading: false,

  event: null,

  executions: null,

  eventError: false,

  executionsError: false,

  loaded: false,
};

function lifecycle(
  status: Execution["status"] | EventDetail["status"],

  publication?: EventDetail["publication"],
) {
  switch (status) {
    case "completed":
      return "Concluído";

    case "ignored":
      return "Ignorado — condição não atendida";

    case "blocked":
      return "Interrompido — precisa de atenção";

    case "retry_scheduled":
      return "Aguardando nova tentativa automática";

    case "retry_released":
      return "Nova tentativa na fila";

    default:
      return publication === "pending"
        ? "Aceito — aguardando envio"
        : publication === "confirmed"
          ? "Enviado — aguardando resultado"
          : "Aceito — aguardando resultado";
  }
}

function ResultMessage({
  result,
}: {
  result: Execution["result"] | EventDetail["result"];
}) {
  if (!result) return <p>Resultado ainda não disponível.</p>;

  if (result.kind === "local-receipt.v1")
    return <p>Recibo local: {result.message}</p>;

  if (result.kind === "viacep-condition-execution.v1")
    return <ViaCepResult result={result} />;

  return (
    <div>
      <p>
        Condição:{" "}
        {result.decision
          ? result.decision.outcome === "TRUE"
            ? "atendida"
            : "não atendida"
          : "sem decisão"}
        .
      </p>

      <p>
        Ação:{" "}
        {
          (
            {
              executed: "executada",

              ignored: "ignorada",

              pending: "pendente",

              not_executed: "não executada",
            } as const
          )[result.action.status]
        }
        .
      </p>

      {result.action.receipt && (
        <p>Recibo local: {result.action.receipt.message}</p>
      )}

      {result.failure && <p>A execução requer atenção.</p>}
    </div>
  );
}

function Earliest({ value }: { value: string | null | undefined }) {
  return value ? (
    <p>
      Próxima tentativa não antes de:{" "}
      <time dateTime={value}>{new Date(value).toLocaleString("pt-BR")}</time>
    </p>
  ) : null;
}

const validMessage = (value: string) =>
  [...value].length >= 1 &&
  [...value].length <= 1024 &&
  !value.includes("\0") &&
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
    value,
  );

const storage = () => sessionStorage;

type Envelope = IntentEnvelope;

function executionLifecycle(status: Execution["status"]) {
  return lifecycle(status);
}

export default function TestEventPanel({
  definition,

  blocked,

  onExecutionTerminal,
}: {
  definition: Definition;

  blocked: boolean;

  onExecutionTerminal?: () => void;
}) {
  const { status: runtime, effective } = useRuntimeStatus();

  const [message, setMessage] = useState("");
  const [testCep, setTestCep] = useState("");
  const conditionField = conditionTestField(definition);
  const [testField, setTestField] = useState<FieldValue>({
    type: "string",
    value: "",
  });
  const [dataError, setDataError] = useState("");
  const lookup =
    definition.graph.version === 3
      ? definition.graph.nodes.find((n) => n.kind === "lookup")
      : undefined;
  const eventCep =
    lookup?.kind === "lookup" && lookup.config.cep.source === "event";
  const unsupportedPath =
    eventCep &&
    lookup.config.cep.source === "event" &&
    !lookup.config.cep.fieldPath.startsWith("data.");
  const cepPath =
    eventCep && lookup.config.cep.source === "event"
      ? lookup.config.cep.fieldPath
      : null;
  const additionalField =
    conditionField && conditionField.path !== cepPath ? conditionField : null;
  const conditionPath = additionalField?.path ?? null;
  const restoreFields = useCallback(
    (envelope: Envelope) => {
      setTestCep(readTestField(envelope.intent.data, cepPath).value);
      setTestField(readTestField(envelope.intent.data, conditionPath));
    },
    [cepPath, conditionPath],
  );
  const inputContract =
    additionalField || (eventCep && cepPath !== "data.cep")
      ? "event-data-v1"
      : definition.graph.version !== 3
        ? "flat-v1"
        : eventCep
          ? "viacep-event-data-cep-v1"
          : "viacep-fixed-v1";
  const compatible = useCallback(
    (envelope: Envelope) =>
      !unsupportedPath &&
      envelope.context?.version === 1 &&
      envelope.context.definitionRevision === definition.revision &&
      envelope.context.inputContract === inputContract,
    [unsupportedPath, definition.revision, inputContract],
  );
  const currentConfiguration = useRef({
    id: definition.id,
    scope: definition.scope,
    compatible,
  });
  currentConfiguration.current = {
    id: definition.id,
    scope: definition.scope,
    compatible,
  };
  const [incompatible, setIncompatible] = useState(false);

  const instanceId = useId();

  const [result, setResult] = useState<Result>({ kind: "idle" });

  const [storageWarning, setStorageWarning] = useState(false);

  const intent = useRef<Envelope | null>(null);

  const displayedOutcome = useRef<Envelope | null>(null);

  const request = useRef(false);

  const generation = useRef(0);

  const summary = useRef<HTMLDivElement>(null);

  const lifecycleSummary = useRef<HTMLHeadingElement>(null);

  const notifiedExecution = useRef<string | null>(null);

  const terminalCallback = useRef(onExecutionTerminal);

  terminalCallback.current = onExecutionTerminal;

  const readsRequest = useRef<AbortController | null>(null);

  const readsSettled = useRef<Promise<void> | null>(null);

  const [reads, setReads] = useState<Reads>(emptyReads);

  const [updatesPaused, setUpdatesPaused] = useState(false);

  const [pollEpoch, setPollEpoch] = useState(0);

  const refreshResults = useRef<() => void>(() => {});

  const reason = !definition.active
    ? "A automação está inativa."
    : blocked
      ? "Salve ou descarte as alterações do editor antes de enviar."
      : definition.schemaVersion === 3 &&
          (effective.stale ||
            !runtime?.capabilities.viacepWrites ||
            !runtime?.capabilities.viacepExternalExecution)
        ? "A execução externa ViaCEP não está disponível. Solicite autorização para ativar e testar."
        : unsupportedPath
          ? "Para testar pela interface, configure o CEP em um campo como data.cep."
          : !/^[A-Za-z0-9_-]{1,64}$(?![\s\S])/.test(definition.scope)
            ? "O escopo não é compatível com eventos de teste: use 1 a 64 letras, números, hífen ou sublinhado."
            : !effective.canSubmit
              ? effective.stale
                ? "A observação de prontidão está desatualizada."
                : runtime && !runtime.capabilities.automationSnapshots
                  ? "Eventos de teste estão indisponíveis: snapshots desativados."
                  : "Os serviços ainda não estão prontos para receber eventos."
              : "";

  useEffect(() => {
    const current = ++generation.current;

    const slot = intentSlot(definition.id, definition.scope);

    intent.current = null;

    displayedOutcome.current = null;

    request.current = false;

    setMessage("");
    setTestCep("");
    setTestField({
      type: conditionTestField(definition)?.type ?? "string",
      value: "",
    });
    setDataError("");
    setIncompatible(false);

    setResult({ kind: "idle" });

    setReads(emptyReads);

    setStorageWarning(false);

    const adopt = (state: Snapshot) => {
      if (generation.current !== current) return;

      setStorageWarning(
        state.persistence === "unavailable" ||
          state.persistence === "conflict" ||
          state.persistence === "invalid",
      );

      // An outcome already delivered to this panel belongs to its local UI until

      // this panel explicitly dismisses it, even if another panel consumes it.

      if (displayedOutcome.current) return;

      if (
        state.outcome &&
        state.outcome.envelope.definitionId === definition.id &&
        state.outcome.envelope.intent.scope === definition.scope
      ) {
        intent.current = null;

        displayedOutcome.current = state.outcome.envelope;

        setMessage(state.outcome.envelope.intent.message);
        restoreFields(state.outcome.envelope);

        setResult(state.outcome.result);

        return;
      }

      if (state.persistence === "conflict" || state.persistence === "invalid")
        return;

      if (!state.envelope && intent.current) {
        intent.current = null;

        setResult((previous) =>
          previous.kind === "uncertain" ? { kind: "idle" } : previous,
        );
      }

      if (
        state.envelope &&
        state.envelope.definitionId === definition.id &&
        state.envelope.intent.scope === definition.scope
      ) {
        intent.current = state.envelope;

        setMessage(state.envelope.intent.message);
        restoreFields(state.envelope);
        setIncompatible(!compatible(state.envelope));

        setResult((previous) =>
          previous.kind === "pending" || previous.kind === "accepted"
            ? previous
            : { kind: "uncertain" },
        );
      }
    };

    const unsubscribe = subscribeIntent(slot, adopt, storage);

    return () => {
      generation.current = current + 1;

      unsubscribe();

      readsRequest.current?.abort();
    };
  }, [definition.id, definition.scope, definition, compatible, restoreFields]);

  useEffect(() => {
    if (!["idle", "pending", "accepted"].includes(result.kind))
      summary.current?.focus();
  }, [result]);

  useEffect(() => {
    if (result.kind === "accepted") lifecycleSummary.current?.focus();
  }, [result]);

  const acceptedId = result.kind === "accepted" ? result.acceptance.id : null;

  useEffect(() => {
    if (!acceptedId) return;

    let disposed = false;

    let timer: ReturnType<typeof setTimeout> | undefined;

    let failures = 0;

    let terminal = false;

    let waiting = false;

    const started = Date.now();

    // Loopback services remain reachable without an Internet connection.
    const available = () => document.visibilityState === "visible";

    const run = async (manual = false) => {
      if (disposed || !available() || (!manual && terminal)) return;

      clearTimeout(timer);

      if (readsSettled.current) {
        setReads((previous) => ({ ...previous, loading: true }));

        if (!waiting) {
          waiting = true;

          void readsSettled.current.then(() => {
            waiting = false;

            if (!disposed) void run(manual);
          });
        }

        return;
      }

      if (
        disposed ||
        readsRequest.current ||
        !available() ||
        (!manual && terminal)
      )
        return;

      if (!manual && Date.now() - started >= 300000) {
        setUpdatesPaused(true);

        return;
      }

      const controller = new AbortController();

      readsRequest.current = controller;

      setReads((previous) => ({ ...previous, loading: true }));

      const pending = Promise.allSettled([
        getEvent(acceptedId, controller.signal),

        listEventExecutions(acceptedId, controller.signal),
      ]);

      const settled = pending.then(() => {});

      readsSettled.current = settled;

      const [event, executions] = await pending;

      if (readsSettled.current === settled) readsSettled.current = null;

      if (readsRequest.current === controller) readsRequest.current = null;

      if (disposed) return;

      if (controller.signal.aborted) {
        setReads((previous) => ({ ...previous, loading: false }));

        return;
      }

      const failed =
        event.status === "rejected" || executions.status === "rejected";

      failures = failed ? failures + 1 : 0;

      setReads((previous) => ({
        loading: false,

        loaded: true,

        event: event.status === "fulfilled" ? event.value : previous.event,

        executions:
          executions.status === "fulfilled"
            ? executions.value
            : previous.executions,

        eventError: event.status === "rejected",

        executionsError: executions.status === "rejected",
      }));

      if (
        !failed &&
        event.status === "fulfilled" &&
        executions.status === "fulfilled"
      ) {
        const current = executions.value.find(
          (x) => x.automationId === definition.id,
        );

        terminal =
          ["completed", "ignored", "blocked"].includes(event.value.status) &&
          !!current &&
          ["completed", "ignored", "blocked"].includes(current.status);
      }

      if (terminal && notifiedExecution.current !== acceptedId) {
        notifiedExecution.current = acceptedId;

        terminalCallback.current?.();
      }

      if (!terminal && available())
        timer = setTimeout(
          () => void run(),

          Math.min(
            30000,

            2000 * 2 ** failures,

            Math.max(0, 300000 - (Date.now() - started)),
          ),
        );
    };

    refreshResults.current = () => {
      clearTimeout(timer);

      void run(true);
    };

    const change = () => {
      clearTimeout(timer);

      if (!available()) {
        readsRequest.current?.abort();

        setReads((previous) => ({
          ...previous,

          loading: !!readsSettled.current,

          eventError: true,

          executionsError: true,
        }));
      } else void run();
    };

    document.addEventListener("visibilitychange", change);

    window.addEventListener("online", change);

    window.addEventListener("offline", change);

    void run();

    return () => {
      disposed = true;

      clearTimeout(timer);

      readsRequest.current?.abort();

      refreshResults.current = () => {};

      document.removeEventListener("visibilitychange", change);

      window.removeEventListener("online", change);

      window.removeEventListener("offline", change);
    };
  }, [acceptedId, definition.id, pollEpoch]);

  async function send(proposed: () => Envelope) {
    if (request.current || reason || !effectiveRuntime(runtime).canSubmit)
      return;

    const slot = intentSlot(definition.id, definition.scope);

    const state = acquireIntent(slot, storage, proposed);

    const envelope = state.envelope;

    setStorageWarning(
      state.persistence === "unavailable" ||
        state.persistence === "conflict" ||
        state.persistence === "invalid",
    );

    if (!envelope) return;

    if (!compatible(envelope)) {
      intent.current = envelope;
      setMessage(envelope.intent.message);
      restoreFields(envelope);
      setIncompatible(true);
      setResult({ kind: "uncertain" });
      return;
    }

    if (
      state.persistence === "conflict" ||
      state.persistence === "invalid" ||
      envelope.definitionId !== definition.id ||
      envelope.intent.scope !== definition.scope
    ) {
      return;
    }

    intent.current = envelope;

    setMessage(envelope.intent.message);
    restoreFields(envelope);

    const current = generation.current;

    request.current = true;

    setResult({ kind: "pending" });

    try {
      await startPost(
        slot,

        envelope,

        () => {
          const current = currentConfiguration.current;
          if (
            current.id !== envelope.definitionId ||
            current.scope !== envelope.intent.scope ||
            !current.compatible(envelope)
          )
            throw new Error("Workflow configuration changed before submission");
          return sendTestEvent(envelope.intent, new AbortController().signal);
        },

        storage,
      );
    } catch {
      if (generation.current === current && intent.current === envelope)
        setResult({ kind: "uncertain" });
    } finally {
      if (generation.current === current) request.current = false;
    }
  }

  function consume() {
    if (displayedOutcome.current) {
      const envelope = displayedOutcome.current;

      displayedOutcome.current = null;

      consumeIntent(
        intentSlot(definition.id, definition.scope),

        storage,

        envelope,
      );
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();

    if (
      reason ||
      request.current ||
      result.kind === "uncertain" ||
      result.kind === "accepted" ||
      result.kind === "validation" ||
      result.kind === "conflict"
    )
      return;

    setDataError("");
    if (!validMessage(message) || (eventCep && !cepValid(testCep))) {
      setResult({ kind: "message" });

      return;
    }
    let data: EventData | undefined;
    try {
      data = testEventData([
        ...(eventCep && cepPath
          ? [
              {
                path: cepPath,
                input: {
                  type: "string" as const,
                  value: testCep.replace("-", ""),
                },
              },
            ]
          : []),
        ...(additionalField
          ? [{ path: additionalField.path, input: testField }]
          : []),
      ]);
    } catch (error) {
      setDataError(
        error instanceof Error ? error.message : "Revise os dados do teste.",
      );
      return;
    }
    void send(() => ({
      version: 1,

      definitionId: definition.id,

      owner: crypto.randomUUID(),

      context: {
        version: 1,
        definitionRevision: definition.revision,
        inputContract,
      },

      intent: newTestEventIntent(definition.scope, message, undefined, data),
    }));
  }

  return (
    <section
      className="panel test-event-panel"
      aria-labelledby={`${instanceId}-title`}
    >
      <h2 id={`${instanceId}-title`}>Enviar evento de teste</h2>

      <p>Este evento é sintético e usa o destino de recibo local.</p>

      {storageWarning && (
        <p role="alert">
          Não foi possível acessar o armazenamento da sessão. Ao sair, a
          continuidade da tentativa pode ser perdida; um evento anterior ainda
          pode ter sido aceito.
        </p>
      )}

      <p className="test-scope-notice">
        O evento pode afetar outras automações ativas no mesmo escopo.
      </p>

      <p>
        O teste usa a revisão ativa salva ({definition.revision}); alterações
        não salvas não são incluídas.
      </p>

      <details>
        <summary>Prontidão dos serviços e recuperação</summary>
        <p>
          Solicitações pendentes são preservadas nesta sessão. Uma retentativa
          usa os mesmos dados e a mesma chave, evitando criar outro evento.
        </p>

        <p>
          {effective.stale
            ? "Observação desatualizada"
            : `Estado: ${effective.state}`}
        </p>

        {runtime && <pre>{JSON.stringify(runtime.components, null, 2)}</pre>}
      </details>

      <form onSubmit={submit} noValidate>
        <p>
          Contexto de execução:{" "}
          <strong>
            {definition.scope === "local" ? "Ambiente local" : definition.scope}
          </strong>
        </p>

        <label htmlFor={`${instanceId}-message`}>Mensagem</label>

        <textarea
          id={`${instanceId}-message`}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          disabled={
            result.kind === "pending" ||
            result.kind === "uncertain" ||
            result.kind === "accepted"
          }
          aria-invalid={result.kind === "message"}
          aria-describedby={
            result.kind === "message" ? `${instanceId}-feedback` : undefined
          }
        />

        {eventCep && !unsupportedPath && (
          <label>
            CEP para este teste
            <input
              aria-label="CEP para este teste"
              inputMode="numeric"
              autoComplete="postal-code"
              placeholder="01001-000"
              value={testCep}
              onChange={(e) => setTestCep(e.target.value)}
              disabled={
                result.kind === "pending" ||
                result.kind === "uncertain" ||
                result.kind === "accepted"
              }
              aria-invalid={
                (testCep !== "" || result.kind === "message") &&
                !cepValid(testCep)
              }
            />
            Use 8 dígitos ou 00000-000, sem espaços.
          </label>
        )}
        {additionalField && (
          <fieldset
            className="test-data-fields"
            disabled={["pending", "uncertain", "accepted"].includes(
              result.kind,
            )}
          >
            <legend>Dado usado pela condição</legend>
            <p>
              A condição consulta <strong>{additionalField.path}</strong>.
              Informe o valor que este evento deve receber.
            </p>
            <label>
              Tipo do dado
              <select
                value={testField.type}
                onChange={(e) =>
                  setTestField({
                    type: e.target.value as FieldValue["type"],
                    value: "",
                  })
                }
              >
                <option value="string">Texto</option>
                <option value="number">Número</option>
                <option value="boolean">Verdadeiro ou falso</option>
                <option value="null">Nulo</option>
                <option value="missing">Não enviar este campo</option>
              </select>
            </label>
            {testField.type !== "null" && testField.type !== "missing" && (
              <label>
                Valor de {additionalField.path}
                {testField.type === "boolean" ? (
                  <select
                    value={testField.value || "false"}
                    onChange={(e) =>
                      setTestField({ ...testField, value: e.target.value })
                    }
                  >
                    <option value="false">Falso</option>
                    <option value="true">Verdadeiro</option>
                  </select>
                ) : (
                  <input
                    value={testField.value}
                    inputMode={testField.type === "number" ? "decimal" : "text"}
                    onChange={(e) => {
                      setTestField({ ...testField, value: e.target.value });
                      setDataError("");
                    }}
                    aria-invalid={!!dataError}
                    aria-describedby={
                      dataError ? `${instanceId}-data-error` : undefined
                    }
                  />
                )}
              </label>
            )}
          </fieldset>
        )}
        {dataError && (
          <p role="alert" id={`${instanceId}-data-error`}>
            {dataError}
          </p>
        )}
        {reason && <p>{reason}</p>}
        {incompatible && (
          <p>
            A solicitação anterior continua incerta e pertence a uma
            configuração anterior da automação. Resolva a solicitação anterior
            antes de iniciar outro evento.
          </p>
        )}

        {result.kind !== "idle" && result.kind !== "pending" && (
          <div
            id={`${instanceId}-feedback`}
            className="test-event-feedback"
            ref={summary}
            tabIndex={-1}
          >
            {result.kind === "accepted" ? (
              <>
                <h3 ref={lifecycleSummary} tabIndex={-1}>
                  {result.acceptance.replay
                    ? "Solicitação anterior confirmada."
                    : "Evento aceito."}
                </h3>

                <div aria-label="Resultado do evento">
                  <div aria-live="polite" aria-atomic="true">
                    {reads.loading && !reads.loaded && (
                      <p>Consultando resultado…</p>
                    )}

                    {reads.loaded && reads.event && (
                      <p className="sr-only">
                        {lifecycle(reads.event.status, reads.event.publication)}
                      </p>
                    )}
                  </div>

                  {(reads.eventError || reads.executionsError) &&
                    reads.loaded && (
                      <p>Os dados anteriores podem estar desatualizados.</p>
                    )}

                  {reads.eventError && (
                    <p>Não foi possível consultar o evento.</p>
                  )}

                  {reads.executionsError && (
                    <p>Não foi possível consultar as execuções.</p>
                  )}

                  {reads.event && (
                    <section aria-label="Situação do evento">
                      <h3>Situação do evento</h3>

                      <p>
                        {lifecycle(reads.event.status, reads.event.publication)}
                      </p>

                      {reads.event.status === "retry_scheduled" && (
                        <Earliest value={reads.event.retry?.nextEligibleAt} />
                      )}

                      <ResultMessage result={reads.event.result} />

                      <p>
                        O recibo do evento não confirma a execução desta
                        automação.
                      </p>
                    </section>
                  )}

                  {reads.executions && (
                    <section aria-label="Execuções do evento">
                      <h3>Execuções do evento</h3>

                      <p>
                        Esta consulta retorna até 100 registros e pode não
                        incluir todas as execuções.
                      </p>

                      {reads.executions.length === 0 && (
                        <p>
                          Nenhum registro de execução encontrado para este
                          evento.
                        </p>
                      )}

                      {!reads.executions.some(
                        (x) => x.automationId === definition.id,
                      ) && (
                        <p>
                          A automação atual não está entre os registros
                          retornados.
                        </p>
                      )}

                      {reads.executions.length > 0 && (
                        <ul>
                          {reads.executions.map((x) => (
                            <li key={x.id}>
                              <p>
                                {x.automationId === definition.id
                                  ? `Automação atual: ${definition.name}`
                                  : "Outra automação"}{" "}
                                — revisão {x.revision}
                              </p>

                              <p>{executionLifecycle(x.status)}</p>

                              {x.status === "retry_scheduled" && (
                                <Earliest value={x.retry?.nextEligibleAt} />
                              )}

                              <ResultMessage result={x.result} />
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  )}
                </div>

                <button
                  type="button"
                  disabled={reads.loading}
                  onClick={() => refreshResults.current()}
                >
                  Atualizar resultado
                </button>

                {updatesPaused && (
                  <p>
                    Atualizações automáticas pausadas.{" "}
                    <button
                      type="button"
                      onClick={() => {
                        setUpdatesPaused(false);

                        setPollEpoch((x) => x + 1);
                      }}
                    >
                      Continuar atualizações
                    </button>
                  </p>
                )}

                <details>
                  <summary>Detalhes técnicos</summary>

                  <p>ID do evento: {result.acceptance.id}</p>

                  {reads.event && (
                    <pre>
                      {JSON.stringify(
                        {
                          content: reads.event.content,

                          result: reads.event.result,

                          retry: reads.event.retry,
                        },

                        null,

                        2,
                      )}
                    </pre>
                  )}

                  {reads.executions && (
                    <pre>
                      {JSON.stringify(
                        reads.executions.map((x) => ({
                          id: x.id,

                          automationId: x.automationId,

                          result: x.result,

                          retry: x.retry,
                        })),

                        null,

                        2,
                      )}
                    </pre>
                  )}
                </details>

                <button
                  type="button"
                  onClick={() => {
                    consume();

                    readsRequest.current?.abort();

                    setReads(emptyReads);

                    setUpdatesPaused(false);

                    intent.current = null;

                    setResult({ kind: "idle" });
                  }}
                >
                  Repetir teste
                </button>

                <button
                  type="button"
                  onClick={() => {
                    consume();

                    readsRequest.current?.abort();

                    setReads(emptyReads);

                    setUpdatesPaused(false);

                    intent.current = null;

                    setMessage("");

                    setResult({ kind: "idle" });
                  }}
                >
                  Enviar outro evento
                </button>
              </>
            ) : result.kind === "uncertain" ? (
              <>
                <p>
                  Não foi possível confirmar o resultado. O evento pode ter sido
                  aceito.
                </p>

                <button
                  type="button"
                  disabled={!!reason || incompatible}
                  onClick={() => {
                    if (intent.current) {
                      const existing = intent.current;

                      void send(() => existing);
                    }
                  }}
                >
                  Tentar novamente com a mesma solicitação
                </button>
              </>
            ) : result.kind === "conflict" ? (
              <>
                <p>
                  Conflito de solicitação: a chave já está associada a outro
                  evento.
                </p>

                <button
                  type="button"
                  onClick={() => {
                    consume();

                    setResult({ kind: "idle" });
                  }}
                >
                  Repetir teste
                </button>
              </>
            ) : result.kind === "validation" ? (
              <>
                <p>
                  O serviço rejeitou os dados do evento. Revise os campos antes
                  de tentar novamente.
                </p>

                <button
                  type="button"
                  onClick={() => {
                    consume();

                    setResult({ kind: "idle" });
                  }}
                >
                  Repetir teste
                </button>
              </>
            ) : (
              <p>
                Informe uma mensagem de 1 a 1024 caracteres, sem NUL ou
                caracteres Unicode inválidos.
              </p>
            )}
          </div>
        )}

        {!["accepted", "uncertain", "validation", "conflict"].includes(
          result.kind,
        ) && (
          <button
            className="primary-button"
            disabled={!!reason || result.kind === "pending"}
          >
            {result.kind === "pending" ? "Enviando…" : "Enviar evento de teste"}
          </button>
        )}
      </form>
    </section>
  );
}
