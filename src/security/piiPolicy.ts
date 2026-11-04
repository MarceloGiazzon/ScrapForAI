import type { PiiPolicy, PiiSuppression } from '../schemas/piiPolicy.schema.js';
import { type PiiFinding, SEVERITY_RANK } from './piiFindings.js';

/**
 * T7.9: applies a target profile's PII policy to the findings of a scan. PURE (the clock comes in as a parameter).
 *
 * Order: severity rules first (they decide how serious a finding is), then suppressions (they decide whether it counts). A suppressed finding is moved
 * out of `findings` into `suppressed`, with the suppression's id, reason and expiry: it stays visible in the report and never fails a step.
 * A suppression past its `until` day is ignored and reported in `expired`, so the finding counts again and somebody is told why.
 */

export interface SuppressedFinding {
  detector: PiiFinding['detector'];
  surface: PiiFinding['surface'];
  location: string;
  suppression: string;
  reason: string;
  until: string;
}

export interface PolicyResult {
  findings: PiiFinding[];
  suppressed: SuppressedFinding[];
  /** Suppressions that matched nothing today only because they ran out. */
  expired: Array<{ id: string; until: string }>;
}

const todayUtc = (now: Date): string => now.toISOString().slice(0, 10);

function matches(suppression: PiiSuppression, finding: PiiFinding): boolean {
  return (
    suppression.detector === finding.detector &&
    (suppression.surface === undefined || suppression.surface === finding.surface) &&
    (suppression.locationContains === undefined || finding.location.includes(suppression.locationContains))
  );
}

export function applyPiiPolicy(findings: readonly PiiFinding[], policy: PiiPolicy | undefined, now: Date = new Date()): PolicyResult {
  if (!policy || (policy.severity.length === 0 && policy.suppressions.length === 0)) return { findings: [...findings], suppressed: [], expired: [] };

  const today = todayUtc(now);
  const active = policy.suppressions.filter((suppression) => suppression.until >= today);
  const lapsed = policy.suppressions.filter((suppression) => suppression.until < today);
  const kept: PiiFinding[] = [];
  const suppressed: SuppressedFinding[] = [];
  const expiredHit = new Map<string, string>();

  for (const original of findings) {
    // Most specific rule wins; among equally specific ones, the later.
    let chosen: { specificity: number; severity: PiiFinding['severity']; note?: string } | undefined;
    for (const rule of policy.severity) {
      if ((rule.detector !== undefined && rule.detector !== original.detector) || (rule.surface !== undefined && rule.surface !== original.surface)) continue;
      const specificity = (rule.detector === undefined ? 0 : 1) + (rule.surface === undefined ? 0 : 1);
      if (!chosen || specificity >= chosen.specificity) chosen = { specificity, severity: rule.severity, ...(rule.note ? { note: rule.note } : {}) };
    }
    const finding: PiiFinding =
      chosen && chosen.severity !== original.severity
        ? { ...original, severity: chosen.severity, severityReason: `profile policy: ${original.severity} -> ${chosen.severity}${chosen.note ? ` (${chosen.note})` : ''}` }
        : { ...original };

    const hit = active.find((suppression) => matches(suppression, finding));
    if (hit) {
      suppressed.push({ detector: finding.detector, surface: finding.surface, location: finding.location, suppression: hit.id, reason: hit.reason, until: hit.until });
      continue;
    }
    for (const suppression of lapsed) if (matches(suppression, finding)) expiredHit.set(suppression.id, suppression.until);
    kept.push(finding);
  }

  kept.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.surface.localeCompare(b.surface) || a.location.localeCompare(b.location) || a.detector.localeCompare(b.detector));
  return { findings: kept, suppressed, expired: [...expiredHit].map(([id, until]) => ({ id, until })) };
}

/** Longest a suppression may last. A year is long enough for a release cycle and short enough that "expected" gets looked at again. */
export const MAX_SUPPRESSION_DAYS = 366;

/** Problems that depend on the clock and so cannot live in the schema (a stored profile must keep loading after its suppression expires). Empty = fine. */
export function policyProblems(policy: PiiPolicy, now: Date = new Date()): Array<{ path: string; message: string }> {
  const today = todayUtc(now);
  const horizon = todayUtc(new Date(now.getTime() + MAX_SUPPRESSION_DAYS * 86_400_000));
  const problems: Array<{ path: string; message: string }> = [];
  policy.suppressions.forEach((suppression, index) => {
    if (suppression.until < today) problems.push({ path: `pii.suppressions.${index}.until`, message: `"${suppression.until}" is in the past; a suppression that has already expired does nothing` });
    else if (suppression.until > horizon) problems.push({ path: `pii.suppressions.${index}.until`, message: `at most ${MAX_SUPPRESSION_DAYS} days ahead (until ${horizon}): an expected finding must be looked at again` });
  });
  return problems;
}
