import { z } from 'zod';

import { buildIdSchema, safeName } from './explorationRequest.schema.js';
import { routineStatusSchema } from './libraryRoutine.schema.js';
import { seedSchema } from './parameters.schema.js';
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
     * Which routine statuses run. Default: `active` and `quarantined` (T3.5: a quarantined routine runs, but its result does not
     * count towards the verdict and is reported apart); draft/retired routines are listed as not run (with the reason) instead of
     * silently disappearing.
     */
    statuses: z.array(routineStatusSchema).min(1).default(['active', 'quarantined']),
    /**
     * T3.5: how many times a run that FAILED is tried again automatically (0 or 1). Both attempts are kept and shown; the second one decides the
     * variant. Default 0: a suite started by hand fails as it fails. A schedule sets it for the suites it starts. Not applied to quarantined
     * routines (they do not count) or to parametric samples (an edge value fails on purpose and would fail again).
     */
    retries: z.number().int().min(0).max(1).optional(),
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
    /** T5.2: run every variant as `functional` (stand-ins for images/media/fonts, no screenshots, no trace). */
    profile: z.enum(['full', 'functional']).optional(),
    /**
     * T5.4: run every PARAMETRIC routine (one that declares `parameters` or uses a generator, also through an include) once per sample
     * `0..samples-1`: edge values first, then random ones (T5.3). A routine without parameters runs once, since N copies would prove
     * nothing. Absent = no expansion (each routine runs once, with a fresh seed as before).
     */
    samples: z.number().int().min(1).max(100).optional(),
    /** The seed every sample draws from, so the whole table can be replayed. Absent with `samples`: a fresh one, recorded in the state. */
    seed: seedSchema.optional(),
  })
  .strict();

export type SuiteRequest = z.infer<typeof suiteRequestSchema>;

export const variantStatusSchema = z.enum(['pending', 'running', 'passed', 'failed', 'error', 'notRun']);

/** T3.5: one attempt at a variant. Only written when there was more than one: the failed first attempt stays next to the one that decided. */
export const variantAttemptSchema = z
  .object({
    attempt: z.number().int().positive(),
    jobId: z.string(),
    status: z.enum(['passed', 'failed']),
    durationMs: z.number().optional(),
    failedStepIndex: z.number().optional(),
    errorType: z.string().optional(),
    errorMessage: z.string().optional(),
  })
  .strict();

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
    /**
     * T3.5: the routine (or the vault item) is quarantined: it ran, but this result does not count towards the suite's verdict, failFast or
     * exit code, and the report lists it in a block of its own. Pinned when the suite is planned.
     */
    quarantined: z.boolean().optional(),
    /** T3.5: every attempt, when there was more than one. The variant's own fields (jobId, status, error...) are those of the last one. */
    attempts: z.array(variantAttemptSchema).optional(),
    /** T3.5: failed on the first attempt and passed on the new one. Counts as passed, and says so everywhere. */
    passedOnRetry: z.boolean().optional(),
    /** T5.4: the sample index of a parametric variant, the values its parameters took and a bounded copy of what it extracted. */
    sample: z.number().int().min(0).optional(),
    parameters: z.record(z.string(), z.string()).optional(),
    /** Parameters whose values are synthetic identity documents (T5.3): dev/QA only. */
    synthetic: z.array(z.string()).optional(),
    extracted: z.record(z.string(), z.string()).optional(),
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
    /** T5.4: the seed shared by every sample of this suite (the caller's, or the one generated). Absent when the suite used no `samples`/`seed`. */
    seed: z.string().optional(),
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
    /** T3.5: variants that passed only on a new attempt (counted as passed). */
    passedOnRetry: z.number().optional(),
    /** T3.5: what the quarantined variants did. They are not in the verdict. Absent when none was quarantined. */
    quarantine: z.object({ total: z.number(), passed: z.number(), failed: z.number(), error: z.number(), notRun: z.number() }).strict().optional(),
    variants: z.array(variantStateSchema),
  })
  .strict();

export type VariantState = z.infer<typeof variantStateSchema>;
export type SuiteState = z.infer<typeof suiteStateSchema>;
