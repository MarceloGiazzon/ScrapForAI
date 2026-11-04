import { z } from 'zod';

import { diffConfigSchema } from './diffConfig.schema.js';
import { buildIdSchema, safeName } from './explorationRequest.schema.js';

/**
 * T6.3 differential execution: the same routine against two target profiles (dev x staging, Java x .NET, GeneXus 17 x 18...) and a
 * comparison of what happened. `left` is the baseline and `right` the candidate: "new console error" means present on the right only.
 */

export const DIFFERENTIAL_DIMENSIONS = ['steps', 'extracted', 'console', 'network', 'timing'] as const;
export type DifferentialDimension = (typeof DIFFERENTIAL_DIMENSIONS)[number];

/** What counts as "the same" and what is noise. Everything is data; patterns are bounded (see diffConfig.schema.ts). */
export const differentialToleranceSchema = z
  .object({
    /**
     * Comparison rules for extracted values (identity keys, masks, numeric tolerance, ignored paths). Masks also clean console messages and
     * network paths. Without it the LEFT profile's own `diff` configuration is used.
     */
    diff: diffConfigSchema.optional(),
    /** A step (or the run) is "slower" when right/left exceeds this ratio... */
    timeRatio: z.number().min(1.1).max(100).default(2),
    /** ...AND the difference is at least this many ms (20 ms -> 60 ms is noise). */
    minTimeDeltaMs: z.number().int().min(0).max(600_000).default(300),
    /**
     * Resource types whose presence is compared in the network shape. Build artefacts (scripts, styles, images, fonts) carry hashed names and
     * change with every build, so by default only the application's own conversations count. An EMPTY list means every type. A failing request
     * (status >= 400 or no answer) of any type is always compared.
     */
    networkResourceTypes: z.array(z.string().min(1).max(30)).max(20).default(['document', 'xhr', 'fetch']),
    /** Dimensions to compare (default all). `timing` is information: it never makes a pair `different`. */
    dimensions: z.array(z.enum(DIFFERENTIAL_DIMENSIONS)).min(1).max(5).default([...DIFFERENTIAL_DIMENSIONS]),
  })
  .strict();
export type DifferentialTolerance = z.infer<typeof differentialToleranceSchema>;
const defaultTolerance = (): DifferentialTolerance => differentialToleranceSchema.parse({});

const sideSchema = z
  .object({
    /** A name for reports ("GeneXus 17", "before the deploy"); defaults to the target profile id. */
    label: z.string().min(1).max(60).optional(),
    targetProfile: safeName,
    /** A credential set of THIS side's profile. Without it the routine's own set is used (which the profile may not allow). */
    credentialSet: safeName.optional(),
    buildId: buildIdSchema.optional(),
  })
  .strict();

export const differentialRequestSchema = z
  .object({
    routines: z
      .array(z.object({ routineId: safeName, version: z.number().int().positive().optional() }).strict())
      .min(1)
      .max(50),
    left: sideSchema,
    right: sideSchema,
    variables: z.record(safeName, z.string().max(5000)).optional(),
    profile: z.enum(['full', 'functional']).optional(),
    /** The evidence of both runs is ephemeral by default; `standard` keeps it STANDARD_RETENTION_DAYS so the diff can be audited. */
    retention: z.enum(['ephemeral', 'standard']).optional(),
    tolerance: differentialToleranceSchema.default(defaultTolerance),
  })
  .strict()
  .superRefine((body, ctx) => {
    const ids = body.routines.map((routine) => routine.routineId);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['routines'], message: 'a routine appears twice' });
  });
export type DifferentialRequest = z.infer<typeof differentialRequestSchema>;

/** `POST /v1/differentials/compare`: compare two runs that already happened (for example before and after a deploy). Synchronous. */
export const differentialCompareRequestSchema = z
  .object({
    leftJobId: z.string().regex(/^job_[A-Za-z0-9_-]{1,64}$/),
    rightJobId: z.string().regex(/^job_[A-Za-z0-9_-]{1,64}$/),
    tolerance: differentialToleranceSchema.default(defaultTolerance),
  })
  .strict();
export type DifferentialCompareRequest = z.infer<typeof differentialCompareRequestSchema>;
