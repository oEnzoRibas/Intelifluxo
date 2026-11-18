# Fontes, proveniência e alcance da análise

## Worktree de implementação

A revisão de portfólio foi realizada na branch `feat/viacep-address-lookup`, com alterações locais preexistentes. Os documentos refletem o working tree, não uma release publicada ou um merge comprovado em main. Nenhum commit, push ou alteração remota foi realizado.

Foram inventariados fontes, testes, migrations, schemas, launchers, documentação e handoffs. A análise de comportamento se concentrou nos pontos abaixo; inventário não equivale a revisão formal de cada linha ou auditoria de segurança completa.

| Alegação                                                         | Fonte primária dentro do repositório                                                                                                                                                     |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identidade idempotente, igualdade JSONB e snapshots na aceitação | [accept.ts](../../backend/src/accept.ts), [contract.ts](../../backend/src/contract.ts)                                                                                                   |
| API, gates e prontidão                                           | [api.ts](../../backend/src/api.ts), [config.ts](../../backend/src/config.ts), [runtime-status.ts](../../backend/src/runtime-status.ts)                                                   |
| Revisões e validação de topologias                               | [automations.ts](../../backend/src/automations.ts), [graph-v2.ts](../../backend/src/graph-v2.ts), [graph-v3.ts](../../backend/src/graph-v3.ts)                                           |
| Confirmação do broker, outbox e retentativa                      | [broker.ts](../../backend/src/broker.ts), [relay.ts](../../backend/src/relay.ts), [scheduler.ts](../../backend/src/scheduler.ts), [retry-policy.ts](../../backend/src/retry-policy.ts)   |
| Resultado e ack depois de commit                                 | [worker.ts](../../backend/src/worker.ts)                                                                                                                                                 |
| Transporte e projeção ViaCEP                                     | [viacep-transport.ts](../../backend/src/viacep-transport.ts), [viacep-projection.ts](../../backend/src/viacep-projection.ts)                                                             |
| Ciclo de vida local                                              | [supervisor](../../backend/src/runtime-supervisor.ts), [children](../../backend/src/runtime-children.ts), [inicializador](../../start-intelifluxo.ps1)                                   |
| UI de configuração e recuperação                                 | [ViaCepBuilder](../../frontend/src/ViaCepBuilder.tsx), [TestEventPanel](../../frontend/src/TestEventPanel.tsx), [registro de intenção](../../frontend/src/test-event-intent-registry.ts) |
| Dependências e scripts                                           | [backend](../../backend/package.json), [frontend](../../frontend/package.json), [Compose](../../backend/compose.yaml), [CI](../../.github/workflows/ci.yml)                              |
| Decisões e design                                                | [índice dos ADRs](../README.md), [handoff](../../design/openpencil/viacep-handoff.md), [design nativo](../../design/openpencil/intelifluxo.fig)                                          |

## Perfis de agentes e MCP

A worktree ativa não continha `.opencode/agents`. O checkout de origem tinha nove perfis e `opencode.jsonc`. Os perfis foram preservados em diretório de evidência, não no diretório ativo do OpenCode, com hashes em [agent-profiles.json](../evidence/agent-profiles.json).

O manifesto registra o HEAD de origem, mas os arquivos foram lidos do working tree: não se presume que aquele commit contenha exatamente esses bytes. Não há links absolutos de disco usados para comprovação no README; as cópias auditadas são acessíveis no próprio repositório.

A configuração MCP sensível não foi copiada. Só o inventário sanitizado em [agentes e MCP](ai-assisted-development.md) foi incluído. Uma referência a ferramenta ou modelo prova uma declaração, não a conexão do servidor ou inferência executada. Foi identificada uma divergência entre a menção a Gemini no Lead e o modelo OpenAI no perfil Documentation.

## Diagramas e imagens

- Arquitetura atual: redesenhada em Mermaid a partir de componentes reais e da árvore de processos do ADR 0006.
- Fluxo de evento: traçado a partir de accept, relay, worker e scheduler.
- Fluxo ViaCEP: a topologia textual do ADR 0005 foi preservada conceitualmente na imagem real do editor e explicada no README.
- Colaboração de agentes/MCP: diagrama declarativo com linhas pontilhadas para relações não comprovadas por trace.
- Capturas: [proveniência](../assets/screenshots/README.md). São imagens da UI real; não foram geradas por IA.

## Não verificado

Disponibilidade de cada modelo do OpenCode, sessões MCP legadas, tokens/custo por agente, revisão independente de todas as mudanças, resultados CI remotos, proteção de main, publicação/deploy, desempenho, escalabilidade e prontidão de produção. Renderização local de Markdown/Mermaid não equivale a uma publicação validada no GitHub.

Os registros antigos em ADRs que dizem que Overview, polling, prontidão ou ViaCEP eram pendentes descrevem checkpoints históricos. Esta revisão preservou esses registros e aponta para fontes atuais; não reescreveu decisões para fabricar uma história uniforme.
