import { z } from 'zod';

import { safeName } from './explorationRequest.schema.js';
import { reportLangSchema } from './integration.schema.js';

/**
 * T9.1: a bug report is a DRAFT of an issue about one failure. One report per failure signature (routine + failing step + error type):
 * the same failure again adds an occurrence to it, it does not make another report. Nothing leaves the server until a person sends it.
 */

export const BUG_REPORT_ID_PATTERN = /^bug_[A-Za-z0-9_-]{1,40}$/;

export const bugReportStatusSchema = z.enum(['draft', 'sent', 'dismissed', 'resolved']);
export type BugReportStatus = z.infer<typeof bugReportStatusSchema>;

export const bugSignatureSchema = z
  .object({
    /** First 16 hex digits of sha256(key). */
    hash: z.string().regex(/^[0-9a-f]{16}$/),
    /** Readable form: `cart-total / step total / StepExecutionError`. */
    key: z.string(),
    /** The library routine, or `scenario:<name>` for a run that is not one. */
    subject: z.string(),
    stepId: z.string(),
    action: z.string().optional(),
    errorType: z.string(),
  })
  .strict();

export const occurrenceSchema = z
  .object({
    jobId: z.string(),
    at: z.string(),
    buildId: z.string().optional(),
    targetProfile: z.string().optional(),
    via: z.enum(['manual', 'schedule']),
  })
  .strict();

export const attemptSchema = z
  .object({
    at: z.string(),
    integrationId: z.string(),
    status: z.enum(['sent', 'failed', 'blocked']),
    httpStatus: z.number().int().optional(),
    reason: z.string().optional(),
  })
  .strict();

export const bugReportSchema = z
  .object({
    id: z.string().regex(BUG_REPORT_ID_PATTERN),
    status: bugReportStatusSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    lang: reportLangSchema,
    signature: bugSignatureSchema,
    /** The run this draft was built from, and the shrink whose result it carries (if any). */
    source: z.object({ jobId: z.string(), shrinkId: z.string().optional() }).strict(),
    targetProfile: safeName.optional(),
    /** What would be sent: already cleaned of vault values, secret shapes and personal data. Checked again right before sending. */
    title: z.string(),
    body: z.string(),
    /** How many strings were replaced while cleaning (0 = nothing needed hiding). */
    redactions: z.number().int().min(0),
    occurrenceCount: z.number().int().min(1),
    /** The newest occurrences (the first one is the run the draft was built from). */
    occurrences: z.array(occurrenceSchema),
    issue: z.object({ integrationId: z.string(), number: z.number().int(), url: z.string(), sentAt: z.string() }).strict().optional(),
    attempts: z.array(attemptSchema),
    /** This failure came back after a report with the same signature was marked resolved. */
    recurrenceOf: z.string().optional(),
    note: z.string().max(500).optional(),
  })
  .strict();

export type BugReport = z.infer<typeof bugReportSchema>;
export type BugSignature = z.infer<typeof bugSignatureSchema>;
export type Occurrence = z.infer<typeof occurrenceSchema>;
export type Attempt = z.infer<typeof attemptSchema>;

/** POST /v1/bug-reports */
export const bugReportRequestSchema = z
  .object({
    fromJobId: z.string().regex(/^job_[A-Za-z0-9_-]{1,64}$/),
    /** A finished shrink of this failure (T5.6): the smallest failing input goes into the report. */
    shrinkId: z.string().regex(/^shrink_[A-Za-z0-9_-]{1,40}$/).optional(),
    lang: reportLangSchema.optional(),
  })
  .strict();

export type BugReportRequest = z.infer<typeof bugReportRequestSchema>;
