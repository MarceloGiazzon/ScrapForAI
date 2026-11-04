import { getHealth } from '../health/healthService.js';
import { diffBuilds } from '../evolution/evolutionService.js';
import { listSnapshots } from '../evolution/snapshotStore.js';
import { listRoutines } from '../library/routineLibrary.js';
import { listFlakiness } from '../metrics/flakyService.js';
import { listPerformanceAlerts } from '../metrics/perfService.js';
import { readPerfRecords } from '../metrics/perfStore.js';
import { listTargets } from '../targets/targetStore.js';
import { buildSummary, type EvolutionInput, type EvolutionPairInput, type RoutineSeriesInput, type SummaryReport } from './summaryAnalysis.js';

/** T9.3 read side: gathers what T3.4/T3.5/T3.7/T4.5/T7.5 already store and hands it to the pure `buildSummary`. Starts nothing, changes nothing. */

const DAY_MS = 24 * 60 * 60_000;
/** Snapshot pairs compared per target and period (each pair reads two snapshots from disk). */
export const MAX_PAIRS_PER_TARGET = 10;

export interface SummaryQuery {
  /** End of the period (default now). */
  to?: Date;
  days?: number;
  targets?: string[];
}

async function evolutionOf(target: string, fromMs: number, toMs: number): Promise<EvolutionInput> {
  const listing = await listSnapshots(target).catch(() => []);
  const pairs: EvolutionPairInput[] = [];
  const firstSnapshots: string[] = [];
  let truncated = false;

  for (let index = 0; index < listing.length; index += 1) {
    const snapshot = listing[index]!;
    const at = Date.parse(snapshot.createdAt);
    if (at < fromMs || at > toMs) continue;
    const previous = listing[index - 1];
    if (!previous) {
      firstSnapshots.push(snapshot.buildId);
      continue;
    }
    if (pairs.length >= MAX_PAIRS_PER_TARGET) {
      truncated = true;
      continue;
    }
    try {
      // By folder name: build ids can repeat (`unknown`), folder names cannot.
      const { diff } = await diffBuilds(target, previous.name, snapshot.name);
      pairs.push({
        from: previous.buildId,
        to: snapshot.buildId,
        at: snapshot.createdAt,
        complete: diff.from.complete && diff.to.complete,
        counts: diff.counts,
        classified: diff.classified,
        ...(diff.accessibility ? { accessibility: diff.accessibility } : {}),
      });
    } catch (error) {
      // EvolutionError carries its code in `name` (SnapshotTampered, SnapshotIncomplete...); the message could hold a path.
      const code = error instanceof Error ? error.name : 'Error';
      pairs.push({ from: previous.buildId, to: snapshot.buildId, at: snapshot.createdAt, error: code });
    }
  }
  return { target, pairs, firstSnapshots, ...(truncated ? { truncated: true } : {}) };
}

export async function getSummary(query: SummaryQuery = {}): Promise<SummaryReport> {
  const to = query.to ?? new Date();
  const days = query.days ?? 7;
  const toMs = to.getTime();
  const fromMs = toMs - days * DAY_MS;

  const [health, routines, flaky, perfAlerts, targets] = await Promise.all([getHealth(to), listRoutines(), listFlakiness(), listPerformanceAlerts(), listTargets()]);

  const series: RoutineSeriesInput[] = [];
  for (const routine of routines) {
    series.push({ id: routine.id, title: routine.title, status: routine.status, targetProfile: routine.targetProfile, records: await readPerfRecords(routine.id) });
  }

  const wanted = query.targets ? new Set(query.targets) : undefined;
  const evolution: EvolutionInput[] = [];
  for (const target of targets) {
    if (wanted && !wanted.has(target.id)) continue;
    evolution.push(await evolutionOf(target.id, fromMs, toMs));
  }

  return buildSummary({
    generatedAt: new Date().toISOString(),
    from: new Date(fromMs).toISOString(),
    to: to.toISOString(),
    days,
    ...(query.targets ? { targets: query.targets } : {}),
    health,
    routines: series,
    flaky: flaky.map((item) => ({ routineId: item.routineId, runs: item.runs, flaky: item.flaky, ...(item.score === undefined ? {} : { score: item.score }), ...(item.suggestion ? { suggestion: item.suggestion } : {}) })),
    perfAlerts: perfAlerts.map((alert) => ({
      routineId: alert.routineId,
      series: alert.series,
      baselineMs: alert.baselineMs,
      recentMs: alert.recentMs,
      ...(alert.ratio === undefined ? {} : { ratio: alert.ratio }),
      ...(alert.suspectBuild ? { suspectBuild: alert.suspectBuild } : {}),
    })),
    evolution,
  });
}
