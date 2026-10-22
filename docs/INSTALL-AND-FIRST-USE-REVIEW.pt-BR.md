# Revisao da experiencia de instalacao e primeiro uso

**Data da avaliacao:** 2026-10-21  
**Ambiente:** Ubuntu 24.04 LTS, maquina nova  
**Objetivo:** registrar a jornada real de instalacao e uso do ScrapForAI e propor melhorias priorizadas para a equipe.

## Resumo executivo

O produto funcionou em Linux depois de instaladas as dependencias e configurada uma origem autorizada. A API iniciou, a interface local respondeu, a inspecao DOM encontrou controles e uma rotina com um passo explicito de screenshot gerou um PNG.

A experiencia, porem, exige conhecimento de Node, Playwright, arquivos `.env`, allowlists, autenticacao e processos de desenvolvimento. Na primeira tentativa, a versao do Node nao era suportada; os testes nao rodaram por causa do glob do script; a instalacao do navegador pediu privilegios de administrador; e a primeira tentativa de inspecao de um alvo parado terminou em HTTP 500, sem uma orientacao clara para o usuario. Estes pontos tornam dificil distinguir erro de instalacao, configuracao, alvo e automacao.

A recomendacao principal e oferecer um caminho Linux documentado e um comando de diagnostico/setup que valide os requisitos antes de iniciar o servico, sem enfraquecer a allowlist nem executar instalacoes privilegiadas silenciosamente.

## Jornada observada

1. O sistema tinha Node.js `18.19.1`, mas o projeto exige `>=22`. `npm ci` terminou, porem emitiu avisos `EBADENGINE`; prosseguir nessa versao pode produzir falhas que parecem bugs do produto.
2. A instalacao do Chromium com `npx playwright install --with-deps chromium` exigiu senha do `sudo` para instalar pacotes de sistema. Em seguida, baixou o Chromium, o Headless Shell e o FFmpeg. O usuario precisa saber previamente que isso envolve downloads grandes e alteracoes no sistema.
3. Docker e Doppler nao estavam instalados. O caminho nativo com `.env` foi suficiente, mas a documentacao apresenta Docker Desktop e Doppler entre os pre-requisitos, o que sugere incorretamente que sao obrigatorios para desenvolvimento local.
4. Copiar `.env.example` criou configuracao valida o bastante para iniciar, mas manteve a chave de exemplo `replace-with-strong-random-value` e origens de exemplo (`dev.example.com` e `qa.example.com`). A UI pede a chave, mas o primeiro uso local nao conduz o usuario a gerar uma chave propria nem a configurar o alvo.
5. A origem local precisou ser incluida como origem exata, incluindo esquema e porta: `http://localhost:5173`. `localhost*` nao e um padrao curinga aceito. Essa restricao e coerente com o modelo de seguranca, mas a mensagem de configuracao deve explicar como liberar apenas a origem necessaria.
6. Quando o servidor do alvo nao estava ativo, a chamada de inspecao falhou com HTTP 500. O usuario precisava diagnosticar separadamente que nada estava ouvindo na porta 5173.
7. Com o ScrapForAI e o alvo ativos, `/health` respondeu 200 e a inspecao DOM passou, encontrando oito controles visiveis. A pagina tambem requisitou `fonts.googleapis.com`, que apareceu como origem externa inesperada; nao houve erros de pagina.
8. `options.screenshots: "always"` sozinho nao produziu screenshot numa rotina bem-sucedida. Foi necessario incluir um passo explicito `{"action":"screenshot","name":"terrasana-home"}`. Com esse passo, a rotina passou e salvou um PNG.
9. `npm run typecheck` passou. `npm test` falhou antes de executar os testes: `tsx --test test/**/*.test.ts` tentou abrir literalmente esse caminho, embora os arquivos de teste estejam diretamente em `test/`.
10. `npm ci` reportou dez vulnerabilidades no conjunto instalado: uma baixa, tres moderadas, cinco altas e uma critica. Isso merece triagem separada; nao se deve recomendar `npm audit fix` automaticamente sem revisar compatibilidade e impacto.

