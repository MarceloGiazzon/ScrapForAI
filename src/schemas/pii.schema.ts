import { z } from 'zod';

import { PII_DETECTORS, PII_SURFACES } from '../security/piiDetectors.js';
import { PII_FAIL_LEVELS, PII_SEVERITIES } from '../security/piiFindings.js';

/** T7.8: the finding of a PII scan. No field holds the raw value (see src/security/piiFindings.ts). */
export const piiFindingSchema = z.object({
  detector: z.enum(PII_DETECTORS),
  surface: z.enum(PII_SURFACES),
  location: z.string(),
  maskedSample: z.string(),
  /** HMAC-SHA256 of the value under a secret of the installation: the same value gives the same fingerprint, and it cannot be reversed by trying candidates. */
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  severity: z.enum(PII_SEVERITIES),
  count: z.number().int().positive(),
  severityReason: z.string().optional(),
});

/** What a scan looked at, so "no findings" is never read as "did not look". */
const scannedSchema = z.object({
  urls: z.number().int(),
  console: z.number().int(),
  responseBodies: z.number().int(),
  responseBodiesSkipped: z.number().int(),
  storageEntries: z.number().int(),
  /** Entries of the browser's cookie jar that were looked at. (Not called `cookies`: a result is redacted by key name.) */
  jarEntries: z.number().int(),
  hiddenInputs: z.number().int(),
});

export const piiReportSchema = z.object({
  kind: z.literal('pii-scan'),
  findings: z.array(piiFindingSchema),
  counts: z.object({
    total: z.number().int(),
    bySeverity: z.record(z.enum(PII_SEVERITIES), z.number().int()),
    byDetector: z.array(z.object({ detector: z.enum(PII_DETECTORS), count: z.number().int() })),
    bySurface: z.array(z.object({ surface: z.enum(PII_SURFACES), count: z.number().int() })),
  }),
  scanned: scannedSchema,
  /** True when findings were dropped past the cap. */
  truncated: z.boolean(),
  /** Surfaces that could not be read and why, in words (never a value). */
  notes: z.array(z.string()),
  /** T7.9: findings a profile suppression hid, with its reason; never silently dropped. */
  suppressed: z
    .array(
      z.object({
        detector: z.enum(PII_DETECTORS),
        surface: z.enum(PII_SURFACES),
        location: z.string(),
        suppression: z.string(),
        reason: z.string(),
        until: z.string(),
      }),
    )
    .optional(),
});
export type PiiReport = z.infer<typeof piiReportSchema>;

export { PII_FAIL_LEVELS };
