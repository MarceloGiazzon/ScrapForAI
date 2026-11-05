# Pacote GeneXus para o ScrapForAI

Para equipes que mantêm aplicações GeneXus (Java ou .NET) e querem testes de regressão repetíveis sem escrever código. O pacote traz:

| O quê | Onde | Para quê |
|---|---|---|
| Perfis de alvo | `templates/targets/` | Dizem "qual aplicação, em qual ambiente, com quais regras". `genexus-dev` e `genexus-staging`. |
| Rotinas modelo | `templates/routines/gx-*.routine.json` | Login GAM, página de fumaça, **Work With** (buscar na grid), **Transaction** (inserir e conferir) e **Prompt** (escolher na janela de busca). |
| Rotinas de caos e concorrência | `templates/routines/chaos-*`, `concurrency-*` | O que acontece quando a API falha ou dois usuários salvam ao mesmo tempo. Adaptadas à mão. |
| Guia de convenções | `docs/genexus-routine-conventions.md` (inglês) e este guia | O que se aprendeu testando GeneXus. |
| Skill para agentes | `skill/scrapforai/SKILL.md` | Para que um agente de IA (Claude Code ou outro cliente MCP) use o ScrapForAI corretamente. |
| Mapa de acessibilidade | `docs/a11y-platform-mapping.md` | O que ajustar no GeneXus/NPDev para cada violação WCAG. |
| `answers.example.json` | raiz | O arquivo de respostas do instalador (abaixo). |

`npm run cli -- pack build --out scrapforai-genexus-pack.zip` monta tudo em um único `.zip` (com uma lista `MANIFEST.sha256`).

## Antes de começar

1. ScrapForAI rodando (`npm run dev`) e `.env` com `SCRAPFORAI_API_KEY` e **`ALLOWED_TARGET_ORIGINS`** com a origem da aplicação (`https://dev.exemplo.com`). Tudo que o ScrapForAI navega passa por essa lista.
2. Um **usuário de teste** da aplicação nesse ambiente. Nunca o de uma pessoa real. Se a aplicação permite uma única sessão por usuário (o normal em GeneXus com GAM), esse usuário é só do ScrapForAI.
3. Guarde as credenciais **no cofre do servidor**, nunca numa rotina:
   ```powershell
   $key = (Select-String -Path .env -Pattern '^SCRAPFORAI_API_KEY=(.+)$').Matches.Groups[1].Value
   $body = @{ boundOrigins = @('https://dev.exemplo.com'); values = @{ loginUser = 'usuario.teste'; loginPassword = '...' } } | ConvertTo-Json
   Invoke-RestMethod -Method Post -Uri http://localhost:3000/v1/credentials/gam-teste -Headers @{Authorization="Bearer $key"} -ContentType 'application/json' -Body $body
   ```
   O conjunto fica **preso a essa origem**: mesmo que alguém escreva uma rotina apontando para outro site, o ScrapForAI não digita a senha lá. Os valores são somente de escrita (nenhuma resposta os devolve).

## Instalar em 5 passos

1. **Copie** `templates/genexus-pack.answers.example.json` para `respostas.json` e preencha: id do perfil, quais rotinas instalar e o valor de cada `REPLACE_...` (a tabela está em `templates/targets/README.md` e `templates/routines/README.md`). Um mesmo `REPLACE_...` pode significar outra coisa em cada rotina (`REPLACE_PAGE_URL` é a página testada numa, o formulário de inclusão noutra): para isso existe `routineValues`, por id de rotina, que sobrepõe `values` só nessa rotina.
2. **Descubra os seletores reais** da sua aplicação. Os do login (`#vUSER`, `#vUSRPSWING`, `BTNENTER`) são comuns em GAM, mas **confirme**. Com o agente: "use `inspect_dom` na página de login"; sem agente: `POST /v1/explorations/inspect-dom`.
3. **Teste sem enviar nada:**
   ```
   npm run cli -- pack apply respostas.json --dry-run
   ```
   Lista o que seria salvo, ou o que falta. **Nada** é enviado enquanto sobrar um `REPLACE_...` ou algo for inválido.
4. **Instale:** `npm run cli -- pack apply respostas.json`. Salva primeiro o perfil (uma rotina não pode ser salva sem o seu perfil), depois a rotina `login` que o perfil nomeia e depois as demais. As rotinas ficam em `draft`.
5. **Execute cada uma** (`npm run cli -- run login`, depois `run smoke-page`...). Quando passar, salve-a como `"status": "active"` (é uma versão nova). As outras rotinas incluem `login` com `"version": 1`: **sempre fixe a versão**, ou a prova deixa de ser reproduzível.

A partir daí: `npm run cli -- run <rotina>`, `suite`, ou um agente com a skill.

## Convenções GeneXus (o que o perfil `platform: genexus` já faz por você)

