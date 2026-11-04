import { z } from 'zod';

/**
 * T7.4 / T7.5: the normalized result of an accessibility audit (axe-core). It says WHICH element breaks WHICH rule, never what the element
 * holds: no HTML, no text, no value. `targetKey` is the element's selector after the T4.1 normalizers (GeneXus row suffix, web component
 * prefix, the profile's masks), so the same control compares equal between two builds.
 */
export const ACCESSIBILITY_STANDARDS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] as const;
export type AccessibilityStandard = (typeof ACCESSIBILITY_STANDARDS)[number];

/** axe tags to run for each standard. Each level includes the ones below it; "best practice" rules are never part of a conformance level. */
export const STANDARD_TAGS: Record<AccessibilityStandard, string[]> = {
  wcag2a: ['wcag2a'],
  wcag2aa: ['wcag2a', 'wcag2aa'],
  wcag21aa: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
  wcag22aa: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
};

export const IMPACTS = ['minor', 'moderate', 'serious', 'critical'] as const;
export type Impact = (typeof IMPACTS)[number];

export const accessibilityFindingSchema = z
  .object({
    ruleId: z.string().min(1).max(100),
    impact: z.enum(IMPACTS),
    /** Identity of the element across builds. Two findings of one rule on elements that normalize alike are told apart as `key`, `key#2`... */
    targetKey: z.string().min(1).max(400),
    /** The selector as axe reported it (nested frames and shadow roots joined with " >> "). For a person to find the element. */
    target: z.string().max(400),
    help: z.string().max(200),
    /** Success criteria, as "1.4.3". */
    wcag: z.array(z.string().max(20)).max(10),
  })
  .strict();
export type AccessibilityFinding = z.infer<typeof accessibilityFindingSchema>;

export const accessibilityAuditSchema = z
  .object({
    kind: z.literal('accessibility-audit'),
    schemaVersion: z.literal(1),
    axeVersion: z.string().max(40),
    standard: z.enum(ACCESSIBILITY_STANDARDS),
    /** CSS selector of the audited subtree, when the step had a scope. */
    scope: z.string().max(300).optional(),
    findings: z.array(accessibilityFindingSchema).max(2000),
    /** Violating rules and elements as axe counted them (more than `findings` when the list was cut). */
    counts: z
      .object({
        rules: z.number().int().nonnegative(),
        elements: z.number().int().nonnegative(),
        critical: z.number().int().nonnegative(),
        serious: z.number().int().nonnegative(),
        moderate: z.number().int().nonnegative(),
        minor: z.number().int().nonnegative(),
      })
      .strict(),
    /** Rules axe could not decide (needs a person), by rule: they are not violations and are not compared. */
    needsReview: z.array(z.object({ ruleId: z.string(), help: z.string().max(200), count: z.number().int().nonnegative() }).strict()).max(200),
    passedRules: z.number().int().nonnegative(),
    /** True when `findings` lists fewer elements than `counts.elements`. A cut list can only under-report, never invent. */
    truncated: z.boolean(),
    notes: z.array(z.string().max(300)).max(10),
  })
  .strict();
export type AccessibilityAudit = z.infer<typeof accessibilityAuditSchema>;

/** The step's `failOn`. */
export const A11Y_FAIL_ON = ['none', 'new', 'serious', 'any'] as const;
export type A11yFailOn = (typeof A11Y_FAIL_ON)[number];

/** Result of comparing an audit with a baseline (T7.5). */
export interface AccessibilityDelta {
  /** Findings that are not in the baseline: regressions. */
  new: AccessibilityFinding[];
  /** Findings that were in the baseline and are gone: fixed. */
  fixed: AccessibilityFinding[];
  /** Findings present in both. */
  unchanged: number;
  /** One side was cut off (`truncated`): "new"/"fixed" may be incomplete, and a finding that fell off the cut would look fixed. */
  incomplete: boolean;
  /** Present only when the two audits ran on different axe-core versions: a "new" finding may then come from a rule that changed, not from the app. */
  axeVersionChanged?: { before: string; after: string };
}

/** What the `auditAccessibility` step writes to `extracted[name]` when it had a baseline (T7.5): the audit plus what changed since. */
export const accessibilityBaselineSchema = z
  .object({
    screen: z.string().max(60),
    buildId: z.string().max(120),
    createdAt: z.string(),
    new: z.array(accessibilityFindingSchema),
    fixed: z.array(accessibilityFindingSchema),
    unchanged: z.number().int().nonnegative(),
    incomplete: z.boolean(),
    axeVersionChanged: z.object({ before: z.string(), after: z.string() }).strict().optional(),
  })
  .strict();
export type AccessibilityBaselineResult = z.infer<typeof accessibilityBaselineSchema>;

export const accessibilityResultSchema = accessibilityAuditSchema.extend({ baseline: accessibilityBaselineSchema.optional() });
export type AccessibilityResult = z.infer<typeof accessibilityResultSchema>;
