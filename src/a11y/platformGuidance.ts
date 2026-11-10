/**
 * T7.7: what to adjust in a GeneXus/NPDev application for each axe-core rule. Pure data, three languages (the languages of the reports).
 *
 * This is ORIENTATION, not a recipe: it says what the rule means in the HTML the browser sees and where, in a GeneXus model, that HTML usually
 * comes from. Property names change with the GeneXus version and the NPDev template, and the GeneXus notes were not checked against a particular build;
 * confirm in your environment. docs/a11y-platform-mapping.md is generated from this file (`npm run generate:a11y-doc`) and a test fails when the two
 * differ, so there is one source of truth.
 *
 * NPDev is NOT GeneXus: a note that says "Label Position", "Textblock" or "Theme object" means nothing there. A group may carry an `npdev` note, written
 * only after the finding was reproduced on a real NPDev build and traced to the generated HTML (2026-11-10: the WmsOffice workbenches; today `form-label`
 * and `contrast`). For a target profile of `platform: 'npdev'`, a group without that note says so instead of showing the GeneXus text.
 */

export type GuidanceLang = 'en' | 'pt' | 'es';
export const GUIDANCE_LANGS: readonly GuidanceLang[] = ['en', 'pt', 'es'];

export interface GuidanceText {
  /** What the rule means for the HTML of the page. */
  what: string;
  /** Where, in a GeneXus/NPDev model, that HTML usually comes from, and what to change. */
  platform: string;
}

export interface GuidanceGroup {
  id: string;
  title: Record<GuidanceLang, string>;
  /** axe-core rule ids this note applies to. */
  rules: readonly string[];
  text: Record<GuidanceLang, GuidanceText>;
  /** What to change in an NPDev application, only when it was verified on a real NPDev build (see the header). Shown instead of `text.platform` for `platform: 'npdev'`. */
  npdev?: Record<GuidanceLang, string>;
}

/** Shown for an NPDev target when the group has no verified NPDev note: the generic text names GeneXus controls that NPDev does not have. */
export const NPDEV_UNVERIFIED: Record<GuidanceLang, string> = {
  en: 'Not verified for NPDev yet: the generic note names GeneXus controls and properties that NPDev does not have. Look for the element in the NPDev workbench template (the generated HTML) and fix it there.',
  pt: 'Ainda não verificado para NPDev: a nota genérica cita controles e propriedades do GeneXus que o NPDev não tem. Procure o elemento no template do workbench do NPDev (o HTML gerado) e corrija lá.',
  es: 'Aún no verificado para NPDev: la nota genérica nombra controles y propiedades de GeneXus que NPDev no tiene. Busque el elemento en el template del workbench de NPDev (el HTML generado) y corríjalo allí.',
};

