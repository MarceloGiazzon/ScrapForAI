import { esc } from '../reports/render.js';
import { DOC_LANGS, type DocLang, pickCaption } from '../schemas/docStep.schema.js';
import type { FigureChangeSet, ManualFormat } from '../schemas/manual.schema.js';
import { type Chapter, chapterIntro, chapterTitle, type ManualModel, orderedChapters } from './manualModel.js';

/**
 * T9.2: Markdown and HTML of a manual. PURE (no I/O, no configuration), like the report renderer.
 *
 * Every text that comes from a routine (title, introduction, captions) is PLAIN TEXT: it is escaped for the format and never interpreted as markup.
 * The HTML is one file per page under a CSP without scripts; images are relative files next to the pages.
 */

const LANGUAGE_NAME: Record<DocLang, string> = { en: 'English', pt: 'Português', es: 'Español' };

interface Labels {
  contents: string;
  backToContents: string;
  languages: string;
  build: string;
  generated: string;
  steps: (n: number) => string;
  noText: (wanted: DocLang, shown: DocLang) => string;
  review: { title: string; build: string; first: string; changed: string; added: string; removed: string; negligible: string; unchanged: string; none: string };
  reasons: { resized: string; bytes: string; visual: (percent: number, cells: number, total: number) => string };
  hint: { changed: string; negligible: string };
}

const LABELS: Record<DocLang, Labels> = {
  en: {
    contents: 'Contents',
    backToContents: 'Back to contents',
    languages: 'Languages',
    build: 'Build',
    generated: 'Generated',
    steps: (n) => `${n} ${n === 1 ? 'step' : 'steps'}`,
    noText: (wanted, shown) => `no ${LANGUAGE_NAME[wanted]} text yet; shown in ${LANGUAGE_NAME[shown]}`,
    review: {
      title: 'Figures to review',
      build: 'Build',
      first: 'This is the first build of this manual: every figure is new and there is nothing to compare with.',
      changed: 'Changed',
      added: 'New',
      removed: 'Removed',
      negligible: 'Differ only slightly',
      unchanged: 'Unchanged',
      none: 'none',
    },
    reasons: {
      resized: 'the picture has another size',
      bytes: 'the file differs and could not be compared visually',
      visual: (percent, cells, total) => `${percent}% of the picture changed (${cells} of ${total} areas)`,
    },
    hint: {
      changed: 'Check the caption still matches the figure.',
      negligible: 'The file differs but no visible area moved: most likely rendering noise. A change of a single character can land here; open it if the caption quotes the text.',
    },
  },
  pt: {
    contents: 'Índice',
    backToContents: 'Voltar ao índice',
    languages: 'Idiomas',
    build: 'Build',
    generated: 'Gerado em',
    steps: (n) => `${n} ${n === 1 ? 'passo' : 'passos'}`,
    noText: (wanted, shown) => `ainda sem texto em ${LANGUAGE_NAME[wanted]}; mostrado em ${LANGUAGE_NAME[shown]}`,
    review: {
      title: 'Figuras para revisar',
      build: 'Build',
      first: 'Este é o primeiro build deste manual: toda figura é nova e não há com o que comparar.',
      changed: 'Mudaram',
      added: 'Novas',
      removed: 'Removidas',
      negligible: 'Diferem pouco',
      unchanged: 'Iguais',
      none: 'nenhuma',
    },
    reasons: {
      resized: 'a imagem tem outro tamanho',
      bytes: 'o arquivo é diferente e não foi possível comparar visualmente',
      visual: (percent, cells, total) => `${percent}% da imagem mudou (${cells} de ${total} áreas)`,
    },
    hint: {
      changed: 'Confira se a legenda ainda corresponde à figura.',
      negligible: 'O arquivo difere, mas nenhuma área visível se moveu: provavelmente ruído de renderização. A troca de um único caractere pode cair aqui; abra a figura se a legenda cita o texto.',
    },
  },
  es: {
    contents: 'Índice',
    backToContents: 'Volver al índice',
    languages: 'Idiomas',
    build: 'Build',
    generated: 'Generado el',
    steps: (n) => `${n} ${n === 1 ? 'paso' : 'pasos'}`,
    noText: (wanted, shown) => `todavía sin texto en ${LANGUAGE_NAME[wanted]}; se muestra en ${LANGUAGE_NAME[shown]}`,
    review: {
      title: 'Figuras para revisar',
      build: 'Build',
      first: 'Este es el primer build de este manual: toda figura es nueva y no hay con qué comparar.',
      changed: 'Cambiaron',
      added: 'Nuevas',
      removed: 'Eliminadas',
      negligible: 'Difieren poco',
      unchanged: 'Iguales',
      none: 'ninguna',
    },
    reasons: {
      resized: 'la imagen tiene otro tamaño',
      bytes: 'el archivo es distinto y no se pudo comparar visualmente',
      visual: (percent, cells, total) => `${percent}% de la imagen cambió (${cells} de ${total} áreas)`,
    },
    hint: {
      changed: 'Verifique que la leyenda siga correspondiendo a la figura.',
      negligible: 'El archivo difiere pero ningún área visible se movió: probablemente ruido de renderizado. El cambio de un solo carácter puede caer aquí; ábrala si la leyenda cita el texto.',
    },
  },
};

