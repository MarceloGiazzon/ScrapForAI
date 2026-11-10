# ScrapForAI em palavras simples

Este texto é para quem **não é especialista** em testes nem em programação. Ele explica o que o
ScrapForAI faz, para que serve, para que não serve e como começar. Os termos técnicos aparecem
só quando são necessários, e sempre com uma explicação ao lado.

---

## 1. O que é o ScrapForAI?

O ScrapForAI é um **robô que usa um sistema web como uma pessoa usaria**: abre o navegador,
entra com usuário e senha, clica nos menus, preenche formulários, pesquisa, salva, e confere se o
que aparece na tela está certo.

A diferença para uma pessoa testando à mão é que o robô:

- **faz sempre do mesmo jeito**, quantas vezes for preciso, de dia ou de madrugada;
- **guarda provas** de tudo o que viu: fotos da tela, erros que o sistema mostrou, o tempo de
  cada passo;
- **pode ser dirigido por uma inteligência artificial** (como o Claude), que você comanda em
  linguagem normal: "abra a tela de clientes e veja se a busca por CPF funciona".

Ele roda **no seu computador ou no servidor da sua empresa**, não em uma nuvem de terceiros. E só
acessa os sistemas que você autorizou explicitamente.

> Uma imagem útil: o ScrapForAI é um **testador incansável e muito organizado**, que trabalha
> trancado em uma sala onde só existem as portas que você abriu, e que anota e fotografa tudo.

---

## 2. Quais problemas ele tenta resolver?

**"Funcionava ontem."** Uma mudança no sistema quebra uma tela que ninguém testou de novo. O
ScrapForAI repete os testes a cada versão (ou toda noite) e avisa quando algo que funcionava
deixou de funcionar.

**"Testar à mão toma tempo e cansa."** Repetir o mesmo roteiro em dez telas, com cinco perfis de
usuário, é lento e sujeito a esquecimentos. O robô não se cansa nem pula etapas.

**"O erro voltou."** Um defeito corrigido reaparece meses depois. O ScrapForAI tem um **cofre de
regressões**: cada defeito corrigido vira um teste permanente, com a prova de que ele existia e a
prova de que foi resolvido.

**"Dar acesso a uma IA é arriscado."** Deixar uma inteligência artificial navegar livremente,
com senhas na mão, assusta com razão. Aqui a IA **nunca vê as senhas** e **só entra nos endereços
permitidos**.

**"Como provo que testei?"** Para homologar uma versão (aprovar que ela pode seguir adiante) é
preciso mostrar evidências. O ScrapForAI gera **relatórios em PDF ou HTML, em português, espanhol
ou inglês**, com as fotos, os passos e os tempos, e pode **assinar digitalmente** as provas para
que ninguém consiga alterá-las depois sem que se perceba.

**"Quem pode ver o quê?"** Saber se um usuário comum consegue abrir uma tela de administrador
digitando o endereço direto no navegador é difícil de verificar à mão. O robô testa cada perfil
contra cada tela e monta uma tabela.

**"O que mudou nesta versão?"** O ScrapForAI fotografa a estrutura das telas a cada versão e
diz, em frases simples, o que apareceu, sumiu ou mudou ("o campo CEP agora é obrigatório").

---

## 3. Para que posso usar o ScrapForAI?

Abaixo, os usos agrupados por objetivo. Você não precisa usar tudo: a maioria das pessoas começa
pelos dois primeiros grupos.

### Explorar e testar uma tela
- **Pedir a uma IA que olhe uma página** e diga quais campos, botões e tabelas ela tem.
- **Executar um roteiro de passos** (entrar, abrir menu, preencher, salvar, conferir) e receber o
  resultado com fotos e erros.
- **Guardar esse roteiro** para usar de novo. Cada vez que você o altera, uma nova versão é
  criada e as antigas ficam guardadas.
- **Montar roteiros a partir de outros**: o roteiro de "entrar no sistema" é escrito uma vez e
  reaproveitado por todos os outros; e há uma "faxina" no final que sempre roda, mesmo se o teste
  falhar (por exemplo, apagar o registro de teste que foi criado).

