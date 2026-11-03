import { z } from 'zod';

import { buildIdSchema, safeName } from './explorationRequest.schema.js';
import { seedSchema, sampleIndexSchema } from './parameters.schema.js';

/**
 * T5.6 `POST /v1/shrinks`: find the smallest input that still fails. Name the failure by the run that showed it (`fromJobId`: a failed
 * run of a library routine that used parameters, e.g. a variant of a suite with `samples`), or by the routine and the seed + sample
 * that produces it.
 */
export const shrinkRequestSchema = z
  .object({
    fromJobId: z.string().regex(/^job_[A-Za-z0-9_-]{1,64}$/).optional(),
    routineId: safeName.optional(),
    version: z.number().int().positive().optional(),
    seed: seedSchema.optional(),
    sample: sampleIndexSchema.optional(),
    // Per-run inputs the evidence does not keep (variables) or that may differ (credential set, profile, build).
    credentialSet: safeName.optional(),
    targetProfile: safeName.optional(),
    variables: z.record(safeName, z.string().max(5000)).optional(),
    buildId: buildIdSchema.optional(),
    /** `functional` makes each probe faster (no screenshots/trace); the run that proves the minimal input then has no screenshot. */
    profile: z.enum(['full', 'functional']).optional(),
    /** Budget: real runs (the first one, which confirms the failure, counts) and wall-clock seconds. */
    maxShrinkRuns: z.number().int().min(1).max(200).default(30),
    maxShrinkSeconds: z.number().int().min(10).max(3600).default(600),
  })
  .strict()
  .superRefine((body, ctx) => {
    const byRoutine = body.routineId !== undefined || body.seed !== undefined || body.sample !== undefined || body.version !== undefined;
    if (body.fromJobId !== undefined && byRoutine) {
      ctx.addIssue({ code: 'custom', message: 'give fromJobId OR routineId + seed + sample, not both' });
    } else if (body.fromJobId === undefined && (body.routineId === undefined || body.seed === undefined || body.sample === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'give fromJobId, or routineId together with seed and sample' });
    }
  });

export type ShrinkRequest = z.infer<typeof shrinkRequestSchema>;

const shrinkValues = z.record(z.string(), z.string());

export const shrinkResultSchema = z
  .object({
    status: z.enum(['minimal', 'independent', 'not-reproduced', 'budget', 'timeout', 'cancelled', 'error']),
    failing: shrinkValues,
    minimal: shrinkValues,
    minimalJobId: z.string().optional(),
    essential: z.array(z.string()),
    boundaries: z.array(z.object({ parameter: z.string(), fails: z.string(), passes: z.string(), precision: z.enum(['adjacent', 'bracket']) }).strict()),
    runs: z.number().int(),
    trail: z.array(z.object({ run: z.number().int(), what: z.string(), failed: z.boolean(), jobId: z.string().optional() }).strict()),
    error: z.string().optional(),
  })
  .strict();

/** The state of a shrink run as `GET /v1/shrinks/:id` returns it (and `scrapforai shrink --json`). */
export const shrinkStateSchema = z
  .object({
    shrinkId: z.string(),
    status: z.enum(['running', 'completed', 'cancelled', 'interrupted']),
    createdAt: z.string(),
    finishedAt: z.string().optional(),
    request: z.unknown(),
    routine: z.object({ id: z.string(), version: z.number().int() }).strict().optional(),
    signature: z.object({ stepId: z.string(), action: z.string().optional(), errorType: z.string() }).strict().optional(),
    runs: z.number().int(),
    currentValues: shrinkValues.optional(),
    outcome: z.enum(['minimal', 'independent', 'not-reproduced', 'budget', 'timeout', 'cancelled', 'error', 'not-failing', 'no-parameters', 'failed']).optional(),
    result: shrinkResultSchema.optional(),
    summary: z.string().optional(),
    replay: z.object({ routineId: z.string(), version: z.number().int(), parameterValues: shrinkValues }).strict().optional(),
    error: z.string().optional(),
  })
  .strict();
