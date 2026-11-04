import { z } from 'zod';

import { parameterRecordSchema } from './parameters.schema.js';
import { piiReportSchema } from './pii.schema.js';

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
  /** T6.4: the actor that ran the step, when the step named one. Absent for a step of the implicit `main` actor. */
  actor: z.string().optional(),
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
  /** T6.4: whose page it is (set when the run has actors). */
  actor: z.string().optional(),
});
export type ScreenshotEvidence = z.infer<typeof screenshotEvidenceSchema>;

export const consoleEvidenceSchema = z.object({
  type: z.string(),
  text: z.string(),
  /** T6.4: whose console it is (set in the merged view of a run with actors). */
  actor: z.string().optional(),
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
  /** T6.4: whose request it is (set in the merged view of a run with actors). */
  actor: z.string().optional(),
});
export type NetworkEvidence = z.infer<typeof networkEvidenceSchema>;

/** T6.3: one distinct request the page made (same method, origin, path, type and status), with how many times. Only with `options.recordTraffic`. */
export const trafficEvidenceSchema = networkEvidenceSchema.extend({ count: z.number().int().positive() });
export type TrafficEvidence = z.infer<typeof trafficEvidenceSchema>;

/** T5.1: a request a routing policy touched (aborted or answered) and which policy did. */
export const routingEvidenceSchema = z.object({
  origin: z.string(),
  pathname: z.string(),
  method: z.string(),
  resourceType: z.string().optional(),
  handledBy: z.string(),
  action: z.enum(['abort', 'fulfill', 'delay']),
  detail: z.string().optional(),
  /** T6.4 */
  actor: z.string().optional(),
});

/** T7.3: a change `setClock` made to the clock the page sees. The server's clock is never touched. */
export const clockEvidenceSchema = z.object({
  stepId: z.string().optional(),
  /** T6.4: the actor whose browser clock moved (absent: main). */
  actor: z.string().optional(),
  mode: z.enum(['fixed', 'install']),
  /** ISO instant, as the browser got it. */
  time: z.string(),
  fastForwardMs: z.number().optional(),
});
export type ClockEvidence = z.infer<typeof clockEvidenceSchema>;

/** The evidence of a run, or (T6.4) of one of its actors. */
export const evidenceBlockSchema = z.object({
  screenshots: z.array(screenshotEvidenceSchema),
  tracePath: z.string().optional(),
  console: z.array(consoleEvidenceSchema),
  consoleErrors: z.array(consoleEvidenceSchema),
  pageErrors: z.array(z.string()),
  network: z.array(networkEvidenceSchema),
  networkFailures: z.array(networkEvidenceSchema),
  // T6.3: every distinct request, successful or not, when the run asked for `options.recordTraffic`; `trafficTruncated` when the distinct ones went past the cap.
  traffic: z.array(trafficEvidenceSchema).optional(),
  trafficTruncated: z.boolean().optional(),
  // T8.1: failures left OUT of `networkFailures` as known noise (platform rule or the profile's noiseFilters). `network` keeps every one of them.
  noiseFiltered: z.array(z.object({ reason: z.string(), count: z.number().int().positive() })).optional(),
  unexpectedExternalRequests: z.array(networkEvidenceSchema),
  // Present only when a routing policy touched at least one request (T5.1).
  routing: z.array(routingEvidenceSchema).optional(),
  domTextSnapshot: z.string().optional(),
  finalUrl: z.string().optional(),
});
export type EvidenceBlock = z.infer<typeof evidenceBlockSchema>;

export const explorationResultSchema = z.object({
  jobId: z.string(),
  scenarioName: z.string().optional(),
  status: jobStatusSchema,
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number(),
  targetUrl: z.string(),
  caller: callerSchema.nullable(),
  /** The values the run's parameters took, with the seed that reproduces them (T5.3). Present only when the run used parameters. */
  parameters: parameterRecordSchema.optional(),
  /** Present only for a `functional` run (T5.2): screenshots/trace were off and images, media and fonts were stand-ins. */
  profile: z.literal('functional').optional(),
  /** Present only when a `setClock` step ran (T7.3): the run saw a simulated BROWSER clock; the server's clock was the real one. */
  clock: z.array(clockEvidenceSchema).optional(),
  /** Present only when the run asked for `options.piiScan` (T7.8): personal data and secrets seen where they should not be. Never holds a raw value. */
  pii: piiReportSchema.optional(),
  /** Present only when the target profile's login routine was included for the run (T8.1, platform genexus). */
  autoLogin: z.object({ routineId: z.string(), version: z.number().int().positive(), gate: z.boolean() }).optional(),
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
  /**
   * T6.4: present only when a step named an actor other than `main`. `evidence` below is then the MERGED view of all actors (every item tagged
   * `actor`); here each actor has its own, untagged. Keys are the actor names, in the order they first ran a step.
   */
  actors: z
    .record(
      z.string(),
      z.object({ credentialSet: z.string().optional(), finalUrl: z.string().optional(), stepsRun: z.number().int().nonnegative(), evidence: evidenceBlockSchema }),
    )
    .optional(),
  evidence: evidenceBlockSchema,
});
export type ExplorationResult = z.infer<typeof explorationResultSchema>;
