import type { EvidenceBlock, NetworkEvidence, TrafficEvidence } from '../schemas/explorationResult.schema.js';
import type { PiiReport } from '../schemas/pii.schema.js';
import { countFindings } from '../security/piiFindings.js';

/**
 * T6.4: a run with actors keeps each actor's evidence apart (`result.actors[name].evidence`) AND a merged view in `result.evidence`, so what
 * already reads `result.evidence` (history, reports, the differential) still sees everything that happened, and a tag says whose it was.
 * Pure: no I/O, no configuration.
 */

/** Same ceiling as the collector's own list of distinct requests. */
const MAX_TRAFFIC_ENTRIES = 2000;

export interface ActorEvidence {
  actor: string;
  evidence: EvidenceBlock;
}

function tagged<T extends object>(items: readonly T[], actor: string): Array<T & { actor: string }> {
  return items.map((item) => ({ ...item, actor }));
}

function mergeTraffic(parts: readonly ActorEvidence[]): { traffic: TrafficEvidence[]; truncated: boolean } | undefined {
  if (!parts.some((part) => part.evidence.traffic !== undefined)) return undefined;
  const merged = new Map<string, TrafficEvidence>();
  let truncated = parts.some((part) => part.evidence.trafficTruncated === true);
  for (const part of parts) {
    for (const entry of part.evidence.traffic ?? []) {
      // The same request seen by two actors is one distinct request with both counts; who made it is in the per-actor evidence.
      const key = [entry.method, entry.origin, entry.pathname, entry.resourceType ?? '', entry.status ?? ''].join(' ');
      const known = merged.get(key);
      if (known) {
        known.count += entry.count;
      } else if (merged.size < MAX_TRAFFIC_ENTRIES) {
        merged.set(key, { ...entry });
      } else {
        truncated = true;
      }
    }
  }
  return { traffic: [...merged.values()], truncated };
}

function mergeNoise(parts: readonly ActorEvidence[]): Array<{ reason: string; count: number }> {
  const byReason = new Map<string, number>();
  for (const part of parts) {
    for (const entry of part.evidence.noiseFiltered ?? []) byReason.set(entry.reason, (byReason.get(entry.reason) ?? 0) + entry.count);
  }
  return [...byReason].map(([reason, count]) => ({ reason, count }));
}

/**
 * The evidence of all actors in one block. Every item says whose it is (`actor`); a page error, which is a plain string, is prefixed `[actor] `.
 * `domTextSnapshot` and `finalUrl` are left out on purpose: which one stands for the run is the caller's decision.
 */
export function mergeEvidence(parts: readonly ActorEvidence[]): EvidenceBlock {
  const traffic = mergeTraffic(parts);
  const noise = mergeNoise(parts);
  const routing = parts.flatMap((part) => tagged(part.evidence.routing ?? [], part.actor));
  // The run's trace is the first actor's that has one (main's, when main ran); each actor's own is in its own evidence.
  const tracePath = parts.map((part) => part.evidence.tracePath).find((path) => path !== undefined);

  return {
    screenshots: parts.flatMap((part) => tagged(part.evidence.screenshots, part.actor)),
    ...(tracePath === undefined ? {} : { tracePath }),
    console: parts.flatMap((part) => tagged(part.evidence.console, part.actor)),
    consoleErrors: parts.flatMap((part) => tagged(part.evidence.consoleErrors, part.actor)),
    pageErrors: parts.flatMap((part) => part.evidence.pageErrors.map((message) => `[${part.actor}] ${message}`)),
    network: parts.flatMap((part) => tagged<NetworkEvidence>(part.evidence.network, part.actor)),
    networkFailures: parts.flatMap((part) => tagged<NetworkEvidence>(part.evidence.networkFailures, part.actor)),
    ...(noise.length > 0 ? { noiseFiltered: noise } : {}),
    unexpectedExternalRequests: parts.flatMap((part) => tagged<NetworkEvidence>(part.evidence.unexpectedExternalRequests, part.actor)),
    ...(routing.length > 0 ? { routing } : {}),
    ...(traffic ? { traffic: traffic.traffic, ...(traffic.truncated ? { trafficTruncated: true } : {}) } : {}),
  };
}

/**
 * One privacy report for the run out of one per actor. A location says whose page it was (`[bob] ...`), so a finding of two actors is two
 * findings; the counts are recomputed from the merged list and what was scanned is added up.
 */
export function mergePiiReports(parts: ReadonlyArray<{ actor: string; report: PiiReport }>): PiiReport | undefined {
  if (parts.length === 0) return undefined;
  const findings = parts.flatMap(({ actor, report }) => report.findings.map((finding) => ({ ...finding, location: `[${actor}] ${finding.location}` })));
  const suppressed = parts.flatMap(({ actor, report }) => (report.suppressed ?? []).map((entry) => ({ ...entry, location: `[${actor}] ${entry.location}` })));
  const scanned = { urls: 0, console: 0, responseBodies: 0, responseBodiesSkipped: 0, storageEntries: 0, jarEntries: 0, hiddenInputs: 0 };
  for (const { report } of parts) {
    for (const key of Object.keys(scanned) as Array<keyof typeof scanned>) scanned[key] += report.scanned[key];
  }
  return {
    kind: 'pii-scan',
    findings,
    counts: countFindings(findings),
    scanned,
    truncated: parts.some(({ report }) => report.truncated),
    notes: parts.flatMap(({ actor, report }) => report.notes.map((note) => `[${actor}] ${note}`)),
    ...(suppressed.length > 0 ? { suppressed } : {}),
  };
}
