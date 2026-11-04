import { z } from 'zod';

import { PII_DETECTORS, PII_SURFACES } from '../security/piiDetectors.js';
import { PII_SEVERITIES } from '../security/piiFindings.js';

/**
 * T7.9: what a target profile says about the findings of the PII hunt (T7.8).
 *
 *  - `severity`: how serious a detector is on a surface for THIS application ("an e-mail on the profile screen is informative"). The most specific
 *    rule wins (detector + surface, then detector or surface alone); among equals, the later one.
 *  - `suppressions`: findings that are EXPECTED. Each needs a reason and an expiry date, so "expected" is a decision that gets looked at again, not a
 *    permanent blind spot. A suppressed finding is still listed in the report (with the reason), never counted, never fails a step.
 *
 * `known-secret` (a value of the credential vault seen on a page) can be neither suppressed nor re-rated: it is always somebody's problem.
 */

export const POLICY_DETECTORS = PII_DETECTORS.filter((detector) => detector !== 'known-secret') as unknown as [(typeof PII_DETECTORS)[number], ...(typeof PII_DETECTORS)[number][]];

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'until: a date as YYYY-MM-DD')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), { message: 'until: not a real calendar date' });

export const piiSeverityRuleSchema = z
  .object({
    detector: z.enum(POLICY_DETECTORS).optional(),
    surface: z.enum(PII_SURFACES).optional(),
    severity: z.enum(PII_SEVERITIES),
    note: z.string().min(1).max(300).optional(),
  })
  .strict()
  .refine((rule) => rule.detector !== undefined || rule.surface !== undefined, { message: 'a rule needs a detector, a surface or both (a rule for everything is just a different default)' });

export const piiSuppressionSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
    /** Required: there is no "suppress everything". */
    detector: z.enum(POLICY_DETECTORS),
    surface: z.enum(PII_SURFACES).optional(),
    /** A literal fragment of the finding's location (the masked one), for example "/perfil". */
    locationContains: z.string().min(1).max(200).optional(),
    reason: z.string().min(10, 'say why this is expected (at least 10 characters)').max(500),
    /** Last day (UTC) the suppression applies. After it the finding counts again. */
    until: isoDate,
  })
  .strict();

export const piiPolicySchema = z
  .object({
    severity: z.array(piiSeverityRuleSchema).max(50).default([]),
    suppressions: z.array(piiSuppressionSchema).max(100).default([]),
  })
  .strict()
  .superRefine((policy, ctx) => {
    const seen = new Set<string>();
    policy.suppressions.forEach((suppression, index) => {
      if (seen.has(suppression.id)) ctx.addIssue({ code: 'custom', path: ['suppressions', index, 'id'], message: `duplicate suppression id "${suppression.id}"` });
      seen.add(suppression.id);
    });
  });

export type PiiPolicy = z.infer<typeof piiPolicySchema>;
export type PiiSuppression = z.infer<typeof piiSuppressionSchema>;
