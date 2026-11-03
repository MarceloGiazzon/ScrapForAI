import { z } from 'zod';

import { buildIdSchema, safeName } from './explorationRequest.schema.js';

/**
 * T2.1 regression-vault item: a fixed bug (or hard scenario) together with the routine that proves it
 * and the evidence of the RED and the first GREEN. Compatible in spirit with the NPDev ledger
 * (`id`, `title`, `type`, `severity`, `status`, `opened`, `surface`).
 */
export const ITEM_ID_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;

/** Evidence is PINNED (T1.5), so this reference stays resolvable; the digest is of the signed manifest. */
export const evidenceRefSchema = z
  .object({
    jobId: z.string(),
    at: z.string(),
    buildId: z.string().optional(),
    manifestSha256: z.string().length(64),
  })
  .strict();

export const itemTypeSchema = z.enum(['BUG', 'SCENARIO', 'BOUNDARY']);
export const itemStatusSchema = z.enum(['ACTIVE', 'QUARANTINED', 'RETIRED']);
export const itemSeveritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'P0', 'P1']);

export const lastRunSchema = z
  .object({ jobId: z.string(), status: z.enum(['passed', 'failed']), at: z.string(), buildId: z.string().optional() })
  .strict();

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:.+Z-]+)?$/, 'expected an ISO date (YYYY-MM-DD)');

const itemBase = z
  .object({
    id: z.string().regex(ITEM_ID_PATTERN, 'expected an id like GX-12 or REG-209'),
    title: z.string().min(1).max(300),
    type: itemTypeSchema,
    severity: itemSeveritySchema.nullable(),
    status: itemStatusSchema,
    opened: date,
    surface: z.string().min(1).max(160),
    tags: z.array(z.string().min(1).max(80)).max(50).default([]),
    /** The executable proof: a library routine, at a pinned version. */
    routine: z.object({ id: safeName, version: z.number().int().positive() }).strict(),
    /** Link to an external ledger, e.g. "npdev:REG-209". Optional: not every project has one. */
    ledgerRef: z.string().min(1).max(120).optional(),
    /** Proof the bug existed: the failing run. Null only with a reason (legacy items, or a scenario that was never red). */
    provenRed: evidenceRefSchema.nullable(),
    redNotCapturedReason: z.string().min(1).max(500).optional(),
    /** First passing run on a build with the fix. Null until a fix is confirmed. */
    firstGreen: evidenceRefSchema.nullable(),
    lastRun: lastRunSchema.optional(),
  })
  .strict();

export const regressionItemSchema = itemBase.refine((item) => item.provenRed !== null || (item.redNotCapturedReason ?? '') !== '', {
  path: ['redNotCapturedReason'],
  message: 'an item without provenRed needs redNotCapturedReason',
});

/**
 * PUT /v1/vault/:id: the definition of an item. The evidence fields are NOT writable here; they are
 * set only by the flows that capture them (add-from-run, confirm-green, runs), so nobody can claim a
 * RED or a GREEN that no run produced.
 */
export const regressionItemWriteSchema = itemBase
  .omit({ id: true, provenRed: true, firstGreen: true, lastRun: true })
  .extend({ opened: date.optional() })
  .strict();

export type RegressionItem = z.infer<typeof regressionItemSchema>;
export type RegressionItemWrite = z.infer<typeof regressionItemWriteSchema>;
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

/** POST /v1/vault/add-from-run */
export const addFromRunSchema = z
  .object({
    id: z.string().regex(ITEM_ID_PATTERN),
    fromJobId: z.string().regex(/^job_[A-Za-z0-9_-]{1,64}$/),
    title: z.string().min(1).max(300),
    type: itemTypeSchema.default('BUG'),
    severity: itemSeveritySchema.nullable().default(null),
    surface: z.string().min(1).max(160),
    tags: z.array(z.string().min(1).max(80)).max(50).default([]),
    ledgerRef: z.string().min(1).max(120).optional(),
    /** Library routine to create for the proof. Default: the item id in lower case (REG-209 -> reg-209). */
    routineId: safeName.optional(),
    targetProfile: safeName.optional(),
  })
  .strict();

export const confirmGreenSchema = z.object({ buildId: buildIdSchema.optional() }).strict();

export type AddFromRun = z.infer<typeof addFromRunSchema>;
