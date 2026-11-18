# Desenvolvimento assistido por IA: agentes, modelos e MCP

## Fronteira de evidência

Os nove perfis foram encontrados no checkout de origem do mesmo projeto, fora da worktree de implementação. Foram copiados como documentos inertes em `docs/evidence/agent-profiles/`, mantendo bytes e hashes. Consulte o [manifesto](../evidence/agent-profiles.json). Nenhum desses arquivos é carregado automaticamente pelo produto.

`mode` e `model` abaixo são declarações dos arquivos, não verificação do catálogo de modelos ou log de inferência. Não há registro completo para atribuir autoria, custo, tokens, duração ou sucesso de cada tarefa a cada modelo. As permissões são intenção de configuração do host; sua aplicação efetiva não foi testada nesta revisão.

## Política de colaboração declarada

O perfil do Lead especifica lotes de até três especialistas OpenAI com tarefas independentes, `background: true`, propriedade exclusiva de arquivos e espera de todas as notificações antes da consolidação. Especialistas não devem criar agentes filhos. O responsável humano conserva decisões de escopo, autorizações e revisão de riscos.

Essa é uma política em texto para o ambiente de desenvolvimento. Não foi encontrado um serviço de escalonamento de agentes, protocolo de mensagens entre LLMs ou banco de memória de agentes no runtime. A execução de tarefas por um host não deve ser confundida com um servidor MCP do produto.

Há uma divergência no próprio perfil do Lead: ele menciona Documentation configurado para Gemini, enquanto o arquivo `documentation.md` declara `openai/gpt-6.1-terra`. A tabela segue o arquivo específico; não se conclui uso de Gemini.

## Perfis individuais

### InteliFluxo Lead

- **Propósito e responsabilidade:** Coordinates InteliFluxo development, delegates specialized tasks, and maintains technical consistency.
- **Modelo / modo declarados:** `openai/gpt-6.1-terra` / `primary`.
- **Entradas:** Objetivo humano, requisitos, restrições e resultados dos especialistas.
- **Saídas:** Plano, divisão de trabalho, decisão de integração e relato de evidências.
- **Colaboração:** Coordena especialistas; mantém decisão crítica e integração sob sua responsabilidade.
- **Ferramentas e recursos:** Declara delegação pelo host. Não é processo da aplicação, nem cliente MCP próprio.
- **Restrições:** Política de lotes fechados de até três especialistas OpenAI, sem reposição dentro do lote; exige consolidação e propriedade exclusiva de arquivos.
- **Papel:** desenvolvimento do software; não participa da execução de eventos em produção.
- **Fonte:** [perfil preservado](../evidence/agent-profiles/intelifluxo-lead.md).

### Architect

- **Propósito e responsabilidade:** Designs InteliFluxo distributed and event-driven architecture and records evidence-based trade-offs in ADRs.
- **Modelo / modo declarados:** `openai/gpt-6-astra` / `subagent`.
- **Entradas:** Requisitos, atributos de qualidade, falhas e arquitetura existente.
- **Saídas:** Contratos, diagramas, alternativas e propostas de ADR.
- **Colaboração:** Consulta Lead, engenheiros, QA e Researcher para viabilidade e validação.
- **Ferramentas e recursos:** Ferramentas efetivamente disponíveis dependem do host; o perfil não lista inventário de ferramentas executadas.
- **Restrições:** Não aprova sozinho decisões irreversíveis; não implementa produto só por desejo arquitetural.
- **Papel:** desenvolvimento do software; não participa da execução de eventos em produção.
- **Fonte:** [perfil preservado](../evidence/agent-profiles/architect.md).

### Designer

- **Propósito e responsabilidade:** Owns the complete InteliFluxo product-design cycle on the selected design platform (defaulting to OpenPencil), from UX discovery and flows through validated prototypes and developer handoff.
- **Modelo / modo declarados:** `openai/gpt-6.1-sol` / `subagent`.
- **Entradas:** Objetivos, necessidades verificadas, estados de interação e restrições técnicas.
- **Saídas:** Fluxos, protótipos, design system, artefatos editáveis e handoff.
- **Colaboração:** Lead revisa a direção; Frontend recebe handoff; Backend e QA contribuem com contrato e acessibilidade.
- **Ferramentas e recursos:** O perfil orienta inspecionar ferramentas MCP da plataforma escolhida, com OpenPencil como padrão.
- **Restrições:** Não implementa frontend; exige evidência da plataforma e não permite substituir artefato editável por mockup estático sem decisão explícita.
- **Papel:** desenvolvimento do software; não participa da execução de eventos em produção.
- **Fonte:** [perfil preservado](../evidence/agent-profiles/designer.md).

