import { useEffect, useState } from "react";
import {
  getOverview,
  type Overview as Data,
  type Period,
} from "./overview-api";

const time = (s: string) =>
  new Date(s).toLocaleString("pt-BR", { timeZone: "UTC" }) + " UTC";
const statuses = {
  success: "Sucesso",
  failed: "Falha",
  skipped: "Ignorada",
  pending_or_unknown: "Pendente ou desconhecida",
};
export default function Overview() {
  const [period, setPeriod] = useState<Period>("24h");
  const [generation, setGeneration] = useState(0);
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    getOverview(period, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setData(value);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setError(true);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [period, generation]);
  function refresh() {
    setError(false);
    setLoading(true);
    setGeneration((x) => x + 1);
  }
  return (
    <div className="overview">
      <p className="eyebrow">AMBIENTE LOCAL</p>
      <h1>Visão geral</h1>
      <p>Execuções por data de criação · janela móvel UTC</p>
      <div className="overview-controls">
        <label>
          Período{" "}
          <select
            value={period}
            onChange={(e) => {
              setLoading(true);
              setError(false);
              setPeriod(e.target.value as Period);
            }}
          >
            <option value="24h">Últimas 24 horas</option>
            <option value="7d">Últimos 7 dias</option>
            <option value="30d">Últimos 30 dias</option>
          </select>
        </label>
        <button disabled={loading} onClick={refresh}>
          Atualizar
        </button>
        <a href="#automations">Abrir automações</a>
      </div>
      <div aria-live="polite">
        {loading && (
          <p role="status">
            {data
              ? "Atualizando · dados anteriores desatualizados"
              : "Carregando dados do período…"}
          </p>
        )}
        {error && (
          <p role="alert">
            Não foi possível carregar dados atuais.{" "}
            {data && "Dados anteriores desatualizados."}{" "}
            <button onClick={refresh}>Tentar novamente</button>
          </p>
        )}
      </div>
      {!data && loading && (
        <div className="overview-metrics" aria-hidden="true">
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      )}
      {data && (
        <>
          {(loading || error || data.period !== period) && (
            <p className="notice">
              Desatualizado · período apresentado: {data.period}
            </p>
          )}
          <div className="overview-metrics">
            <section className="panel">
              <h2>Automações ativas</h2>
              <strong>{data.automations.active}</strong>
              <p>{data.automations.total} no total</p>
            </section>
            <section className="panel">
              <h2>Execuções criadas</h2>
              <strong>{data.executions.total}</strong>
              <p>
                Sucesso: {data.executions.success} · Falha:{" "}
                {data.executions.failed} · Ignoradas: {data.executions.skipped}{" "}
                · Pendentes ou desconhecidas: {data.executions.pendingOrUnknown}
              </p>
            </section>
            <section className="panel">
              <h2>Taxa de sucesso</h2>
              <strong>
                {data.executions.successRate === null
                  ? "—"
                  : `${(data.executions.successRate * 100).toFixed(1)}%`}
              </strong>
              <p>
                {data.executions.successRate === null
                  ? "Sem resultados elegíveis"
                  : "Sucesso sobre sucesso + falha"}
              </p>
            </section>
          </div>
          <section className="panel">
            <h2>Atividade</h2>
            {data.executions.total === 0 && (
              <p>Nenhuma execução criada nesta janela.</p>
            )}
            <div className="bucket-chart" aria-hidden="true">
              {data.buckets.map((b) => (
                <div
                  key={b.start}
                  style={{
                    height: `${data.executions.total ? (b.executions / Math.max(...data.buckets.map((x) => x.executions))) * 100 : 0}%`,
                  }}
                />
              ))}
            </div>
            <details>
              <summary>Contagens por intervalo UTC</summary>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Início</th>
                      <th>Fim</th>
                      <th>Execuções</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.buckets.map((b) => (
                      <tr key={b.start}>
                        <td>{time(b.start)}</td>
                        <td>{time(b.end)}</td>
                        <td>{b.executions}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
            <p>Duração de conclusão indisponível.</p>
          </section>
          <section className="panel">
            <h2>Execuções recentes</h2>
            {data.recent.length === 0 ? (
              <p>Nenhuma execução retornada nesta janela.</p>
            ) : (
              <ul>
                {data.recent.map((x) => (
                  <li key={x.executionId}>
                    <a href={`#automations/${x.automationId}`}>
                      {x.automationName}
                    </a>{" "}
                    · {statuses[x.status]} · {time(x.createdAt)}
                  </li>
                ))}
              </ul>
            )}
            <p>Até 10 registros.</p>
          </section>
          <section className="panel">
            <h2>Falhas de execução</h2>
            {data.executionFailures.length === 0 ? (
              <p>Nenhuma falha retornada nesta janela.</p>
            ) : (
              <ul>
                {data.executionFailures.map((x) => (
                  <li key={x.executionId}>
                    <a href={`#automations/${x.automationId}`}>
                      {x.automationName}
                    </a>{" "}
                    · {time(x.createdAt)}
                  </li>
                ))}
              </ul>
            )}
            <h3>Eventos que precisam de atenção agora</h3>
            {data.eventAttention.items.length === 0 ? (
              <p>Nenhum evento retornado.</p>
            ) : (
              <ul>
                {data.eventAttention.items.map((x) => (
                  <li key={x.eventId}>
                    <a
                      href={`#explorer?eventId=${encodeURIComponent(x.eventId)}`}
                    >
                      Diagnóstico do evento
                    </a>{" "}
                    ·{" "}
                    {x.status === "blocked"
                      ? "Interrompido"
                      : "Aguardando nova tentativa"}{" "}
                    · criado em {time(x.eventCreatedAt)}
                  </li>
                ))}
              </ul>
            )}
            <p>
              Estado atual dos eventos, independente do período. Até 10
              registros por lista.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
