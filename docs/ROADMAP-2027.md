# ScrapForAI — Plano de Evolução (Roadmap 2027)

| | |
|---|---|
| **Versão** | 1.0 (proposta) |
| **Data** | 2026-11-02 |
| **Status** | Proposta. Nada aqui está aprovado; a Fase 0 decide o escopo real. |
| **Público** | O time (para decidir) e o agente de IA que vai implementar (para executar) |
| **Relacionados** | [PRODUCTIZATION-PLAN.md](PRODUCTIZATION-PLAN.md) · [SECURITY.md](SECURITY.md) · [genexus-routine-conventions.md](genexus-routine-conventions.md) · [npdev-testing-guide.md](npdev-testing-guide.md) |

---

## Sumário executivo

1. **A premissa original caducou.** Quando o ScrapForAI nasceu, agentes de IA não tinham browser.
   Hoje têm: Playwright MCP (Microsoft, gratuito), Claude in Chrome, o browser integrado do app
   desktop, computer use e os Playwright Test Agents. Competir como "browser para IA" não faz
   mais sentido.
2. **A tese nova: rotinas são dados.** Um `.spec.ts` é código; uma rotina ScrapForAI é um JSON
   validado. Dados podem ser **guardados, versionados, multiplicados, comparados, agendados e
   assinados**. É isso que nenhuma ferramenta genérica faz, e é onde o projeto deve investir.
3. **Quatro pilares:** (a) rotinas como dados, (b) tempo e histórico, (c) conhecimento de
   GeneXus e NPDev, (d) segurança como fronteira real, e não como conveniência.
4. **Três problemas concretos encontrados agora** precisam ser resolvidos de qualquer forma:
   credenciais que trafegam pelo modelo no caminho MCP, credenciais literais versionadas em
   `samples/`, e 15 provas do ledger do NPDev apontando para evidências que já foram apagadas.
5. **O plano tem 11 fases e 74 tarefas**, mas não deve ser executado inteiro de uma vez. Ele tem
   **quatro portões de decisão (G0–G3)** e uma **trilha recomendada** (§0.5) que entrega valor
   em cerca de 3–4 meses e só então decide o resto.

---

## Índice

