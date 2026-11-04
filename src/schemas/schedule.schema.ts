import { z } from 'zod';

import { buildIdSchema, safeName } from './explorationRequest.schema.js';
import { suiteRequestSchema } from './suiteRequest.schema.js';

/**
 * T3.2 (Appendix A.9): a schedule says WHEN (cron + time zone) and WHAT (a routine, a suite, the regression vault or a system-evolution
 * snapshot). `overlap: skip` is the only policy: a tick that finds the previous run still going is recorded as skipped, never queued.
 */
export const scheduleTargetSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('routine'),
      routineId: safeName,
      /** Absent = the current version at the moment it fires. */
      version: z.number().int().positive().optional(),
      credentialSet: safeName.optional(),
      targetProfile: safeName.optional(),
      profile: z.enum(['full', 'functional']).optional(),
      buildId: buildIdSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('suite'), suite: suiteRequestSchema }).strict(),
  /** Every ACTIVE regression-vault item (optionally only these tags), as a suite. */
  z.object({ kind: z.literal('vault'), tags: z.array(z.string().min(1)).min(1).optional(), buildId: buildIdSchema.optional() }).strict(),
  z.object({ kind: z.literal('evolutionSnapshot'), targetProfile: safeName, buildId: buildIdSchema.optional() }).strict(),
]);

export const scheduleSchema = z
  .object({
    id: safeName,
    /** Five fields (or a macro such as @daily); see src/scheduler/cron.ts. */
    cron: z.string().min(1).max(120),
    timezone: z.string().min(1).max(80).default('America/Montevideo'),
    target: scheduleTargetSchema,
    enabled: z.boolean().default(true),
    overlap: z.enum(['skip']).default('skip'),
    /** Each occurrence fires up to this many seconds late, a stable amount per (schedule, occurrence): many schedules do not all start at :00. */
    jitterSeconds: z.number().int().min(0).max(600).default(0),
    /** Webhook ids (T3.3). Stored and returned, but nothing is sent until notifications exist. */
    notify: z.array(safeName).max(20).default([]),
    /**
     * T3.5: a run that FAILED is tried once more, automatically (0 = never). Both attempts are runs of their own and both stay in the history and
     * the series: the new attempt never hides the failure. A pass on the second attempt is a pass for the schedule (and for webhooks), recorded as
     * `passedOnRetry`. Applies to routine targets, and to the suites a schedule starts (suite and vault targets) unless the suite sets its own `retries`.
     */
    retries: z.number().int().min(0).max(1).default(1),
  })
  .strict();

/** PUT /v1/schedules/:id: the id comes from the path. */
export const scheduleWriteSchema = scheduleSchema.omit({ id: true });

export type Schedule = z.infer<typeof scheduleSchema>;
export type ScheduleWrite = z.infer<typeof scheduleWriteSchema>;
export type ScheduleTarget = z.infer<typeof scheduleTargetSchema>;

/** What happened at one occurrence. */
export const scheduleOutcomeSchema = z.enum([
  /** Fired; the run is still going. */
  'started',
  'passed',
  'failed',
  /** The run could not execute (credential refused, profile gone, server restarted...). */
  'error',
  /** The previous run was still going. */
  'skipped-overlap',
  /** The target uses evaluate/watch and SCHEDULED_ALLOW_EVALUATE is off. */
  'skipped-evaluate',
  /** The server was down (or the tick late): this occurrence was not run; the latest one of a gap is the recovery run. */
  'missed',
]);

export const scheduleHistoryEntrySchema = z
  .object({
    /** The occurrence this entry is about (ISO instant). */
    at: z.string(),
    firedAt: z.string().optional(),
    finishedAt: z.string().optional(),
    outcome: scheduleOutcomeSchema,
    /** True for the single run that makes up for missed occurrences after downtime. */
    recovered: z.boolean().optional(),
    /** True when started by `run-now`, not by the clock. */
    manual: z.boolean().optional(),
    /** How many occurrences this entry stands for (`missed` entries that summarize a longer gap). */
    count: z.number().int().optional(),
    run: z.object({ kind: z.enum(['run', 'suite', 'snapshot']), id: z.string() }).strict().optional(),
    message: z.string().optional(),
    /** T3.5: every attempt of a routine run, when there was more than one (the first failed). `run` and `outcome` are those of the last. */
    attempts: z.array(z.object({ attempt: z.number().int().positive(), jobId: z.string(), status: z.enum(['passed', 'failed']) }).strict()).optional(),
    /** T3.5: failed on the first attempt, passed on the new one. The outcome is `passed`; this says it was not clean. */
    passedOnRetry: z.boolean().optional(),
  })
  .strict();

export const scheduleStateSchema = z
  .object({
    scheduleId: z.string(),
    /** Every occurrence up to here has been handled (run, skipped or recorded as missed). */
    cursor: z.string(),
    running: z.object({ kind: z.enum(['run', 'suite', 'snapshot']), id: z.string(), startedAt: z.string(), at: z.string() }).strict().optional(),
    history: z.array(scheduleHistoryEntrySchema),
  })
  .strict();

export type ScheduleHistoryEntry = z.infer<typeof scheduleHistoryEntrySchema>;
export type ScheduleState = z.infer<typeof scheduleStateSchema>;
