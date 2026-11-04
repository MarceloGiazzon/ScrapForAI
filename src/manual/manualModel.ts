import { type DocCaption, DOC_LANGS, type DocLang, pickCaption, type RoutineDoc } from '../schemas/docStep.schema.js';
import type { ManualManifest } from '../schemas/manual.schema.js';

/**
 * T9.2: the content of a manual, independent of format and language. PURE: the service reads the runs and hands the facts to these functions.
 */

export interface ChapterStep {
  stepId: string;
  caption: DocCaption;
  figure: { id: string; file: string; width: number; height: number };
}

export interface Chapter {
  routineId: string;
  version: number;
  /** The routine's own `title` (one language): used where `doc.title` has no text for the language. */
  title: string;
  description?: string;
  doc?: RoutineDoc;
  jobId: string;
  steps: ChapterStep[];
}

export interface ManualModel {
  targetProfile: string;
  /** The target profile's name. */
  title: string;
  buildId: string;
  createdAt: string;
  chapters: Chapter[];
}

/** A file name for a step id: letters, digits, dot, dash and underscore only. */
export function slugOfStepId(stepId: string): string {
  const slug = stepId
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return slug === '' ? 'step' : slug;
}

/** `figures/<routineId>/<slug>.png`, relative to the manual folder. */
export const figureFileOf = (routineId: string, stepId: string): string => `figures/${routineId}/${slugOfStepId(stepId)}.png`;

export const figureIdOf = (routineId: string, stepId: string): string => `${routineId}/${stepId}`;

/** Chapters in a stable order: by routine id (prefix the ids with 01-, 02- to choose the order). */
export const orderedChapters = (chapters: readonly Chapter[]): Chapter[] => [...chapters].sort((a, b) => a.routineId.localeCompare(b.routineId));

/** The chapter heading in `lang`: `doc.title` when it has the language (or any other: then `fallback` is true), else the routine's own title. */
export function chapterTitle(chapter: Chapter, lang: DocLang): { text: string; fallback: boolean; lang?: DocLang; missing: boolean } {
  const picked = pickCaption(chapter.doc?.title, lang);
  if (picked) return { text: picked.text, fallback: picked.fallback, lang: picked.lang, missing: picked.fallback };
  // No doc.title at all: the routine's title is all there is, and nothing says what language it is in, so it is not reported as missing.
  return { text: chapter.title, fallback: false, missing: false };
}

export function chapterIntro(chapter: Chapter, lang: DocLang): { text: string; fallback: boolean; lang?: DocLang; missing: boolean } | undefined {
  const picked = pickCaption(chapter.doc?.intro, lang);
  if (picked) return { text: picked.text, fallback: picked.fallback, lang: picked.lang, missing: picked.fallback };
  return chapter.description ? { text: chapter.description, fallback: false, missing: false } : undefined;
}

/** Every caption, title or introduction that has no text in a requested language. */
export function missingCaptionsOf(chapters: readonly Chapter[], langs: readonly DocLang[]): ManualManifest['missingCaptions'] {
  const out: ManualManifest['missingCaptions'] = [];
  for (const chapter of orderedChapters(chapters)) {
    for (const lang of langs) {
      if (chapterTitle(chapter, lang).missing) out.push({ routineId: chapter.routineId, field: 'title', lang });
      if (chapterIntro(chapter, lang)?.missing) out.push({ routineId: chapter.routineId, field: 'intro', lang });
      for (const step of chapter.steps) {
        if (pickCaption(step.caption, lang)?.fallback) out.push({ routineId: chapter.routineId, stepId: step.stepId, field: 'caption', lang });
      }
    }
  }
  return out;
}

export { DOC_LANGS };