- [0. Como usar este documento](#0-como-usar-este-documento)
- [1. Contexto e tese](#1-contexto-e-tese)
- [2. Arquitetura-alvo](#2-arquitetura-alvo)
- [Fase 0 — Decisão, higiene e validação](#fase-0--decisão-higiene-e-validação)
- [Fase 1 — Fundações](#fase-1--fundações)
- [Fase 2 — Prova permanente](#fase-2--prova-permanente)
- [Fase 3 — Tempo e histórico](#fase-3--tempo-e-histórico)
- [Fase 4 — System Evolution](#fase-4--system-evolution)
- [Fase 5 — Dados e perfil funcional](#fase-5--dados-e-perfil-funcional)
- [Fase 6 — Multiplicação](#fase-6--multiplicação)
- [Fase 7 — Robustez e qualidade](#fase-7--robustez-e-qualidade)
- [Fase 8 — GeneXus e NPDev](#fase-8--genexus-e-npdev)
- [Fase 9 — Saídas para pessoas](#fase-9--saídas-para-pessoas)
- [Fase 10 — Distribuição](#fase-10--distribuição)
- [11. Segurança por recurso](#11-segurança-por-recurso)
- [12. Dependências candidatas](#12-dependências-candidatas)
- [13. Cronograma estimado](#13-cronograma-estimado)
- [14. Riscos](#14-riscos)
- [15. Métricas de sucesso](#15-métricas-de-sucesso)
- [16. Decisões em aberto](#16-decisões-em-aberto)
- [Apêndice A — Esboços de schema](#apêndice-a--esboços-de-schema)
- [Apêndice B — Roteiro das entrevistas](#apêndice-b--roteiro-das-entrevistas)

---

## 0. Como usar este documento

### 0.1 Regras para o agente que implementa

As regras do [PRODUCTIZATION-PLAN.md §0.1](PRODUCTIZATION-PLAN.md) continuam valendo, com estas
adaptações:

1. **Respeite os portões.** Não comece uma fase cujo portão anterior não foi aprovado por um humano.
2. **Uma tarefa por commit.** Rode a verificação (§0.3) antes de passar para a próxima.
3. **Nunca enfraqueça um controle de segurança.** Allowlist de origens, bloqueio SSRF/IP privado,
   redação de segredos, bearer token, CSRF, `helmet()` e contenção de caminhos só podem ser
   *estendidos*. Toda tarefa que abre superfície nova tem uma linha na §11.
4. **Dependências novas só as listadas na §12**, e só depois da decisão correspondente. Se
   precisar de outra, PARE e reporte.
5. **Compatibilidade retroativa.** Toda rotina válida hoje continua válida e com o mesmo
   comportamento. Todo campo novo é opcional, com default que preserva o comportamento atual.
6. **Paridade REST/MCP.** Toda capacidade nova sai nos dois, e o `inputSchema` do MCP continua
   importando os schemas Zod de `src/schemas/`, nunca uma cópia.
7. **Tarefas `[cross-repo]`** tocam outro repositório (NPDev). Prepare a proposta e PARE para
   coordenar com quem mantém aquele repositório.
8. **Se o código real divergir do que este plano descreve, PARE** e reporte a diferença.

### 0.2 Convenções

As da [PRODUCTIZATION-PLAN.md §0.2](PRODUCTIZATION-PLAN.md): ESM, imports relativos com `.js`,
`import type`, prefixo `node:`, Zod em `src/schemas/`, erros `{ error: { type, message, details? } }`.

### 0.3 Verificação

```powershell
npm run typecheck     # zero erros
npm test              # testes unitários
npm run test:smoke    # Chromium real
npm run build         # gera schema + dist/
```

Cada tarefa lista seus próprios testes. Teste novo de segurança é obrigatório quando a tarefa
aparece na §11.

### 0.4 Legenda de esforço

Estimativas para **1 desenvolvedor trabalhando com um agente de IA**:

| Sigla | Significado |
|---|---|
| **P** | até 2 dias |
| **M** | 3–7 dias |
| **G** | 1–3 semanas |
| **GG** | mais de 3 semanas |

### 0.5 Trilha recomendada

A numeração das fases agrupa por tema; **a ordem de execução recomendada é outra**:

| # | O quê | Por quê |
|---|---|---|
| 1 | **Fase 0** inteira → **Portão G0** | Decide se o projeto segue, e com que escopo |
| 2 | **Fase 1** (T1.1–T1.9) | Tudo depois depende disto |
| 3 | **Fase 2** (cofre de regressão + evidência assinada) → **Portão G1** | Fecha um buraco real que já existe (provas expiradas no ledger) |
| 4 | **T3.1** + **Fase 4** (System Evolution, disparo manual) | Torna a evolução do sistema visível; precisa só do contexto de build |
| 5 | **T5.1–T5.6** (perfil funcional, geradores, oráculo, shrinking) | O perfil funcional é barato, e os geradores são o maior diferencial técnico |
| 6 | **T6.1–T6.2** (matriz de permissões) | Valor alto e custo baixo; depende só da Fase 1 |
| 7 | **T3.2–T3.7** (agendador, desempenho, flakiness, bisect) | Transforma execuções avulsas em histórico |
| 8 | **T7.1, T7.4–T7.7** (acessibilidade com baseline) → **Portão G2** | Só vale com histórico, que a esta altura já existe |
| 9 | O restante (F6, F7, F8, F9), conforme a demanda medida | |
| 10 | **Fase 10** somente após o **Portão G3** | |

---

## 1. Contexto e tese

### 1.1 O cenário em novembro de 2026

| Ferramenta | O que cobre | Onde não chega |
|---|---|---|
| **Playwright MCP** (Microsoft) | Snapshot da página, console, rede, screenshots, traces, storage state, `--allowed-origins`, `--secrets` | A própria documentação diz que a allowlist "is not a security boundary and does not affect redirects" e que secrets são "a convenience, not a security feature". Não guarda histórico nem tem rotinas como dados |
| **Claude in Chrome / browser integrado / computer use** | O agente opera um browser de verdade | Usa as sessões reais do usuário; sem rotina reexecutável; sem evidência estruturada |
| **Playwright Test + Test Agents** | Geração e manutenção de `.spec.ts` | É código: difícil de multiplicar, comparar ou assinar como dado; exige perfil de dev JS |
| **GXtest** (GeneXus/Abstracta) | Testes funcionais de apps GeneXus, recorder, geração a partir da KB | Não encontramos sinal de orientação a agentes de IA (confirmar na Fase 0) |

### 1.2 Tese

> **Rotinas são dados.** O ScrapForAI deve ser o lugar onde a IA (ou uma pessoa) escreve uma rotina
> uma vez, e onde essa rotina vira **prova permanente, teste multiplicado, série histórica e
> documentação**, com segurança de verdade e conhecimento das plataformas GeneXus e NPDev.

Os quatro pilares:

| Pilar | O que significa | Exemplos |
|---|---|---|
| **A. Rotinas como dados** | Guardar, versionar, compor, multiplicar, comparar | Cofre de regressão, geradores com shrinking, matriz de permissões, execução diferencial |
| **B. Tempo e histórico** | Cada execução é um ponto numa série | System Evolution, desempenho, flakiness, bisect |
| **C. Conhecimento de plataforma** | GeneXus e NPDev como cidadãos de primeira classe | Seletores semânticos, CRUD gerado, domínios derivados do modelo/KB |
| **D. Segurança real** | Fronteiras que valem como fronteira | Cofre de credenciais com vínculo por origem, evidência assinada, caçador de PII |

### 1.3 O que NÃO fazer

- Não adicionar steps genéricos que só espelham a API do Playwright sem um consumidor concreto
  (esse é um trabalho que nunca termina, e o Playwright MCP já tem tudo isso de graça).
- Não polir instalador, UI ou empacotamento para um público genérico antes do Portão G3.
- Não competir em "navegação aberta na web", anti-bot ou evasão. Isso continua fora de escopo
  (ver [README](../README.md)).
- Não fazer o servidor chamar LLMs. O servidor continua sem chave de modelo; todo o trabalho de
  IA é feito pelo agente cliente via MCP (ver princípio P7).

### 1.4 Achados concretos (motivam tarefas deste plano)

| ID | Achado | Evidência | Tratado em |
|---|---|---|---|
| **A1** | No caminho MCP, **o modelo escreve o segredo**. As credenciais chegam no corpo da requisição (`credentials`), e o MCP só repassa o corpo. A promessa do AGENTS.md ("callers, including LLMs, never see the actual secret") só vale para a *saída* (redação), não para a entrada | [explorationRequest.schema.ts](../src/schemas/explorationRequest.schema.ts) (`credentials: z.record(...)`), [mcp/client.ts](../src/mcp/client.ts) | T0.2, T1.2 |
| **A2** | Os 7 arquivos versionados em `samples/*.json` contêm `loginUser`/`loginPassword` **literais** (não são placeholders), e o repositório tem remote no GitHub | `git ls-files samples` | T0.1 |
| **A3** | **7 itens do ledger do NPDev citam 15 job IDs do ScrapForAI como prova**, mas `ARTIFACT_RETENTION_HOURS=4`. A evidência já foi apagada, e um job ID não pode ser reexecutado. Pelo próprio critério do ledger, isso é "a claim, not a proof" | `NPDev_General/ledger/items/*.yml`, [env.ts](../src/config/env.ts) | T1.5, F2, T2.5 |
| **A4** | Guards `live` e `manual` do ledger são verificados só pela existência do caminho; nunca rodam | README do ledger (regra de *Resolution*) | T2.4 |
| **A5** | Rotina não é uma entidade: existe só no corpo da requisição. Não há ID estável nem versão (`scenarioName` é texto livre e opcional) | [explorationRequest.schema.ts](../src/schemas/explorationRequest.schema.ts) | T1.3 |
| **A6** | Execução é síncrona dentro do request HTTP (`JOB_TIMEOUT_MS` = 60 s). Suítes, execuções paramétricas e snapshots levam minutos | [runExploration.ts](../src/runner/runExploration.ts) | T1.6 |
| **A7** | Não há interceptação de rede (`page.route`). Recursos de origens inesperadas são só *reportados*, não bloqueados | [collectEvidence.ts](../src/runner/collectEvidence.ts), README | T5.1 |
| **A8** | O runner assume uma única página/contexto por job | [playwrightContext.ts](../src/runner/playwrightContext.ts) | T6.4 |
| **A9** | O histórico é um JSONL de processo único, sem `routineId`, `buildId` ou `suiteRunId` | [runHistoryStore.ts](../src/history/runHistoryStore.ts), [summarizeResult.ts](../src/history/summarizeResult.ts) | T1.3, T1.9, T3.1 |

### 1.5 Mapa de ideias → tarefas

| ID | Ideia | Pilar | Tarefas |
|---|---|---|---|
| I-01 | Cofre de regressão integrado ao ledger | A/D | F2 (T2.1–T2.5, T2.8) |
| I-02 | Evidência de homologação assinada | D | T1.5, T2.6, T2.7 |
| I-03 | System Evolution (inclui a Deriva de UI) | B | F4 |
| I-04 | Perfil funcional (sem imagens) | A | T5.1, T5.2 |
| I-05 | Geradores de valores em faixa | A | T5.3, T5.4 |
| I-06 | Oráculo de fórmulas | A | T5.5 |
| I-07 | Shrinking (redução da entrada mínima que falha) | A | T5.6 |
| I-08 | Matriz de permissões (GAM) | A/D | T6.1, T6.2 |
| I-09 | Execução diferencial | A | T6.3 |
| I-10 | Multi-ator (fluxos e concorrência) | A | T6.4–T6.6 |
| I-11 | Agendador | B | T3.2, T3.3 |
| I-12 | Tendência de desempenho | B | T3.4 |
| I-13 | Flakiness e quarentena | B | T3.5 |
| I-14 | Bisect de regressão | B | T3.1, T3.6 |
| I-15 | Caos controlado | A | T5.1, T7.2 |
| I-16 | Relógio falso | A | T7.3 |
| I-17 | Acessibilidade (baseline, teclado, tradução GX) | B/C | T7.1, T7.4–T7.7 |
| I-18 | Caçador de PII | D | T7.8, T7.9 |
| I-19 | Seletores semânticos GeneXus | C | T8.3 |
| I-20 | Espera pelo ciclo AJAX | C | T8.2 |
| I-21 | Domínios derivados do modelo NPDev / KB GeneXus | C | T8.5 |
| I-22 | Testes CRUD gerados | C | T8.6 |
| I-23 | Convenções como lint | C | T8.4 |
| I-24 | Bug report automático | — | T9.1 |
| I-25 | Manual vivo | — | T9.2 |
| I-26 | Modo HTTP para regras de servidor | A | T5.7 |

---

## 2. Arquitetura-alvo

### 2.1 Visão geral

```
                 ┌──────────────── Clientes ────────────────┐
                 │  Agente (MCP)   CLI scrapforai   Web UI   │
                 └──────┬───────────────┬───────────────┬────┘
                        │ REST (bearer / sessão)        │
┌───────────────────────▼───────────────────────────────▼──────────────────────┐
│ API Express                                                                   │
│  /v1/explorations  /v1/routines  /v1/suites  /v1/vault  /v1/targets           │
│  /v1/credentials (write-only)  /v1/schedules  /v1/evolution  /v1/runs         │
├──────────────────────────────────────────────────────────────────────────────┤
│ Orquestrador ── fila de jobs (prioridade: interativo > suíte > agendado)      │
│   expansão de variantes: credenciais × alvos × amostras × atores              │
│   locks: 1 sessão por conjunto de credenciais (sessão única GeneXus)          │
├──────────────┬───────────────┬──────────────┬───────────────┬────────────────┤
│ Runner       │ Roteamento    │ Scripts      │ Diff estrutural│ Detectores     │
│ (atores,     │ (política de  │ confiáveis   │ + normaliza-   │ (PII, ruído    │
│  include,    │  recursos,    │ (axe, foco,  │  dores         │  GX)           │
│  teardown)   │  falhas)      │  quietude)   │                │                │
├──────────────┴───────────────┴──────────────┴───────────────┴────────────────┤
│ Armazenamento                                                                 │
│  targets/  library/  vault/  credentials.enc  evidence/(classes, manifestos)  │
│  history/runs.jsonl  metrics/  suites/  schedules.json  → system-evolution/   │
│                                                             (repo git)        │
├──────────────────────────────────────────────────────────────────────────────┤
│ Segurança transversal: validateTargetUrl em toda navegação · redação ·        │
│ vínculo credencial↔origem · assinatura Ed25519 · allowlists de egress         │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Módulos novos

| Diretório | Responsabilidade | Criado em |
|---|---|---|
| `src/targets/` | Perfis de alvo (app + ambiente) | T1.1 |
| `src/vault/credentials/` | Cofre de credenciais cifrado | T1.2 |
| `src/library/` | Biblioteca de rotinas versionada, composição | T1.3, T1.4 |
| `src/evidence/` | Classes de retenção, manifestos, assinatura | T1.5, T2.6 |
| `src/orchestrator/` | Fila de jobs, suítes, variantes, locks | T1.6 |
| `src/cli.ts` | CLI `scrapforai` | T1.7 |
| `src/vault/regression/` | Cofre de regressão | F2 |
| `src/scheduler/` | Agendador | T3.2 |
| `src/metrics/` | Séries de desempenho, flakiness | T3.4, T3.5 |
| `src/diff/` | Diff estrutural e normalizadores | T4.1 |
| `src/evolution/` | Catálogo, inventário, snapshots | F4 |
| `src/runner/routing.ts` | Camada de roteamento | T5.1 |
| `src/params/` | Parâmetros, geradores, oráculo, shrinking | T5.3–T5.6 |
| `src/runner/trusted/` | Scripts confiáveis embutidos | T7.1 |
| `src/security/piiDetectors.ts` | Detectores de PII | T7.8 |
| `src/platforms/genexus/`, `src/platforms/npdev/` | Conhecimento de plataforma | F8 |
| `src/integrations/` | Webhooks, issue trackers | T3.3, T9.1 |
| `src/reports/` | Relatórios HTML/PDF | T2.7 |

### 2.3 Layout de dados (diretório por usuário)

```
%LOCALAPPDATA%\ScrapForAI\           (ou SCRAPFORAI_DATA_DIR)
  targets\<id>.json
  credentials.enc.json                # cifrado; nunca exportado pela API
  vault.key                           # se não vier de SCRAPFORAI_VAULT_KEY; ACL restrita
  signing\ed25519.key + .pub          # T2.6
  library\<routineId>\v<N>.json       # versões imutáveis
  library\<routineId>\current.json
  regression-vault\<ITEM-ID>.json
  artifacts\<jobId>\...               # efêmero (4 h)
  evidence\pinned\<jobId>\...         # fixado; fora da retenção
  history\runs.jsonl
  metrics\<routineId>.jsonl
  suites\<suiteRunId>.json
  schedules.json
SYSTEM_EVOLUTION_DIR\<target>\<data>_<build>\   # preferencialmente um repo git
```

`ROUTINE_LIBRARY_DIR` e `REGRESSION_VAULT_DIR` podem apontar para dentro de um repositório (por
exemplo, o do NPDev), para que rotinas e itens sejam revisados em PR como qualquer código.

### 2.4 Princípios transversais

| # | Princípio |
|---|---|
| P1 | **Paridade REST/MCP**, com schemas Zod como fonte única |
| P2 | **Nada contorna `validateTargetUrl`.** A camada de roteamento só altera tráfego de origens allowlisted |
| P3 | **Segredos nunca em requisição, resposta ou log** no caminho MCP. Credenciais vêm do cofre, por nome |
| P4 | **Determinismo.** Toda aleatoriedade tem seed, e a seed fica registrada no resultado |
| P5 | **Evidência fixada é imutável**, com hash por arquivo e cadeia de manifestos |
| P6 | **Diff semântico primeiro**, visual depois e opcional |
| P7 | **Fonte de verdade determinística.** Texto gerado por IA é comentário rotulado, produzido pelo agente cliente, nunca pelo servidor |
| P8 | **Opt-in por perfil de alvo.** Nada destrutivo ou intrusivo fica ligado por padrão |
| P9 | **Compatibilidade.** Rotinas atuais continuam funcionando sem alteração |

---

# Fase 0 — Decisão, higiene e validação

**Objetivo:** corrigir o que está exposto e decidir com dados se o projeto segue, e com qual escopo.
**Duração estimada:** 1–2 semanas.

### T0.1 — Higiene das credenciais em `samples/` · P

**Por quê:** achado A2.

**Passos:**
1. Verificar se os valores de `loginUser`/`loginPassword` nos 7 arquivos de `samples/*.json` são
   credenciais reais de algum ambiente (por exemplo, `dev.example.com`).
2. Se forem reais: **rotacionar no ambiente** antes de qualquer outra coisa.
3. Substituir os valores por placeholders (`"<LOGIN_USER>"`) ou, após a T1.2, por
   `credentialSet`.
4. Decidir se a história do git será reescrita (o mesmo procedimento usado no item AIP-0/AIP-6
   do NPDev). Se a chave já foi rotacionada, reescrever é opcional.
5. Adicionar um teste em `test/samples-hygiene.test.ts` que falha se qualquer `credentials` em
   `samples/` não for placeholder.

**Aceite:**
- [ ] Valores rotacionados (se eram reais) e confirmados por quem administra o ambiente
- [ ] Nenhum sample com credencial literal
- [ ] Teste de higiene no CI

### T0.2 — Corrigir a promessa de indireção de credenciais · P

**Por quê:** achado A1. A documentação promete mais do que o código entrega.

**Passos:** ajustar AGENTS.md, README e SECURITY.md para dizer exatamente o que vale hoje: a
redação protege a *saída*, mas no caminho MCP o modelo fornece os valores na entrada. Apontar
para a T1.2 como a correção.

**Aceite:** nenhum documento afirma que o modelo nunca vê o segredo enquanto a T1.2 não estiver
entregue.

### T0.3 — Teste comparativo com Playwright MCP + Skill · M

**Por quê:** é a pergunta central. Se uma Skill com as convenções GeneXus sobre o Playwright MCP
entrega o mesmo resultado, o runner próprio não se justifica para uso interativo.

**Montagem:**
- Lado A: ScrapForAI atual via MCP.
- Lado B: Playwright MCP com `--isolated`, `--allowed-origins` e `--secrets`, mais uma Skill do
  Claude Code contendo [genexus-routine-conventions.md](genexus-routine-conventions.md) e o
  [npdev-testing-guide.md](npdev-testing-guide.md) adaptados. Essa Skill é o primeiro rascunho da
  T8.7.

**Cinco tarefas reais:**
1. Reproduzir o bug `panel_nested_masterdetail` (citado no guia NPDev).
2. Login GeneXus + navegação + extração (`report-activity-routine.sample.json`).
3. A investigação de scrollbar (`scrollbar-investigation.sample.json`).
4. A rotina de 44 steps do item EDIT-5 do ledger (`npdev explore`).
5. Uma exploração nova, numa tela que nenhum dos dois lados conhece.

**Critérios, registrados por tarefa:** sucesso (sim/não), chamadas de ferramenta, tokens, tempo
total, falsos positivos, intervenções humanas, exposição de segredo ao modelo e se o resultado é
**reexecutável sem LLM**.

**Entregável:** `docs/T0.3-COMPARISON.md` com a tabela e a conclusão.

### T0.4 — Entrevistas de validação · M

**Passos:** conversar com 2–3 empresas GeneXus de fora e com 2 usuários internos (NPDev e
GeneXus), usando o roteiro do [Apêndice B](#apêndice-b--roteiro-das-entrevistas). Objetivo:
descobrir quais ideias da §1.5 resolvem uma dor pela qual alguém **pagaria** ou **trocaria uma
ferramenta**.

**Entregável:** `docs/T0.4-INTERVIEWS.md` com um ranking das ideias por dor relatada.

### T0.5 — Posicionamento e nome · P

O nome "ScrapForAI" descreve o que o projeto **não** é (o próprio README diz "not a generic
open-web scraper"). Decidir (D1, §16) se o nome se mantém para uso interno e qual nome e frase de
posicionamento usar caso o Portão G3 aprove distribuição externa. Critério: o nome deve comunicar
**prova/verificação/QA para agentes**, não scraping.

### T0.6 — Linha de base de métricas · P

Registrar o estado atual, para comparar depois:
- execuções por semana e taxa de sucesso (`GET /v1/runs/stats`);
- rotinas distintas em uso (`GET /v1/runs/scenarios`);
- itens do ledger do NPDev com prova ScrapForAI: 47 mencionam o ScrapForAI; 7 citam job IDs
  expirados; **0 guards executáveis**.

**Entregável:** `docs/T0.6-BASELINE.md`.

### 🚦 Portão G0

| Resultado | Decisão |
|---|---|
| ScrapForAI vence em ≥ 3 das 5 tarefas da T0.3 **ou** ≥ 2 empresas externas demonstram interesse concreto (aceitariam um piloto) | Seguir a trilha recomendada (§0.5) |
| Empate na T0.3 e nenhum interesse externo | **Trilha interna mínima:** T1.1–T1.7 e Fase 2 (o cofre resolve o A3, que existe de qualquer forma), mais a Skill (T8.7). Parar aí |
| Playwright MCP + Skill vence com folga e não há interesse externo | Manter só a Skill e o cofre de regressão como camada fina; arquivar o restante |

---

# Fase 1 — Fundações

**Objetivo:** transformar rotina, credencial, alvo e evidência em entidades de primeira classe, e
permitir execuções longas.
**Duração estimada:** 4–6 semanas.

### T1.1 — Perfis de alvo · M

**Por quê:** quase todos os recursos precisam saber "que app é este, em que ambiente, com que
regras".

**Entregáveis:**
- `src/schemas/targetProfile.schema.ts` (esboço no [Apêndice A](#a1-perfil-de-alvo))
- `src/targets/targetStore.ts`: um arquivo por perfil em `<dataDir>/targets/`
- `src/routes/targets.routes.ts`: `GET /v1/targets`, `GET /v1/targets/:id`, `PUT /v1/targets/:id`

**Especificação:**
- O perfil **não amplia** a allowlist: `baseUrl` precisa estar em `ALLOWED_TARGET_ORIGINS`, ou o
  save é recusado.
- `PUT` exige o bearer token. Sessão da UI não basta, pela mesma regra dos campos travados da
  configuração.
- `explorationRequest` ganha `targetProfile?: safeName`. Quando presente, `targetUrl` passa a ser
  opcional (o default vem do perfil).
- O perfil carrega: plataforma (`generic | genexus | npdev`), ambiente, conjuntos de credenciais
  permitidos, filtros de ruído, mapa superfície → globs de arquivo (T2.3), catálogo de telas (T4.2),
  sonda de build (T3.1) e flags (`allowDestructive` = false, `maxSessionsPerCredential` = 1).

**Aceite:**
- [ ] Perfil com origem fora da allowlist é recusado (teste)
- [ ] `PUT` com sessão de UI e sem bearer → 403 (teste)
- [ ] Rotina sem `targetProfile` funciona exatamente como hoje (teste de regressão)

**Depende de:** —

### T1.2 — Cofre de credenciais server-side · G

**Por quê:** achado A1. É a correção da promessa central de segurança do projeto.

**Entregáveis:**
- `src/vault/credentials/credentialVault.ts`
- `src/routes/credentials.routes.ts`
- Ferramenta MCP `list_credential_sets`

**Especificação:**
- Armazenamento em `<dataDir>/credentials.enc.json`, cifrado com AES-256-GCM (`node:crypto`). A
  chave vem de `SCRAPFORAI_VAULT_KEY` (32 bytes em base64) ou de `<dataDir>/vault.key`, gerada no
  primeiro uso com ACL restrita ao usuário. O instalador aplica a ACL via `icacls` (D3, §16).
- Um *conjunto de credenciais* tem: `id`, `boundOrigins` (≥ 1), campos nomeados (`loginUser`,
  `loginPassword`, ...), `tags` (por exemplo, `role:admin`) e notas.
- A requisição passa `credentialSet: 'gam-admin'`. O runner carrega os campos no mapa
  `credentials` **do lado do servidor**, e `valueFromCredential` continua igual.
- **Vínculo por origem:** um `fill` com valor de credencial só executa se a origem da página atual
  estiver em `boundOrigins`. Isso impede que uma rotina escrita por IA leve a senha para outra
  origem allowlisted.
- API: `POST/PUT/DELETE /v1/credentials/:id` exigem bearer, e os valores são **somente escrita**.
  `GET` devolve só metadados (id, origens, tags, nomes dos campos, último uso).
- MCP: o `run_exploration` passa a usar um schema derivado **sem** o campo `credentials` inline,
  construído a partir do objeto base **antes** do `superRefine` (para não perder nem quebrar as
  validações), e ainda importado de `src/schemas/`. Na REST, o campo inline continua aceito por
  compatibilidade, controlado por `ALLOW_INLINE_CREDENTIALS` (default `true`, com aviso de
  depreciação no log).
- Os valores do cofre entram em `collectKnownSecretValues` para redação.

**Aceite:**
- [ ] Nenhuma resposta, log, `result.json` ou entrada do histórico contém um valor do cofre (teste com valor sentinela)
- [ ] `fill` com credencial numa origem não vinculada falha com `CredentialOriginMismatch` (teste)
- [ ] `GET /v1/credentials` nunca retorna valores (teste)
- [ ] O schema MCP de `run_exploration` não expõe `credentials` (teste do schema)
- [ ] AGENTS.md, README e SECURITY.md atualizados (desfaz a ressalva da T0.2)

**Depende de:** T1.1

### T1.3 — Biblioteca de rotinas versionada · G

**Por quê:** achado A5. Sem uma rotina com ID estável não existe cofre, agendamento, diferencial
nem histórico por rotina.

**Entregáveis:**
- `src/schemas/libraryRoutine.schema.ts` ([Apêndice A](#a3-rotina-da-biblioteca))
- `src/library/routineLibrary.ts`
- `src/routes/routines.routes.ts`: `GET /v1/routines`, `GET /v1/routines/:id[?version=N]`,
  `PUT /v1/routines/:id`, `POST /v1/routines/:id/run`
- MCP: `list_routines`, `get_routine`, `save_routine`, `run_routine`

**Especificação:**
- Cada `PUT` com conteúdo diferente cria `v<N+1>.json`, imutável. `current.json` aponta para a
  versão ativa. O `sha256` do conteúdo canônico fica registrado.
- Status: `draft | active | quarantined | retired`. Só `active` roda em agendamentos e suítes por
  padrão.
- **Lint no save:** recusar `value` literal que coincida com qualquer valor do cofre (T1.2) ou com
  padrões de segredo (`sk-`, `ghp_`, JWT, etc.).
- `save_routine` aceita `fromJobId`: a partir de uma execução bem-sucedida, salva a rotina usada.
  É o atalho "o agente acabou de fazer funcionar → guardar".
- `runSummary` ganha `routineId?` e `routineVersion?`.
- `ROUTINE_LIBRARY_DIR` permite apontar para um diretório dentro de um repositório.

**Aceite:**
- [ ] Salvar duas vezes o mesmo conteúdo não cria versão nova (teste)
- [ ] Executar `?version=1` depois de existir a v2 roda a v1 (teste)
- [ ] Lint recusa senha literal conhecida (teste)
- [ ] Execução registra `routineId`/`routineVersion` no histórico (teste)

**Depende de:** T1.1, T1.2

### T1.4 — Composição: `include` e `teardown` · M

**Por quê:** login, logout e limpeza se repetem em todas as rotinas GeneXus (ver convenções §1 e
§2). Testes CRUD (T8.6) e concorrência (T6.6) precisam de limpeza garantida.

**Especificação:**
- Step `include { routineId, version? }`: expande os steps da rotina incluída no lugar.
  Profundidade máxima 3; ciclos são recusados na validação. Os steps expandidos recebem IDs
  prefixados (`login.submit`).
- Bloco `teardown: Step[]` no nível da rotina: executa **sempre**, inclusive após uma falha, como
  um `finally`. Falhas no teardown são registradas à parte e não mascaram a falha principal.
- Limite de steps (`MAX_STEPS_PER_JOB`) vale após a expansão.

**Aceite:**
- [ ] Rotina com `include` de login + teardown de logout passa no smoke test
- [ ] Ciclo de include é recusado (teste)
- [ ] Teardown roda após falha no step 3 (teste)

**Depende de:** T1.3

### T1.5 — Retenção por classe e evidência fixada com manifesto · M

**Por quê:** achado A3. Prova não pode expirar em 4 horas.

**Especificação:**
- Classes: `ephemeral` (default, `ARTIFACT_RETENTION_HOURS`), `standard` (`STANDARD_RETENTION_DAYS`,
  default 30) e `pinned` (nunca removida automaticamente).
- Toda execução grava `manifest.json` com `sha256` de cada arquivo e do `result.json`. É barato e
  habilita a T2.6.
- `POST /v1/runs/:jobId/pin { reason, ref }` move o job para `evidence/pinned/<jobId>/`. O
  `pruneExpiredArtifacts` ignora `pinned`.
- Cota `PINNED_EVIDENCE_MAX_MB` (default 2048). Ao estourar, recusar novas fixações com erro claro;
  nunca apagar evidência fixada.
- Na fixação, o trace é descartado por padrão (é o arquivo mais pesado), a menos que
  `keepTrace: true`.
- `runSummary` ganha `retention` e `pinned`.

**Aceite:**
- [ ] Job fixado sobrevive ao prune (teste com relógio adiantado)
- [ ] O manifesto confere com os arquivos (teste que altera 1 byte e detecta)
- [ ] Cota estourada → 409 sem apagar nada (teste)

**Depende de:** —

### T1.6 — Fila de jobs assíncrona e orquestrador · G

**Por quê:** achado A6. Também é a base de suítes, variantes, matriz, parametrização e agendamento.

**Entregáveis:**
- `src/orchestrator/jobQueue.ts`: fila em memória com prioridade (interativo > suíte > agendado),
  respeitando `MAX_PARALLEL_JOBS`
- `src/orchestrator/suiteRunner.ts`
- `src/schemas/suiteRequest.schema.ts` ([Apêndice A](#a5-suíte))
- `POST /v1/suites` → `202 { suiteRunId }`; `GET /v1/suites/:id`; `POST /v1/suites/:id/cancel`
- MCP: `run_suite` (retorna o id) e `get_suite_result`

**Especificação:**
- **Expansão de variantes:** itens × `credentialSets` × `targetProfiles` × amostras (T5.4) geram
  uma lista de execuções concretas, cada uma com uma `variantKey` legível.
- **Locks:** no máximo `maxSessionsPerCredential` (default 1) execuções simultâneas por conjunto de
  credenciais. Isso implementa a regra de sessão única das convenções GeneXus §2.
- Modos: `sequential` (default) ou `parallel` com `concurrency`. Com `failFast`, a suíte para no
  primeiro vermelho e lista os itens não executados.
- **Veredito único**, com contrato de saída para a CLI: `0` tudo verde, `1` alguma falha, `2` erro
  de infraestrutura.
- O resultado de cada suíte fica em `<dataDir>/suites/<suiteRunId>.json`.
- `runSummary` ganha `suiteRunId?` e `variantKey?`.
- O `POST /v1/explorations/run` síncrono continua existindo, sem mudanças.

**Aceite:**
- [ ] Suíte com 2 rotinas × 2 credenciais gera 4 execuções com `variantKey` distintas (teste)
- [ ] Duas variantes com a mesma credencial nunca rodam ao mesmo tempo (teste com relógio)
- [ ] `failFast` para e lista os não executados (teste)
- [ ] Uma suíte de 5 minutos não estoura o timeout do MCP (smoke)

**Depende de:** T1.3

### T1.7 — CLI `scrapforai` · M

**Por quê:** CI, guards do ledger (T2.4) e agendamento pelo sistema operacional precisam de um
binário com código de saída.

**Especificação:**
- `src/cli.ts`, publicado como `bin` no `package.json`. Fala com a API REST, como o cliente MCP, e
  lê a chave do `.env` com a mesma resolução ancorada.
- Comandos: `run <routineId> [--version N] [--target id]`, `suite <arquivo|nome>`,
  `routines list`, `runs show <jobId>`, `pin <jobId>`. Comandos de cofre, evolução e evidência
  entram nas fases seguintes.
- Saída `--json` estável e versionada (`"cliSchema": 1`), porque o NPDev vai consumi-la.
- Códigos de saída conforme a T1.6.

**Aceite:**
- [ ] `scrapforai run x` sai com 1 quando a rotina falha e 2 quando a API está fora (teste)
- [ ] `--json` validado contra um schema (teste)

**Depende de:** T1.6

### T1.8 — Ferramentas MCP da fundação e documentação · M

**Especificação:**
- Ferramentas novas: `list_credential_sets`, `list_targets`, `list_routines`, `get_routine`,
  `save_routine`, `run_routine`, `run_suite`, `get_suite_result`, `get_run` (resultado de um job
  passado, ainda não disponível via MCP).
- Atualizar as `instructions` do servidor MCP com o fluxo recomendado: `list_targets` →
  `inspect_dom` → `run_exploration` → `save_routine`.
- Atualizar AGENTS.md, README, SECURITY.md e o manual do usuário (en/es/pt).

**Depende de:** T1.1–T1.7

### T1.9 — Decisão de armazenamento · P

**Pergunta (D2):** o JSONL atual aguenta histórico, métricas, suítes e agendamentos?

**Recomendação inicial:**
- Entidades editáveis por humanos (perfis, rotinas, itens do cofre): **um arquivo JSON por
  entidade**. São revisáveis em PR e versionáveis em git.
- Séries de alto volume (execuções, métricas por step): **JSONL agora**, com o limiar de migração
  documentado. Quando migrar, avaliar `node:sqlite` (embutido no Node ≥ 22.13 sem flag, mas ainda
  marcado como experimental; confirmar na versão alvo) antes de qualquer dependência nativa.

**Entregável:** atualização da §1.5 do PRODUCTIZATION-PLAN com o novo limiar.

---

# Fase 2 — Prova permanente

**Objetivo:** cada bug corrigido vira uma prova reexecutável, com evidência que não expira e que
pode ser verificada por terceiros.
**Duração estimada:** 3–4 semanas.

### T2.1 — Modelo do item do cofre de regressão · P

**Especificação:** schema em `src/schemas/regressionItem.schema.ts`
([Apêndice A](#a4-item-do-cofre-de-regressão)), **compatível em espírito** com o ledger do NPDev
(`id`, `title`, `type`, `severity`, `status`, `opened`, `surface`), mais:
- `routine { id, version }`: a prova executável;
- `ledgerRef`: por exemplo `npdev:REG-209` (opcional; projetos GeneXus podem não ter ledger);
- `provenRed` e `firstGreen`: referências a evidência **fixada** (jobId, buildId, sha256 do manifesto);
- `redNotCapturedReason`: obrigatório quando `provenRed` é nulo, espelhando a política de legado
  do ledger;
- `lastRun`.

Tipos: `BUG` (corrigido), `SCENARIO` (situação difícil de testar) e `BOUNDARY` (limite aceito).
Status: `ACTIVE`, `QUARANTINED`, `RETIRED`.

### T2.2 — Fluxo RED → GREEN · M

**Especificação:**
- `vault add --from-run <jobId>`: o agente acabou de reproduzir um bug. A rotina vai para a
  biblioteca, a execução vermelha é **fixada** como `provenRed`, e o item nasce `ACTIVE`.
- `vault confirm-green <id>`: roda contra o build corrigido. Se passar, fixa como `firstGreen`.
  Se falhar, mantém o status e reporta.
- Regra: um item `ACTIVE` sem `provenRed` exige `redNotCapturedReason`.
- MCP: `vault_add_from_run`, `vault_confirm_green`.

**Aceite:**
- [ ] O fluxo completo num app de fixture: RED fixado → correção → GREEN fixado (smoke)
- [ ] `confirm-green` com rotina ainda vermelha não altera o item (teste)

### T2.3 — Execução por impacto · M

**Por quê:** a sua ideia original: ao implementar uma feature, rodar em sequência os erros
corrigidos e as situações complicadas, começando pelos mais prováveis de quebrar.

**Especificação:**
- Entrada: `changedFiles` (por exemplo, `git diff --name-only main...HEAD`) e/ou `surfaces`
  explícitas.
- Mapeamento superfície → globs no perfil de alvo (T1.1).
- Ordem: (1) itens cuja superfície bate com os arquivos alterados; (2) itens que falharam nas
  últimas N execuções; (3) maior severidade; (4) o restante.
- Sequencial por padrão (obrigatório para sessão única), com `--fail-fast` opcional.
- `scrapforai vault run --impact --changed-files <arquivo|->`.
- O relatório mostra **por que** cada item entrou em cada posição.

**Aceite:**
- [ ] Com `changedFiles` tocando a superfície X, os itens de X rodam primeiro (teste)

### T2.4 — Guard executável no ledger do NPDev · M · `[cross-repo]`

**Por quê:** achado A4.

**Proposta para o repositório NPDev:**
- Novo `guard.kind: routine` com `ref: scrapforai:<ITEM-ID>`.
- Resolução em `check-done-item-guards.py`, em três níveis:
  1. **Offline (default no gate):** o item existe num export do cofre versionado no próprio repo
     NPDev (`ledger/scrapforai-vault.json`, gerado por `scrapforai vault export`), tem
     `provenRed` ou uma razão válida, e `firstGreen` não é nulo.
  2. **Frescor:** o `lastRun` GREEN tem no máximo `maxAgeDays` (configurável) — vale como alerta,
     não como erro.
  3. **Execução (`--execute`):** roda `scrapforai vault run <ID> --json` e exige saída 0.
- Assim o gate não passa a exigir um browser rodando para tudo, mas a prova deixa de ser uma
  frase.

**Entregáveis (lado ScrapForAI):** `vault export`, `vault show --json` e a documentação do
contrato da CLI (`cliSchema`).

### T2.5 — Migração das provas expiradas · P

**Passos:**
1. Listar os 7 itens e 15 job IDs (`grep -E "job_[A-Za-z0-9_-]{6,}" ledger/items/*.yml`).
2. Para cada item: recriar a rotina a partir do `detail` do ledger e passá-la pelo fluxo da T2.2,
   **ou** reclassificar honestamente o guard como `manual`, com nota de que a evidência expirou.
3. Registrar a migração no próprio ledger. `[cross-repo]`

### T2.6 — Manifesto assinado e cadeia de hashes · M

**Por quê:** clientes de governo e bancos pedem evidência de teste para homologação. Hoje isso é
print colado em Word.

**Especificação:**
- Chave Ed25519 da instalação em `<dataDir>/signing/` (`node:crypto`, sem dependência), com
  `keyId` = fingerprint da chave pública.
- Toda evidência **fixada** recebe um `manifest.json` assinado
  ([Apêndice A](#a8-manifesto-de-evidência)), que inclui `previousManifestSha256`. Isso forma uma
  cadeia: remover ou alterar uma evidência no meio quebra a cadeia.
- `scrapforai evidence verify <dir|jobId>` verifica hashes, assinatura e cadeia.
- `scrapforai evidence export <jobId>` gera um `.zip` com a evidência, o manifesto e a chave
  pública.
- **Documentar o que a assinatura prova:** integridade e origem (esta instalação produziu
  exatamente isto). Ela **não** prova que o teste está correto.

**Aceite:**
- [ ] Alterar 1 byte de um screenshot → `verify` falha apontando o arquivo (teste)
- [ ] Remover um manifesto do meio da cadeia → `verify` detecta (teste)

### T2.7 — Relatório de homologação (HTML/PDF) · M

**Especificação:**
- `src/reports/`: template HTML com cabeçalho (sistema, ambiente, build, data, executor), resumo
  do veredito, steps com screenshots, tempos, console e rede resumidos, e o rodapé com `keyId` e o
  hash do manifesto.
- PDF gerado pelo próprio Chromium (`page.pdf`), sem dependência nova.
- i18n pt/es/en.
- `scrapforai report <jobId|suiteRunId> --format pdf --lang es`.

### T2.8 — UI e MCP do cofre · M

- Tela "Cofre" na UI: lista de itens, status, último resultado, links para a evidência RED/GREEN
  e botão "rodar por impacto".
- MCP: `vault_list`, `vault_show`, `vault_run`.

### 🚦 Portão G1

Seguir para as próximas fases somente se, após **4 semanas de uso real**:
- o cofre tiver ≥ 15 itens ativos;
- ≥ 1 regressão tiver sido pega pelo cofre antes de chegar ao ambiente compartilhado;
- itens novos do ledger do NPDev estiverem usando `kind: routine`.

Se não: investigar o motivo (atrito de uso? ninguém lembra de rodar?) antes de construir mais.

---

# Fase 3 — Tempo e histórico

**Objetivo:** cada execução vira um ponto numa série, e a série começa a responder perguntas.
**Duração estimada:** 3–4 semanas.

### T3.1 — Contexto de build · M

> **Implementada em 2026-11-03**, depois de o usuário autorizar seguir além do G1 (ver AGENTS.md, "Build context"). A sonda roda no fim
> da execução, no mesmo contexto do navegador. Resultado e `runSummary` ganharam `buildId` e `buildIdSource` (`provided`/`probe`/`unknown`).

**Por quê:** sem saber *qual build* foi testado, não há bisect, System Evolution nem relatório de
homologação útil.

**Especificação:**
- Sonda `buildInfo` no perfil de alvo, de um destes tipos: `httpHeader` (nome do header),
  `selectorText` (por exemplo, a versão no rodapé), `jsonEndpoint` (URL allowlisted + caminho
  JSON) ou `provided` (vem na requisição/CLI, por exemplo do CI).
- O resultado e o `runSummary` ganham `buildId`. Quando a sonda falha, registra `unknown`; isso
  nunca derruba a execução.

### T3.2 — Agendador · G

> **Implementada em 2026-11-03** (`src/scheduler/`, ver AGENTS.md, "Scheduler"). Parser de cron próprio com tabela de casos e testes de horário de verão; sobreposição vira `skipped-overlap`; no
> máximo uma recuperação por lacuna (as demais ocorrências viram uma entrada `missed` com contagem); `evaluate`/`watch` recusados em execuções agendadas (também via include e em suítes) salvo
> `SCHEDULED_ALLOW_EVALUATE`. **`SCHEDULER_ENABLED` é `false` por padrão.** Alvos: rotina, suíte, cofre e snapshot de evolução. Não feito: tela na UI (T3.7), nova tentativa (T3.5), notificações (T3.3).

**Especificação:**
- `src/scheduler/`, com a entidade `Schedule` ([Apêndice A](#a9-agendamento)): `cron` de 5
  campos, fuso (default `America/Montevideo`), alvo (`routineId`, `suite`, `vaultTag` ou
  `evolutionSnapshot`), `enabled`, política de sobreposição (`skip`) e `jitterSeconds`.
- Parser de cron **próprio** (~150 linhas, com testes), para evitar dependência (D5, §12).
- Ao iniciar, executa **no máximo uma** recuperação por agendamento perdido.
- Execuções agendadas nunca usam `evaluate`/`watch`, a menos que `SCHEDULED_ALLOW_EVALUATE=true`.
- **Limitação honesta:** um agendador dentro de um processo que roda na máquina do dev só funciona
  enquanto o processo estiver de pé. Opções (D5): registrar uma tarefa no Agendador de Tarefas
  do Windows via instalador (`schtasks`) chamando a CLI, ou rodar o servidor em Docker num host
  sempre ligado.

**Aceite:**
- [ ] Parser de cron com tabela de casos (teste)
- [ ] Sobreposição → a segunda execução é pulada e registrada (teste)

### T3.3 — Notificações por webhook · M

> **Implementada em 2026-11-03** (`src/integrations/`, ver AGENTS.md, "Webhook notifications"). Presets generic/Slack/Teams/Google Chat; só transições (verde→vermelho, vermelho→verde) e resumo diário
> opcional; a URL fica no cofre de credenciais (`webhook-<id>`) e nenhuma leitura a devolve; egress por `ALLOWED_NOTIFY_ORIGINS` (conferido ao salvar e a cada envio, sem seguir redirecionamentos);
> redação + verificação final antes de sair (teste com segredo sentinela). **Não feito:** o detector de PII (T7.8 ainda não existe), links para o relatório, edição na UI, notificação de execuções
> que não vêm de um agendamento.

- Webhook genérico com presets para Teams, Slack e Google Chat.
- Dispara **só em transições** (verde→vermelho, vermelho→verde) e num resumo diário opcional.
  Nunca a cada execução.
- URLs de webhook ficam no cofre de credenciais (são segredos).
- Egress restrito por `ALLOWED_NOTIFY_ORIGINS`.
- O payload passa pela redação e pelo detector de PII (T7.8, quando existir) antes de sair.

### T3.4 — Série temporal de desempenho · M

- `<dataDir>/metrics/<routineId>.jsonl` com `{ jobId, at, buildId, steps: [{ id, durationMs }] }`.
  O `durationMs` por step já é medido hoje.
- Baseline = mediana das últimas 20 execuções verdes do mesmo step.
- Alerta quando a mediana das últimas 3 passa de `baseline × 1.3` (configurável).
- UI: sparkline por rotina e por step, com marcação de troca de build.

### T3.5 — Flakiness e quarentena · M

- Score = transições de estado / execuções, numa janela de 20.
- Em execuções agendadas: 1 nova tentativa automática em caso de falha. As duas execuções ficam
  registradas, porque a nova tentativa nunca esconde a falha.
- Acima do limiar → sugestão de `quarantined`. Rotinas em quarentena rodam, mas não afetam o
  veredito da suíte e aparecem num bloco separado do relatório.

### T3.6 — Bisect de regressão · G

**Especificação:**
- Na transição verde → vermelho, localizar o último verde e o primeiro vermelho e comparar seus
  `buildId`.
- Interface `ChangeSource` com adaptadores:
  1. **git** (`git log <a>..<b> --name-only`), quando o build mapeia para commits;
  2. **NPDev**: diff do `model.json` entre os dois builds; `[cross-repo]` para expor isso;
  3. **GeneXus Server**: *spike* para investigar como obter os objetos alterados entre revisões.
- Cruzar os arquivos/objetos alterados com o mapa de superfícies → lista ordenada de suspeitos,
  anexada à notificação e ao bug report (T9.1).
- **Bisect por reexecução** (rodar contra builds intermediários) só quando o perfil declarar um
  `buildArchive`. Na prática isso é raro; o padrão é um "bisect por evidência".

### T3.7 — Painel de saúde · M

UI por perfil de alvo: último estado de cada rotina, tendência, flaky, alertas de desempenho,
estado do cofre e próximos agendamentos.

---

# Fase 4 — System Evolution

**Objetivo:** tornar visível como o sistema evolui, release a release. Inclui a "Deriva de UI":
a deriva detecta, a pasta guarda e mostra.
**Duração estimada:** 3–4 semanas.

### T4.1 — Motor de diff estrutural e normalizadores · G · `[compartilhado]`

> **Implementada em 2026-11-03** (`src/diff/`, ver AGENTS.md, "Structural diff"). Entrega o motor, os normalizadores GeneXus (sufixo de linha de grid, prefixo de web
> component), máscaras, tolerância numérica e `ignorePaths`, configuráveis em `targetProfile.diff`. Os consumidores T6.3 e T7.5 ainda não existem.

**Usado por:** F4, T6.1, T6.3, T7.5.

**Especificação:**
- `src/diff/structuralDiff.ts`: compara JSON **por identidade** (chave declarada, por exemplo
  `field.key`), não por índice de array. Assim, reordenar não vira mudança.
- Pipeline de normalizadores, configurável por perfil: máscara de IDs dinâmicos (regex), remoção
  de sufixos de linha de grid GeneXus (`_0001`), mapeamento de prefixos de web component
  (`W0012`), tolerância numérica, listas de ignorados.
- Saída `ChangeSet`: `added`, `removed`, `changed[{ path, before, after }]`, cada um com um texto
  curto legível.

**Aceite:** fixtures com casos de reordenação, IDs dinâmicos e linhas de grid (testes).

### T4.2 — Catálogo de telas · M

> **Implementada em 2026-11-03** (ver AGENTS.md, "Direct-URL probing" e "System evolution snapshots"). O catálogo (`screens`) veio com a T6.2; esta entrega o prompt MCP
> `propose_screen_catalog` (descoberta assistida: o agente propõe, um humano aprova via `PUT /v1/targets/:id`). **Não feito:** gerar o
> catálogo a partir do modelo NPDev (depende da T8.5).

- `screens` no perfil de alvo: `{ id, name, reach: { routineId } | { url }, credentialSet? }`.
- Descoberta assistida: um prompt MCP orienta o agente a navegar via `inspect_dom` e **propor** um
  catálogo; um humano aprova.
- Para NPDev: gerar o catálogo a partir do modelo (T8.5).

### T4.3 — Inventário semântico · M

> **Implementada em 2026-11-03** (`src/inventory/`, ver AGENTS.md, "Screen inventory"). `inspect_dom` ganhou `includeStructure`; o step `captureInventory` lê o
> mesmo dentro de uma sessão autenticada. Nenhum valor é lido (provado por smoke com valores semeados). A chave é genérica; a T8.3 a torna
> GeneXus.

**Especificação:**
- `ScreenInventory` derivado do `inspect-dom`
  ([Apêndice A](#a10-inventário-de-tela)): campos (`key`, rótulo, tipo, obrigatório, habilitado,
  visível, `maxLength`, opções de select), ações (botões e links) e grids (colunas).
- **Exclui valores por desenho:** o inventário descreve a estrutura, nunca dados. Isso reduz ruído
  e risco de PII.
- A derivação da `key` é genérica aqui e passa a entender GeneXus na T8.3.

### T4.4 — Snapshot de evolução versionado em git · M

> **Implementada em 2026-11-03** (`src/evolution/`, ver AGENTS.md, "System evolution snapshots"). Inventário + screenshot por tela, `snapshot.json` com sha256, commit
> em git via `child_process`, idempotente por build, tudo-ou-nada. **Não feito:** `perf.json` (T3.4), resumo de acessibilidade (T7.5) e a
> matriz de permissões dentro do snapshot: esses produtores não existem ou não estão ligados.

**Especificação:**
- `scrapforai evolution snapshot <target>`: para cada tela do catálogo, grava inventário +
  screenshot, mais `perf.json` (da T3.4) e, quando existirem, o resumo de acessibilidade (T7.5) e a
  matriz de permissões (T6.1).
- Destino: `SYSTEM_EVOLUTION_DIR/<target>/<AAAA-MM-DD>_<buildId>/`.
- Se o diretório for um repositório git, faz commit com o `buildId` na mensagem (via
  `child_process`, sem dependência).
- Idempotente: o mesmo `buildId` não gera um snapshot novo sem `--force`.
- Opção `--no-screenshots` para ambientes com dados reais.

### T4.5 — `CHANGES.md` determinístico + narrativa do agente · M

> **Implementada em 2026-11-03** (`src/evolution/compare.ts`, `evolutionService.ts`). `GET /v1/evolution/:target/diff`, `POST .../changes` grava o `CHANGES.md` ao lado do
> snapshot novo; a ferramenta MCP `evolution_diff` devolve o diff e, com `narrative`, grava a seção rotulada "AI-generated summary, not
> verified". O texto determinístico está em inglês; a localização (pt/es) como nos relatórios ficou para depois.

- **Seção determinística** gerada do `ChangeSet`: "Tela Cliente: + campo Telefone (texto,
  opcional); − botão Exportar; campo CEP agora obrigatório".
- **Seção narrativa opcional**, escrita pelo agente cliente via a ferramenta MCP `evolution_diff`
  e rotulada como "resumo gerado por IA" (princípio P7: o servidor não chama LLM).

### T4.6 — Linha do tempo e consultas · M

> **Implementada em 2026-11-03** **parcialmente**: `GET /v1/evolution/:target/timeline`, `scrapforai evolution timeline` e a ferramenta MCP `evolution_query` ("quando
> apareceu o campo X?", por tela, por data). **Não feito:** a linha do tempo na UI web. "Entre os builds A e B" é o `evolution_diff`.

- UI: linha do tempo por tela (quando cada campo e ação apareceu, mudou ou sumiu).
- MCP `evolution_query`: "quando apareceu o campo X?", "o que mudou na tela Y entre os builds A e
  B?", "quais telas mudaram no último mês?".
- Serve também como memória consultável para agentes que trabalham no sistema.

### T4.7 — Mudanças esperadas × inesperadas · M

> **Implementada em 2026-11-03** (`expected-changes` em `<target>/expected/<build>.json`, `PUT /v1/evolution/:target/expected/:buildId`). `scrapforai evolution diff`
> sai com 1 quando o build declarou suas mudanças e houve outras. **Não feito:** derivar as esperadas dos itens fechados do ledger.

- Um release pode declarar as mudanças pretendidas: `expected-changes.json` por build, ou
  derivado dos itens do ledger fechados no período.
- O diff classifica cada mudança como **esperada** ou **inesperada**, e as inesperadas viram
  alerta. É assim que se pega o "mexi numa tela e quebrei outra".

---

# Fase 5 — Dados e perfil funcional

**Objetivo:** testar cálculos e regras com volume, rapidez e reprodutibilidade.
**Duração estimada:** 3–5 semanas.

### T5.1 — Camada de roteamento de rede · M · `[compartilhado]`

> **Implementada em 2026-11-03** (`src/runner/routing.ts`, ver AGENTS.md, "Network routing"). Entrega a guarda de allowlist
> (`BLOCK_UNEXPECTED_RESOURCES`, fecha o achado A7) e os encaixes `faults` (T7.2) e `resources` (T5.2), que ainda não existem.

**Usado por:** T5.2, T7.2, T7.8.

**Especificação:**
- `src/runner/routing.ts`: um único `context.route('**/*')` que compõe políticas nesta ordem:
  1. **guarda de allowlist**: requisições a origens fora da allowlist seguem o comportamento
     atual (reportadas), ou são **bloqueadas** quando `BLOCK_UNEXPECTED_RESOURCES=true`. Isso
     fecha a lacuna do achado A7;
  2. injeção de falhas (T7.2);
  3. política de recursos (T5.2);
  4. `continue`.
- Toda requisição tocada por uma política recebe `handledBy` na evidência.
- Requisições bloqueadas por política **não** entram em `networkFailures`.

**Aceite:**
- [ ] Com `BLOCK_UNEXPECTED_RESOURCES=true`, um recurso de origem não allowlisted é abortado e reportado (teste)
- [ ] Sem políticas ativas, o comportamento é idêntico ao atual (teste de regressão)

### T5.2 — Perfil funcional · P

> **Implementada em 2026-11-03, com o benchmark pendente.** Código e testes prontos (ver AGENTS.md, "Functional profile"). **O critério
> de aceite ainda não está cumprido:** falta rodar 3 rotinas reais × 10 execuções em cada perfil contra o WmsOffice e publicar os números
> aqui. O script está pronto: `npm run bench:profile -- <rotina> <rotina> <rotina> --runs 10` (servidor no ar, rotinas salvas); ele sai
> com 1 se algum resultado de step diferir entre os perfis e imprime a tabela para colar neste arquivo. O smoke com fixture local já
> prova "nenhuma mudança de resultado nos steps" num caso controlado.

**Especificação:**
- `options.profile: 'full' | 'functional'` (default `full`), mais um `options.resourcePolicy`
  para ajuste fino.
- `functional`: imagens respondem com um **PNG 1×1 transparente** (não `abort`, para que `onload`
  dispare e ícones clicáveis do GeneXus continuem existindo), mídia com 204, fontes com 204;
  screenshots e trace desligados.
- **CSS nunca é bloqueado**, porque a visibilidade no Playwright depende dele. O schema recusa
  `stylesheet` na lista.
- **Benchmark obrigatório:** 3 rotinas reais × 10 execuções em cada perfil. Publicar os números em
  `docs/`. **Critério de aceite: nenhuma mudança de resultado nos steps.** O ganho de tempo é
  medido, não prometido; contra servidor local, ele pode ser pequeno.

### T5.3 — Parâmetros e geradores de valores · G

> **Implementada em 2026-11-03, em duas partes** (`src/generators/`, `src/schemas/parameters.schema.ts`, ver AGENTS.md, "Parameters and generators").
> Parte 1:
> `parameters` (geradores `int`, `decimal`, `date`, `string` com os charsets `alpha|alnum|unicode|hostile`, `oneOf`, ou `cases`),
> `valueFromParameter` e `valueFromGenerator` (açúcar), bordas primeiro, `seed` reproduzível, `sample`, e `result.parameters`.
> Parte 2: o gerador `document` (`ci-uy`, `rut-uy`, `cpf`, `cnpj`, válidos ou com o último dígito errado), a marca `synthetic` em `result.parameters` e nos relatórios
> (en/pt/es), uma seção "Dados de teste" no relatório e parâmetros próprios em rotinas incluídas (renomeados `<include>_<nome>`).
> **Atenção:** os algoritmos de dígito verificador são os públicos e padrão; os vetores de teste são números conhecidos (CPF 529.982.247-25, CNPJ 11.222.333/0001-81,
> CI 1.234.567-2, RUT 215521750017). Não foram conferidos contra um validador oficial do órgão emissor.

**Especificação** ([Apêndice A](#a6-parâmetros-e-geradores)):
- A rotina declara `parameters: [{ name, generator | cases }]`, e os steps usam
  `valueFromParameter`. Um `valueFromGenerator` inline é açúcar sintático para um parâmetro
  implícito.
- Geradores: `int`, `decimal` (com escala), `date` (faixa e formato), `string` (tamanho e
  charset: `alpha`, `alnum`, `unicode`, `hostile`, este último com aspas, `<script>`, emoji e
  RTL), `oneOf`, `document` (`ci-uy`, `rut-uy`, `cpf`, `cnpj`; válidos ou inválidos, com dígito
  verificador correto ou propositalmente errado).
- **Valores de borda sempre primeiro:** `min`, `min-1`, `max`, `max+1`, zero, negativo, vazio e o
  tamanho máximo.
- **Seed** por execução, registrada no resultado. Os valores gerados aparecem em
  `result.parameters` (não são segredos).
- Documentos gerados são sintéticos, mas um CI "válido" pode coincidir com o de uma pessoa real.
  Por isso, usar só em ambientes de dev/QA e marcar como `synthetic` nos relatórios.

### T5.4 — Execução paramétrica · M

> **Implementada em 2026-11-03** (`src/orchestrator/suiteRunner.ts`, ver AGENTS.md, "Samples (T5.4)"). `samples` e `seed` na **suíte** (não em uma execução
> avulsa: lá já existem `seed` + `sample` do T5.3). Só rotinas paramétricas se multiplicam; a tabela parâmetros → status → extraídos fica no estado de cada variante
> e é impressa pelo CLI. Não feito: combinações cartesianas de vários parâmetros e a tabela no relatório.

- `samples: N` e `seed` na execução ou na suíte. O orquestrador (T1.6) expande em N execuções:
  bordas primeiro, depois aleatórias.
- Para velocidade, combina com o perfil funcional (T5.2).
- Resultado: tabela parâmetros → status → valores extraídos.

### T5.5 — Oráculo de fórmulas · M

> **Implementada em 2026-11-03, sem as tabelas CSV** (`src/oracle/`, ver AGENTS.md, "Formula oracle"). Feito: `assertEquals` com `expr` ou `value`, parser próprio sem `eval`
> (`+ - * / ^`, comparações, `round`, `floor`, `ceil`, `min`, `max`, `abs`, `if` preguiçoso), localidade `en`/`pt`/`es`, tolerância absoluta/relativa, variáveis de parâmetros e
> extraídos, fórmulas de rotinas incluídas acompanhando o renome. **Pendente:** `expected: { table: 'casos.csv' }` (tabelas guardadas na biblioteca).

**Por quê:** testar "o cálculo está certo" exige saber o resultado esperado para cada entrada
gerada.

**Especificação:**
- Step `assertEquals { actual: { extracted: 'total' }, expected: { expr: 'round(price * qty * (1 + tax), 2)' } | { table: 'casos.csv' }, tolerance? }`.
- Linguagem de expressão **própria e segura**: números, `+ - * / ^`, parênteses, `round`,
  `floor`, `ceil`, `min`, `max`, `abs`, `if(cond, a, b)` e variáveis vindas de parâmetros e
  extraídos. **Sem `eval`**: parser próprio com testes.
- Tabelas de casos em CSV guardadas na biblioteca.
- Parsing de números com localidade configurável (`1.234,56` × `1,234.56`).

### T5.6 — Shrinking · G

> **Implementada em 2026-11-03** (`src/shrink/`, ver AGENTS.md, "Shrinking"). `POST /v1/shrinks` (assíncrono), MCP `shrink_failure`/`get_shrink_result`, CLI `scrapforai shrink`. Aceite
> cumprido em `test/shrink.test.ts` e `test/shrink.smoke.ts` (Chromium real): bug em qty >= 1000, "falha com 1000, passa com 999". "Salvar no cofre" = `vault add-from-run` com o
> `minimalJobId` e `type: SCENARIO` (parâmetros fixados via `parameterValues`). Não feito: botão na UI web e shrinking automático dentro da suíte.

**Especificação:**
- Quando uma amostra falha, o sistema busca a **entrada mínima que ainda falha**:
  - numérico: busca binária entre o último valor bom conhecido e o que falhou;
  - string: corte pela metade, depois remoção caractere a caractere;
  - vários parâmetros: *delta debugging* (ddmin).
- Orçamento: `maxShrinkRuns` (default 30) e um tempo máximo.
- Saída: "falha com `qty=1000000`, passa com `qty=999999`", mais a seed e um botão/comando
  **"salvar no cofre"**, que cria um item `SCENARIO` com os parâmetros fixados (T2.2).

**Aceite:** fixture com um bug de limite conhecido; o shrinking encontra o limite exato (teste).

### T5.7 — Modo HTTP para regras de servidor (opcional) · M

- Step `httpRequest { method, url, body?, extract }` usando `context.request`, que **compartilha
  os cookies da sessão logada**. Mesma allowlist; métodos permitidos configuráveis por perfil.
- Serve para testar cálculos de servidor com alto volume, sem UI.
- **Ressalva honesta:** em GeneXus, muitas chamadas são AJAX com estado (`GXState`, tokens),
  difíceis de reproduzir fora da página. Isso é prático para os endpoints REST do NPDev (ver o
  item MON-13 do ledger), não necessariamente para GeneXus.

### 🚦 Portão G2

Após a trilha recomendada até o item 8 (§0.5): o valor interno está comprovado? Existe ao menos
**uma empresa externa disposta a um piloto**? Se não houver piloto, as fases 6–9 seguem só pela
demanda interna medida, e a Fase 10 fica fora do horizonte.

---

# Fase 6 — Multiplicação

**Objetivo:** uma rotina testa muitos papéis, muitos ambientes e muitos usuários ao mesmo tempo.
**Duração estimada:** 4–6 semanas.

### T6.1 — Matriz de permissões · G · *pode ser antecipada (depende só da Fase 1)*

> **Implementada em 2026-11-03, antecipada antes do G1** (`src/permissions/`, ver AGENTS.md). Diferenças em relação ao texto
> abaixo, por dependerem de tarefas que ainda não existem: a sonda `control` recebe a `url` da tela (o catálogo T4.2 não
> existe; `screen` é só um rótulo); o diff é contra a **execução anterior** da mesma matriz (não contra o release anterior via
> T4.1); o login é uma `loginRoutine` explícita (T8.1 não existe). O snapshot de evolução (T4.4) fica para quando ele existir.

**Especificação:**
- Definição ([Apêndice A](#a7-matriz-de-permissões)):
  - **papéis** = conjuntos de credenciais (T1.2);
  - **sondas**: `url` (acessar a URL diretamente), `control` (em tal tela, tal seletor deve estar
    visível/oculto/habilitado/desabilitado) e `action` (rodar tal rotina deve terminar em
    sucesso/negado);
  - **expectativa** opcional por papel × sonda.
- Detecção de "negado" configurável por plataforma: redirecionamento para login do GAM, página
  "não autorizado", marcador de texto, status HTTP.
- Execução: variantes papel × sonda via orquestrador, respeitando a sessão única.
- Saída: tabela papel × sonda (permitido/negado/erro), diff contra a expectativa e **diff contra o
  release anterior** (T4.1). "O papel Vendedor ganhou acesso a Configurações" vira alerta.
- Entra no snapshot de evolução (T4.4).

### T6.2 — Sondagem de acesso direto por URL · M

> **Implementada em 2026-11-03, antecipada antes do G1** (ver AGENTS.md, "Direct-URL probing"). Diferenças: o catálogo T4.2 ainda não
> existe, então `screens` do perfil ganhou uma forma mínima (`id`, `name`, `reach: { url } | { routineId }`, `offeredTo`) escrita à mão;
> "o que o menu oferece" é a lista `offeredTo` (papéis), não uma leitura do menu real; telas só alcançáveis por rotina não são sondadas.

- Para cada tela do catálogo (T4.2) e cada papel: tentar a URL diretamente, sem passar pelo menu.
- Alerta quando um papel **chega a uma tela que o menu não oferece a ele**. É o tipo clássico de
  falha de autorização que o teste manual não pega.

### T6.3 — Execução diferencial · G

**Especificação:**
- A mesma rotina contra dois perfis de alvo: dev × staging, gerador Java × .NET, GeneXus 17 × 18,
  antes × depois de um deploy.
- Comparação via T4.1:
  - status de cada step;
  - valores extraídos (com tolerância);
  - erros de console **novos**;
  - forma da rede: método + padrão de caminho (IDs mascarados) + status;
  - razão de tempo por step.
- Diff visual **opcional e adiado** (D6, §12). O semântico vem primeiro (princípio P6).
- Caso de uso principal: **migração de versão do GeneXus** (rodar a suíte inteira nas duas versões
  e listar só as diferenças).

### T6.4 — Runner multi-contexto (atores) · G

**Por quê:** achado A8.

**Especificação:**
- `actors: { [nome]: { credentialSet?, viewport? } }` na rotina. Sem `actors`, existe um ator
  implícito `main`, o que garante compatibilidade total.
- Cada ator ganha seu próprio `BrowserContext` (cookies isolados) dentro do mesmo `Browser`.
- `baseStep` ganha `actor?`. Evidências (console, rede, screenshots) são separadas por ator.
- Refatoração do [runExploration.ts](../src/runner/runExploration.ts): substituir o uso direto de
  `playwright.page` por `actors.get(step.actor ?? 'main').page`.

**Aceite:** toda a suíte de testes atual passa sem alteração (regressão), mais um smoke com 2 atores.

### T6.5 — Sincronização e corridas entre atores · M

- Passos que alternam atores rodam em sequência (o comportamento natural).
- Step `parallel { branches: [[steps do ator A], [steps do ator B]] }` executa os ramos ao mesmo
  tempo (`Promise.all`), para provocar corridas de verdade, como duplo submit ou edição simultânea.

### T6.6 — Cenários de concorrência prontos · M

Rotinas-modelo na biblioteca (status `draft`, para adaptar):
- **edição simultânea** do mesmo registro (espera a mensagem de bloqueio otimista);
- **duplo submit** (espera um único registro criado);
- **sessão única** (o segundo login derruba o primeiro, conforme as convenções §2);
- **fluxo de aprovação** (um ator envia e outro aprova; GXflow ou equivalente NPDev).

---

# Fase 7 — Robustez e qualidade

**Duração estimada:** 4–6 semanas.

### T7.1 — Scripts confiáveis embutidos · M · `[compartilhado]`

**Usado por:** T7.4, T7.6, T7.8, T8.2, T9.2.

**Especificação:**
- `src/runner/trusted/`: registro `{ id, arquivo, sha256 }` de scripts **do próprio projeto**,
  injetados por steps dedicados.
- **Não** passam por `ALLOW_EVALUATE`, que continua existindo para código vindo do chamador. O
  chamador escolhe um `id`; nunca envia código.
- Hash verificado no boot. Se divergir, o servidor não inicia.
- Limites de tempo e tamanho de saída; saída sempre redigida.

### T7.2 — Caos controlado · M

- Step `injectFault { match: { urlContains, method? }, fault: { status, body? } | { delayMs } | { abort: 'failed' | 'timedout' } | { malformedJson: true }, times?, untilStep? }`, via T5.1.
- Só em origens allowlisted; cada requisição afetada é marcada `handledBy: 'fault'` na evidência.
- Asserts de apoio: `assertNoTextMatches` (padrões de stack trace e exceção vazando na tela) e
  `assertVisible` da mensagem de erro esperada.
- Rotinas-modelo: "API de salvar retorna 500", "busca demora 10 s", "resposta JSON corrompida".
- Proibido em perfis `staging` sem `allowFaults: true`.

### T7.3 — Relógio falso · P

- Step `setClock { fixedTime } | { installAt, fastForwardMs? }`, usando `page.clock` do
  Playwright.
- **Limitação documentada:** só afeta o relógio do browser. Regras de data do GeneXus rodam quase
  sempre no servidor.
- Gancho opcional `serverClock` no perfil, para apps que expõem um endpoint de data **somente em
  dev**. Sugerir ao NPDev um endpoint assim. `[cross-repo]`

### T7.4 — Auditoria de acessibilidade (axe) · M

- Dependência `axe-core`, mediante a decisão D7 (licença MPL-2.0; checar compatibilidade com a
  distribuição).
- Step `auditAccessibility { scope?, standard: 'wcag2a' | 'wcag2aa' | 'wcag21aa' | 'wcag22aa', rules? , failOn: 'none' | 'new' | 'serious' | 'any' }`, com default `failOn: 'none'`.
- Saída normalizada: `{ ruleId, impact, targetKey, help, wcag }`, com `targetKey` normalizado
  (T4.1) para permitir comparação entre releases.

### T7.5 — Baseline e diff de acessibilidade · M

- O baseline por tela fica no snapshot de evolução (T4.4).
- O relatório mostra **novas** e **corrigidas** desde o baseline, não a lista completa. Num app
  legado, a lista completa tem centenas de itens e ninguém age sobre ela; o diff é acionável.
- `failOn: 'new'` permite bloquear só a regressão.

### T7.6 — Navegação por teclado · M

**Por quê:** o axe não testa teclado.

**Especificação:**
- Step `keyboardWalk { startSelector?, maxTabs: 200 }`: aperta Tab repetidamente e registra a
  ordem de foco `[{ key, role, name, focusVisible }]`.
- Detecta:
  - controles interativos do inventário (T4.3) que **nunca recebem foco**;
  - **armadilhas de foco** (ciclo que não chega ao fim);
  - **foco invisível**, por heurística (script confiável que compara os estilos computados com e
    sem foco: `outline`, `box-shadow`, `border`).

### T7.7 — Tradução das violações para GeneXus/NPDev · P

- `docs/a11y-platform-mapping.md`: regra → o que ajustar na plataforma (por exemplo, "falta
  rótulo" → propriedade de rótulo/caption do controle; "contraste" → classe do tema).
- O relatório anexa a orientação a cada violação.

### T7.8 — Caçador de PII · G

**Especificação:**
- `src/security/piiDetectors.ts`, reaproveitando a infraestrutura de redação: CI-UY, RUT-UY, CPF,
  CNPJ (com dígito verificador), cartão (Luhn), e-mail, telefone UY, JWT, bearer, formatos de chave
  de API e os valores conhecidos do cofre.
- Superfícies varridas:
  - URLs de **todas** as requisições (query e fragmento);
  - console e erros de página;
  - `localStorage`/`sessionStorage` (via script confiável);
  - cookies com token sem `HttpOnly`;
  - corpos de resposta de requisições **sem autenticação** (com limite de tamanho; só JSON/HTML);
  - inputs ocultos.
- Achado: `{ detector, superfície, local, amostraMascarada, sha256, severidade }`. **O valor bruto
  nunca é armazenado.**
- `options.piiScan: true` ou step `scanForPii`.

### T7.9 — Supressões e severidade · P

- Supressões por perfil (por exemplo, "o e-mail do usuário logado na tela de perfil é esperado"),
  com motivo e **data de expiração** obrigatórios.
- Política de severidade por detector e superfície (token em URL = alta; e-mail em tela autenticada
  = informativa).

---

# Fase 8 — GeneXus e NPDev

**Objetivo:** o diferencial que nenhuma ferramenta genérica vai construir.
**Duração estimada:** 6–10 semanas (inclui spikes de pesquisa).

### T8.1 — Plataforma no perfil de alvo · M

Com `platform: 'genexus'`:
- filtro de ruído automático: `net::ERR_ABORTED` causado por redirects `top.location` (convenções §3);
- `loginRoutine` do perfil incluída automaticamente via `include` (T1.4), com o *login gate* (convenções §1);
- lock de sessão única por credencial (T1.6) ligado por padrão.

Com `platform: 'npdev'`: as regras equivalentes, levantadas junto com o time do NPDev. `[cross-repo]`

### T8.2 — Espera por quietude de rede (+ sinais GX) · M

**Por quê:** `networkidle` é frágil, e esperas fixas (`waitForTimeout`) são a principal fonte de
lentidão e flakiness.

**Especificação:**
- Script de init confiável que conta requisições XHR/fetch pendentes (genérico e útil para
  qualquer app).
- Condição de espera `{ quiet: { idleMs: 300, timeoutMs } }`: nenhuma requisição pendente por
  `idleMs`.
- **Spike GeneXus:** investigar se o runtime JS do GeneXus (gerador Java e .NET) expõe um
  indicador confiável de "ocupado". Se sim, combiná-lo com o contador; se não, ficar só com o
  contador.

### T8.3 — Seletores semânticos · G

**Especificação:**
- Seletor-objeto `{ gx: { name: 'CLIENTENOME', kind: 'variable' | 'attribute', row?: 3, component?: 'W0012' } }`, resolvido para candidatos CSS como `#vCLIENTENOME_0003`.
- **Spike obrigatório antes:** montar fixtures com páginas reais geradas (Java e .NET; GeneXus 17
  e 18) e documentar as regras de nomenclatura em `docs/genexus-dom-naming.md`. As regras deste
  plano são hipóteses até o spike confirmar.
- **NPDev:** como o NPDev é gerador próprio, a solução melhor é o gerador emitir atributos
  estáveis (por exemplo, `data-npdev-key`). Propor ao repositório NPDev (D9). `[cross-repo]`
- O inventário (T4.3) passa a usar essas chaves.

### T8.4 — Lint de rotinas (convenções como código) · M

- `scrapforai routine lint <arquivo|id>` e lint automático no `save_routine`.
- Regras derivadas de [genexus-routine-conventions.md](genexus-routine-conventions.md):
  - submit de login sem *login gate* em seguida → erro;
  - `waitForTimeout` fixo → aviso (sugere `quiet`);
  - rotina com login e sem teardown de logout → aviso;
  - seletor frágil (posicional, `nth-child`) quando existe um semântico → aviso.
- Saída com código de regra, para permitir supressão justificada.

### T8.5 — Domínios derivados: NPDev primeiro, depois a KB GeneXus · G

**Especificação:**
- **NPDev primeiro:** o `model.json` é de vocês e tem tipos, tamanhos e obrigatoriedade explícitos.
  O módulo lê o modelo e gera, por campo: o gerador (T5.3), os casos de borda e o mapeamento
  campo ↔ controle na tela (via chaves da T8.3).
- **GeneXus depois:** *spike* sobre o export da KB (`.xpz`, XML) para extrair atributos e domínios
  (`Numeric(10.2)`, `Character(40)`, enumerados). Um `Numeric(10.2)` vira testes com
  `99999999.99` e `100000000`.
- O catálogo de telas (T4.2) também pode ser gerado a partir do modelo/KB.

### T8.6 — Gerador de testes CRUD · GG

**Especificação:**
- Para cada conceito NPDev ou transação GeneXus: gerar a rotina **criar → consultar → editar →
  excluir** com dados válidos (T8.5), mais **uma variante inválida por campo** obrigatório ou com
  limite.
- Os modos de transação GeneXus (INS/UPD/DLT/DSP) e o formato de URL de cada modo devem ser
  **confirmados nos apps reais** antes da implementação.
- As rotinas nascem como **`draft`** na biblioteca: um humano ou o agente revisa antes de ativar.
- Rotinas destrutivas só rodam em perfis com `allowDestructive: true`. A limpeza é garantida via
  `teardown` (T1.4).
- Resultado esperado: centenas de testes de base sem ninguém escrever nenhum.

### T8.7 — Skill oficial para agentes · P

- `.claude/skills/scrapforai/SKILL.md`: quando usar cada ferramenta MCP, o fluxo recomendado, as
  convenções GeneXus/NPDev, como interpretar evidências e como transformar um bug reproduzido em
  item do cofre.
- O primeiro rascunho nasce na T0.3; aqui ele é finalizado e mantido junto do código.

---

# Fase 9 — Saídas para pessoas

**Duração estimada:** 2–4 semanas.

### T9.1 — Bug report automático · G

**Especificação:**
- Ao falhar (ou sob demanda): título, ambiente, build, a **rotina mínima** que reproduz (após o
  shrinking, quando a rotina é paramétrica), os steps, o screenshot, trechos de console e rede e
  os suspeitos do bisect (T3.6).
- **Deduplicação** por assinatura (rotina + step que falhou + tipo de erro).
- Primeiro adaptador: GitHub Issues (D8). Azure DevOps e Jira depois, por demanda.
- **Modo rascunho por padrão:** o relatório é gerado, e um humano aprova o envio. O envio
  automático é opt-in.
- Egress restrito por `ALLOWED_INTEGRATION_ORIGINS`; token no cofre; payload passa pela redação
  **e** pelo caçador de PII (T7.8) antes de sair.

### T9.2 — Manual vivo · G

**Especificação:**
- Rotinas com a tag `doc`. Os steps ganham `doc: { caption: { pt, es, en }, highlight?: selector }`.
- Antes de cada screenshot de documentação, um script confiável desenha o destaque (borda ou seta)
  no elemento.
- `scrapforai manual build <target> --lang pt,es,en` gera Markdown/HTML em `MANUAL_OUTPUT_DIR`.
- A cada release, regenerar e listar **quais figuras mudaram** (hash perceptual simples, sem
  dependência), para que quem escreve o manual revise só essas.
- O próprio manual do ScrapForAI (en/es/pt, hoje feito à mão) é o primeiro cliente.

### T9.3 — Resumo semanal · M

Agendamento (T3.2) que gera um resumo: saúde por app, regressões, flaky, alertas de desempenho,
acessibilidade nova e mudanças de evolução. Entregue por webhook (T3.3) ou como arquivo.

### T9.4 — Painel executivo · M

Visão agregada na UI, para quem não é técnico: quantos testes, quantas regressões evitadas,
tendência de qualidade e status de homologação por sistema.

---

# Fase 10 — Distribuição

**Pré-requisito:** Portão G3 (o piloto externo deu certo).

### 🚦 Portão G3

O piloto (T10.3) foi concluído com: uso semanal pela empresa piloto durante 6 semanas, ≥ 1
regressão real pega e disposição declarada de pagar (ou de manter o uso).

### T10.1 — Servidor de equipe · G

Hoje há uma única API key. Para equipe: chaves por usuário, papéis (`viewer`, `runner`, `admin`),
log de auditoria (quem rodou o quê, quem alterou perfil ou credencial) e implantação em Docker
num host sempre ligado.

### T10.2 — Pacote para empresas GeneXus · M

Modelos de perfil de alvo, a Skill (T8.7), rotinas-modelo (login GAM, Work With, prompts) e
documentação em es/pt.

### T10.3 — Piloto externo · M

Uma empresa, 6 semanas, critérios de sucesso definidos **antes** de começar e reuniões
quinzenais. Os aprendizados reordenam as fases.

### T10.4 — Modelo comercial e licenças · P

O repositório está marcado como `UNLICENSED`. Decidir (D7): licença, preço e implicações das
dependências (por exemplo, a MPL-2.0 do `axe-core`).

---

## 11. Segurança por recurso

| Recurso | Risco novo | Mitigação | Teste obrigatório |
|---|---|---|---|
| Cofre de credenciais (T1.2) | Arquivo cifrado vira alvo; chave no mesmo disco | AES-256-GCM; chave via env ou arquivo com ACL; valores somente escrita; vínculo por origem | Valor sentinela nunca aparece em nenhuma saída |
| Biblioteca (T1.3) | Rotina salva com segredo literal | Lint no save contra valores do cofre e padrões | Save recusado |
| Fila / suítes (T1.6) | Esgotamento de recursos | `MAX_PARALLEL_JOBS`, cotas por suíte, cancelamento | Fila respeita o limite |
| Evidência fixada (T1.5) | Crescimento sem limite; dados sensíveis retidos por mais tempo | Cota; trace descartado por padrão; só ambientes dev/QA | Cota estourada não apaga nada |
| Assinatura (T2.6) | Chave vazada permite falsificar | Chave separada; `keyId` no manifesto; procedimento de rotação | `verify` detecta adulteração |
| Agendador (T3.2) | Execução sem supervisão | Só rotinas `active`; sem `evaluate` por padrão; cotas | Agendada com `evaluate` é recusada |
| Webhooks e integrações (T3.3, T9.1) | **Novo egress de dados** | Allowlists de destino; redação + PII antes do envio; rascunho por padrão | Payload com segredo sentinela é bloqueado |
| Roteamento e caos (T5.1, T7.2) | Mascarar falhas reais; tocar origens externas | Só origens allowlisted; tudo marcado em `handledBy`; proibido em staging sem flag | Falha injetada aparece na evidência |
| Scripts confiáveis (T7.1) | Supply chain (`axe-core`) | Versão fixada; `sha256` verificado no boot | Hash divergente impede o boot |
| Caçador de PII (T7.8) | O relatório vira o vazamento | Só tipo, local, máscara e hash | Nenhum valor bruto em saída |
| Matriz de permissões (T6.1) | Muitas sessões com credenciais diferentes; sondas que levam a qualquer URL | Papéis só entre os `credentialSets` do perfil; URLs das sondas validadas contra a allowlist no save e no run; sessões pela fila com o lock por credencial; `probePage` só lê; ações só rotinas da biblioteca | URL fora da allowlist e papel fora do perfil recusados; nenhum valor de credencial no estado salvo |
| Multi-ator (T6.4) | Sessões cruzadas | Um `BrowserContext` por ator | Cookies não vazam entre atores |
| CRUD gerado (T8.6) | Destruição de dados | `draft` por padrão; `allowDestructive`; teardown | Rotina destrutiva recusada sem a flag |
| System Evolution em git (T4.4) | Screenshots com dados reais indo para um repositório | Inventário sem valores; `--no-screenshots`; só dev/QA | Inventário não contém valores de campos |
| Modo HTTP (T5.7) | Chamadas diretas a endpoints internos | Mesma allowlist; métodos permitidos por perfil | Método não permitido é recusado |

---

## 12. Dependências candidatas

| Pacote | Uso | Alternativa sem dependência | Recomendação |
|---|---|---|---|
| `axe-core` | Acessibilidade (T7.4) | Nenhuma realista | **Adotar** após D7 (licença MPL-2.0) |
| `croner` ou similar | Cron (T3.2) | Parser próprio de 5 campos (~150 linhas) | **Parser próprio** |
| `pixelmatch` + `pngjs` | Diff visual (T6.3) | Hash perceptual simples | **Adiar** (diff semântico primeiro) |
| `yaml` | Itens em YAML, como no ledger | JSON | **Não adotar**; o NPDev referencia por ID |
| `node:sqlite` (embutido) | Séries de alto volume | JSONL | Avaliar na T1.9 |

`node:crypto` (AES-GCM, Ed25519, SHA-256), `child_process` (git) e `page.pdf` / `page.clock` /
`context.route` do Playwright cobrem o restante sem dependências novas.

---

## 13. Cronograma estimado

Para 1 desenvolvedor com agente de IA, em semanas de trabalho focado:

| Fase | Semanas | Acumulado (trilha recomendada) |
|---|---|---|
| F0 — Decisão e higiene | 1–2 | 2 |
| F1 — Fundações | 4–6 | 8 |
| F2 — Prova permanente | 3–4 | 12 → **G1** |
| T3.1 + F4 — System Evolution | 3–4 | 16 |
| T5.1–T5.6 — Dados e perfil funcional | 3–5 | 21 |
| T6.1–T6.2 — Matriz de permissões | 2 | 23 |
| T3.2–T3.7 — Tempo e histórico | 3 | 26 |
| T7.1, T7.4–T7.7 — Acessibilidade | 2–3 | 29 → **G2** |
| Restante de F6, F7, F8, F9 | 14–22 | conforme a demanda |
| F10 | — | só após G3 |

**Leitura honesta:** o plano completo leva de 9 a 13 meses. A trilha até o G2 leva cerca de 7
meses, e a trilha mínima interna (F0 + F1 + F2) cerca de 3 meses. Os portões existem para que o
projeto possa parar em qualquer um deles **com valor entregue**.

---

## 14. Riscos

| # | Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|---|
| R1 | **Escopo:** 74 tarefas para 1 pessoa | Alta | Alto | Portões; trilha mínima; cortar sem culpa |
| R2 | Ferramentas grandes (Microsoft, Anthropic, GeneXus) lançam algo equivalente | Média | Alto | Revisão trimestral do cenário (§1.1); foco nos pilares B, C e D, que elas tendem a não cobrir |
| R3 | Detalhes internos do GeneXus mudam entre versões | Média | Médio | Spikes com fixtures por versão; camada de adaptação em `src/platforms/` |
| R4 | Falsos positivos minam a confiança (diffs, flakiness, PII) | Alta | Alto | Normalização; quarentena; supressões com expiração; métrica de ruído |
| R5 | Crescimento de armazenamento | Média | Médio | Cotas; classes de retenção; trace fora da evidência fixada |
| R6 | Limites do processo único (fila em memória, JSONL) | Média | Médio | Limiares documentados (T1.9); servidor de equipe só na F10 |
| R7 | Coordenação com o repositório NPDev | Média | Médio | Tarefas `[cross-repo]` explícitas; contrato de CLI versionado |
| R8 | Cada fase amplia a superfície de ataque | Média | Alto | §11 com teste obrigatório por linha; revisão de segurança por fase |
| R9 | **Baixa adoção:** a ferramenta existe, mas ninguém a usa no dia a dia | Média | Alto | Portão G1 mede uso real; Skill (T8.7) reduz o atrito |
| R10 | Agendador numa máquina de dev não roda quando ela está desligada | Alta | Baixo | Documentado; opção de tarefa do Windows ou Docker (D5) |

---

## 15. Métricas de sucesso

| Métrica | Hoje (T0.6) | Meta no G1 | Meta no G2 |
|---|---|---|---|
| Itens DONE do ledger com guard de browser **executável** | 0 | ≥ 10 | ≥ 30 |
| Itens ativos no cofre de regressão | 0 | ≥ 15 | ≥ 50 |
| Regressões pegas pelo cofre antes do ambiente compartilhado | — | ≥ 1 | ≥ 5 |
| Tempo "bug reproduzido" → "item no cofre" | — | < 5 min | < 2 min |
| Provas apontando para evidência inexistente | 15 | 0 | 0 |
| Taxa de flakiness das rotinas `active` | desconhecida | medida | < 3% |
| Novas violações de acessibilidade por release | desconhecida | — | medida e em queda |
| Empresas externas em piloto | 0 | — | ≥ 1 |

---

## 16. Decisões em aberto

| ID | Decisão | Opções | Quando decidir |
|---|---|---|---|
| D1 | Nome e posicionamento | Manter "ScrapForAI" internamente / renomear antes de distribuir | T0.5 |
| D2 | Armazenamento | JSON por entidade + JSONL (recomendado) / SQLite | T1.9 |
| D3 | Chave do cofre de credenciais | Variável de ambiente / arquivo com ACL / Windows DPAPI via PowerShell | T1.2 |
| D4 | Formato de itens e rotinas | JSON (recomendado) / YAML | T1.3 |
| D5 | Onde roda o agendador | No processo / Agendador de Tarefas do Windows / Docker | T3.2 |
| D6 | Diff visual | Não fazer / hash perceptual / `pixelmatch` | T6.3 |
| D7 | Licença e modelo comercial | `UNLICENSED` / comercial / open-core; compatibilidade com MPL-2.0 | Antes da T7.4 e da F10 |
| D8 | Primeiro issue tracker | GitHub Issues (recomendado) / Azure DevOps / Jira | T9.1 |
| D9 | NPDev emitir atributos estáveis (`data-npdev-key`) | Sim (recomendado) / não | T8.3, no repositório NPDev |
| D10 | Manter o `evaluate` genérico | Manter atrás da flag / reduzir conforme os scripts confiáveis cobrem os casos | Após a T7.1 |

---

## Apêndice A — Esboços de schema

Os esboços são orientativos. A forma final é definida na tarefa correspondente, seguindo as
convenções de [explorationRequest.schema.ts](../src/schemas/explorationRequest.schema.ts).

### A.1 Perfil de alvo

```ts
export const targetProfileSchema = z
  .object({
    id: safeName,
    name: z.string().min(1).max(160),
    platform: z.enum(['generic', 'genexus', 'npdev']).default('generic'),
    environment: z.enum(['dev', 'qa', 'staging']),
    baseUrl: z.string().url(), // precisa estar em ALLOWED_TARGET_ORIGINS
    credentialSets: z.array(safeName).default([]),
    loginRoutine: safeName.optional(), // T8.1
    buildInfo: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('httpHeader'), header: z.string() }),
        z.object({ kind: z.literal('selectorText'), url: z.string(), selector: z.string() }),
        z.object({ kind: z.literal('jsonEndpoint'), url: z.string(), jsonPath: z.string() }),
        z.object({ kind: z.literal('provided') }),
      ])
      .optional(),
    noiseFilters: z.array(z.object({ networkFailureTextContains: z.string(), reason: z.string() })).default([]),
    surfaces: z.record(z.string(), z.array(z.string())).default({}), // superfície -> globs
    screens: z.array(screenSchema).default([]), // T4.2
    flags: z
      .object({
        allowDestructive: z.boolean().default(false),
        allowFaults: z.boolean().default(false),
        maxSessionsPerCredential: z.number().int().min(1).default(1),
      })
      .default({}),
  })
  .strict();
```

### A.2 Conjunto de credenciais (metadados; valores ficam cifrados)

```ts
export const credentialSetMetaSchema = z
  .object({
    id: safeName,
    boundOrigins: z.array(z.string().url()).min(1),
    fields: z.array(safeName).min(1), // só os nomes: loginUser, loginPassword...
    tags: z.array(z.string().max(80)).default([]), // ex.: "role:admin"
    notes: z.string().max(500).optional(),
  })
  .strict();

// Na requisição:
//   credentialSet: 'gam-admin'
// No step (inalterado):
//   { action: 'fill', selector: '#vUSERNAME', valueFromCredential: 'loginUser' }
```

### A.3 Rotina da biblioteca

```ts
export const libraryRoutineSchema = z
  .object({
    id: safeName,
    version: z.number().int().positive(),
    title: z.string().min(1).max(160),
    description: z.string().max(2000).optional(),
    tags: z.array(z.string().max(80)).default([]),
    surface: z.string().max(160).optional(),
    status: z.enum(['draft', 'active', 'quarantined', 'retired']).default('active'),
    targetProfile: safeName,
    credentialSet: safeName.optional(),
    actors: z.record(safeName, actorSchema).optional(), // T6.4
    parameters: z.array(parameterSchema).default([]), // T5.3
    options: explorationOptionsSchema.optional(),
    steps: z.array(explorationStepSchema).min(1),
    teardown: z.array(explorationStepSchema).default([]), // T1.4
    sha256: z.string().length(64),
    createdBy: z.string().max(200).optional(),
    createdAt: z.string(),
  })
  .strict();
```

### A.4 Item do cofre de regressão

```ts
const evidenceRefSchema = z.object({
  jobId: z.string(),
  at: z.string(),
  buildId: z.string().optional(),
  manifestSha256: z.string().length(64),
});

export const regressionItemSchema = z
  .object({
    id: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/), // ex.: GX-12, REG-209
    title: z.string().min(1).max(300),
    type: z.enum(['BUG', 'SCENARIO', 'BOUNDARY']),
    severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'P0', 'P1']).nullable(),
    status: z.enum(['ACTIVE', 'QUARANTINED', 'RETIRED']),
    opened: z.string(), // ISO date
    surface: z.string().max(160),
    tags: z.array(z.string()).default([]),
    routine: z.object({ id: safeName, version: z.number().int().positive() }),
    ledgerRef: z.string().optional(), // ex.: "npdev:REG-209"
    provenRed: evidenceRefSchema.nullable(),
    redNotCapturedReason: z.string().max(500).optional(),
    firstGreen: evidenceRefSchema.nullable(),
    lastRun: z.object({ jobId: z.string(), status: z.enum(['passed', 'failed']), at: z.string(), buildId: z.string().optional() }).optional(),
  })
  .strict()
  .refine((item) => item.provenRed !== null || item.redNotCapturedReason, {
    message: 'provenRed ou redNotCapturedReason é obrigatório',
  });
```

### A.5 Suíte

```ts
export const suiteRequestSchema = z
  .object({
    name: z.string().min(1).max(160),
    items: z
      .array(
        z.union([
          z.object({ routineId: safeName, version: z.number().int().positive().optional() }),
          z.object({ vault: z.object({ status: z.array(z.string()).optional(), tags: z.array(z.string()).optional() }) }),
        ]),
      )
      .min(1),
    variants: z
      .object({
        credentialSets: z.array(safeName).optional(),
        targetProfiles: z.array(safeName).optional(),
        samples: z.number().int().min(1).max(1000).optional(),
        seed: z.number().int().optional(),
      })
      .optional(),
    order: z.enum(['asIs', 'impact']).default('asIs'),
    impact: z.object({ changedFiles: z.array(z.string()).optional(), surfaces: z.array(z.string()).optional() }).optional(),
    mode: z.enum(['sequential', 'parallel']).default('sequential'),
    concurrency: z.number().int().min(1).optional(),
    failFast: z.boolean().default(false),
  })
  .strict();
```

### A.6 Parâmetros e geradores

```ts
const generatorSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('int'), min: z.number().int(), max: z.number().int() }),
  z.object({ type: z.literal('decimal'), min: z.number(), max: z.number(), scale: z.number().int().min(0).max(8) }),
  z.object({ type: z.literal('date'), from: z.string(), to: z.string(), format: z.string().default('dd/MM/yyyy') }),
  z.object({
    type: z.literal('string'),
    minLength: z.number().int().min(0),
    maxLength: z.number().int().max(5000),
    charset: z.enum(['alpha', 'alnum', 'unicode', 'hostile']).default('alnum'),
  }),
  z.object({ type: z.literal('oneOf'), values: z.array(z.string()).min(1) }),
  z.object({ type: z.literal('document'), kind: z.enum(['ci-uy', 'rut-uy', 'cpf', 'cnpj']), valid: z.boolean().default(true) }),
]);

export const parameterSchema = z.union([
  z.object({ name: safeName, generator: generatorSchema, includeBoundaries: z.boolean().default(true) }),
  z.object({ name: safeName, cases: z.array(z.string()).min(1) }),
]);

// Nova fonte de valor nos steps:
//   { action: 'fill', selector: '#vQTD', valueFromParameter: 'qty' }
```

### A.7 Matriz de permissões

```ts
export const permissionMatrixSchema = z
  .object({
    targetProfile: safeName,
    roles: z.array(safeName).min(1), // conjuntos de credenciais
    deniedWhen: z.array(
      z.union([
        z.object({ urlContains: z.string() }), // ex.: redirecionou para o login do GAM
        z.object({ textVisible: z.string() }),
        z.object({ status: z.number().int() }),
      ]),
    ),
    probes: z.array(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('url'), id: safeName, url: z.string() }),
        z.object({ kind: z.literal('control'), id: safeName, screen: safeName, selector: z.string() }),
        z.object({ kind: z.literal('action'), id: safeName, routineId: safeName }),
      ]),
    ),
    expected: z.record(safeName, z.record(safeName, z.enum(['allowed', 'denied', 'visible', 'hidden', 'enabled', 'disabled']))).optional(),
  })
  .strict();
```

### A.8 Manifesto de evidência

```json
{
  "manifestVersion": 1,
  "jobId": "job_XXXXXXXXXXXX",
  "createdAt": "2026-11-02T14:00:00.000Z",
  "routine": { "id": "login-and-report", "version": 3, "sha256": "…" },
  "target": { "profile": "gx-dev", "buildId": "rev4519" },
  "files": [
    { "path": "result.json", "sha256": "…" },
    { "path": "screenshots/failure.png", "sha256": "…" }
  ],
  "previousManifestSha256": "…",
  "signature": { "alg": "Ed25519", "keyId": "…", "value": "…" }
}
```

### A.9 Agendamento

```ts
export const scheduleSchema = z
  .object({
    id: safeName,
    cron: z.string().max(120), // 5 campos
    timezone: z.string().default('America/Montevideo'),
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('routine'), routineId: safeName }),
      z.object({ kind: z.literal('suite'), suite: suiteRequestSchema }),
      z.object({ kind: z.literal('vault'), tags: z.array(z.string()).optional() }),
      z.object({ kind: z.literal('evolutionSnapshot'), targetProfile: safeName }),
    ]),
    enabled: z.boolean().default(true),
    overlap: z.enum(['skip']).default('skip'),
    jitterSeconds: z.number().int().min(0).max(600).default(0),
    notify: z.array(safeName).default([]), // ids de webhook no cofre
  })
  .strict();
```

### A.10 Inventário de tela

```ts
export const screenInventorySchema = z.object({
  screenId: safeName,
  title: z.string().optional(),
  fields: z.array(
    z.object({
      key: z.string(), // estável: semântico (T8.3) ou name/id normalizado
      label: z.string().optional(),
      type: z.string(),
      required: z.boolean(),
      enabled: z.boolean(),
      visible: z.boolean(),
      maxLength: z.number().int().optional(),
      options: z.array(z.string()).optional(), // rótulos de select, nunca valores digitados
    }),
  ),
  actions: z.array(z.object({ key: z.string(), label: z.string().optional(), enabled: z.boolean() })),
  grids: z.array(z.object({ key: z.string(), columns: z.array(z.string()) })),
});
```

---

## Apêndice B — Roteiro das entrevistas

Para a T0.4 (30–45 minutos cada):

1. Como vocês testam hoje um sistema GeneXus antes de liberar uma versão? Quem testa, com que
   ferramenta e quanto tempo leva?
2. Qual foi a última regressão que chegou ao cliente? Como ela poderia ter sido pega antes?
3. Vocês usam o GXtest? O que funciona e o que falta?
4. Seus desenvolvedores já usam agentes de IA (Claude, Copilot, Cursor)? Para quê? Deixariam um
   agente operar um browser contra o ambiente de QA?
5. Algum cliente (governo, banco) exige **evidência formal de teste** para homologação? Como vocês
   produzem essa evidência hoje?
6. Vocês testam **permissões por papel** (GAM)? Como sabem que um papel não ganhou um acesso
   indevido numa release?
7. Quando migram de versão do GeneXus, como verificam que nada mudou de comportamento?
8. Acessibilidade é exigida por algum cliente? Como verificam hoje?
9. Dentre estas ideias (mostrar a lista da §1.5, resumida), quais três resolveriam um problema
   real seu **neste trimestre**?
10. Quanto custa hoje esse problema (horas por release, incidentes)? Vocês pagariam por uma
    solução, ou dedicariam uma pessoa para adotá-la?

---

*Fim do documento.*
