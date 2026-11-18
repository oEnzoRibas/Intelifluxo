# Case técnico: automação confiável com desenvolvimento assistido por IA

## Problema e objetivo de aprendizagem

Aceitar um evento por HTTP é simples; explicar o que aconteceu quando o broker redelivery, o usuário edita uma regra ou uma consulta externa falha exige contratos e estados explícitos. O InteliFluxo explora essas fronteiras em um MVP local com automações visuais.

O objetivo educacional é demonstrado pelo perfil `local-development-only`, pelo escopo dos ADRs e pelo uso de fixtures sintéticas. Não há evidência de cliente pagante, adoção empresarial, volume de produção ou retorno financeiro. Esses resultados não são reivindicados.

## Evolução verificável

1. Recibo básico, identidade idempotente e outbox transacional.
2. Definições e revisões persistidas, com seleção das automações na aceitação.
3. Grafo visual e protocolo de revisão esperada.
4. Condições tipadas, incluindo ausente versus nulo e rejeição de coerções implícitas.
5. Lista resumida com keyset pagination, separada do contrato legado.
6. Consulta ViaCEP com observação persistida, restrições de transporte e classificação de falha.
7. Supervisor local e experiência de teste/inspeção sem varrer filas manualmente.

Essa sequência descreve dependências técnicas verificáveis nos ADRs e migrations; não é uma reconstrução de datas de autoria por agente.

## Desafios e escolhas

| Desafio                                  | Escolha                                                | Aprendizado e limite                                                 |
| ---------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------- |
| Aceite e publicação têm tempos distintos | Outbox na mesma transação do evento                    | Ack do broker não é conclusão do negócio                             |
| Uma regra muda depois do aceite          | Fixar revisão selecionada                              | A decisão passada precisa continuar reproduzível                     |
| Reenvio após resposta perdida            | Chave e conteúdo preservados                           | Retry da solicitação e nova intenção de negócio não são equivalentes |
| Número enviado como texto                | Entrada tipada e validação dos caminhos                | Formulário e contrato precisam concordar sobre tipos                 |
| Queda de provedor                        | Timeout, projeção e resultado de falha explícitos      | Rede externa não participa da transação PostgreSQL                   |
| Colaboração de IA                        | Responsabilidades e propriedade de arquivos declaradas | Perfis não provam execução correta nem revisão independente          |
| Inicialização local no Windows           | Preferências locais e portas configuráveis             | Restrições de ambiente são parte da experiência de produto           |

## Participação de IA e julgamento humano

A IA auxiliou na análise, redação de contratos, implementação da UI, diagnóstico de testes e documentação no trabalho observado. O usuário determinou prioridades e autorizou execução externa separadamente. A arquitetura foi registrada como decisões pequenas e verificáveis, evitando transformar desejo de produto em alegação de implementação.

Testes de contrato, integrações com serviços reais, tipagem, lint e build são mecanismos concretos de validação. O caso de uma retentativa que clicava antes da recuperação da prontidão ilustra que o teste também precisa representar o estado real da UI. Isso não autoriza enfraquecer asserções nem tomar uma suíte verde como prova completa de confiabilidade.

## O que este case demonstra — e o que ainda precisa de evidência

| Competência               | Evidência disponível                                      | Limite                                                              |
| ------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------- |
| Software Architecture     | ADRs, migrações, outbox, revisões e componentes separados | Sem benchmark/SLO de produção                                       |
| AI-Assisted Development   | Perfis e mudanças/validações observadas no trabalho       | Sem log completo de autoria/custo por agente                        |
| Multi-Agent Systems       | Política declarada de Lead e especialistas                | Colaboração no ambiente de desenvolvimento; não runtime multiagente |
| MCP                       | Inventário de conectores na configuração legada           | Sessões e uso efetivo de cada servidor não comprovados              |
| AI Engineering em runtime | Não identificado no código atual                          | Exige integração e avaliação explícitas em um próximo incremento    |
| Technical Documentation   | Contratos, fontes rastreáveis, capturas reais e limites   | ADRs históricos não devem ser lidos como inventário atualizado      |

Fontes e resultados: [mapa de evidências](evidence.md) e [validação](validation.md).