1. **Sempre uma "porta" depois do login.** Após o submit, esperar um trecho de URL que só existe depois de logar (`loginGate.urlContains`, ex.: `hwbwkw01`). Se o login não terminou, falha ali e não como um timeout confuso adiante. O perfil a adiciona sozinho: uma execução com `credentialSet` inclui a rotina `login` e depois a porta.
2. **Uma única sessão por usuário.** Um segundo login do mesmo usuário pode devolver ao `wblogin`. O ScrapForAI **nunca** usa o mesmo conjunto de credenciais em duas sessões ao mesmo tempo (suites esperam; uma execução síncrona recebe `409 CredentialInUse`) e o `teardown` do `login` encerra a sessão.
3. **Não persiga falhas falsas.** Os `net::ERR_ABORTED` (documentos, imagens do tema) são redirecionamentos do lado do cliente do GeneXus; o perfil os conta como ruído (`evidence.noiseFiltered`). Os sinais confiáveis: `consoleErrors`, `pageErrors`, suas asserções e a porta do login. Um "componente ausente" costuma ser consequência de não ter chegado à página.
4. **Os ids do GeneXus:** `vNOME` é uma variável; numa grid vira `vNOME_0001` (o sufixo é a **linha**); dentro de um web component recebe o prefixo `W0012`. Prefira o `vNOME` sem posição; um seletor com `:nth-child(...)` é frágil (a regra `SEL001` avisa).
5. **Sair do campo.** O GeneXus valida ao perder o foco: os modelos fazem `press Tab` depois de cada `fill`.
6. **Esperar a rede, não o tempo.** `waitForQuiet` espera não haver XHR/fetch pendente (em qualquer frame). `waitForTimeout` fixo é frágil (regra `WT001`).

Ao **salvar** uma rotina o servidor aplica essas regras: `GX001` (erro: submit de credencial sem porta de login), `GX002` (aviso: faz login e não encerra), `WT001`, `SEL001`. Um erro impede salvar; um aviso volta na resposta. Dá para suprimir uma regra com `lintSuppress` (e uma razão de 10 caracteres ou mais), e isso fica visível na rotina.

## Os modelos de tela

| Modelo | O que testa | Altera dados |
|---|---|---|
| `gx-login` | Login GAM com porta e logout. Salve-o como a rotina `login`. | Não |
| `gx-smoke-page` | Entrar, chegar a uma página, conferir que não caiu no login, captura. A forma de todo item do cofre. | Não |
| `gx-work-with-search` | Work With: digita um valor no filtro, busca, a grid mostra linhas e a primeira tem o valor; nenhum stack trace chega à tela. | Não |
| `gx-transaction-insert` | Transaction: insere com um código único **gerado**, encontra na lista (exatamente uma linha) e apaga no `teardown`. | **Sim** (e limpa) |
| `gx-prompt-select` | Prompt: abre a janela de busca, filtra, escolhe uma linha e confere que o formulário mostra o escolhido. | Não |

Os de **caos** (`chaos-*`) quebram uma chamada de propósito (500, lenta, JSON corrompido) e conferem que a tela diz isso com palavras próprias e sem erro cru. Os de **concorrência** (`concurrency-*`) usam dois usuários ao mesmo tempo. Ambos exigem decisões suas: leia em `templates/routines/README.md`. Um perfil `staging` recusa o caos, a menos que uma pessoa ative `flags.allowFaults`.

## Limites, ditos com franqueza

- Os modelos de login se baseiam numa aplicação GeneXus real com GAM; **Work With, Transaction e Prompt são rascunhos** montados com as convenções de ids do GeneXus e executados num navegador real contra uma **aplicação simulada** que imita essas telas (`test/genexus-pack.smoke.ts`: cada modelo passa e fica vermelho no passo certo quando a tela tem o defeito), **não contra uma aplicação GeneXus real nem contra a sua**. Cada seletor `REPLACE_...` precisa ser confirmado.
- **O Prompt só é alcançado se abrir dentro da página** (camada com iframe). Uma janela separada do navegador não é controlada por esses passos: mude o modo de janela do prompt no modelo, ou teste essa tela pela URL.
- Ainda não há regras próprias para `platform: npdev` (a definir com essa equipe) e não se mediu se o runtime do GeneXus expõe um indicador de "ocupado": por isso se espera pela atividade de rede.
- Os dados de teste são sua responsabilidade: `gx-transaction-insert` apaga o que criou, mas um `teardown` não conserta um ambiente com dados reais. Use um ambiente de desenvolvimento/QA.
- As orientações de "o que ajustar no GeneXus" para acessibilidade são orientação e **não foram verificadas contra uma build concreta**.

## E depois

Quando uma rotina passa, ela é um **teste de regressão**: guarde-a no cofre (`vault add-from-run`) com a falha vermelha comprovada e depois a verde. Para várias pessoas e um servidor sempre ligado: `docs/TEAM-SERVER.md` (inglês). Para ver como a aplicação mudou entre builds: snapshots de evolução (`scrapforai evolution snapshot`). Para qual papel vê qual tela: matriz de permissões. Para dados pessoais em URLs e no console: `options.piiScan`.