### Backend Engineer

- **Propósito e responsabilidade:** Implements and tests reliable InteliFluxo backend APIs, event processing, persistence, messaging, and concurrency behavior.
- **Modelo / modo declarados:** `openai/gpt-6.1-terra` / `subagent`.
- **Entradas:** Escopo aprovado, ADRs, contratos e critérios de aceitação.
- **Saídas:** Código, migrações, testes, observabilidade e notas operacionais.
- **Colaboração:** Alinha contrato com Architect/Frontend, estratégia com QA e revisão com Code Reviewer.
- **Ferramentas e recursos:** Perfil orientado a código e testes; disponibilidade real de shell/edição é definida pelo host.
- **Restrições:** Não aprova as próprias mudanças críticas nem escolhe infraestrutura estratégica unilateralmente.
- **Papel:** desenvolvimento do software; não participa da execução de eventos em produção.
- **Fonte:** [perfil preservado](../evidence/agent-profiles/backend-engineer.md).

### Frontend Engineer

- **Propósito e responsabilidade:** Implements and tests accessible, performant InteliFluxo frontend architecture, state management, and API integrations.
- **Modelo / modo declarados:** `openai/gpt-6.1-terra` / `subagent`.
- **Entradas:** Design revisado, contratos de API, estados e critérios de interação.
- **Saídas:** Componentes, integração tipada, testes e evidência de interface.
- **Colaboração:** Trabalha com Designer, Backend, Architect e QA sob coordenação do Lead.
- **Ferramentas e recursos:** Código, inspeção e testes conforme permissões do host; ferramentas de navegador não são comprovadas pelo perfil.
- **Restrições:** Não inventa endpoints nem compensa silenciosamente contrato ambíguo; validação visual só pode ser alegada se executada.
- **Papel:** desenvolvimento do software; não participa da execução de eventos em produção.
- **Fonte:** [perfil preservado](../evidence/agent-profiles/frontend-engineer.md).

### Code Reviewer

- **Propósito e responsabilidade:** Independently reviews InteliFluxo changes for defects, security risks, regressions, architecture violations, and maintainability without editing files.
- **Modelo / modo declarados:** `openai/gpt-6.1-terra#low` / `subagent`.
- **Entradas:** Requisitos, diff, contexto de código, contratos e evidências de teste.
- **Saídas:** Achados priorizados com localização, impacto, correção sugerida e risco residual.
- **Colaboração:** Retorna achados ao Lead e solicita contexto aos especialistas.
- **Ferramentas e recursos:** O perfil nega explicitamente edição, shell, execução e criação de subagentes.
- **Restrições:** Somente leitura; não implementa correções nem usa o próprio julgamento como autorização de ações destrutivas.
- **Papel:** desenvolvimento do software; não participa da execução de eventos em produção.
- **Fonte:** [perfil preservado](../evidence/agent-profiles/code-reviewer.md).

### QA Engineer

- **Propósito e responsabilidade:** Defines and implements risk-based testing for InteliFluxo units, integrations, contracts, end-to-end flows, and reliability behavior.
- **Modelo / modo declarados:** `openai/gpt-6.1-terra` / `subagent`.
- **Entradas:** Requisitos verificáveis, diffs, riscos e critérios de aceitação.
- **Saídas:** Estratégia, testes, resultados, defeitos reproduzíveis e limites da confiança.
- **Colaboração:** Alinha aceitação com Lead, contratos com engenheiros e riscos com Architect/Reviewer.
- **Ferramentas e recursos:** Testes e análise conforme host; não há um serviço QA rodando no produto.
- **Restrições:** Não enfraquece asserções para obter verde e não confunde cobertura com correção.
- **Papel:** desenvolvimento do software; não participa da execução de eventos em produção.
- **Fonte:** [perfil preservado](../evidence/agent-profiles/qa-engineer.md).

### Researcher

