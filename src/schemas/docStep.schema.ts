import { z } from 'zod';

/**
 * T9.2: the "living manual". A routine tagged `doc` is also a piece of documentation: its steps carry a caption per language and may name an element
 * to highlight, and `scrapforai manual build` runs the routines and turns the figures and captions into Markdown/HTML.
 *
 * PURE: no configuration, no I/O. `explorationRequest.schema.ts` imports this file, never the other way round.
 */

/** The tag that makes a library routine part of the manual of its target profile. */
export const DOC_TAG = 'doc';

/** Languages of a manual, in the order a missing caption falls back to (the requested one first, then these). */
export const DOC_LANGS = ['en', 'pt', 'es'] as const;
export type DocLang = (typeof DOC_LANGS)[number];

/** Plain text, never markup: the builder escapes it for Markdown and HTML. A caption is published, so it is linted like a step literal. */
const captionText = z.string().trim().min(1).max(500);

/** One text per language; at least one. A language that is missing is reported by the build, never filled in silently. */
export const docCaptionSchema = z
  .object({ pt: captionText.optional(), es: captionText.optional(), en: captionText.optional() })
  .strict()
  .refine((caption) => caption.pt !== undefined || caption.es !== undefined || caption.en !== undefined, { message: 'give the caption in at least one language (pt, es, en)' });
export type DocCaption = z.infer<typeof docCaptionSchema>;

/**
 * `doc` on a STEP. The figure is a screenshot of the page (the viewport the run has, so set it with `setViewport` for a stable size) with `highlight` drawn
 * around the element(s) it matches. It is only taken when the run asks for it (`options.docFigures`, which `manual build` sets): in any other run `doc` is
 * inert metadata and the run is exactly what it always was.
 *
 *  - `when`: `before` the step acts (the element you are about to click is visible and highlighted; a field still empty) or `after` it. Default: `before`
 *    for the steps that act on one element (click, fill, ...), `after` for the rest (goto, waits, asserts...), see `defaultDocWhen`.
 *  - `fullPage`: the whole page instead of the viewport.
 */
export const docStepSchema = z
  .object({
    caption: docCaptionSchema,
    highlight: z.string().min(1).max(500).optional(),
    when: z.enum(['before', 'after']).optional(),
    fullPage: z.boolean().optional(),
  })
  .strict();
export type DocStep = z.infer<typeof docStepSchema>;

/** `doc` on a ROUTINE: the chapter heading and a short introduction per language. Without it the chapter uses the routine's `title` / `description` as they are. */
export const routineDocSchema = z.object({ title: docCaptionSchema.optional(), intro: docCaptionSchema.optional() }).strict();
export type RoutineDoc = z.infer<typeof routineDocSchema>;

/** Steps that act on ONE element the reader is about to touch: their figure is taken before the action by default. */
const ACTS_ON_AN_ELEMENT: ReadonlySet<string> = new Set(['click', 'doubleClick', 'hover', 'press', 'fill', 'selectOption', 'check', 'uncheck']);

export function defaultDocWhen(action: string): 'before' | 'after' {
  return ACTS_ON_AN_ELEMENT.has(action) ? 'before' : 'after';
}

/** What the step's `doc.when` really is. */
export function docWhenOf(step: { action: string; doc?: { when?: 'before' | 'after' } }): 'before' | 'after' {
  return step.doc?.when ?? defaultDocWhen(step.action);
}

/** Every caption text a step or routine carries (for the secret lint: a caption is published in a manual). */
export function captionTexts(caption: DocCaption | undefined): string[] {
  return caption ? DOC_LANGS.map((lang) => caption[lang]).filter((text): text is string => text !== undefined) : [];
}

/** The text for `lang`, or the first language that has one (the order of `DOC_LANGS`); `fallback` says the requested language was missing. */
export function pickCaption(caption: DocCaption | undefined, lang: DocLang): { text: string; lang: DocLang; fallback: boolean } | undefined {
  if (!caption) return undefined;
  if (caption[lang] !== undefined) return { text: caption[lang]!, lang, fallback: false };
  const other = DOC_LANGS.find((candidate) => caption[candidate] !== undefined);
  return other ? { text: caption[other]!, lang: other, fallback: true } : undefined;
}
