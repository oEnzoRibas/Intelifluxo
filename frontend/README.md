# Frontend InteliFluxo

A interface oferece visão geral da API, lista filtrável e paginada, criação de
Conditions e ViaCEP, editores, testes guiados e histórico de execuções.
Consulte o [guia principal](../README.md) para inicialização e uso do MVP.

## Desenvolvimento

Node.js 24. Execute `npm ci` e `npm run dev`. Vite escuta em loopback e encaminha
`/api` para a API local na porta 3000. Use o inicializador da raiz para operar
banco, fila e processos juntos.

## Comportamento

- Desative a automação antes de editar. Conflitos preservam o rascunho.
- Conditions são executáveis; ViaCEP aceita CEP fixo ou campo do evento.
- Prontidão e capacidades são informadas pelo runtime. Escrita e execução
  externa têm habilitações separadas.
- O teste aceita dados tipados e caminhos aninhados em `data`.
- Solicitações incertas são recuperadas com os mesmos dados e a mesma chave.
- Publicação confirmada e execução concluída são estados distintos.
- O histórico mostra revisão utilizada, decisão, ação e falhas. IDs e resultados
  brutos ficam nos detalhes de diagnóstico.

## Verificação

`npm run typecheck`, `npm run lint`, `npm run format`, `npm test`, `npm run build`.
O build precisa de proxy de mesma origem para `/api` se servido fora do Vite.

O MVP local não tem autenticação ou isolamento entre usuários. A API não fornece
histórico completo de revisões ou data de conclusão; a interface não inventa
esses dados. Não publique esta configuração em rede compartilhada.
