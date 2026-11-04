import { z } from 'zod';

import { env } from '../config/env.js';
import { actorsSchema, buildIdSchema, explorationOptionsSchema, explorationStepSchema, safeName } from './explorationRequest.schema.js';
import { parametersSchema, parameterValuesSchema, sampleIndexSchema, seedSchema } from './parameters.schema.js';

/**
 * T1.3 library routine. A routine is DATA: this JSON is what gets stored, versioned, reviewed in PRs
 * and executed. Versions are immutable; `sha256` is the digest of the canonical author content.
 *
 * Fields owned by later tasks (actors T6.4, parameters T5.3) were added as optional additions,
 * so routines saved today stay valid.
 */
export const routineStatusSchema = z.enum(['draft', 'active', 'quarantined', 'retired']);

/** T8.4: a convention finding the author accepts on purpose, with the reason. The finding is still listed (as suppressed). */
export const lintSuppressionSchema = z
  .object({ rule: z.string().regex(/^[A-Z]{2,4}[0-9]{3}$/, 'rule code such as GX001'), reason: z.string().min(10).max(300), stepId: z.string().min(1).max(80).optional() })
  .strict();

const contentShape = {
  title: z.string().min(1).max(160),
  description: z.string().max(2000).optional(),
  tags: z.array(z.string().min(1).max(80)).max(50).default([]),
  surface: z.string().min(1).max(160).optional(),
  status: routineStatusSchema.default('active'),
  targetProfile: safeName,
  credentialSet: safeName.optional(),
  // T6.4. Optional with no default, so routines saved before actors existed keep their digest.
  actors: actorsSchema.optional(),
  options: explorationOptionsSchema.optional(),
  // T5.3. Optional with no default, like teardown: a default would change the digest of routines saved before parameters existed.
  parameters: parametersSchema.optional(),
  // T8.4. Optional with no default, so routines saved before the lint keep their digest.
  lintSuppress: z.array(lintSuppressionSchema).max(50).optional(),
  steps: z.array(explorationStepSchema).min(1).max(env.MAX_STEPS_PER_JOB),
  // T1.4. Optional with NO default on purpose: a default would add `teardown: []` to every routine and
  // change the digest of versions saved before teardown existed, failing their integrity check.
  teardown: z.array(explorationStepSchema).min(1).max(env.MAX_STEPS_PER_JOB).optional(),
};

/** What an author supplies (and what the digest covers, together with the id). */
export const routineContentSchema = z.object(contentShape).strict();

export const libraryRoutineSchema = routineContentSchema
  .extend({
    id: safeName,
    version: z.number().int().positive(),
    sha256: z.string().length(64),
    createdBy: z.string().max(200).optional(),
    createdAt: z.string(),
  })
  .strict();

const jobId = z.string().regex(/^job_[A-Za-z0-9_-]{1,64}$/);

/**
 * PUT /v1/routines/:id body, also the MCP save_routine input (plus `id`). Either `steps` or
 * `fromJobId` (copy the steps of a successful run that is still within evidence retention).
 */
export const routineSaveBodyBase = z
  .object({
    title: contentShape.title.optional(),
    description: contentShape.description,
    tags: z.array(z.string().min(1).max(80)).max(50).optional(),
    surface: contentShape.surface,
    status: routineStatusSchema.optional(),
    targetProfile: safeName.optional(),
    credentialSet: safeName.optional(),
    actors: contentShape.actors,
    options: explorationOptionsSchema.optional(),
    parameters: contentShape.parameters,
    lintSuppress: contentShape.lintSuppress,
    steps: contentShape.steps.optional(),
    teardown: contentShape.teardown,
    fromJobId: jobId.optional(),
    createdBy: z.string().max(200).optional(),
  })
  .strict();

type SaveBodyShape = { steps?: unknown; fromJobId?: string; title?: string; targetProfile?: string };

export function refineRoutineSaveBody(body: SaveBodyShape, ctx: z.RefinementCtx): void {
  if ((body.steps === undefined) === (body.fromJobId === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps'], message: 'give exactly one of steps or fromJobId' });
  }

  if (body.fromJobId === undefined) {
    for (const field of ['title', 'targetProfile'] as const) {
      if (body[field] === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} is required unless fromJobId is given` });
      }
    }
  }
}

export const routineSaveBodySchema = routineSaveBodyBase.superRefine(refineRoutineSaveBody);
/** MCP save_routine: the same body plus the routine id. */
export const mcpSaveRoutineSchema = routineSaveBodyBase.extend({ id: safeName }).superRefine(refineRoutineSaveBody);

/** POST /v1/routines/lint body: the content to lint (not stored). `routineId` lets the rules know it is the profile's login routine. */
export const routineLintBodySchema = z
  .object({
    targetProfile: safeName,
    steps: contentShape.steps,
    teardown: contentShape.teardown,
    lintSuppress: contentShape.lintSuppress,
    routineId: safeName.optional(),
  })
  .strict();

/** POST /v1/routines/:id/run body: per-run inputs only; the steps always come from the routine. */
export const routineRunBodySchema = z
  .object({
    variables: z.record(safeName, z.string().max(5000)).optional(),
    credentialSet: safeName.optional(),
    // Run the routine against another profile (e.g. the same flow on qa). Its credential sets still apply.
    targetProfile: safeName.optional(),
    retention: z.enum(['ephemeral', 'standard']).optional(),
    // T5.2: `functional` = stand-ins for images/media/fonts, no screenshots, no trace. Default: what the routine says (full).
    profile: z.enum(['full', 'functional']).optional(),
    // T6.3: also record the requests that succeeded (see options.recordTraffic).
    recordTraffic: z.boolean().optional(),
    // T5.3: replay a run's generated values (the seed is in its result.parameters) or take another sample.
    seed: seedSchema.optional(),
    sample: sampleIndexSchema.optional(),
    // T5.6: exact values for named parameters (a shrunk failure), instead of the seed/sample ones.
    parameterValues: parameterValuesSchema.optional(),
    buildId: buildIdSchema.optional(),
    caller: z
      .object({
        correlationId: z.string().max(200).optional(),
        source: z.string().max(200).optional(),
        metadata: z.record(z.string(), z.string().max(5000)).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type RoutineContent = z.infer<typeof routineContentSchema>;
export type LibraryRoutine = z.infer<typeof libraryRoutineSchema>;
export type RoutineSaveBody = z.infer<typeof routineSaveBodyBase>;
export type RoutineRunBody = z.infer<typeof routineRunBodySchema>;
