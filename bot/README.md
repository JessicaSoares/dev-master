# Motor de candidaturas — implementação inicial local

O objetivo é ampliar a cobertura por conectores. **Não existe suporte universal nem envio automático em todos os sites.** Este módulo não está conectado ao painel publicado. Nenhuma candidatura real foi enviada nos testes.

## Prioridade da usuária: Indeed, InfoJobs e Gupy

Essas três plataformas agora têm identificação de links de vagas, deduplicação por identificador e preparação local de um material para candidatura. **Não são conectores de envio automático.** O Indeed restringe bots externos de candidatura nos seus termos. A Gupy documenta a API como integração para empresas. No InfoJobs, não foi confirmado um canal autorizado de envio automatizado para candidatas. Ausência de documentação não é tratada como autorização ou como proibição comprovada.

```powershell
# Confira as capacidades e fontes verificadas de cada plataforma.
node bot/cli.cjs platforms

# Exporte seu perfil e as vagas cadastradas no painel.
node bot/cli.cjs prepare dev-master-backup.json bot/data/fila.json

# Prepara nome, contato, resumo, projetos e checklist por vaga.
node bot/cli.cjs handoff bot/data/fila.json bot/data/candidaturas.md
```

`handoff` não abre o navegador, não faz login, não extrai dados dos sites, não preenche formulários e não envia currículos. O material usa apenas os dados que você forneceu e indica os passos para finalizar no site. Um link de busca ou login é marcado como insuficiente: cadastre a URL de uma vaga individual. Após enviar no site, registre o resultado no painel. `run --send` mantém esses três canais como `manual_required`, mesmo que o item esteja aprovado.

Reconhecimento atual: Indeed Brasil/global com `jk` ou `vjk`; InfoJobs Brasil com ID `__123.aspx`; Gupy em páginas de empresa `empresa.gupy.io/jobs/123`. Outros formatos precisam de validação e não ganham suporte de envio por serem reconhecidos como domínio.

## Operação

Node 20+, sem instalação de dependências. Execute na pasta `dev-master`:

```powershell
# Consulta pública de vagas de uma empresa que usa Lever.
node bot/cli.cjs discover identificador-da-empresa vagas.json

# Também consulta empresas que usam Greenhouse.
node bot/cli.cjs discover identificador-da-empresa bot/data/vagas-gh.json --greenhouse

# Perfil exportado + arquivo de vagas consultadas, sem combinar JSON manualmente.
node bot/cli.cjs prepare dev-master-backup.json bot/data/fila.json --jobs bot/data/vagas-gh.json

# Campos obrigatórios de uma vaga Greenhouse e validação de respostas.
node bot/cli.cjs inspect https://job-boards.greenhouse.io/empresa/jobs/123 bot/data/formulario.json
node bot/cli.cjs validate bot/data/formulario.json bot/data/respostas.json

# Exporte seus dados pelo painel. O arquivo deve conter profile e jobs.
node bot/cli.cjs prepare dev-master-backup.json fila.json

# Simulação; nunca envia.
node bot/cli.cjs run fila.json
```

Arquivos de descoberta contêm `jobs`. Para preparar uma fila, use `--jobs` com o arquivo de vagas desejadas e seu perfil exportado. Não altere uma fila já enviada para apagar seu histórico. Guarde dados pessoais em `bot/data/`, ignorado pelo Git.

O arquivo de respostas para Greenhouse tem o formato `{"answers":{"first_name":"Seu nome","last_name":"Seu sobrenome","email":"seu@email.com","resume_text":"Experiência real"},"files":{},"consent":{}}`. Use os nomes e opções retornados por `inspect`, incluindo as perguntas personalizadas. A validação considera os campos alternativos de uma mesma pergunta (por exemplo, currículo em arquivo **ou** texto). Perguntas obrigatórias sem resposta são listadas; consentimentos nunca são marcados automaticamente. Essa validação não envia uma candidatura e não verifica arquivos no disco. Campos demográficos obrigatórios ainda exigem o formulário original.

Cada item começa com `approved: false` e `requiredFieldsVerified: false`. Revise destino, dados da candidata, perguntas obrigatórias e exigência de currículo antes de mudar esses campos para o booleano `true`. Se houver perguntas ou consentimentos que o conector não representa, finalize no formulário original. O bot não inventa respostas nem fornece consentimentos automaticamente. Em `resumePath`, use o caminho absoluto para o currículo revisado (até 10 MB), se necessário.

## Envio Greenhouse

O motor inclui envio multipart com autenticação Basic Auth. Configure `GREENHOUSE_KEY_IDENTIFICADOR_DA_EMPRESA` somente com uma chave autorizada da Job Board API da empresa contratante. Uma conta de candidata não fornece essa chave. Não envie credenciais no chat nem coloque em arquivos versionados.

Na fila, preencha `answers` usando os nomes consultados por `inspect`. `first_name`, `last_name` e `email` são obrigatórios no conector; o e-mail deve coincidir com o perfil aprovado. Os nomes não são separados automaticamente. Para anexos, `files` associa o nome do campo ao caminho absoluto, por exemplo `{"cover_letter":"E:/Documentos/carta.pdf"}`. `resumePath` também pode fornecer o arquivo do campo `resume`. Os arquivos são lidos somente depois de validar as respostas e devem ter até 10 MB cada.

