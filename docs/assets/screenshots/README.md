# Capturas reais da aplicação

Capturadas em 17/11/2026, pelo navegador, com frontend em `127.0.0.1:5173` e API local operacional. Arquivos JPEG de página completa, sem substituir UI por mockup ou imagem gerada. Dados de demonstração locais; não representam escala ou adoção de produção.

| Arquivo                                        | Tela e contexto                                                  | O que comprova                                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [overview.jpg](overview.jpg)                   | `#overview`, janela últimas 24 horas, sem execuções nessa janela | UI real consultando a API e apresentando estado vazio sem taxa inventada              |
| [create-automation.jpg](create-automation.jpg) | `#automations/create`, condição guiada selecionada               | Dois tipos de automação e criação desativada; nenhuma definição criada para a captura |
| [viacep-builder.jpg](viacep-builder.jpg)       | Editor de uma definição ViaCEP existente e desativada            | Cinco etapas, CEP fixo e condição sobre UF, com os dois caminhos explícitos           |

As capturas foram feitas por navegação e leitura. Nenhuma automação foi ativada nem evento enviado para gerar essas imagens. A tela de editor não é evidência de consulta ao provedor concluída. Não há tela de agentes conversando no produto porque essa capacidade não existe no runtime.