### Repetir sempre e ser avisado
- **Rodar vários testes de uma vez** (uma "suíte"), com vários usuários e vários ambientes, e
  receber um veredito único: verde (tudo certo), vermelho (algo falhou) ou "não deu para testar".
- **Agendar** testes para rodar sozinhos (por exemplo, toda noite).
- **Receber aviso no Slack, Teams ou Google Chat** quando algo quebra ou volta a funcionar (não a
  cada execução, só quando a situação muda).
- **Receber um resumo semanal** do que quebrou, do que foi consertado e do que ficou mais lento.

### Guardar provas e homologar
- **Relatórios de homologação** em PDF/HTML, em três idiomas.
- **Provas assinadas digitalmente**, que podem ser exportadas e conferidas em outra máquina, sem
  o servidor.
- **Cofre de regressões**: o defeito fica registrado com a prova de "estava errado" e a prova de
  "foi corrigido", e é testado de novo em cada versão, começando pelos que têm mais chance de
  quebrar com a mudança que foi feita.
- **Rascunho de chamado (issue) no GitHub** a partir de um teste que falhou, já limpo de senhas e
  dados pessoais. Uma pessoa revisa e aprova antes de enviar.

### Acompanhar a saúde do sistema
- **Painel de Saúde**: o estado de cada sistema em uma tela (o que passa, o que falha, o que está
  instável).
- **Painel Executivo**: para gestores, mostra quantos testes existem, quantas regressões foram
  pegas, a tendência de qualidade e se a última versão está pronta para homologação.
- **Desempenho**: avisa quando um passo ficou mais lento e em qual versão isso começou.
- **Testes instáveis**: identifica testes que ora passam, ora falham sem motivo, e sugere
  colocá-los em "quarentena" (continuam rodando, mas não contam no veredito até alguém olhar).
- **Evolução das telas**: o que mudou em cada tela, versão a versão, e desde quando um campo
  existe.

### Testes que são difíceis de fazer à mão
- **Matriz de permissões**: cada perfil de usuário contra cada tela, incluindo o acesso por
  endereço direto. Se um perfil ganhou um acesso que não deveria ter, o teste fica vermelho.
- **Comparar dois ambientes** (desenvolvimento e homologação, versão antiga e nova): o mesmo
  roteiro nos dois lados e uma lista do que deu diferente.
- **Dois usuários ao mesmo tempo**: dois usuários editando o mesmo registro, ou clicando em
  "salvar" juntos, para descobrir se um apaga o trabalho do outro.
- **Dados de teste gerados automaticamente**: números, datas, textos e até CPF, CNPJ, CI e RUT do
  Uruguai com dígito verificador correto. Os valores "na beirada" (o mínimo, um a menos que o
  mínimo, etc.) são testados primeiro, porque é ali que os erros costumam estar.
- **Encontrar o menor caso que falha**: quando um teste falha com muitos dados, o robô vai
  simplificando até achar o valor exato onde o erro começa ("falha com 1000, passa com 999").
- **Conferir cálculos**: você escreve a fórmula esperada (`preço × quantidade × 1,1`) ou uma
  planilha CSV com entradas e resultados esperados, e o robô compara com o que a tela mostrou.
- **Simular problemas**: fazer o servidor "responder com erro", "demorar" ou "mandar dados
  quebrados", para ver se a tela trata bem a situação e não mostra mensagens técnicas ao usuário.
- **Mudar a data** que a página enxerga (por exemplo, testar o fechamento do mês).
- **Acessibilidade**: verificar as regras de acessibilidade (WCAG) de cada tela, e se é possível
  navegar só com o teclado.
- **Caçar dados pessoais vazando**: CPF, e-mail, cartão ou senhas aparecendo em endereços,
  mensagens de erro ou memória do navegador.

### Documentar
- **Manual vivo**: os roteiros podem ter legendas, e o robô gera um manual do usuário com as
  fotos das telas destacando o botão certo, em português, espanhol e inglês. A cada versão, o
  manual é refeito e ele diz quais imagens mudaram.

