import { recentOutcomes } from '../../history/runHistoryStore.js';
import { getRoutine } from '../../library/routineLibrary.js';
import type { RegressionItem } from '../../schemas/regressionItem.schema.js';
import { getTarget } from '../../targets/targetStore.js';
import { matchesGlob, normalizePath } from '../../util/glob.js';

/**
 * T2.3 impact ordering. When a feature is implemented, run first the fixed bugs and hard scenarios that
 * are most likely to break, and say WHY each item landed where it did.
 *
 * Order (lexicographic, each rule only breaks ties of the previous one):
 *   1. the item's surface is touched: an explicit `surfaces` entry, or a changed file matches a glob of
 *      that surface in the target profile (`surfaces: { inventory: ["src/inventory/**"] }`);
 *   2. it failed in its last N runs (more failures first);
 *   3. higher severity (P0, P1, HIGH, MEDIUM, LOW, none);
 *   4. the rest, by id.
 */

export const RECENT_RUNS_WINDOW = 5;

const SEVERITY_RANK: Record<string, number> = { P0: 0, P1: 1, HIGH: 2, MEDIUM: 3, LOW: 4 };

export interface ImpactInput {
  changedFiles?: string[];
  surfaces?: string[];
}

export interface OrderReason {
  rule: 'surface' | 'recent-failure' | 'severity' | 'rest' | 'awaiting-fix';
  detail: string;
}

export interface OrderedItem {
  item: RegressionItem;
  position: number;
  reasons: OrderReason[];
}

interface Scored {
  item: RegressionItem;
  surfaceHit: boolean;
  failures: number;
  severity: number;
  reasons: OrderReason[];
}

async function surfaceGlobs(item: RegressionItem): Promise<string[]> {
  const routine = await getRoutine(item.routine.id, item.routine.version).catch(() => undefined);
  const profile = routine ? await getTarget(routine.targetProfile).catch(() => undefined) : undefined;
  return profile?.surfaces[item.surface] ?? [];
}

export async function orderByImpact(items: RegressionItem[], input: ImpactInput = {}): Promise<OrderedItem[]> {
  const changed = (input.changedFiles ?? []).map(normalizePath).filter(Boolean);
  const explicit = new Set(input.surfaces ?? []);
  const scored: Scored[] = [];

  for (const item of items) {
    const reasons: OrderReason[] = [];

    let surfaceHit = false;
    if (explicit.has(item.surface)) {
      surfaceHit = true;
      reasons.push({ rule: 'surface', detail: `surface "${item.surface}" was named explicitly` });
    }

    const globs = await surfaceGlobs(item);
    for (const file of changed) {
      const glob = globs.find((candidate) => matchesGlob(file, candidate));
      if (glob) {
        surfaceHit = true;
        reasons.push({ rule: 'surface', detail: `changed file ${file} matches ${glob} (surface "${item.surface}")` });
        break; // one file is enough to explain the position
      }
    }

    const outcomes = await recentOutcomes(item.routine.id, RECENT_RUNS_WINDOW);
    const failures = outcomes.filter((outcome) => outcome === 'failed').length;
    if (failures > 0) {
      reasons.push({ rule: 'recent-failure', detail: `failed ${failures} of its last ${outcomes.length} run(s)` });
    }

    const severity = item.severity === null ? 5 : (SEVERITY_RANK[item.severity] ?? 5);
    if (item.severity !== null) {
      reasons.push({ rule: 'severity', detail: `severity ${item.severity}` });
    }

    if (!item.firstGreen) {
      reasons.push({ rule: 'awaiting-fix', detail: 'no firstGreen yet: the bug is not confirmed fixed, so a failure is expected' });
    }

    if (!surfaceHit && failures === 0 && item.severity === null) {
      reasons.push({ rule: 'rest', detail: 'no impact signal; ordered by id' });
    }

    scored.push({ item, surfaceHit, failures, severity, reasons });
  }

  scored.sort(
    (a, b) =>
      Number(b.surfaceHit) - Number(a.surfaceHit) ||
      b.failures - a.failures ||
      a.severity - b.severity ||
      a.item.id.localeCompare(b.item.id, 'en', { numeric: true }),
  );

  return scored.map((entry, index) => ({ item: entry.item, position: index + 1, reasons: entry.reasons }));
}

/** One line per item, for terminals and reports: "1. REG-209 - surface ...; severity P0". */
export function describeOrder(ordered: OrderedItem[]): string {
  return ordered.map((entry) => `${entry.position}. ${entry.item.id} - ${entry.reasons.map((reason) => reason.detail).join('; ')}`).join('\n');
}