## O que funcionou bem

- O servico iniciou em loopback (`127.0.0.1:3000`), sem exposicao involuntaria na rede local.
- A chave da API nao precisou ser colocada no corpo da rotina; a chamada autenticada foi feita pelo cliente.
- A allowlist aceitou a origem local exata sem habilitar curingas.
- A inspecao e a rotina retornaram resultados estruturados, e a captura ficou disponivel como artefato do job.
- O fluxo local funcionou sem Docker ou Doppler quando Node, dependencias e `.env` estavam presentes.

## Melhorias propostas

### P0 — Corrigir bloqueios do caminho feliz

#### 1. Tornar os requisitos por modo de instalacao inequivocos

Separar explicitamente os caminhos **desenvolvimento nativo**, **Docker Compose** e **instalador final**. Para Linux nativo, indicar a versao minima de Node suportada pelo projeto e pelo conjunto de ferramentas; com as dependencias observadas, documentar no minimo Node `22.13+` para evitar os avisos de engine do ESLint e de pacotes relacionados. Marcar Docker, Doppler e `cloudflared` como opcionais quando o usuario escolhe `.env` e execucao nativa.

**Criterio de aceite:** uma tabela por sistema operacional e modo de execucao informa o que e obrigatorio, opcional, o tamanho aproximado dos downloads, quando sera pedido `sudo` e como remover/atualizar os componentes.

#### 2. Corrigir o comando de testes em Linux

Atualizar o script `test` para localizar os testes existentes no nivel superior de `test/` e validar a mesma configuracao em Linux e Windows. O estado atual permite que a instalacao e o typecheck passem enquanto `npm test` nao executa nenhum teste.

**Criterio de aceite:** `npm test` executa os arquivos existentes em uma checkout limpa nos sistemas suportados; se nao houver testes encontrados, o comando falha com uma mensagem clara.

#### 3. Adicionar um comando de diagnostico e primeiro setup

Adicionar, por exemplo, `npm run doctor` e `npm run setup`, ou uma experiencia equivalente. O diagnostico deve verificar Node/npm, instalacao do Chromium e bibliotecas do sistema, existencia/validade do `.env`, portas em uso e disponibilidade do alvo. O setup pode gerar uma chave local forte e orientar a inclusao de uma origem exata.

O comando nao deve instalar pacotes de sistema nem pedir privilegios implicitamente. Se houver uma etapa que requer `sudo`, explicar o motivo e oferecer o comando para o usuario executar conscientemente.

**Criterio de aceite:** cada falha informa causa, impacto e proximo comando; nenhum segredo e impresso em logs alem da apresentacao inicial explicitamente avisada.

#### 4. Rejeitar configuracao de exemplo antes de iniciar

Detectar valores inalterados como `replace-with-strong-random-value` e origens `dev.example.com`/`qa.example.com`. Em desenvolvimento, apresentar um erro de configuracao direto com instrucoes para gerar uma chave e definir origens reais, em vez de deixar o usuario chegar a uma tela de login cuja chave nao conhece ou a um erro de allowlist.

**Criterio de aceite:** a primeira execucao nao aceita silenciosamente a chave de exemplo; uma chave gerada e mostrada uma unica vez, com aviso para guarda-la, e nunca aparece em logs subsequentes.

### P1 — Tornar o primeiro uso mais guiado

#### 5. Melhorar erros de alvo indisponivel

Transformar falhas de conexao, DNS e timeout em resultados estruturados e acionaveis, distinguindo `target unreachable`, `origin not allowlisted`, falha ao iniciar o browser e erro HTTP da aplicacao. A resposta nao deve parecer um erro interno generico do ScrapForAI quando o servidor de destino simplesmente nao esta ativo.

**Criterio de aceite:** para `localhost` sem servidor ativo, a UI e a API indicam a URL/porta testada e sugerem verificar se o servidor do alvo esta rodando; nao exibem stack trace ou segredo.

#### 6. Guiar a configuracao segura de origens

