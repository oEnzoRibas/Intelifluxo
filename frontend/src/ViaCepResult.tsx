import type { ExecutionResultV3 } from "./viacep-result";

export default function ViaCepResult({
  result,
}: {
  result: ExecutionResultV3;
}) {
  const lookup = result.lookup;
  const address = lookup?.status === "found" ? lookup.address : null;
  const fields = [
    ["CEP", lookup?.cep],
    ["Logradouro", address?.logradouro],
    ["Complemento", address?.complemento],
    ["Bairro", address?.bairro],
    ["Cidade / localidade", address?.localidade],
    ["UF", address?.uf],
    ["IBGE", address?.ibge],
  ];
  return (
    <div
      className={`viacep-result viacep-result--${lookup?.status ?? "pending"}`}
    >
      <p>
        {!lookup
          ? "Consulta indisponível"
          : lookup.status === "found"
            ? "Endereço encontrado"
            : lookup.status === "not_found"
              ? "CEP não encontrado"
              : "Consulta indisponível"}
      </p>
      {lookup?.cep && !address && <p>CEP: {lookup.cep}</p>}
      {address && (
        <dl className="viacep-address">
          {fields
            .filter(([, value]) => value !== undefined)
            .map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value === "" ? "Não informado" : value}</dd>
              </div>
            ))}
        </dl>
      )}
      <p>
        Condição:{" "}
        {result.decision
          ? result.decision.outcome === "TRUE"
            ? "TRUE — atendida; segue para a ação"
            : "FALSE — não atendida; segue sem executar a ação"
          : "sem decisão"}
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
      </p>
      {result.action.status === "executed" && (
        <p>Recibo local: {result.action.receipt.message}</p>
      )}
      {result.failure && (
        <p>
          A execução requer atenção
          {
            (
              {
                transient:
                  "; falha temporária, nova tentativa conforme a política do evento",
                permanent: "; falha permanente, sem nova tentativa automática",
                unknown: "; não foi possível classificar a falha",
                exhausted: "; tentativas esgotadas",
              } as const
            )[result.failure.classification]
          }
          .
        </p>
      )}
      <details>
        <summary>Dados técnicos</summary>
        <pre>{JSON.stringify(result, null, 2)}</pre>
      </details>
    </div>
  );
}
