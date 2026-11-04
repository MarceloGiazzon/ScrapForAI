import type { NetworkEvidence } from '../schemas/explorationResult.schema.js';
import type { TargetProfile } from '../schemas/targetProfile.schema.js';

/**
 * T8.1: what a target profile knows about its platform, as pure functions (no I/O, no configuration).
 *
 * Noise: a network failure that is known to say nothing about the application. It is left out of `evidence.networkFailures` and counted in
 * `evidence.noiseFiltered` with the reason, so a filter is never silent; `evidence.network` still holds every request.
 */

export interface NoiseRule {
  reason: string;
  matches(item: NetworkEvidence): boolean;
}

export const GENEXUS_ABORT_REASON = 'GeneXus top.location redirects abort in-flight requests (net::ERR_ABORTED); not an application failure';

export function noiseRulesFor(profile: Pick<TargetProfile, 'platform' | 'noiseFilters'> | undefined): NoiseRule[] {
  if (!profile) return [];
  const rules: NoiseRule[] = [];

  if (profile.platform === 'genexus') {
    rules.push({ reason: GENEXUS_ABORT_REASON, matches: (item) => item.failureText?.includes('net::ERR_ABORTED') === true });
  }

  for (const filter of profile.noiseFilters) {
    rules.push({ reason: filter.reason, matches: (item) => item.failureText?.includes(filter.networkFailureTextContains) === true });
  }

  return rules;
}

export interface NoiseResult {
  kept: NetworkEvidence[];
  filtered: Array<{ reason: string; count: number }>;
}

/** The first rule that matches takes the failure, so one failure is counted once. Only FAILED requests (failureText) are ever noise, never an HTTP 4xx/5xx. */
export function applyNoiseFilters(failures: NetworkEvidence[], rules: NoiseRule[]): NoiseResult {
  if (rules.length === 0) return { kept: failures, filtered: [] };

  const counts = new Map<string, number>();
  const kept: NetworkEvidence[] = [];

  for (const item of failures) {
    const rule = item.failureText ? rules.find((candidate) => candidate.matches(item)) : undefined;
    if (rule) {
      counts.set(rule.reason, (counts.get(rule.reason) ?? 0) + 1);
    } else {
      kept.push(item);
    }
  }

  return { kept, filtered: [...counts].map(([reason, count]) => ({ reason, count })) };
}
