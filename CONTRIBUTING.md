# Contribuir com o InteliFluxo

## Escopo

Este repositório demonstra um MVP local. Leia o [README](README.md), o [mapa de documentação](docs/README.md) e o ADR relevante antes de propor mudanças. Não trate `scope` como fronteira de autorização.

## Fluxo de trabalho

1. Descreva problema, resultado observável e limites na issue ou PR.
2. Use branch própria e preserve alterações locais de outras pessoas.
3. Para contratos, estados persistidos ou comportamento de execução, explique compatibilidade e migrações. Registre uma decisão em ADR quando necessário.
4. Execute tipagem, lint, formatação, testes e build conforme o README. Integrações exigem serviços locais e opt-ins; registre testes pulados e a razão.
5. Inclua evidência de interface para mudanças visuais e cenários de falha para mudanças de comportamento.
6. Solicite revisão independente para mudanças críticas. Código criado com IA passa pelos mesmos critérios.

Não faça push em main, deployment ou mudança de licença sem autorização do responsável. Não use filas/bancos compartilhados para demonstrações que criem recursos de teste.

## Uso de IA

Informe o tipo de auxílio, decisões humanas, testes executados e limites de verificação. Não apresente modelo configurado como modelo comprovadamente executado. Agentes de desenvolvimento, servidores MCP e processos do produto são categorias distintas.

## Segurança e dados

Use dados sintéticos. Nunca inclua tokens, arquivos `.env`, configurações privadas MCP, dumps, volumes ou capturas com dados sensíveis. Consulte [SECURITY.md](SECURITY.md).

## Licenciamento

O projeto é distribuído sob a [licença MIT](LICENSE). Ao contribuir, você declara ter os direitos necessários sobre sua contribuição e concorda em disponibilizá-la sob essa licença.
