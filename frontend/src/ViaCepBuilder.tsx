import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ConflictError,
  ValidationError,
  getDefinition,
  saveGraph,
  type Definition,
} from "./automation-api";
import {
  conditionConfigValid,
  fieldPathValid,
  type ConditionConfig,
} from "./condition-contract";
import { ConditionInspector } from "./WorkflowBuilder";
import {
  cepValid,
  viacepGraphValid,
  type CepInput,
  type ViaCepGraph,
  type ViaCepConditionInput,
} from "./viacep-graph";
import "./automation-experience.css";

const addressFields: Record<string, string> = {
  "address.uf": "Estado (UF)",
  "address.localidade": "Cidade",
  "address.bairro": "Bairro",
  "address.logradouro": "Logradouro",
  "address.complemento": "Complemento",
  "address.cep": "CEP",
};
const operators = {
  exists: "existe",
  equals: "é igual a",
  not_equals: "é diferente de",
  greater_than: "é maior que",
  less_than: "é menor que",
  contains: "contém",
};

type Props = {
  definition: Definition;
  graph: ViaCepGraph;
  onSaved: (d: Definition) => void;
  onDirty: (dirty: boolean) => void;
  busy?: boolean;
};
export default function ViaCepBuilder({
  definition,
  graph,
  onSaved,
  onDirty,
  busy,
}: Props) {
  const [baseline, setBaseline] = useState(definition);
  const [draft, setDraft] = useState(graph);
  const lookup = draft.nodes.find((n) => n.kind === "lookup")!;
  const condition = draft.nodes.find((n) => n.kind === "condition")!;
  if (lookup.kind !== "lookup" || condition.kind !== "condition")
    throw new Error("Invalid graph");
  const [cep, setCep] = useState<CepInput>(lookup.config.cep);
  const [input, setInput] = useState<ViaCepConditionInput>(
    condition.config.input,
  );
  const [config, setConfig] = useState<ConditionConfig>(() => {
    const { input, ...rest } = condition.config;
    return { ...rest, fieldPath: input.fieldPath } as ConditionConfig;
  });
  const cepValues = useRef<{ fixed: string; event: string }>({
    fixed: lookup.config.cep.source === "fixed" ? lookup.config.cep.value : "",
    event:
      lookup.config.cep.source === "event"
        ? lookup.config.cep.fieldPath
        : "data.cep",
  });
  const conditionValues = useRef<Record<"step" | "event", ConditionConfig>>({
    step: {
      ...config,
      fieldPath: input.source === "step" ? input.fieldPath : "address.uf",
    },
    event: {
      ...config,
      fieldPath: input.source === "event" ? input.fieldPath : "data.uf",
    },
  });
  const inspectorHeading = useRef<HTMLHeadingElement>(null);
  const [selected, setSelected] = useState<"lookup" | "condition" | null>(null);
  const [pending, setPending] = useState(false);
  const [locked, setLocked] = useState(false);
  const [gateDisabled, setGateDisabled] = useState(false);
  const [problem, setProblem] = useState("");
  const invoker = useRef<HTMLButtonElement | null>(null);
  const restore = useRef(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useLayoutEffect(() => {
    if (selected && window.matchMedia?.("(max-width: 599px)").matches)
      inspectorHeading.current?.focus();
    if (!selected && restore.current) {
      restore.current = false;
      invoker.current?.focus();
    }
  }, [selected]);
  const { input: originalInput, ...originalConfig } = condition.config;
  const inspectorDirty =
    JSON.stringify(cep) !== JSON.stringify(lookup.config.cep) ||
    JSON.stringify(config) !==
      JSON.stringify({
        ...originalConfig,
        fieldPath: originalInput.fieldPath,
      }) ||
    JSON.stringify(input) !== JSON.stringify(originalInput);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline.graph);
  const validCep =
    cep.source === "fixed"
      ? cepValid(cep.value)
      : fieldPathValid(cep.fieldPath);
  const validCondition = conditionConfigValid(config);
  const editable =
    !baseline.active && !pending && !locked && !gateDisabled && !busy;
  useEffect(() => {
    onDirty(dirty || inspectorDirty || locked || pending || gateDisabled);
  }, [dirty, inspectorDirty, locked, pending, gateDisabled, onDirty]);
  function close() {
    restore.current = true;
    setSelected(null);
  }
  function discardInspector() {
    setCep(lookup.config.cep);
    setInput(originalInput);
    setConfig({
      ...originalConfig,
      fieldPath: originalInput.fieldPath,
    } as ConditionConfig);
    close();
  }
  function apply() {
    if (!editable || (selected === "lookup" ? !validCep : !validCondition))
      return;
    setDraft((g) => ({
      ...g,
      nodes: g.nodes.map((n) => {
        if (selected === "lookup" && n.kind === "lookup")
          return { ...n, config: { cep } };
        if (selected === "condition" && n.kind === "condition") {
          const { fieldPath, ...rest } = config;
          return {
            ...n,
            config: { ...rest, input: { ...input, fieldPath } },
          } as typeof n;
        }
        return n;
      }),
    }));
    close();
  }
  async function save() {
    if (!editable || !dirty || inspectorDirty || !viacepGraphValid(draft))
      return;
    setPending(true);
    setProblem("");
    const controller = new AbortController();
    request.current = controller;
    try {
      const updated = await saveGraph(baseline, draft, controller.signal);
      if (controller.signal.aborted) return;
      if (updated.graph.version !== 3) throw new Error("Unexpected version");
      setBaseline(updated);
      setDraft(updated.graph);
      onSaved(updated);
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err instanceof ValidationError) {
        if (
          err.issues.some(
            (issue) =>
              issue.code === "viacep_disabled" ||
              issue.code === "conditions_disabled",
          )
        )
          setGateDisabled(true);
        setProblem(
          `Servidor recusou a definição: ${err.issues.map((i) => (i.code === "viacep_disabled" || i.code === "conditions_disabled" ? "gate desabilitado" : i.code)).join(", ")}. Rascunho preservado.`,
        );
      } else {
        setLocked(true);
        setProblem(
          err instanceof ConflictError
            ? "Conflito de revisão. Rascunho preservado; recarregue deliberadamente."
            : "Resultado desconhecido. Rascunho preservado; recarregue antes de tentar novamente.",
        );
      }
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }
  async function reload() {
    if (!window.confirm("Recarregar e descartar o rascunho local?")) return;
    setPending(true);
    const controller = new AbortController();
    request.current = controller;
    try {
      const updated = await getDefinition(definition.id, controller.signal);
      if (controller.signal.aborted) return;
      if (updated.graph.version !== 3) {
        setProblem(
          "A versão do servidor mudou. Rascunho preservado; não é possível substituí-lo aqui.",
        );
        return;
      }
      const nextLookup = updated.graph.nodes.find((n) => n.kind === "lookup");
      const nextCondition = updated.graph.nodes.find(
        (n) => n.kind === "condition",
      );
      if (
        !nextLookup ||
        nextLookup.kind !== "lookup" ||
        !nextCondition ||
        nextCondition.kind !== "condition"
      )
        throw new Error("Invalid graph");
      const { input: nextInput, ...nextConfig } = nextCondition.config;
      setBaseline(updated);
      setDraft(updated.graph);
      setCep(nextLookup.config.cep);
      cepValues.current = {
        fixed:
          nextLookup.config.cep.source === "fixed"
            ? nextLookup.config.cep.value
            : "",
        event:
          nextLookup.config.cep.source === "event"
            ? nextLookup.config.cep.fieldPath
            : "data.cep",
      };
      const restoredConfig = {
        ...nextConfig,
        fieldPath: nextInput.fieldPath,
      } as ConditionConfig;
      conditionValues.current = {
        step: {
          ...restoredConfig,
          fieldPath:
            nextInput.source === "step" ? nextInput.fieldPath : "address.uf",
        },
        event: {
          ...restoredConfig,
          fieldPath:
            nextInput.source === "event" ? nextInput.fieldPath : "data.uf",
        },
      };
      setInput(nextInput);
      setConfig({
        ...nextConfig,
        fieldPath: nextInput.fieldPath,
      } as ConditionConfig);
      setLocked(false);
      setGateDisabled(false);
      setProblem("");
      setSelected(null);
      onSaved(updated);
    } catch {
      if (!controller.signal.aborted)
        setProblem("Falha ao recarregar. Rascunho preservado.");
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }
  return (
    <section
      className={`panel viacep-builder ${selected ? "viacep-inspector-open" : ""}`}
      aria-label="Editor ViaCEP"
      onKeyDown={(e) => {
        if (e.key === "Escape" && selected) {
          e.preventDefault();
          close();
        }
      }}
    >
      <div className="flow-toolbar">
        <div>
          <p className="eyebrow">CONSULTAR · DECIDIR · REGISTRAR</p>
          <h2>Fluxo da automação</h2>
          <p className="muted">
            Selecione uma etapa para configurar. O caminho depende da condição.
          </p>
        </div>
        <div className="flow-save">
          <span role="status" className="flow-save-state">
            {pending
              ? "Salvando…"
              : dirty || inspectorDirty
                ? "Alterações não salvas"
                : "Definição salva"}
          </span>
          <button
            type="button"
            className="primary-button"
            onClick={save}
            disabled={!editable || !dirty || inspectorDirty}
          >
            Salvar definição
          </button>
        </div>
      </div>
      {baseline.active && (
        <p className="notice">
          Desative a automação para editar. A versão ativa continua disponível
          para testes.
        </p>
      )}
      {inspectorDirty && (
        <div className="flow-draft-notice" role="status">
          <p>
            Aplique as alterações do painel antes de salvar ou ativar. Seu
            rascunho continua disponível nas etapas.
          </p>
          <button type="button" onClick={discardInspector} disabled={!editable}>
            Descartar alterações do painel
          </button>
        </div>
      )}
      {problem && <p role="alert">{problem}</p>}
      {(locked || gateDisabled) && (
        <button type="button" disabled={pending} onClick={reload}>
          Recarregar versão do servidor
        </button>
      )}
      <div
        className={`viacep-layout ${selected ? "viacep-has-inspector" : ""}`}
      >
        <div className="viacep-nodes">
          <ol className="cep-flow" aria-label="Etapas da automação">
            <li className="cep-step cep-step--trigger">
              <span className="step-number" aria-hidden="true">
                01
              </span>
              <div>
                <strong>Receber evento</strong>
                <span>O teste ou uma integração inicia o fluxo</span>
              </div>
            </li>
            <li className="cep-step cep-step--lookup">
              <button
                type="button"
                aria-pressed={selected === "lookup"}
                onClick={(e) => {
                  invoker.current = e.currentTarget;
                  setSelected("lookup");
                }}
              >
                <span className="step-number" aria-hidden="true">
                  02
                </span>
                <span>
                  <strong>Consultar CEP</strong>
                  <span>
                    {lookup.config.cep.source === "fixed"
                      ? lookup.config.cep.value
                      : `evento: ${lookup.config.cep.fieldPath}`}
                  </span>
                  <small>ViaCEP · configurar consulta →</small>
                </span>
              </button>
            </li>
            <li className="cep-step cep-step--condition">
              <button
                type="button"
                aria-pressed={selected === "condition"}
                onClick={(e) => {
                  invoker.current = e.currentTarget;
                  setSelected("condition");
                }}
              >
                <span className="step-number" aria-hidden="true">
                  03
                </span>
                <span>
                  <strong>Condição</strong>
                  <span>
                    {addressFields[condition.config.input.fieldPath] ??
                      condition.config.input.fieldPath}{" "}
                    {operators[condition.config.operator]}{" "}
                    {condition.config.operator !== "exists"
                      ? String(condition.config.expectedValue)
                      : ""}
                  </span>
                  <small>Configurar decisão →</small>
                </span>
              </button>
            </li>
            <li className="cep-step cep-step--action">
              <span className="flow-branch flow-branch--yes">SE ATENDIDA</span>
              <span className="step-number" aria-hidden="true">
                04
              </span>
              <div>
                <strong>Registrar recibo</strong>
                <span>Salva a mensagem do evento localmente</span>
              </div>
            </li>
            <li className="cep-step cep-step--end">
              <span className="flow-branch">SE NÃO ATENDIDA · SEM AÇÃO</span>
              <span className="step-number" aria-hidden="true">
                05
              </span>
              <div>
                <strong>Finalizar</strong>
                <span>Os dois caminhos encerram o fluxo aqui</span>
              </div>
            </li>
          </ol>
          <p className="flow-caption">
            A condição atendida registra um recibo e finaliza. Caso contrário,
            finaliza sem executar a ação.
          </p>
        </div>
        {selected && (
          <div className="viacep-inspector">
            <button type="button" onClick={close}>
              Voltar ao nó
            </button>
            <h3 ref={inspectorHeading} tabIndex={-1}>
              {selected === "lookup" ? "Consultar CEP" : "Condição"}
            </h3>
            {selected === "lookup" ? (
              <fieldset disabled={!editable}>
                <legend>Configuração do CEP</legend>
                <label>
                  Origem do CEP
                  <select
                    value={cep.source}
                    onChange={(e) => {
                      cepValues.current[cep.source] =
                        cep.source === "fixed" ? cep.value : cep.fieldPath;
                      setCep(
                        e.target.value === "fixed"
                          ? { source: "fixed", value: cepValues.current.fixed }
                          : {
                              source: "event",
                              fieldPath: cepValues.current.event,
                            },
                      );
                    }}
                  >
                    <option value="fixed">Fixo</option>
                    <option value="event">Evento</option>
                  </select>
                </label>
                <label>
                  {cep.source === "fixed" ? "CEP" : "Campo do evento"}
                  <input
                    value={cep.source === "fixed" ? cep.value : cep.fieldPath}
                    onChange={(e) =>
                      setCep(
                        cep.source === "fixed"
                          ? { source: "fixed", value: e.target.value }
                          : { source: "event", fieldPath: e.target.value },
                      )
                    }
                    aria-invalid={!validCep || undefined}
                    aria-describedby={
                      validCep ? "viacep-help" : "viacep-help viacep-error"
                    }
                  />
                </label>
                <p id="viacep-help">
                  {cep.source === "fixed"
                    ? "8 dígitos ou 00000-000. Sem espaços."
                    : "Use data.cep para receber um CEP diferente em cada evento."}
                </p>
                {!validCep && (
                  <p id="viacep-error" role="status">
                    {cep.source === "fixed"
                      ? "Informe um CEP com 8 dígitos, como 01001-000."
                      : "Informe um caminho válido, como data.cep."}
                  </p>
                )}
                <p>
                  O endereço será consultado pelo ViaCEP durante a execução.
                </p>
              </fieldset>
            ) : (
              <>
                <label>
                  Origem da condição
                  <select
                    disabled={!editable}
                    value={input.source}
                    onChange={(e) => {
                      conditionValues.current[input.source] = config;
                      const source =
                        e.target.value === "step" ? "step" : "event";
                      const nextConfig = conditionValues.current[source];
                      const next: ViaCepConditionInput =
                        source === "step"
                          ? {
                              source,
                              nodeId: lookup.id,
                              fieldPath: nextConfig.fieldPath,
                            }
                          : { source, fieldPath: nextConfig.fieldPath };
                      setInput(next);
                      setConfig(nextConfig);
                    }}
                  >
                    <option value="step">Resultado da consulta</option>
                    <option value="event">Evento</option>
                  </select>
                </label>
                {input.source === "step" && (
                  <label>
                    Campo do endereço
                    <select
                      disabled={!editable}
                      value={
                        Object.hasOwn(addressFields, config.fieldPath)
                          ? config.fieldPath
                          : "custom"
                      }
                      onChange={(e) => {
                        if (e.target.value !== "custom") {
                          setConfig({ ...config, fieldPath: e.target.value });
                          setInput({ ...input, fieldPath: e.target.value });
                        } else {
                          setConfig({ ...config, fieldPath: "" });
                          setInput({ ...input, fieldPath: "" });
                        }
                      }}
                    >
                      {Object.entries(addressFields).map(([path, label]) => (
                        <option value={path} key={path}>
                          {label}
                        </option>
                      ))}
                      <option value="custom">Outro campo</option>
                    </select>
                  </label>
                )}
                <ConditionInspector
                  key={input.source}
                  config={config}
                  pathLabel={
                    input.source === "step"
                      ? "Campo do resultado"
                      : "Campo do evento"
                  }
                  pathHelp={
                    input.source === "step"
                      ? "Compare um dado retornado pela consulta. Exemplo: address.uf para o estado."
                      : "Compare um dado recebido no evento. Exemplo: data.uf."
                  }
                  disabled={!editable}
                  onChange={(c) => {
                    setConfig(c);
                    setInput((i) => ({ ...i, fieldPath: c.fieldPath }));
                  }}
                />
              </>
            )}
            <button
              type="button"
              className="primary-button"
              disabled={
                !editable ||
                (selected === "lookup" ? !validCep : !validCondition)
              }
              onClick={apply}
            >
              Aplicar ao rascunho
            </button>
          </div>
        )}
      </div>
      <details className="flow-notes">
        <summary>Sobre este fluxo</summary>
        <p>
          Aplicar altera o rascunho. Salvar persiste a definição completa, sem
          executar a automação. A consulta ao ViaCEP depende da habilitação da
          execução externa no ambiente.
        </p>
        <p>
          Ambiente local, sem autenticação ou isolamento entre usuários. Utilize
          dados sintéticos.
        </p>
      </details>
    </section>
  );
}
