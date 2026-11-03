import { z } from 'zod';

/**
 * A compact, durable summary of one exploration run.
 *
 * Target size: ~500 bytes serialized. Do NOT add bulky fields (DOM snapshots, console
 * output, network logs, extracted values). Those live in the per-job result.json under
 * ARTIFACT_DIR and are pruned on a much shorter schedule.
 */
export const runSummarySchema = z.object({
  jobId: z.string(),
  scenarioName: z.string().optional(),
  status: z.enum(['passed', 'failed']),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number(),
  targetUrl: z.string(),

  // Mirrors callerSchema in schemas/explorationRequest.schema.ts, which carries
  // correlationId/source/metadata. metadata is deliberately omitted: it is caller-supplied
  // and unbounded in key count, which is exactly the bulk this record must not accumulate.
  /** Teardown outcome when the run had one (T1.4); a failed teardown is invisible in `status`. */
  teardownStatus: z.enum(['passed', 'failed']).optional(),

  /** Suite this run belongs to, and which variant of it (T1.6). */
  suiteRunId: z.string().optional(),
  variantKey: z.string().optional(),

  /** Library routine this run executed (T1.3). */
  routineId: z.string().optional(),
  routineVersion: z.number().optional(),

  callerSource: z.string().optional(),
  callerCorrelationId: z.string().optional(),

  stepCount: z.number(),
  passedSteps: z.number(),
  failedSteps: z.number(),
  skippedSteps: z.number(),
  failedStepIndex: z.number().optional(),

  errorType: z.string().optional(),
  errorMessage: z.string().optional(),

  screenshotCount: z.number(),
  consoleErrorCount: z.number(),
  networkFailureCount: z.number(),
  unexpectedExternalRequestCount: z.number(),

  /** Evidence retention class (T1.5). Runs recorded before classes existed read as ephemeral. */
  retention: z.enum(['ephemeral', 'standard', 'pinned']).default('ephemeral'),
  /** True once the evidence was pinned. Pinned runs are exempt from history pruning too. */
  pinned: z.boolean().default(false),
  pinRef: z.string().optional(),

  /** Relative artifact root, e.g. "artifacts/job_abc123". */
  artifactRelativeRoot: z.string(),
});

export type RunSummary = z.infer<typeof runSummarySchema>;
