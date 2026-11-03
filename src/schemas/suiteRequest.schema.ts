import { z } from 'zod';

import { buildIdSchema, safeName } from './explorationRequest.schema.js';
import { routineStatusSchema } from './libraryRoutine.schema.js';
import { itemStatusSchema, itemTypeSchema } from './regressionItem.schema.js';

/**
 * T1.6 suite request: which saved routines to run, multiplied by credential sets and target
 * profiles. Only what exists today: regression-vault items (T2.x), parametric samples (T5.4) and
 * impact ordering (T2.3) join this schema, optionally, when those tasks land.
 */
export const suiteItemSchema = z
  .object({
    routineId: safeName,
    /** Pin a version. Absent = the version that is current WHEN THE SUITE STARTS (then fixed for the whole suite). */
    version: z.number().int().positive().optional(),
  })
  .strict();

/** Every regression-vault item matching the filter (default: ACTIVE ones) becomes a run of its pinned routine. */
export const suiteVaultItemSchema = z
  .object({
    vault: z
      .object({
        status: z.array(itemStatusSchema).min(1).optional(),
        type: z.array(itemTypeSchema).min(1).optional(),
        tags: z.array(z.string().min(1)).min(1).optional(),
        surface: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict();

export const suiteRequestSchema = z
  .object({
    name: z.string().min(1).max(160),
    items: z.array(z.union([suiteItemSchema, suiteVaultItemSchema])).min(1).max(200),
    variants: z
      .object({
        /** Run every item once per credential set (e.g. one per GAM role). */
        credentialSets: z.array(safeName).min(1).max(20).optional(),
        /** Run every item once per target profile (e.g. dev and qa). */
        targetProfiles: z.array(safeName).min(1).max(20).optional(),
      })
      .strict()
      .optional(),
    /**
     * Which routine statuses run. Default: only `active`; quarantined/draft/retired routines are listed
     * as not run (with the reason) instead of silently disappearing.
     */
    statuses: z.array(routineStatusSchema).min(1).default(['active']),
    /**
     * `impact`: order the regression-vault items by how likely they are to break (T2.3) using `impact`; routine
     * items keep their place, before them. Each run records why it is where it is.
     */
    order: z.enum(['asIs', 'impact']).default('asIs'),
    impact: z
      .object({ changedFiles: z.array(z.string().min(1).max(500)).max(5000).optional(), surfaces: z.array(z.string().min(1)).max(100).optional() })
      .strict()
      .optional(),
    /** Build of the application under test; recorded in every run and in the evidence it pins. */
    buildId: buildIdSchema.optional(),
    mode: z.enum(['sequential', 'parallel']).default('sequential'),
    /** Parallel mode only. Capped by the server's slots, and by credential locks (one session per credential). */
    concurrency: z.number().int().min(1).max(20).optional(),
    /** Stop starting new variants at the first red one; the rest are listed as not run. */
    failFast: z.boolean().default(false),
    retention: z.enum(['ephemeral', 'standard']).optional(),
  })
  .strict();

export type SuiteRequest = z.infer<typeof suiteRequestSchema>;

export const variantStatusSchema = z.enum(['pending', 'running', 'passed', 'failed', 'error', 'notRun']);

export const variantStateSchema = z
  .object({
    variantKey: z.string(),
    routineId: z.string(),
    routineVersion: z.number().int().positive(),
    /** Set when the run comes from a regression-vault item (T2.1). */
    vaultItemId: z.string().optional(),
    /** With order "impact": the position and why (T2.3). */
    order: z.object({ position: z.number(), reasons: z.array(z.string()) }).strict().optional(),
    credentialSet: z.string().optional(),
    targetProfile: z.string().optional(),
    status: variantStatusSchema,
    jobId: z.string().optional(),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
    durationMs: z.number().optional(),
    failedStepIndex: z.number().optional(),
    /** `failed`: the step error type. `error`: why the run could not happen at all. */
    errorType: z.string().optional(),
    errorMessage: z.string().optional(),
    teardownStatus: z.enum(['passed', 'failed']).optional(),
    notRunReason: z.string().optional(),
  })
  .strict();

export const suiteStateSchema = z
  .object({
    suiteRunId: z.string(),
    name: z.string(),
    status: z.enum(['running', 'completed', 'cancelled', 'interrupted']),
    createdAt: z.string(),
    finishedAt: z.string().optional(),
    request: suiteRequestSchema,
    total: z.number(),
    counts: z.object({ pending: z.number(), running: z.number(), passed: z.number(), failed: z.number(), error: z.number(), notRun: z.number() }).strict(),
    /**
     * One verdict for the whole suite, set when it ends. `green`: every variant that ran passed.
     * `red`: some failed. `infra-error`: some could not run (credential refused, vault unreadable, job
     * timeout...), or the suite was cancelled/interrupted. The CLI exit code is 0 / 1 / 2 respectively.
     */
    verdict: z.enum(['green', 'red', 'infra-error']).optional(),
    verdictReason: z.string().optional(),
    exitCode: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
    /** Variants whose steps passed but whose teardown failed: not red, but data may have been left behind. */
    teardownFailures: z.number().optional(),
    variants: z.array(variantStateSchema),
  })
  .strict();

export type VariantState = z.infer<typeof variantStateSchema>;
export type SuiteState = z.infer<typeof suiteStateSchema>;