O motor faz um novo GET do formulário antes de cada simulação com credencial ou envio, valida perguntas e opções atuais e só transmite campos declarados. `consent` contém decisões explícitas da candidata para os nomes `gdpr_consent_given`, `gdpr_processing_consent_given` ou `gdpr_retention_consent_given`, conforme a política retornada. Campos demográficos obrigatórios e tipos não suportados precisam do formulário original. Perguntas opcionais não preenchidas são omitidas.

`node bot/cli.cjs run fila.json` simula (pode consultar o formulário público, mas nunca faz POST). `node bot/cli.cjs run fila.json --send` realiza POST real apenas dos itens revisados e com integração configurada. Uma resposta HTTP de sucesso da Greenhouse é registrada como `accepted_unverified`, não `submitted`: o contrato de comprovante de candidatura ainda não foi validado em um ambiente autorizado. Confira o resultado no canal original. O motor não repete esse item automaticamente.

## Envio Lever

O POST exige chave gerada por administrador da conta da **empresa contratante**. Uma conta de candidata não fornece essa credencial. Não peça nem coloque senha pessoal no arquivo de fila. Sem uma integração autorizada pela empresa, use o formulário original.

Para integração autorizada, configure a variável de ambiente `LEVER_KEY_IDENTIFICADOR_DA_EMPRESA` (identificador em maiúsculas, hífens convertidos para `_`). Nunca salve a chave nos arquivos ou no Git. Após revisão e configuração, `node bot/cli.cjs run fila.json --send` realiza envios reais dos itens aprovados e suportados. Uma fila usa o perfil de uma candidata; não execute arquivos fornecidos por terceiros sem revisão.

## Evidências e estados

- `pending_review`: aguarda revisão dos dados e campos exigidos.
- `credential_required`: falta credencial autorizada da empresa.
- `manual_required`: conector de envio indisponível.
- `ready`: simulação passou pelos pré-requisitos; não houve envio.
- `sending`: intenção persistida antes da requisição. Se interrompido, verificar manualmente; não repetir automaticamente.
- `submitted`: API respondeu `ok: true` com `applicationId`; comprovante salvo.
- `accepted_unverified`: Greenhouse respondeu HTTP de sucesso sem erro explícito, mas falta confirmar o registro da candidatura; não repetir automaticamente.
- `preflight_failed`: falha na consulta do formulário ou na leitura de seus anexos; nenhum POST foi realizado e uma nova execução pode tentar validar novamente.
- `rate_limited`: HTTP 429; aguarda `retryAt`, respeitando no mínimo 60 segundos. Uma nova execução retoma após o prazo.
- `uncertain`: timeout, resposta inválida ou erro de servidor; verificar no canal original antes de repetir.
- `failed`: rejeição explícita; corrigir antes de considerar nova tentativa.
- `invalid`: URL, perfil ou arquivo inválido.

Fila persistida atomicamente; CLI mantém bloqueio exclusivo por arquivo. Envios sequenciais com intervalo de 1 segundo. A mesma URL de vaga Lever com `/apply`, query ou fragmento é deduplicada para a mesma candidata. Filas diferentes não compartilham histórico: mantenha uma única fila por lote e não envie o mesmo lote por múltiplas filas.

## Cobertura atual

| Canal | Consulta | Envio |
| --- | --- | --- |
| Lever global / EU | API pública por empresa, com paginação | Implementado, condicionado à chave e revisão dos campos |
| Greenhouse | API pública por empresa e inspeção de perguntas por vaga | Implementado com validação atual do formulário; exige chave da empresa; resultado precisa de confirmação |
| LinkedIn | Não implementada | Manual; plataforma restringe automação |
| Indeed Brasil/global | Links fornecidos pela usuária; sem busca automática | Preparação local; conclusão no site; automação externa restringida |
| InfoJobs Brasil | Links fornecidos pela usuária; sem busca automática | Preparação local; canal automático não verificado |
| Gupy | Links de empresa fornecidos pela usuária; sem busca automática | Preparação local; canal automático de candidata não verificado |
| Demais sites | Não implementada | Manual até existir um conector específico |

## Verificação

`npm run test:bot` testa com HTTP simulado: deduplicação, revisão, credencial, comprovantes, falhas ambíguas, limite de requisições, retomada, consulta de vagas, inspeção de formulários, campos alternativos, validação de opções/consentimentos e preparação assistida para Indeed/InfoJobs/Gupy. Isso não comprova envio real nem compatibilidade com todos os formulários.

Documentação consultada em 14/10/2026:

- https://github.com/lever/postings-api — consulta, multipart, credencial obrigatória, comprovante e limites.
- https://docs.greenhouse.io/job-board.html — envio autenticado.
- https://www.linkedin.com/help/linkedin/answer/a1341543 — restrições a automação.
- https://www.indeed.com/legal?hl=en_US — restrições a bots externos de candidatura.
- https://www.infojobs.com.br/legal/aviso-legal-para-candidatos__15727.aspx — condições para candidatas; integração de envio não verificada.
- https://www.gupy.io/termos-de-uso-recrutamento-e-selecao-candidatos — API para integração de empresas.

Faltam: integração ao painel, banco de dados e histórico global de deduplicação, agendamento, mais conectores, campos demográficos e tipos adicionais, validação ponta a ponta e confirmação do comprovante Greenhouse em ambiente autorizado. Não foi validado envio real a empregadores. A implementação atual não torna possível enviar a todos os sites existentes.
