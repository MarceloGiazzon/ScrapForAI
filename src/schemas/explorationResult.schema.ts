import { z } from 'zod';

import { callerSchema } from './explorationRequest.schema.js';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]),
);

export const stepStatusSchema = z.enum(['passed', 'failed', 'skipped']);
export type StepStatus = z.infer<typeof stepStatusSchema>;

export const jobStatusSchema = z.enum(['passed', 'failed']);
export type JobStatus = z.infer<typeof jobStatusSchema>;

const errorSchema = z.object({
  type: z.string(),
  message: z.string(),
});

export const stepResultSchema = z.object({
  index: z.number(),
  id: z.string().optional(),
  label: z.string().optional(),
  description: z.string().optional(),
  action: z.string(),
  status: stepStatusSchema,
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number(),
  error: errorSchema.optional(),
});
export type StepResult = z.infer<typeof stepResultSchema>;

export const screenshotEvidenceSchema = z.object({
  name: z.string(),
  path: z.string(),
});
export type ScreenshotEvidence = z.infer<typeof screenshotEvidenceSchema>;

export const consoleEvidenceSchema = z.object({
  type: z.string(),
  text: z.string(),
  location: z
    .object({
      url: z.string().optional(),
      lineNumber: z.number().optional(),
      columnNumber: z.number().optional(),
    })
    .optional(),
});
export type ConsoleEvidence = z.infer<typeof consoleEvidenceSchema>;

export const networkEvidenceSchema = z.object({
  origin: z.string(),
  pathname: z.string(),
  method: z.string(),
  resourceType: z.string().optional(),
  status: z.number().optional(),
  failureText: z.string().optional(),
  unexpectedExternalOrigin: z.boolean().optional(),
});
export type NetworkEvidence = z.infer<typeof networkEvidenceSchema>;

/** T5.1: a request a routing policy touched (aborted or answered) and which policy did. */
export const routingEvidenceSchema = z.object({
  origin: z.string(),
  pathname: z.string(),
  method: z.string(),
  resourceType: z.string().optional(),
  handledBy: z.string(),
  action: z.enum(['abort', 'fulfill']),
});

export const explorationResultSchema = z.object({
  jobId: z.string(),
  scenarioName: z.string().optional(),
  status: jobStatusSchema,
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number(),
  targetUrl: z.string(),
  caller: callerSchema.nullable(),
  /** Present only for a `functional` run (T5.2): screenshots/trace were off and images, media and fonts were stand-ins. */
  profile: z.literal('functional').optional(),
  /** Routines expanded into this run by `include`, with the versions actually used (T1.4). */
  includes: z.array(z.object({ routineId: z.string(), version: z.number().int().positive(), sha256: z.string() })).optional(),
  /** Teardown step results (T1.4), apart from `steps`. Present only when the run had a teardown. */
  teardown: z.array(stepResultSchema).optional(),
  /**
   * Outcome of the teardown. It does NOT change `status`: that stays the verdict of the steps, so a
   * failed cleanup never masks (or manufactures) a test result. Callers that care check this too.
   */
  teardownStatus: z.enum(['passed', 'failed']).optional(),
  /** Build of the application under test, when the caller said (T2.1). */
  buildId: z.string().optional(),
  /** Where `buildId` came from (T3.1): the caller, the profile's `buildInfo` probe, or `unknown` (the probe could not read it). */
  buildIdSource: z.enum(['provided', 'probe', 'unknown']).optional(),
  /** Set when this run is one variant of a suite (T1.6). */
  suite: z.object({ suiteRunId: z.string(), variantKey: z.string() }).optional(),
  /** Set when the run came from a library routine (T1.3). */
  routine: z.object({ id: z.string(), version: z.number().int().positive(), sha256: z.string() }).optional(),
  finalUrl: z.string().optional(),
  failedStepIndex: z.number().optional(),
  error: errorSchema.optional(),
  steps: z.array(stepResultSchema),
  extracted: z.record(z.string(), jsonValueSchema),
  evidence: z.object({
    screenshots: z.array(screenshotEvidenceSchema),
    tracePath: z.string().optional(),
    console: z.array(consoleEvidenceSchema),
    consoleErrors: z.array(consoleEvidenceSchema),
    pageErrors: z.array(z.string()),
    network: z.array(networkEvidenceSchema),
    networkFailures: z.array(networkEvidenceSchema),
    unexpectedExternalRequests: z.array(networkEvidenceSchema),
    // Present only when a routing policy touched at least one request (T5.1).
    routing: z.array(routingEvidenceSchema).optional(),
    domTextSnapshot: z.string().optional(),
    finalUrl: z.string().optional(),
  }),
});
export type ExplorationResult = z.infer<typeof explorationResultSchema>;