- **Propósito e responsabilidade:** Produces source-backed technical research and feasibility recommendations for InteliFluxo libraries, infrastructure, and engineering approaches.
- **Modelo / modo declarados:** `openai/gpt-6.1-terra` / `subagent`.
- **Entradas:** Pergunta técnica, critérios de comparação e contexto existente.
- **Saídas:** Comparação, fontes, incertezas e recomendação delimitada.
- **Colaboração:** Apoia Architect e engenheiros; Lead decide escopo e adoção.
- **Ferramentas e recursos:** O perfil nega edição, shell, execução e subagentes; fontes e pesquisa dependem de ferramentas concedidas pelo host.
- **Restrições:** Não toma decisões finais de arquitetura nem inventa benchmarks.
- **Papel:** desenvolvimento do software; não participa da execução de eventos em produção.
- **Fonte:** [perfil preservado](../evidence/agent-profiles/researcher.md).

### Documentation

- **Propósito e responsabilidade:** Creates and maintains accurate InteliFluxo ADRs, architecture and API documentation, runbooks, and development guides.
- **Modelo / modo declarados:** `openai/gpt-6.1-terra` / `subagent`.
- **Entradas:** Código, contratos, ADRs e evidências de validação.
- **Saídas:** Guias, referências, runbooks, fontes e indicação de conteúdo obsoleto.
- **Colaboração:** Confirma fatos com Lead, Architect, engenheiros, QA e Researcher.
- **Ferramentas e recursos:** Edição e leitura conforme host; organização para recuperação futura não é implementação de RAG.
- **Restrições:** Não aprova arquitetura nem afirma que um procedimento foi testado sem evidência.
- **Papel:** desenvolvimento do software; não participa da execução de eventos em produção.
- **Fonte:** [perfil preservado](../evidence/agent-profiles/documentation.md).

## Inventário MCP do ambiente de desenvolvimento

| Entrada encontrada | Configuração observada, sem credenciais                                                                               | Alcance da evidência                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| GitHub             | Processo local em Docker, imagem `ghcr.io/github/github-mcp-server`, credencial referenciada por variável de ambiente | Entrada declarada; sem trace verificável de ferramenta executada                       |
| Context7           | Endpoint remoto declarado                                                                                             | Entrada sob agrupamento `servers`; compatibilidade do esquema e sessão não verificadas |
| OpenPencil         | Comando local `openpencil-mcp`                                                                                        | Coerente com perfis e handoffs; arquivo de design não prova uso da ferramenta MCP      |
| Figma              | Endpoint remoto habilitado                                                                                            | Conflita com orientação do Lead de não depender de Figma                               |
| draw.io            | Endpoint remoto habilitado                                                                                            | Nenhum diagrama nativo draw.io foi identificado nesta worktree                         |
| Penpot             | URL remota com credencial embutida e estrutura aparentemente malformada                                               | Não copiada, não testada; exige tratamento pelo titular                                |

A configuração completa não foi importada: continha material sensível, estrutura heterogênea e entradas que contradizem o escopo escolhido. Reproduzir essa configuração como exemplo pronto para execução seria inadequado. O inventário registra somente metadados sanitizados; não certifica seis conexões funcionais.

**MCP não é RAG.** Os perfis orientam separar conectividade de ferramentas de recuperação de conhecimento. Não foi encontrado pipeline RAG, índice vetorial, embedding ou recuperação contextual no código da aplicação.

## Processo observado nesta entrega

A assistência de IA foi usada em inspeção de contratos, código de UX/UI, configuração local, diagnóstico de falhas, testes e documentação. O usuário determinou prioridades e autorizou consulta externa ao ViaCEP separadamente. As mudanças foram validadas por comandos de qualidade e testes; não foram automaticamente aceitas por terem sido geradas por IA.

Os perfis estabelecem uma intenção de revisão independente, mas não há evidência suficiente para afirmar que toda alteração histórica foi revisada por outro agente. Também não há avaliação comparativa dos modelos ou demonstração de agentes autônomos no runtime. O processo observado neste chat não comprova o acionamento de todos os perfis OpenCode preservados.

## Aprendizados e próximos experimentos

- Separar política escrita, configuração carregada, ferramenta conectada e execução comprovada evita inflar o case.
- Contratos, estados e testes são necessários tanto para código assistido por IA quanto para código escrito manualmente.
- Perfis com responsabilidades claras reduzem ambiguidade de propriedade, mas não substituem testes e revisão humana.
- Um próximo incremento de agentes no produto exigiria ferramentas autorizadas, limites de custo/tempo, rastreabilidade, testes de avaliação e desenho de falha. Isso permanece proposta.