export interface RenderInput {
  model: ManualModel;
  langs: readonly DocLang[];
  formats: readonly ManualFormat[];
  changes: FigureChangeSet;
}

export interface RenderedFile {
  /** Relative to the manual folder, forward slashes. */
  relative: string;
  data: string;
}

/** One line of plain text: whitespace collapsed. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Escapes what Markdown would read as formatting or as a link/HTML. Line-start markers cannot occur: every caption is put after a prefix. */
export function escapeMarkdown(text: string): string {
  return oneLine(text).replace(/([\\`*_[\]<>|])/g, '\\$1');
}

const dateOf = (iso: string): string => iso.slice(0, 10);

// --- Markdown -----------------------------------------------------------------------------------------------------------------------

function chapterMarkdown(model: ManualModel, chapter: Chapter, lang: DocLang): string {
  const labels = LABELS[lang];
  const title = chapterTitle(chapter, lang);
  const intro = chapterIntro(chapter, lang);
  const lines: string[] = [`# ${escapeMarkdown(title.text)}`, ''];
  if (title.missing && title.lang) lines.push(`_${escapeMarkdown(labels.noText(lang, title.lang))}_`, '');
  if (intro) {
    lines.push(escapeMarkdown(intro.text), '');
    if (intro.missing && intro.lang) lines.push(`_${escapeMarkdown(labels.noText(lang, intro.lang))}_`, '');
  }

  chapter.steps.forEach((step, index) => {
    const caption = pickCaption(step.caption, lang);
    const text = caption ? escapeMarkdown(caption.text) : '';
    const note = caption?.fallback ? ` _(${escapeMarkdown(labels.noText(lang, caption.lang))})_` : '';
    const alt = caption ? escapeMarkdown(caption.text) : '';
    lines.push(`**${index + 1}.** ${text}${note}`, '', `![${alt}](../${step.figure.file})`, '');
  });

  lines.push(`[${labels.backToContents}](index.md)`, '');
  return `${lines.join('\n')}`;
}

function indexMarkdown(model: ManualModel, lang: DocLang, langs: readonly DocLang[]): string {
  const labels = LABELS[lang];
  const lines: string[] = [`# ${escapeMarkdown(model.title)}`, '', `${labels.build}: ${escapeMarkdown(model.buildId)} · ${labels.generated}: ${dateOf(model.createdAt)}`, ''];
  if (langs.length > 1) {
    lines.push(`${labels.languages}: ${langs.map((other) => (other === lang ? `**${LANGUAGE_NAME[other]}**` : `[${LANGUAGE_NAME[other]}](../${other}/index.md)`)).join(' · ')}`, '');
  }
  lines.push(`## ${labels.contents}`, '');
  orderedChapters(model.chapters).forEach((chapter, index) => {
    lines.push(`${index + 1}. [${escapeMarkdown(chapterTitle(chapter, lang).text)}](${chapter.routineId}.md) — ${labels.steps(chapter.steps.length)}`);
  });
  lines.push('');
  return lines.join('\n');
}

/** What the person who writes the manual reviews after a build: only the figures that moved. */
export function figuresChangedMarkdown(model: ManualModel, changes: FigureChangeSet, lang: DocLang): string {
  const labels = LABELS[lang];
  const fileOf = new Map(orderedChapters(model.chapters).flatMap((chapter) => chapter.steps.map((step) => [step.figure.id, step.figure.file] as const)));
  const where = (id: string): string => {
    const file = fileOf.get(id);
    return file ? `\`${id}\` (${file})` : `\`${id}\``;
  };
  const lines: string[] = [`# ${labels.review.title} — ${escapeMarkdown(model.title)}`, '', `${labels.review.build}: ${escapeMarkdown(model.buildId)}${changes.previousBuildId ? ` (← ${escapeMarkdown(changes.previousBuildId)})` : ''} · ${dateOf(model.createdAt)}`, ''];

  if (changes.firstBuild) {
    lines.push(labels.review.first, '');
  } else {
    lines.push(`## ${labels.review.changed} (${changes.changed.length})`, '');
    if (changes.changed.length === 0) lines.push(`- ${labels.review.none}`);
    else lines.push(labels.hint.changed, '');
    for (const change of changes.changed) {
      const reason =
        change.reason === 'visual' && change.percent !== undefined && change.changedCells !== undefined && change.totalCells !== undefined
          ? labels.reasons.visual(change.percent, change.changedCells, change.totalCells)
          : change.reason === 'resized'
            ? labels.reasons.resized
            : labels.reasons.bytes;
      lines.push(`- ${where(change.id)} — ${reason}`);
    }
    lines.push('', `## ${labels.review.added} (${changes.new.length})`, '');
    if (changes.new.length === 0) lines.push(`- ${labels.review.none}`);
    for (const id of changes.new) lines.push(`- ${where(id)}`);
    lines.push('', `## ${labels.review.removed} (${changes.removed.length})`, '');
    if (changes.removed.length === 0) lines.push(`- ${labels.review.none}`);
    for (const id of changes.removed) lines.push(`- \`${id}\``);
    lines.push('', `## ${labels.review.negligible} (${changes.negligible.length})`, '');
    if (changes.negligible.length === 0) lines.push(`- ${labels.review.none}`);
    else lines.push(labels.hint.negligible, '');
    for (const id of changes.negligible) lines.push(`- ${where(id)}`);
    lines.push('', `${labels.review.unchanged}: ${changes.unchanged}`);
  }
  lines.push('');
  return lines.join('\n');
}

// --- HTML ---------------------------------------------------------------------------------------------------------------------------

const CSS = `
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1f2933; --muted: #5b6770; --line: #d5dbe0; --accent: #0b5cad; --card: #f6f8fa; }
@media (prefers-color-scheme: dark) { :root { --bg: #14181d; --fg: #e6eaee; --muted: #9aa5af; --line: #2f3841; --accent: #6db3f2; --card: #1c2229; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 56rem; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
h1 { font-size: 1.75rem; line-height: 1.25; margin: 0 0 .5rem; }
h2 { font-size: 1.25rem; margin: 2rem 0 .75rem; }
a { color: var(--accent); }
.meta, .note { color: var(--muted); font-size: .9rem; }
.note { font-style: italic; }
nav.top { display: flex; flex-wrap: wrap; gap: .5rem 1.25rem; margin-bottom: 1.25rem; font-size: .95rem; }
ol.steps { list-style: none; counter-reset: step; padding: 0; margin: 1.5rem 0; }
ol.steps > li { counter-increment: step; margin: 0 0 2rem; }
ol.steps > li > p { margin: 0 0 .6rem; font-weight: 600; }
ol.steps > li > p::before { content: counter(step) ". "; color: var(--accent); }
figure { margin: 0; }
figure img { display: block; max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: 6px; background: var(--card); }
ol.chapters { padding-left: 1.4rem; }
ol.chapters li { margin: .4rem 0; }
`;

function htmlPage(lang: DocLang, title: string, body: string): string {
  return `<!doctype html>
<html lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

function languageLinks(lang: DocLang, langs: readonly DocLang[], file: string): string {
  if (langs.length < 2) return '';
  const items = langs.map((other) => (other === lang ? `<strong>${esc(LANGUAGE_NAME[other])}</strong>` : `<a href="../${esc(other)}/${esc(file)}">${esc(LANGUAGE_NAME[other])}</a>`));
  return `<span>${esc(LABELS[lang].languages)}: ${items.join(' · ')}</span>`;
}

function chapterHtml(model: ManualModel, chapter: Chapter, lang: DocLang, langs: readonly DocLang[]): string {
  const labels = LABELS[lang];
  const title = chapterTitle(chapter, lang);
  const intro = chapterIntro(chapter, lang);
  const parts: string[] = [
    `<nav class="top"><a href="index.html">${esc(labels.backToContents)}</a>${languageLinks(lang, langs, `${chapter.routineId}.html`)}</nav>`,
    `<h1>${esc(title.text)}</h1>`,
  ];
  if (title.missing && title.lang) parts.push(`<p class="note">${esc(labels.noText(lang, title.lang))}</p>`);
  if (intro) {
    parts.push(`<p>${esc(intro.text)}</p>`);
    if (intro.missing && intro.lang) parts.push(`<p class="note">${esc(labels.noText(lang, intro.lang))}</p>`);
  }
  parts.push('<ol class="steps">');
  for (const step of chapter.steps) {
    const caption = pickCaption(step.caption, lang);
    const text = caption ? oneLine(caption.text) : '';
    const note = caption?.fallback ? ` <span class="note">(${esc(labels.noText(lang, caption.lang))})</span>` : '';
    const size = step.figure.width > 0 && step.figure.height > 0 ? ` width="${step.figure.width}" height="${step.figure.height}"` : '';
    parts.push(`<li><p>${esc(text)}${note}</p><figure><img src="../${esc(step.figure.file)}" alt="${esc(text)}"${size}></figure></li>`);
  }
  parts.push('</ol>');
  return htmlPage(lang, `${title.text} — ${model.title}`, parts.join('\n'));
}

function indexHtml(model: ManualModel, lang: DocLang, langs: readonly DocLang[]): string {
  const labels = LABELS[lang];
  const items = orderedChapters(model.chapters).map(
    (chapter) => `<li><a href="${esc(chapter.routineId)}.html">${esc(chapterTitle(chapter, lang).text)}</a> <span class="meta">— ${esc(labels.steps(chapter.steps.length))}</span></li>`,
  );
  const body = [
    `<nav class="top">${languageLinks(lang, langs, 'index.html')}</nav>`,
    `<h1>${esc(model.title)}</h1>`,
    `<p class="meta">${esc(labels.build)}: ${esc(model.buildId)} · ${esc(labels.generated)}: ${esc(dateOf(model.createdAt))}</p>`,
    `<h2>${esc(labels.contents)}</h2>`,
    `<ol class="chapters">`,
    ...items,
    `</ol>`,
  ].join('\n');
  return htmlPage(lang, model.title, body);
}

// --- All the files ------------------------------------------------------------------------------------------------------------------

/** Every page of the manual, for each requested language and format, plus the list of figures to review (Markdown, per language). */
export function renderManual(input: RenderInput): RenderedFile[] {
  const { model, formats, changes } = input;
  const langs = DOC_LANGS.filter((lang) => input.langs.includes(lang));
  const files: RenderedFile[] = [];

  for (const lang of langs) {
    if (formats.includes('md')) {
      files.push({ relative: `${lang}/index.md`, data: indexMarkdown(model, lang, langs) });
      for (const chapter of orderedChapters(model.chapters)) files.push({ relative: `${lang}/${chapter.routineId}.md`, data: chapterMarkdown(model, chapter, lang) });
    }
    if (formats.includes('html')) {
      files.push({ relative: `${lang}/index.html`, data: indexHtml(model, lang, langs) });
      for (const chapter of orderedChapters(model.chapters)) files.push({ relative: `${lang}/${chapter.routineId}.html`, data: chapterHtml(model, chapter, lang, langs) });
    }
    files.push({ relative: `${lang}/figures-changed.md`, data: figuresChangedMarkdown(model, changes, lang) });
  }
  return files;
}
