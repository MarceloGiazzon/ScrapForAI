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

export const explorationResultSchema = z.object({
  jobId: z.string(),
  scenarioName: z.string().optional(),
  status: jobStatusSchema,
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number(),
  targetUrl: z.string(),
  caller: callerSchema.nullable(),
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
    domTextSnapshot: z.string().optional(),
    finalUrl: z.string().optional(),
  }),
});
export type ExplorationResult = z.infer<typeof explorationResultSchema>;