### Para empresas que trabalham com GeneXus
- Um **pacote pronto** com modelos de teste para as telas típicas do GeneXus (login GAM, "Work
  With" com filtro e grade, inclusão em uma transação, janela de seleção "Prompt") e guias em
  espanhol e português.

---

## 4. Para que **não** é indicado?

- **Coletar dados de sites de terceiros** (o "scraping" do nome engana). Ele só acessa endereços
  que você autorizou, e não tem nenhum recurso para driblar bloqueios, CAPTCHAs ou proteções
  contra robôs. Isso é proposital.
- **Testar em produção com dados reais de clientes.** As fotos e registros podem conter dados
  sensíveis. O lugar certo é o ambiente de desenvolvimento ou de testes.
- **Teste de carga** (simular milhares de usuários para ver se o servidor aguenta). Ele simula
  poucos usuários ao mesmo tempo, para encontrar erros de lógica, não limites de capacidade.
- **Aplicativos de celular nativos ou programas de computador.** Ele testa o que abre em um
  navegador.
- **Comparar imagens pixel a pixel.** Ele compara a estrutura e o conteúdo das telas, não a
  aparência exata (cor, posição de um botão).
- **Substituir os testes que os programadores escrevem dentro do código.** Ele complementa esses
  testes, olhando o sistema "de fora", como o usuário.
- **Aprovar uma versão no seu lugar.** Ele diz "nada que eu conheço está falhando". Quem aprova é
  uma pessoa.
- **Funcionar sem ninguém por perto no começo.** Alguém precisa dizer quais sistemas podem ser
  acessados, cadastrar os usuários de teste e revisar os primeiros roteiros.

---

## 5. Para quem ele foi pensado?

- **Equipes que mantêm sistemas web corporativos**, em especial sistemas feitos em **GeneXus** ou
  na plataforma **NPDev**, com muitas telas parecidas e muitos perfis de usuário.
- **Analistas de qualidade (QA) e testadores**, que querem parar de repetir à mão o mesmo roteiro.
- **Desenvolvedores que usam assistentes de IA** (Claude Code e similares) e querem que a IA
  consiga ver e testar a tela de verdade, com segurança.
- **Quem homologa versões** e precisa de provas organizadas.
- **Gestores**, pelos painéis Executivo e de Saúde e pelo resumo semanal, sem precisar ler
  registros técnicos.
- **Equipes pequenas**: há um modo "servidor de equipe" com chave pessoal para cada pessoa, três
  papéis (só ver, executar, administrar) e um registro de tudo o que cada um fez.

Não é preciso saber programar para **usar** os resultados (painéis, relatórios, avisos) nem para
**pedir** testes a uma IA. Para **instalar e configurar** pela primeira vez, ajuda ter alguém com
um pouco de experiência técnica.

---

## 6. Qual é a filosofia?

**Segurança primeiro.** Tudo é proibido até ser permitido. O robô só entra nos endereços da
lista, as senhas ficam guardadas criptografadas e presas ao sistema a que pertencem, e qualquer
senha que apareça em um resultado é apagada antes de ser mostrada. O próprio projeto impede que
alguém salve uma senha por engano no código.

**A IA propõe, a pessoa decide.** A IA pode explorar, escrever roteiros, rodar testes e preparar
rascunhos. Mas tudo o que **sai** do servidor ou **roda sozinho** precisa de uma pessoa: enviar
um chamado, criar um agendamento, configurar um aviso, aprovar o catálogo de telas.

**Provas, não opiniões.** Um teste que passou deixa evidência: fotos, tempos, a versão exata do
sistema e do roteiro. As provas importantes podem ser fixadas, assinadas e encadeadas, de modo que
apagar ou editar uma delas fica visível.

**Honestidade antes de tudo.** Quando o robô não sabe, ele diz que não sabe. Se não conseguiu
descobrir a versão do sistema, ela aparece como "desconhecida", não inventada. O painel diz
regressões **pegas**, não "evitadas", porque não há como saber se teriam chegado aos usuários.
"Pronto para homologar" significa "nada conhecido está falhando", não "aprovado". Uma tela que não
pôde ser lida aparece como "desconhecida", nunca como "removida".

**Roteiro é dado, não programa.** Um roteiro é uma lista de passos descrita em um formato simples
(JSON), que pode ser lida, revisada, versionada e guardada junto com o código do sistema. Não é
preciso programar para entendê-lo.

**Tudo fica com você.** Roda localmente ou no seu servidor, sem nuvem própria e sem mensalidade
de terceiros. O servidor não chama nenhum modelo de IA por conta própria: a IA é a sua, e você
escolhe usá-la ou não. O código é aberto (licença MIT).

**Silêncio quando está tudo bem.** Os avisos só chegam quando a situação muda (quebrou, voltou).
Um teste instável vai para a quarentena em vez de acostumar a equipe a ignorar o vermelho.

---

## 7. Como funciona (a mecânica)

### As peças

| Peça | O que é, em palavras simples |
|---|---|
| **Lista de permitidos** | Os endereços que o robô pode abrir. Fora dela, nada. |
| **Perfil de alvo** | Um "cartão de identidade" de cada sistema e ambiente: endereço, tipo (GeneXus, NPDev), quais usuários de teste ele usa, como se entra, onde descobrir a versão instalada. |
| **Cofre de credenciais** | Onde ficam usuários e senhas de teste, criptografados. Os roteiros dizem só "use o usuário *admin-teste*"; a senha nunca aparece. |
| **Roteiro (rotina)** | A receita: uma lista de passos como "abrir", "clicar", "preencher", "conferir que aparece". |
| **Biblioteca** | Onde os roteiros ficam guardados, com todas as versões. |
| **Execução** | Uma vez em que o robô seguiu um roteiro. Resultado: passou, falhou ou não conseguiu rodar. |
| **Evidência** | O que ficou de cada execução: fotos, erros, tempos, a versão do sistema. As comuns expiram sozinhas; as importantes podem ser fixadas e assinadas. |
| **Suíte** | Vários roteiros rodados juntos, com um veredito único. |
| **Cofre de regressões** | A coleção de defeitos que já aconteceram, cada um com a prova "antes" e "depois". |
| **Agendamento e avisos** | Quando rodar sozinho e para onde avisar. |

### O caminho típico

```
Você (ou a IA) ──pede──> ScrapForAI ──abre o navegador──> Sistema em teste
                              │                          (só endereços permitidos)
                              │
                              └──devolve──> resultado + provas (sem senhas)
```

1. **Explorar:** você pede à IA "veja o que tem na tela de pedidos". O robô abre a página e
   devolve a lista de campos, botões e tabelas, sem clicar em nada.
2. **Experimentar:** a IA escreve um roteiro com esses elementos e manda executar. O resultado
   volta com fotos e erros.
3. **Guardar:** quando o roteiro funciona, ele é salvo na biblioteca. O robô confere, antes de
   salvar, se não há uma senha escrita nele e se ele segue as boas práticas.
4. **Repetir:** o roteiro entra em uma suíte, em um agendamento noturno ou no cofre de regressões.
5. **Acompanhar:** os painéis, avisos e resumos mostram como o sistema está, e os relatórios
   servem de prova.

### Por onde se conversa com ele

- **Pela IA** (Claude Code e outras ferramentas compatíveis com MCP, o "conector" padrão entre IAs
  e ferramentas): é o jeito mais fácil para quem não programa. Você escreve o que quer; a IA usa o
  ScrapForAI.
- **Pelo console web**, no navegador: histórico, Executivo, Saúde, Desempenho, Evolução, Cofre de
  regressões, Equipe, Configuração e Status. (Hoje o console está só em inglês; os relatórios estão
  em português, espanhol e inglês.)
- **Pela linha de comando** (`scrapforai ...`), para quem automatiza ou integra com outros
  processos.
- **Pela API**, para quem quer ligar o ScrapForAI a outro sistema.

---

## 8. Como começo? Os primeiros passos

### Passo 1: instalar

**No Windows, com o instalador** (`ScrapForAI-Setup-x.y.z.exe`, quando você o tiver recebido):
dê dois cliques. Não pede permissão de administrador e já traz tudo o que precisa (inclusive o
navegador). Na primeira abertura, ele cria uma **chave de acesso** e a mostra: **copie e guarde
essa chave**, é com ela que você entra.

**A partir do código** (para quem tem alguém técnico por perto): instalar o Node.js 22.13 ou mais
novo, baixar o projeto e seguir o `README.md`. Depois, rodar `npm run doctor`: ele confere a
máquina e diz, em frases claras, o que falta e qual comando resolve. Ele não instala nada nem
mostra a sua chave.

### Passo 2: entrar no console

Abra `http://127.0.0.1:3000/ui/` no navegador e entre com a chave. O serviço só escuta no seu
próprio computador; outras máquinas não o alcançam.

### Passo 3: dizer qual sistema pode ser testado

Na tela **Configuração**, informe o endereço exato do sistema de testes (por exemplo
`https://qa.minhaempresa.com`). Exato quer dizer com `http` ou `https`, nome e porta: outra porta
é outro endereço. Enquanto isso não for feito, o robô não abre nada.

> O servidor se recusa a iniciar se a configuração ainda for a de exemplo. Não é defeito: é para
> ninguém ficar com uma chave conhecida por todos.

### Passo 4: ligar a sua IA

No Claude Code, abra a pasta do ScrapForAI. Ele vai perguntar se pode usar o servidor
`scrapforai`: aprove. A partir daí, você pode pedir em português:

- "Use o ScrapForAI para inspecionar a página `https://qa.minhaempresa.com/login`."
- "Faça um roteiro que entra no sistema, abre Clientes e pesquisa pelo nome 'Teste'."
- "Esse roteiro funcionou, salve na biblioteca com o nome `clientes-busca`."

### Passo 5: cadastrar os usuários de teste

Usuários e senhas vão para o cofre de credenciais, nunca para um roteiro ou para a conversa com a
IA. Hoje isso é feito pela API, com a chave de administrador (ainda não há tela para isso): peça
ajuda a quem instalou ou siga o `README.md`. Use **apenas usuários de teste**, nunca contas
pessoais reais.

### Passo 6: transformar em rotina

Com dois ou três roteiros salvos:

- rode-os juntos como suíte e veja o veredito;
- quando encontrar um defeito, peça à IA para guardá-lo no **cofre de regressões**;
- quando estiver confortável, peça a quem administra para criar um **agendamento noturno** e um
  **aviso** no canal da equipe;
- abra os painéis **Saúde** e **Executivo** de vez em quando.

### Dicas para não se frustrar

- Comece por **uma tela** e **um roteiro**, não pelo sistema inteiro.
- Se o sistema for GeneXus, use o **pacote GeneXus** (`docs/genexus-pack/README.pt.md`): ele já
  traz os modelos e as armadilhas conhecidas (por exemplo: depois de preencher um campo, aperte
  Tab; espere a rede acalmar em vez de esperar um tempo fixo).
- Um teste vermelho não é um fracasso do robô: muitas vezes é exatamente o defeito que você queria
  encontrar. Leia a foto e a mensagem do erro antes de mudar o roteiro.

---

## 9. Quais os diferenciais em relação a outras ferramentas?

Para ser justo, primeiro o que já existe:

- **Playwright, Cypress, Selenium**: ferramentas excelentes e muito usadas, para quem **programa**
  testes. O ScrapForAI usa o Playwright por baixo.
- **IAs que navegam sozinhas** (extensões de navegador, conectores de navegador para IA): ótimas
  para uma tarefa pontual, mas não guardam roteiros, não repetem o teste amanhã, não produzem
  provas e, em geral, a IA vê tudo o que está na tela, inclusive as senhas que você digita.
- **Plataformas comerciais de teste na nuvem**: completas, mas os seus dados e telas passam pelos
  servidores delas, e elas costumam ser pagas por usuário ou por execução.

O que o ScrapForAI oferece de diferente:

1. **IA com rédea curta.** A IA pode usar o navegador, mas só nos endereços permitidos, **sem
   nunca ver uma senha** (ela pede "o usuário *admin-teste*" e o servidor preenche), e uma senha
   só pode ser digitada no sistema ao qual pertence. Tudo o que sai ou roda sozinho passa por uma
   pessoa. Poucas ferramentas separam tão claramente "o que a IA pode" de "o que só uma pessoa
   pode".

2. **Provas que valem como prova.** Cada execução registra a impressão digital de cada arquivo;
   as provas fixadas são **assinadas digitalmente e encadeadas** (apagar ou alterar uma quebra a
   corrente) e podem ser **conferidas em outra máquina, sem o servidor**. Os relatórios de
   homologação saem prontos, em três idiomas.

3. **Cofre de regressões com "antes e depois".** Não basta dizer "foi corrigido": o item guarda
   a execução que falhou e a primeira que passou na versão corrigida. Ninguém consegue "digitar"
   uma prova; ela só nasce de uma execução real. E o cofre é testado começando pelo que a mudança
   do dia mais provavelmente quebrou.

4. **Testes que normalmente ninguém faz, prontos para usar.** Matriz de permissões (incluindo
   acesso por endereço direto), comparação entre dois ambientes, dois usuários ao mesmo tempo,
   simulação de falhas, relógio falso, acessibilidade, navegação por teclado, caça a dados
   pessoais vazando, dados gerados com valores-limite e a busca automática do menor caso que
   falha. Em outras ferramentas, cada um desses exige programação específica.

5. **Memória do sistema ao longo do tempo.** Fotografias da estrutura das telas por versão ("o
   campo CEP ficou obrigatório na versão X"), séries de desempenho por passo com o aviso de "ficou
   mais lento a partir da versão Y", detecção de testes instáveis com quarentena, painéis de Saúde
   e Executivo, e o resumo semanal. A ferramenta não só testa: ela **lembra**.

6. **Feito para GeneXus (e NPDev).** Conhece as manias dessas plataformas (entrada pelo GAM, uma
   sessão por usuário, identificadores de linha de grade, janelas "Prompt" dentro da página, ruído
   de rede que não é erro) e tem um pacote de modelos e guias em espanhol e português. Ferramentas
   genéricas deixam esse trabalho para você.

7. **Manual do usuário que se atualiza sozinho**, com fotos das telas e o botão destacado, em três
   idiomas, refeito a cada versão e dizendo quais imagens mudaram.

8. **Seu, local e aberto.** Roda na sua máquina ou no seu servidor, os dados ficam com você,
   não depende de nuvem nem de assinatura, e o código é aberto (MIT). Funciona com a IA que você
   já usa.

### E, com toda a honestidade, os limites atuais

- É um projeto **jovem e de equipe pequena**. Playwright e Cypress têm comunidades enormes,
  documentação vasta e anos de uso em produção.
- Os modelos GeneXus foram testados contra **réplicas que imitam** um sistema GeneXus, **ainda não
  contra uma aplicação GeneXus 17/18 real**. Os seletores dos modelos precisam ser confirmados no
  seu sistema.
- O **console está só em inglês**, e algumas tarefas (cadastrar senhas, criar agendamentos e
  avisos) ainda são feitas pela API ou pela linha de comando, sem tela.
- A instalação e a configuração inicial pedem algum conhecimento técnico.
- Se a sua equipe já programa testes com Playwright e só precisa disso, talvez o Playwright puro
  baste. O ScrapForAI vale a pena quando você quer **IA com segurança, provas, memória ao longo
  do tempo e os testes difíceis já prontos**.

---

*Este documento descreve o que o ScrapForAI faz hoje. Para detalhes técnicos, veja o `README.md`
e o manual em `docs/user-manual.md`.*
