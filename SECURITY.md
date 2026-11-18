# Segurança e publicação

## Limite operacional

O InteliFluxo é uma demonstração local: sem autenticação, autorização ou isolamento entre usuários. Mantenha API, frontend e serviços em loopback. Credenciais dos exemplos Compose são públicas e não devem ser usadas fora de desenvolvimento.

## Antes de publicar

- Verifique arquivos staged e histórico para credenciais. `.gitignore` não remove segredos já commitados.
- Mantenha `intelifluxo.local.json`, `.env*`, configurações MCP privadas, certificados, dumps e logs fora do Git.
- Revise capturas reais para garantir dados sintéticos e ausência de tokens.
- Use referências a variáveis de ambiente para credenciais de ferramentas. Não publique URLs que incluam tokens.

## Achado da revisão de portfólio

Uma configuração MCP no checkout de origem inspecionado continha uma credencial embutida e uma URL aparentemente malformada. Esse arquivo não foi copiado para esta worktree. O titular deve revogar/rotacionar a credencial no provedor e verificar eventual exposição no histórico antes de publicar. Sua validade não foi testada. Esta revisão não alterou credenciais, permissões ou configuração crítica daquele checkout.

## Relatar um problema

Não abra uma issue pública com credenciais, payloads pessoais ou exploração detalhada. Não foi identificado um canal privado de segurança verificado nesta revisão; combine um canal privado com o responsável antes de compartilhar conteúdo sensível. Não há SLA de correção ou política de suporte de produção declarados.