export const GUIDANCE_GROUPS: readonly GuidanceGroup[] = [
  {
    id: 'alt-text',
    title: { en: 'Text alternative for images', pt: 'Texto alternativo de imagens', es: 'Texto alternativo de imágenes' },
    rules: ['image-alt', 'input-image-alt', 'role-img-alt', 'svg-img-alt', 'object-alt', 'area-alt', 'server-side-image-map'],
    text: {
      en: {
        what: 'An image that carries meaning has no text alternative, so a screen reader says nothing (or the file name).',
        platform: 'Image control: fill its alternative-text / tooltip property (name varies by version). A purely decorative image should have an empty alternative text, not none. Image buttons: use the control caption.',
      },
      pt: {
        what: 'Uma imagem com significado não tem texto alternativo; o leitor de tela não diz nada (ou lê o nome do arquivo).',
        platform: 'Controle Image: preencha a propriedade de texto alternativo / tooltip (o nome varia com a versão). Imagem só decorativa deve ter texto alternativo vazio, e não ausente. Botão de imagem: use a legenda (caption) do controle.',
      },
      es: {
        what: 'Una imagen con significado no tiene texto alternativo; el lector de pantalla no dice nada (o lee el nombre del archivo).',
        platform: 'Control Image: complete la propiedad de texto alternativo / tooltip (el nombre varía según la versión). Una imagen solo decorativa debe tener texto alternativo vacío, no ausente. Botón de imagen: use el caption del control.',
      },
    },
  },
  {
    id: 'form-label',
    title: { en: 'Form fields without a label', pt: 'Campos de formulário sem rótulo', es: 'Campos de formulario sin etiqueta' },
    rules: ['label', 'select-name', 'form-field-multiple-labels', 'label-content-name-mismatch'],
    npdev: {
      en: 'NPDev workbench (verified on the WmsOffice build of 2026-11-10): the generated screen writes the caption as a <label> with no "for", next to a field that has no id (it carries only data-fkey), and the <select> has no label at all, so the browser cannot tie them together. Fix it once in the workbench template of the NPDev generator, not field by field: give each control an id and its label a matching "for" (or wrap the control in the label, or set aria-label). That covers every generated screen.',
      pt: 'Workbench do NPDev (verificado na compilação da WmsOffice de 10/11/2026): a tela gerada escreve o rótulo como <label> sem "for", ao lado de um campo sem id (só tem data-fkey), e o <select> não tem rótulo algum; por isso o navegador não os associa. Corrija uma vez no template do workbench do gerador NPDev, não campo a campo: dê um id a cada controle e ao rótulo o "for" correspondente (ou envolva o controle no rótulo, ou use aria-label). Isso cobre todas as telas geradas.',
      es: 'Workbench de NPDev (verificado en la compilación de WmsOffice del 10/11/2026): la pantalla generada escribe la etiqueta como <label> sin "for", junto a un campo sin id (solo tiene data-fkey), y el <select> no tiene etiqueta alguna; por eso el navegador no los asocia. Corrija una vez en el template del workbench del generador NPDev, no campo por campo: dé un id a cada control y a la etiqueta el "for" correspondiente (o envuelva el control en la etiqueta, o use aria-label). Eso cubre todas las pantallas generadas.',
    },
    text: {
      en: {
        what: 'An input, select or textarea has no accessible name (or has several, or a visible text that differs from its name).',
        platform: 'Attribute/variable control: keep its label visible (Label Position must not be None) or give it a caption/description. Do not replace the label with a Textblock next to the field: the browser cannot tie the two together.',
      },
      pt: {
        what: 'Um input, select ou textarea não tem nome acessível (ou tem vários, ou o texto visível difere do nome).',
        platform: 'Controle de atributo/variável: mantenha o rótulo visível (Label Position diferente de None) ou dê uma caption/descrição. Não troque o rótulo por um Textblock ao lado do campo: o navegador não os associa.',
      },
      es: {
        what: 'Un input, select o textarea no tiene nombre accesible (o tiene varios, o el texto visible difiere del nombre).',
        platform: 'Control de atributo/variable: mantenga la etiqueta visible (Label Position distinto de None) o dé un caption/descripción. No reemplace la etiqueta por un Textblock junto al campo: el navegador no los asocia.',
      },
    },
  },
  {
    id: 'autocomplete',
    title: { en: 'Autocomplete purpose', pt: 'Finalidade do autocomplete', es: 'Propósito del autocomplete' },
    rules: ['autocomplete-valid'],
    text: {
      en: { what: 'The autocomplete attribute of a personal-data field has a value that does not exist.', platform: 'Where the control takes a custom HTML attribute, use a value from the HTML list (name, email, tel, postal-code...) or remove it.' },
      pt: { what: 'O atributo autocomplete de um campo de dado pessoal tem um valor que não existe.', platform: 'Onde o controle aceita atributo HTML personalizado, use um valor da lista do HTML (name, email, tel, postal-code...) ou remova.' },
      es: { what: 'El atributo autocomplete de un campo de dato personal tiene un valor que no existe.', platform: 'Donde el control acepta un atributo HTML personalizado, use un valor de la lista de HTML (name, email, tel, postal-code...) o quítelo.' },
    },
  },
  {
    id: 'control-name',
    title: { en: 'Buttons, links and widgets without a name', pt: 'Botões, links e widgets sem nome', es: 'Botones, enlaces y widgets sin nombre' },
    rules: [
      'button-name',
      'input-button-name',
      'link-name',
      'summary-name',
      'aria-command-name',
      'aria-input-field-name',
      'aria-toggle-field-name',
      'aria-tooltip-name',
      'aria-meter-name',
      'aria-progressbar-name',
      'aria-tab-name',
    ],
    text: {
      en: {
        what: 'A control that can be activated has no text a screen reader could announce (an icon-only button, an empty link).',
        platform: 'Button/Textblock-as-link: fill the Caption. Icon-only controls: give the Image inside it an alternative text, or add a hidden text/aria-label through the control custom attributes.',
      },
      pt: {
        what: 'Um controle acionável não tem texto que o leitor de tela possa anunciar (botão só com ícone, link vazio).',
        platform: 'Button/Textblock usado como link: preencha a Caption. Controles só com ícone: dê texto alternativo à Image dentro dele, ou acrescente texto oculto / aria-label pelos atributos personalizados do controle.',
      },
      es: {
        what: 'Un control accionable no tiene texto que el lector de pantalla pueda anunciar (botón solo con ícono, enlace vacío).',
        platform: 'Button/Textblock usado como enlace: complete el Caption. Controles solo con ícono: dé texto alternativo a la Image que contiene, o agregue texto oculto / aria-label por los atributos personalizados del control.',
      },
    },
  },
  {
    id: 'contrast',
    title: { en: 'Colour contrast', pt: 'Contraste de cor', es: 'Contraste de color' },
    rules: ['color-contrast', 'link-in-text-block'],
    npdev: {
      en: 'NPDev workbench (verified on the WmsOffice build of 2026-11-10): the colours come from the CSS of the generated screen (the table header background and the accent colour variable), not from the model. Change them once in the workbench template (its CSS variables and classes) and recheck every screen that uses them.',
      pt: 'Workbench do NPDev (verificado na compilação da WmsOffice de 10/11/2026): as cores vêm do CSS da tela gerada (o fundo do cabeçalho da tabela e a variável da cor de destaque), não do modelo. Altere uma vez no template do workbench (suas variáveis e classes CSS) e reverifique as telas que as usam.',
      es: 'Workbench de NPDev (verificado en la compilación de WmsOffice del 10/11/2026): los colores vienen del CSS de la pantalla generada (el fondo del encabezado de la tabla y la variable del color de énfasis), no del modelo. Cámbielos una vez en el template del workbench (sus variables y clases CSS) y revise las pantallas que los usan.',
    },
    text: {
      en: {
        what: 'Text and its background are too close in brightness (4.5:1 for normal text, 3:1 for large text), or a link inside a paragraph is told apart only by colour.',
        platform: 'Fix it in the theme, not in each screen: change the colour of the theme class used by the control (Theme object, class foreground/background), then recheck every screen that uses the class. Links in text: add an underline in the class.',
      },
      pt: {
        what: 'O texto e o fundo têm brilho parecido (4,5:1 para texto normal, 3:1 para texto grande), ou um link dentro de um parágrafo se distingue só pela cor.',
        platform: 'Corrija no tema, não tela a tela: altere a cor da classe do tema usada pelo controle (objeto Theme, cor de texto/fundo da classe) e reverifique as telas que usam a classe. Links em texto: acrescente sublinhado na classe.',
      },
      es: {
        what: 'El texto y su fondo tienen brillo parecido (4,5:1 para texto normal, 3:1 para texto grande), o un enlace dentro de un párrafo se distingue solo por el color.',
        platform: 'Corrija en el tema, no pantalla por pantalla: cambie el color de la clase del tema usada por el control (objeto Theme, color de texto/fondo de la clase) y revise las pantallas que usan la clase. Enlaces en texto: agregue subrayado en la clase.',
      },
    },
  },
  {
    id: 'target-size',
    title: { en: 'Size of click targets', pt: 'Tamanho do alvo de clique', es: 'Tamaño del objetivo de clic' },
    rules: ['target-size'],
    text: {
      en: { what: 'A control is smaller than 24 by 24 CSS pixels and has no room around it (WCAG 2.2).', platform: 'Enlarge it in the theme class (height/width/padding) rather than per control; icon buttons in grids are the usual cause.' },
      pt: { what: 'Um controle é menor que 24 por 24 pixels CSS e não tem espaço ao redor (WCAG 2.2).', platform: 'Aumente na classe do tema (altura/largura/padding) em vez de controle a controle; botões de ícone em grids são a causa comum.' },
      es: { what: 'Un control es menor que 24 por 24 píxeles CSS y no tiene espacio alrededor (WCAG 2.2).', platform: 'Agrándelo en la clase del tema (alto/ancho/padding) y no control por control; los botones de ícono en grids son la causa habitual.' },
    },
  },
  {
    id: 'zoom-and-spacing',
    title: { en: 'Zoom, orientation and text spacing', pt: 'Zoom, orientação e espaçamento do texto', es: 'Zoom, orientación y espaciado del texto' },
    rules: ['meta-viewport', 'css-orientation-lock', 'avoid-inline-spacing'],
    text: {
      en: { what: 'The page blocks zooming, locks the screen orientation, or fixes text spacing with !important so a user stylesheet cannot change it.', platform: 'Look at the viewport meta tag in the master page / template (remove user-scalable=no and maximum-scale) and at theme CSS that uses !important on line-height, letter-spacing or word-spacing.' },
      pt: { what: 'A página impede o zoom, trava a orientação da tela, ou fixa o espaçamento do texto com !important de modo que uma folha de estilo do usuário não consiga alterá-lo.', platform: 'Veja a meta tag viewport na master page / template (remova user-scalable=no e maximum-scale) e o CSS do tema que usa !important em line-height, letter-spacing ou word-spacing.' },
      es: { what: 'La página impide el zoom, bloquea la orientación de la pantalla, o fija el espaciado del texto con !important de modo que una hoja de estilo del usuario no pueda cambiarlo.', platform: 'Revise la meta etiqueta viewport en la master page / plantilla (quite user-scalable=no y maximum-scale) y el CSS del tema que usa !important en line-height, letter-spacing o word-spacing.' },
    },
  },
  {
    id: 'page-title',
    title: { en: 'Page title', pt: 'Título da página', es: 'Título de la página' },
    rules: ['document-title'],
    text: {
      en: { what: 'The page has no <title>, or it is empty.', platform: 'Set the title (caption) of the web panel / transaction: it is usually what the generator writes into <title>. A title that names the screen helps; the same title everywhere does not.' },
      pt: { what: 'A página não tem <title>, ou ele está vazio.', platform: 'Defina o título (caption) do web panel / transação: normalmente é o que o gerador grava em <title>. Um título que nomeia a tela ajuda; o mesmo título em todas, não.' },
      es: { what: 'La página no tiene <title>, o está vacío.', platform: 'Defina el título (caption) del web panel / transacción: normalmente es lo que el generador escribe en <title>. Un título que nombra la pantalla ayuda; el mismo título en todas, no.' },
    },
  },
  {
    id: 'language',
    title: { en: 'Page language', pt: 'Idioma da página', es: 'Idioma de la página' },
    rules: ['html-has-lang', 'html-lang-valid', 'valid-lang', 'html-xml-lang-mismatch'],
    text: {
      en: { what: 'The <html> element has no lang attribute, or it has an invalid value or one that differs from xml:lang; a screen reader then reads with the wrong voice.', platform: 'The lang attribute comes from the page template: check the master page / generator template for the <html> tag, and set the language the application is shown in (es, pt-BR...).' },
      pt: { what: 'O elemento <html> não tem o atributo lang, ou ele tem valor inválido ou diferente de xml:lang; o leitor de tela lê com a voz errada.', platform: 'O atributo lang vem do template da página: verifique a master page / template do gerador na tag <html> e defina o idioma em que a aplicação é exibida (es, pt-BR...).' },
      es: { what: 'El elemento <html> no tiene el atributo lang, o tiene un valor inválido o distinto de xml:lang; el lector de pantalla lee con la voz equivocada.', platform: 'El atributo lang viene de la plantilla de la página: revise la master page / plantilla del generador en la etiqueta <html> y defina el idioma en que se muestra la aplicación (es, pt-BR...).' },
    },
  },
  {
    id: 'frames',
    title: { en: 'Frames', pt: 'Frames', es: 'Frames' },
    rules: ['frame-title', 'frame-title-unique', 'frame-focusable-content'],
    text: {
      en: { what: 'An iframe has no title (or two share one), or its content cannot be reached with the keyboard.', platform: 'Give the title to the iframe/web component container (custom attributes of the control) and make each one distinct. Check the embedded page separately: this audit does not look inside frames.' },
      pt: { what: 'Um iframe não tem título (ou dois têm o mesmo), ou o conteúdo dele não é alcançável pelo teclado.', platform: 'Dê o título ao contêiner do iframe/web component (atributos personalizados do controle) e torne cada um distinto. Verifique a página embutida à parte: esta auditoria não olha dentro de frames.' },
      es: { what: 'Un iframe no tiene título (o dos comparten uno), o su contenido no es alcanzable con el teclado.', platform: 'Dé el título al contenedor del iframe/web component (atributos personalizados del control) y haga cada uno distinto. Revise la página incrustada por separado: esta auditoría no mira dentro de los frames.' },
    },
  },
  {
    id: 'bypass',
    title: { en: 'Skipping repeated blocks', pt: 'Pular blocos repetidos', es: 'Saltar bloques repetidos' },
    rules: ['bypass'],
    text: {
      en: { what: 'There is no way to jump past the menu to the main content (a skip link, a heading or a landmark).', platform: 'Add it once in the master page: a "skip to content" link as the first focusable element, and mark the menu and the main area as landmarks (nav, main).' },
      pt: { what: 'Não há como pular o menu e ir ao conteúdo principal (link de atalho, título ou landmark).', platform: 'Acrescente uma vez na master page: um link "ir para o conteúdo" como primeiro elemento focável, e marque o menu e a área principal como landmarks (nav, main).' },
      es: { what: 'No hay forma de saltar el menú e ir al contenido principal (enlace de salto, encabezado o landmark).', platform: 'Agréguelo una vez en la master page: un enlace "ir al contenido" como primer elemento enfocable, y marque el menú y el área principal como landmarks (nav, main).' },
    },
  },
  {
    id: 'semantic-structure',
    title: { en: 'Headings and lists', pt: 'Títulos e listas', es: 'Encabezados y listas' },
    rules: ['p-as-heading', 'list', 'listitem', 'definition-list', 'dlitem'],
    text: {
      en: { what: 'Text styled to look like a heading is a plain paragraph, or a list is built with elements that are not list items.', platform: 'Titles made with a Textblock styled in the theme are paragraphs to a screen reader: use the control property that renders a heading element (or custom HTML) and keep the order h1, h2, h3.' },
      pt: { what: 'Um texto estilizado para parecer título é um parágrafo comum, ou uma lista é montada com elementos que não são itens de lista.', platform: 'Títulos feitos com Textblock estilizado no tema são parágrafos para o leitor de tela: use a propriedade do controle que gera um elemento de título (ou HTML personalizado) e mantenha a ordem h1, h2, h3.' },
      es: { what: 'Un texto con estilo de encabezado es un párrafo común, o una lista se arma con elementos que no son ítems de lista.', platform: 'Los títulos hechos con un Textblock con estilo en el tema son párrafos para el lector de pantalla: use la propiedad del control que genera un elemento de encabezado (o HTML personalizado) y mantenga el orden h1, h2, h3.' },
    },
  },
  {
    id: 'table-headers',
    title: { en: 'Table headers', pt: 'Cabeçalhos de tabela', es: 'Encabezados de tabla' },
    rules: ['td-has-header', 'th-has-data-cells', 'td-headers-attr', 'table-fake-caption'],
    text: {
      en: { what: 'A data table has cells without a header, a header without cells, a headers attribute that points nowhere, or a caption made of a merged cell.', platform: 'For data use a Grid and give every column a Title (that is the header cell). For layout use a Table control and do not mark its cells as headers.' },
      pt: { what: 'Uma tabela de dados tem células sem cabeçalho, cabeçalho sem células, um atributo headers que aponta para o nada, ou uma legenda feita com célula mesclada.', platform: 'Para dados use um Grid e dê Title a cada coluna (é a célula de cabeçalho). Para layout use o controle Table e não marque as células como cabeçalho.' },
      es: { what: 'Una tabla de datos tiene celdas sin encabezado, encabezado sin celdas, un atributo headers que apunta a nada, o un título hecho con una celda combinada.', platform: 'Para datos use un Grid y dé Title a cada columna (es la celda de encabezado). Para layout use el control Table y no marque sus celdas como encabezado.' },
    },
  },
  {
    id: 'aria-misuse',
    title: { en: 'ARIA written by hand', pt: 'ARIA escrito à mão', es: 'ARIA escrito a mano' },
    rules: [
      'aria-allowed-attr',
      'aria-prohibited-attr',
      'aria-valid-attr',
      'aria-valid-attr-value',
      'aria-roles',
      'aria-deprecated-role',
      'aria-conditional-attr',
      'aria-roledescription',
      'aria-braille-equivalent',
      'aria-required-attr',
      'aria-required-children',
      'aria-required-parent',
    ],
    text: {
      en: { what: 'An ARIA role or attribute is misspelled, not allowed on that element, or incomplete (a required attribute, child or parent is missing).', platform: 'GeneXus does not write ARIA by itself: it comes from a user control, an extended component or custom attributes typed in the object. Find the source and correct it, or remove the ARIA if the native element already says it.' },
      pt: { what: 'Um papel ou atributo ARIA está escrito errado, não é permitido naquele elemento, ou está incompleto (falta atributo, filho ou pai obrigatório).', platform: 'O GeneXus não escreve ARIA sozinho: ele vem de um user control, componente estendido ou atributos personalizados digitados no objeto. Encontre a origem e corrija, ou remova o ARIA se o elemento nativo já diz isso.' },
      es: { what: 'Un rol o atributo ARIA está mal escrito, no se permite en ese elemento, o está incompleto (falta un atributo, hijo o padre obligatorio).', platform: 'GeneXus no escribe ARIA por sí solo: viene de un user control, un componente extendido o atributos personalizados escritos en el objeto. Encuentre el origen y corríjalo, o quite el ARIA si el elemento nativo ya lo dice.' },
    },
  },
  {
    id: 'hidden-focus',
    title: { en: 'Hidden or nested interactive content', pt: 'Conteúdo interativo oculto ou aninhado', es: 'Contenido interactivo oculto o anidado' },
    rules: ['aria-hidden-body', 'aria-hidden-focus', 'nested-interactive'],
    text: {
      en: { what: 'Something hidden from assistive technology still takes keyboard focus, or a control sits inside another control.', platform: 'Common with dialogs and menus built by a user control: the hidden panel keeps its fields focusable. Hide it with display:none (or disable its controls) instead of only aria-hidden; never put a button inside a link.' },
      pt: { what: 'Algo oculto para tecnologia assistiva ainda recebe foco do teclado, ou um controle está dentro de outro controle.', platform: 'Comum em diálogos e menus montados por um user control: o painel oculto mantém seus campos focáveis. Oculte com display:none (ou desabilite os controles) em vez de só aria-hidden; nunca coloque um botão dentro de um link.' },
      es: { what: 'Algo oculto para la tecnología asistiva todavía recibe el foco del teclado, o un control está dentro de otro control.', platform: 'Habitual en diálogos y menús armados por un user control: el panel oculto mantiene sus campos enfocables. Ocúltelo con display:none (o deshabilite los controles) y no solo con aria-hidden; nunca ponga un botón dentro de un enlace.' },
    },
  },
  {
    id: 'scroll-region',
    title: { en: 'Scrollable areas', pt: 'Áreas com rolagem', es: 'Áreas con desplazamiento' },
    rules: ['scrollable-region-focusable'],
    text: {
      en: { what: 'An area that scrolls cannot be reached with the keyboard, so keyboard users cannot read what is out of view.', platform: 'Typical of a Grid or panel with a fixed height and overflow: add tabindex="0" through the control custom attributes, or let the page scroll instead of the panel.' },
      pt: { what: 'Uma área com rolagem não é alcançável pelo teclado, então quem usa só o teclado não lê o que está fora da vista.', platform: 'Típico de Grid ou painel com altura fixa e overflow: acrescente tabindex="0" pelos atributos personalizados do controle, ou deixe a página rolar em vez do painel.' },
      es: { what: 'Un área con desplazamiento no es alcanzable con el teclado, así que quien usa solo el teclado no lee lo que queda fuera de vista.', platform: 'Típico de un Grid o panel con alto fijo y overflow: agregue tabindex="0" por los atributos personalizados del control, o deje que se desplace la página en lugar del panel.' },
    },
  },
  {
    id: 'motion-and-time',
    title: { en: 'Moving content and timed refresh', pt: 'Conteúdo em movimento e atualização por tempo', es: 'Contenido en movimiento y actualización por tiempo' },
    rules: ['marquee', 'blink', 'meta-refresh', 'no-autoplay-audio'],
    text: {
      en: { what: 'Blinking or scrolling text, a page that refreshes itself on a timer, or audio that plays by itself.', platform: 'Remove the marquee/blink markup from the template; replace a meta refresh with a user-triggered reload (or a long, adjustable interval); do not autoplay sound.' },
      pt: { what: 'Texto que pisca ou rola, página que se atualiza sozinha por tempo, ou áudio que toca sozinho.', platform: 'Remova o marquee/blink do template; troque o meta refresh por um recarregamento acionado pelo usuário (ou um intervalo longo e ajustável); não toque som automaticamente.' },
      es: { what: 'Texto que parpadea o se desplaza, página que se actualiza sola por tiempo, o audio que suena solo.', platform: 'Quite el marquee/blink de la plantilla; reemplace el meta refresh por una recarga iniciada por el usuario (o un intervalo largo y ajustable); no reproduzca sonido automáticamente.' },
    },
  },
  {
    id: 'media-alternatives',
    title: { en: 'Captions for audio and video', pt: 'Legendas de áudio e vídeo', es: 'Subtítulos de audio y video' },
    rules: ['audio-caption', 'video-caption'],
    text: {
      en: { what: 'A video or audio element has no captions track.', platform: 'Media is usually embedded as custom HTML or a user control: add a <track kind="captions"> with the subtitle file.' },
      pt: { what: 'Um elemento de vídeo ou áudio não tem trilha de legendas.', platform: 'A mídia costuma ser embutida como HTML personalizado ou user control: acrescente um <track kind="captions"> com o arquivo de legendas.' },
      es: { what: 'Un elemento de video o audio no tiene pista de subtítulos.', platform: 'El medio suele incrustarse como HTML personalizado o user control: agregue un <track kind="captions"> con el archivo de subtítulos.' },
    },
  },
  {
    id: 'duplicate-id',
    title: { en: 'Duplicate ids', pt: 'Ids duplicados', es: 'Ids duplicados' },
    rules: ['duplicate-id-aria'],
    text: {
      en: { what: 'Two elements share an id that an ARIA attribute or a label points at, so the reference lands on the wrong one.', platform: 'GeneXus derives ids from control names: the same control name twice in one page (or a web component included twice) repeats the id. Rename one control. Grid rows get a suffix (vNAME_0001) by design.' },
      pt: { what: 'Dois elementos compartilham um id para o qual aponta um atributo ARIA ou um rótulo, e a referência cai no elemento errado.', platform: 'O GeneXus deriva os ids do nome dos controles: o mesmo nome duas vezes na página (ou um web component incluído duas vezes) repete o id. Renomeie um dos controles. Linhas de Grid recebem sufixo (vNAME_0001) por desenho.' },
      es: { what: 'Dos elementos comparten un id al que apunta un atributo ARIA o una etiqueta, y la referencia cae en el elemento equivocado.', platform: 'GeneXus deriva los ids del nombre de los controles: el mismo nombre dos veces en la página (o un web component incluido dos veces) repite el id. Renombre uno de los controles. Las filas de un Grid reciben sufijo (vNAME_0001) por diseño.' },
    },
  },
];

const BY_RULE = new Map<string, GuidanceGroup>();
for (const group of GUIDANCE_GROUPS) for (const rule of group.rules) BY_RULE.set(rule, group);

export function guidanceGroupFor(ruleId: string): GuidanceGroup | undefined {
  return BY_RULE.get(ruleId);
}

/**
 * The note for a rule, or undefined when this file has none (the report then relies on the rule's own help text).
 * `platform` is the target profile's: for `'npdev'` the `platform` text is the verified NPDev note of the group, or `NPDEV_UNVERIFIED`; any other value (or none) gets the GeneXus text.
 */
export function guidanceFor(ruleId: string, lang: GuidanceLang, platform?: string): (GuidanceText & { title: string; groupId: string }) | undefined {
  const group = BY_RULE.get(ruleId);
  if (!group) return undefined;
  const note = { ...group.text[lang], title: group.title[lang], groupId: group.id };
  return platform === 'npdev' ? { ...note, platform: group.npdev?.[lang] ?? NPDEV_UNVERIFIED[lang] } : note;
}

/** Every rule that has a note, sorted: the doc's table and the tests use it. */
export const GUIDED_RULES: readonly string[] = [...BY_RULE.keys()].sort();