Na configuracao inicial, pedir a origem completa (`http://localhost:5173`) e explicar que esquema, host e porta formam uma origem exata. Nao introduzir `localhost*` nem curingas globais. Separar visualmente a allowlist do alvo das origens de recursos externos, como fontes e APIs, e explicar o significado de requisicoes externas inesperadas.

**Criterio de aceite:** o usuario consegue autorizar o proprio ambiente de desenvolvimento sem editar manualmente o arquivo, sem wildcard e sem abrir acesso a outras portas locais.

#### 7. Tornar screenshots previsiveis e visiveis

A opcao `screenshots: "always"` e facil de interpretar como “capturar sempre”, mas uma rotina bem-sucedida sem passo `screenshot` gerou `evidence.screenshots: []`. Manter o controle granular, mas deixar a semantica clara na UI/schema e oferecer uma acao de screenshot no builder ou uma opcao de captura ao final da rotina. Mostrar a imagem e o link do artefato no detalhe do job.

**Criterio de aceite:** antes de executar, a interface deixa claro se a imagem sera capturada em sucesso, falha ou apenas em passos nomeados; depois da execucao, um PNG gerado pode ser aberto diretamente.

#### 8. Oferecer comandos de desenvolvimento por sistema operacional

O README mistura exemplos de PowerShell, pre-requisitos de Docker/Doppler e uma instalacao nativa. Incluir um caminho Ubuntu/macOS com comandos shell e um caminho Windows com PowerShell, mantendo Docker como alternativa separada. Adicionar comandos de validacao (`/health`, typecheck, testes e primeiro job) para que o usuario saiba quando cada etapa terminou corretamente.

**Criterio de aceite:** uma pessoa em cada sistema suportado consegue seguir um unico caminho sem traduzir comandos entre shells nem instalar ferramentas que nao serao usadas.

### P2 — Reduzir friccao recorrente

#### 9. Revisar o relatorio de dependencias vulneraveis

Investigar as dez vulnerabilidades informadas por `npm ci`, identificar se estao em dependencias de runtime ou somente de desenvolvimento e registrar a decisao. Atualizar dependencias apenas com testes e verificacao de compatibilidade, em especial para manter alinhamento entre Playwright e a imagem Docker.

**Criterio de aceite:** a equipe documenta o resultado da triagem e evita que uma instalacao nova termine com uma vulnerabilidade critica sem contextualizacao.

#### 10. Melhorar o retorno de status do primeiro run

Ao final do setup, apresentar um resumo curto: API ativa, URL da UI, autenticacao configurada, origem autorizada e estado do Chromium. Oferecer um job de verificacao opt-in contra uma pagina local/de teste autorizada, sem navegar automaticamente para um site externo.

**Criterio de aceite:** o usuario consegue distinguir “instalado”, “configurado” e “primeira exploracao concluida” sem inferir isso a partir de logs do terminal.

## Proposta de fluxo ideal

1. Escolher **Linux nativo**, **Windows instalador** ou **Docker**; ver requisitos especificos antes de baixar.
2. Executar um diagnostico pre-instalacao que identifica versoes incompatíveis e dependencias de browser ausentes.
3. Instalar somente os componentes necessarios para o caminho escolhido, com tamanho e privilegios informados.
4. Gerar uma chave forte e configurar uma origem de teste exata; manter `ALLOW_EVALUATE=false` por padrao.
5. Abrir a UI, autenticar e executar uma inspecao de teste autorizada.
6. Ver o resultado, screenshot, erros de console/rede e orientacao de correcao no historico.

## Escopo e referencias

Esta avaliacao cobre uma jornada de desenvolvimento local em Ubuntu 24.04; nao substitui teste de instalacao limpa em Windows, avaliacao completa de seguranca ou validacao de todos os modos Docker/MCP. Os detalhes da rotina local e as observacoes acima podem ser reproduzidos a partir de [README.md](../README.md), [user-manual.md](user-manual.md), [package.json](../package.json), [`.env.example`](../.env.example) e dos schemas publicados pela API.
