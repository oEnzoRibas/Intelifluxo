# Validação do case e da aplicação

Checkpoint local: **17/11/2026**, working tree da branch `feat/viacep-address-lookup`. Resultados não equivalem a uma release ou run CI remoto.

## Testes reexecutados nesta revisão

| Verificação                        | Comando, na pasta correspondente                                 | Resultado                                                             |
| ---------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| Frontend                           | `npm test -- --reporter=json`                                    | 307 aprovados, 0 falhas                                               |
| Backend, porta de supervisor livre | `npm test -- --reporter=json`                                    | 949 aprovados, 0 falhas, 61 pulados por opt-ins/condições de execução |
| Integrações oficiais               | `INTEGRATION=1` com URLs explícitas e `npm run test:integration` | 34 aprovados em 8 arquivos                                            |

Os testes de integração utilizaram PostgreSQL e RabbitMQ locais, com schemas e filas de fixture. A suíte ViaCEP injeta um provedor controlado; seu resultado não depende da disponibilidade da Internet e não comprova uma consulta real em cada teste.

A primeira execução do backend, com a demonstração aberta, teve **948 aprovados e 1 falha**: o teste de singleton não conseguiu reservar `127.0.0.1:3210`, já usada pelo supervisor. A instância local foi identificada e encerrada temporariamente; a repetição com a porta livre passou. Nenhuma asserção foi alterada nesta revisão de portfólio. Para reproduzir a suíte completa, encerre o supervisor local antes dos testes de porta fixa. Encerramento forçado usado para essa preparação não comprova shutdown gracioso no Windows.

Os arquivos de evidência preservam os contadores essenciais, sem dumps de payloads ou credenciais: [test-results.json](../evidence/test-results.json). Testes pulados não são considerados aprovados. O conjunto oficial de 34 integrações não inclui automaticamente todos os testes opt-in existentes no repositório.

## Documentação e imagens

- Três imagens JPEG reais capturadas pelo navegador na aplicação local: [manifesto das capturas](../assets/screenshots/README.md).
- README renderizado em prévia local com Markdown e Mermaid; os três diagramas produziram SVG e as três imagens locais carregaram.
- Links de arquivos relativos, blocos de código, hashes dos nove perfis preservados e assinatura JPEG verificados por script de revisão.
- Nenhum mockup ou imagem gerada por IA usado para representar execução.
- Nenhum segredo da configuração MCP legada copiado. O achado é descrito sem valor em [SECURITY.md](../../SECURITY.md).

A prévia local verifica sintaxe e assets, **não é uma renderização autenticada no GitHub**. Não houve push ou publicação para forçar essa validação. Badges externos são informativos; não foram usados como evidência de aprovação do CI.

## Comandos de qualidade

Na raiz:

```powershell
npm --prefix backend run typecheck
npm --prefix backend run lint
npm --prefix backend run format
npm --prefix frontend run typecheck
npm --prefix frontend run lint
npm --prefix frontend run format
npm --prefix frontend run build
```

Os comandos acima foram reexecutados e aprovados nesta revisão, incluindo o build frontend. O workflow em [ci.yml](../../.github/workflows/ci.yml) inclui esses checks. As mudanças do portfólio se limitam a documentação, imagens, templates e regras de ignore, sem refatorar o runtime.

## Não comprovado

Conexão e uso de cada MCP legado, execução de cada modelo declarado, autoria por agente, qualidade de respostas LLM, custo/tokens, revisão independente de todas as mudanças, benchmark/SLO, escalabilidade, produção, CI remoto e testes opt-in não executados. Nenhuma dessas propriedades é inferida de uma suíte verde.
