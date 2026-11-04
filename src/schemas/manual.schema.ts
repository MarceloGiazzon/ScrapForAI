import { z } from 'zod';

import { DOC_LANGS } from './docStep.schema.js';
import { buildIdSchema, safeName } from './explorationRequest.schema.js';

/** T9.2: the living manual. A build runs the `doc` routines of one target profile and writes Markdown/HTML plus the figures. */

export const MANUAL_BUILD_ID_PATTERN = /^man_[A-Za-z0-9_-]{1,40}$/;
export const MANUAL_FORMATS = ['md', 'html'] as const;
export type ManualFormat = (typeof MANUAL_FORMATS)[number];

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;

/** POST /v1/manual/builds. */
export const manualBuildBodySchema = z
  .object({
    targetProfile: safeName,
    /** Languages to write, in this order of preference when a caption is missing in one. Default: English. */
    langs: z.array(z.enum(DOC_LANGS)).min(1).max(DOC_LANGS.length).refine(unique, { message: 'each language once' }).default(['en']),
    formats: z.array(z.enum(MANUAL_FORMATS)).min(1).max(MANUAL_FORMATS.length).refine(unique, { message: 'each format once' }).default(['md', 'html']),
    /** The build of the application the figures show (default: what the runs report, see buildContext). */
    buildId: buildIdSchema.optional(),
    variables: z.record(safeName, z.string().max(5000)).optional(),
  })
  .strict();
export type ManualBuildBody = z.infer<typeof manualBuildBodySchema>;

const figureChangeReason = z.enum(['resized', 'visual', 'bytes']);

export const manualFigureSchema = z
  .object({
    /** `<routineId>/<stepId>`: what the list of changed figures is keyed by. */
    id: z.string().min(3).max(200),
    routineId: safeName,
    stepId: z.string().min(1).max(80),
    /** Relative to the target's manual folder, forward slashes. */
    file: z.string().min(1).max(300),
    sha256: z.string().length(64),
    width: z.number().int().min(0),
    height: z.number().int().min(0),
    /** base64 of the 32x32 luminance grid (src/manual/figureHash.ts); absent when the PNG could not be decoded. */
    fingerprint: z.string().max(2000).optional(),
  })
  .strict();
export type ManualFigure = z.infer<typeof manualFigureSchema>;

export const figureChangeSetSchema = z
  .object({
    /** No earlier build of this manual: every figure is new, nothing is "changed". */
    firstBuild: z.boolean(),
    previousBuildId: z.string().optional(),
    previousCreatedAt: z.string().optional(),
    new: z.array(z.string()),
    removed: z.array(z.string()),
    changed: z.array(
      z
        .object({ id: z.string(), reason: figureChangeReason, changedCells: z.number().int().optional(), totalCells: z.number().int().optional(), percent: z.number().optional() })
        .strict(),
    ),
    /** Bytes differ but no visible cell moved: probably rendering noise. Listed, never hidden. */
    negligible: z.array(z.string()),
    unchanged: z.number().int().min(0),
  })
  .strict();
export type FigureChangeSet = z.infer<typeof figureChangeSetSchema>;

/** `<target>/manual.json`: what the last build wrote. Written last, so it only ever describes a build that finished. */
export const manualManifestSchema = z
  .object({
    manualVersion: z.literal(1),
    targetProfile: safeName,
    title: z.string().max(200),
    buildId: z.string(),
    buildIdSource: z.string().optional(),
    createdAt: z.string(),
    langs: z.array(z.enum(DOC_LANGS)),
    formats: z.array(z.enum(MANUAL_FORMATS)),
    routines: z.array(z.object({ id: safeName, version: z.number().int().positive(), title: z.string(), jobId: z.string(), figures: z.number().int().min(0) }).strict()),
    figures: z.array(manualFigureSchema),
    changes: figureChangeSetSchema,
    /** Captions that are not written in a requested language (the build shows another one, marked). */
    missingCaptions: z.array(z.object({ routineId: safeName, stepId: z.string().optional(), field: z.enum(['caption', 'title', 'intro']), lang: z.enum(DOC_LANGS) }).strict()),
    /** Every file the build wrote, relative to the target folder. The next build removes the ones it no longer writes, and ONLY those. */
    files: z.array(z.string()),
  })
  .strict();
export type ManualManifest = z.infer<typeof manualManifestSchema>;
