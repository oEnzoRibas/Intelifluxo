# Documentação do InteliFluxo

Comece pelo [README principal](../README.md). Código e testes atuais comprovam implementação; ADRs registram decisões e checkpoints que podem anteceder a worktree atual.

## Apresentação e evidências

- [Case técnico](portfolio/case-study.md): problema, decisões, desafios e aprendizados.
- [Desenvolvimento assistido por IA](portfolio/ai-assisted-development.md): nove perfis, modelos declarados e MCP de desenvolvimento.
- [Fontes auditadas](portfolio/evidence.md): proveniência e distinção entre configuração e execução.
- [Validação](portfolio/validation.md): comandos e alcance dos resultados.
- [Capturas reais](assets/screenshots/README.md).
- [Apresentação no GitHub](portfolio/github-presentation.md).

## Decisões arquiteturais

| Registro                                             | Decisão                             | Leitura atual                                               |
| ---------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------- |
| [0001](adr/0001-visual-automation-mvp1.md)           | Limite inicial da automação visual  | Histórico da primeira fatia                                 |
| [0002](adr/0002-persistent-visual-workflow-graph.md) | Grafo persistido por revisão        | Base de persistência e compatibilidade                      |
| [0003](adr/0003-conditions-and-decisions.md)         | Condições tipadas e dados de evento | Base dos contratos v2                                       |
| [0004](adr/0004-automation-list-dashboard.md)        | Lista resumida e keyset pagination  | Base da listagem atual                                      |
| [0005](adr/0005-viacep-address-lookup.md)            | Consulta ViaCEP antes da condição   | Base dos contratos v3                                       |
| [0006](adr/0006-no-terminal-local-app-workflow.md)   | Supervisor e operação local pela UI | Contém inventário histórico parcial; conferir runtime atual |

## Referências de engenharia

- [Arquitetura inicial](architecture/visual-automation-mvp1.md): descrição histórica, anterior a Conditions/ViaCEP.
- [Vetores de condições](architecture/conditions-and-decisions-validation.md): contrato e casos requeridos; exemplos não são logs de execução.
- [Governança de CI](ci/governance.md) e [preparação de CD](deployment/cd-preparation.md): não comprovam deploy ou proteção de branch ativa.
- [Backend](../backend/README.md): contratos e comandos detalhados.
- [Frontend](../frontend/README.md): operação e limites da UI.
- [Handoff ViaCEP](../design/openpencil/viacep-handoff.md), [handoff app-driven](../design/openpencil/app-driven-flow-handoff.md) e [artefato de design](../design/openpencil/intelifluxo.fig).

As topologias textuais originais de 0003/0005 e a árvore de processos de 0006 foram reaproveitadas na representação Mermaid do README. Os diagramas de agentes são inventário de responsabilidades declaradas, sem trace completo de sessão disponível.
