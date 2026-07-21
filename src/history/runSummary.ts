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

  /** Relative artifact root, e.g. "artifacts/job_abc123". */
  artifactRelativeRoot: z.string(),
});

export type RunSummary = z.infer<typeof runSummarySchema>;
