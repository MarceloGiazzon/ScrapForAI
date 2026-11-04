import { compileDiffConfig, type CompiledNormalizers, maskText, normalizeKey } from '../diff/normalizers.js';
import type { DiffConfigInput } from '../schemas/diffConfig.schema.js';
import {
  type AccessibilityAudit,
  type AccessibilityDelta,
  type AccessibilityFinding,
  type AccessibilityStandard,
  IMPACTS,
  type Impact,
} from '../schemas/accessibility.schema.js';

/**
 * T7.4 / T7.5, the pure half: what the in-page axe run answered becomes a normalized audit, and two audits become "new" and "fixed". No I/O, no
 * configuration import, no browser: unit-tested with literal answers.
 */

/** What the trusted script `a11y-axe` returns (see src/runner/trusted/scripts/axe.ts). */
export interface RawAxeAnswer {
  scopeFound: boolean;
  axeVersion?: string;
  violations?: Array<{ ruleId: string; impact: string; help: string; wcag: string[]; total: number; targets: string[] }>;
  needsReview?: Array<{ ruleId: string; help: string; count: number }>;
  passedRules?: number;
  truncated?: boolean;
}

const ID_TOKEN = /#((?:[A-Za-z0-9_-]|\\.)+)/g;
const ID_ATTRIBUTE = /\[id=(["'])(.*?)\1\]/g;

/**
 * A selector made comparable between builds (T4.1): inside every `#id` and `[id="..."]` the GeneXus web-component prefix (`W0012vNAME`) and
 * grid-row suffix (`vNAME_0001`) are removed, then the profile's mask patterns run over the whole text. What the selector says about
 * position (`:nth-child(3)`) is kept: a violation in the third row is not the same finding as one in the fourth.
 */
export function normalizeSelector(selector: string, normalizers: CompiledNormalizers): string {
  const ids = selector
    .replace(ID_TOKEN, (_whole, id: string) => `#${normalizeKey(id, normalizers)}`)
    .replace(ID_ATTRIBUTE, (_whole, quote: string, id: string) => `[id=${quote}${normalizeKey(id, normalizers)}${quote}]`);
  return maskText(ids, normalizers);
}

const isImpact = (value: string): value is Impact => (IMPACTS as readonly string[]).includes(value);
export const impactRank = (impact: Impact): number => IMPACTS.indexOf(impact);

export interface NormalizeOptions {
  standard: AccessibilityStandard;
  scope?: string;
  /** Only these axe rule ids are kept (the step's `rules`). */
  rules?: string[];
  /** The target profile's `diff` configuration. */
  diff?: DiffConfigInput;
}

export function normalizeAxeAnswer(raw: RawAxeAnswer, options: NormalizeOptions): AccessibilityAudit {
  const normalizers = compileDiffConfig(options.diff ?? {});
  const wanted = options.rules && options.rules.length > 0 ? new Set(options.rules) : undefined;
  const violations = (raw.violations ?? []).filter((rule) => !wanted || wanted.has(rule.ruleId));

  const findings: AccessibilityFinding[] = [];
  const seen = new Map<string, number>();
  for (const rule of violations) {
    const impact: Impact = isImpact(rule.impact) ? rule.impact : 'minor';
    for (const target of rule.targets) {
      const base = normalizeSelector(target, normalizers).slice(0, 380) || '(document)';
      // Elements that normalize alike (grid rows) stay separate findings: `key`, `key#2`... in the order axe listed them.
      const identity = `${rule.ruleId}|${base}`;
      const occurrence = (seen.get(identity) ?? 0) + 1;
      seen.set(identity, occurrence);
      findings.push({
        ruleId: rule.ruleId,
        impact,
        targetKey: occurrence === 1 ? base : `${base}#${occurrence}`,
        target: target.slice(0, 400),
        help: rule.help,
        wcag: rule.wcag,
      });
    }
  }
  findings.sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : a.targetKey < b.targetKey ? -1 : a.targetKey > b.targetKey ? 1 : 0));

  const counts = { rules: violations.length, elements: 0, critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const rule of violations) {
    const impact: Impact = isImpact(rule.impact) ? rule.impact : 'minor';
    counts.elements += rule.total;
    counts[impact] += rule.total;
  }

  const shown = findings.length;
  const truncated = (raw.truncated ?? false) || shown < counts.elements;
  const notes: string[] = [];
  if (truncated) notes.push(`Only ${shown} of ${counts.elements} violating element(s) are listed; the totals above are complete.`);
  if (options.scope) notes.push(`Only the subtree matching "${options.scope.slice(0, 120)}" was audited.`);
  if (wanted) notes.push(`Only these rules are reported: ${[...wanted].slice(0, 20).join(', ')}.`);

  return {
    kind: 'accessibility-audit',
    schemaVersion: 1,
    axeVersion: raw.axeVersion ?? 'unknown',
    standard: options.standard,
    ...(options.scope ? { scope: options.scope.slice(0, 300) } : {}),
    findings,
    counts,
    needsReview: (raw.needsReview ?? []).filter((rule) => !wanted || wanted.has(rule.ruleId)),
    passedRules: raw.passedRules ?? 0,
    truncated,
    notes,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// T7.5: baseline comparison

const identityOf = (finding: AccessibilityFinding): string => `${finding.ruleId}|${finding.targetKey}`;

export type Comparison = { comparable: true; delta: AccessibilityDelta } | { comparable: false; reason: string };

/**
 * `before` is the baseline, `after` the audit being judged. A finding is the same finding when rule and normalized target are the same; its impact
 * may change without making it new. Two audits taken against different WCAG levels or scopes are not comparable: a level that adds rules
 * would call every one of its findings "new".
 */
export function compareAudits(before: AccessibilityAudit, after: AccessibilityAudit): Comparison {
  if (before.standard !== after.standard) {
    return { comparable: false, reason: `the baseline was taken with ${before.standard}, this audit uses ${after.standard}` };
  }
  if ((before.scope ?? '') !== (after.scope ?? '')) {
    return { comparable: false, reason: 'the baseline and this audit cover different parts of the page (scope)' };
  }

  const was = new Map(before.findings.map((finding) => [identityOf(finding), finding]));
  const now = new Map(after.findings.map((finding) => [identityOf(finding), finding]));
  const created = after.findings.filter((finding) => !was.has(identityOf(finding)));
  const fixed = before.findings.filter((finding) => !now.has(identityOf(finding)));
  const byImpactThenKey = (a: AccessibilityFinding, b: AccessibilityFinding): number =>
    impactRank(b.impact) - impactRank(a.impact) || (identityOf(a) < identityOf(b) ? -1 : identityOf(a) > identityOf(b) ? 1 : 0);

  return {
    comparable: true,
    delta: {
      new: created.sort(byImpactThenKey),
      fixed: fixed.sort(byImpactThenKey),
      unchanged: after.findings.length - created.length,
      incomplete: before.truncated || after.truncated,
      ...(before.axeVersion !== after.axeVersion ? { axeVersionChanged: { before: before.axeVersion, after: after.axeVersion } } : {}),
    },
  };
}

/** Why a step with `failOn` fails, or undefined. `delta` is needed for `new`. */
export function failureFor(failOn: 'none' | 'new' | 'serious' | 'any', audit: AccessibilityAudit, delta?: AccessibilityDelta): string | undefined {
  switch (failOn) {
    case 'none':
      return undefined;
    case 'any':
      return audit.counts.elements > 0 ? `${audit.counts.elements} accessibility violation(s) in ${audit.counts.rules} rule(s)` : undefined;
    case 'serious': {
      const severe = audit.counts.serious + audit.counts.critical;
      return severe > 0 ? `${severe} serious or critical accessibility violation(s)` : undefined;
    }
    case 'new': {
      if (!delta || delta.new.length === 0) return undefined;
      const rules = [...new Set(delta.new.map((finding) => finding.ruleId))].slice(0, 5).join(', ');
      return `${delta.new.length} new accessibility violation(s) since the baseline (${rules})`;
    }
  }
}
