import { env } from '../config/env.js';
import { analyzeRoutine, type PerfConfig, type Population, type RoutineAnalysis, type SeriesAnalysis } from './perfAnalysis.js';
import { listPerfRoutines, readPerfRecords } from './perfStore.js';

/** T3.4 read side: the series of a routine analysed with the configured thresholds. */

export function perfConfig(): PerfConfig {
  return {
    baselineRuns: env.PERF_BASELINE_RUNS,
    recentRuns: env.PERF_RECENT_RUNS,
    minBaselineRuns: env.PERF_MIN_BASELINE_RUNS,
    alertRatio: env.PERF_ALERT_RATIO,
    minDeltaMs: env.PERF_MIN_DELTA_MS,
  };
}

export interface PerfQuery {
  limit?: number;
  version?: number;
  profile?: 'full' | 'functional';
  env?: string;
}

/** undefined = the routine has no series at all. */
export async function getRoutinePerformance(routineId: string, query: PerfQuery = {}): Promise<(RoutineAnalysis & { routineId: string; thresholds: PerfConfig }) | undefined> {
  const records = await readPerfRecords(routineId);
  if (records.length === 0) return undefined;
  const select = { ...(query.version === undefined ? {} : { version: query.version }), ...(query.profile ? { profile: query.profile } : {}), ...(query.env ? { env: query.env } : {}) };
  const config = perfConfig();
  return { routineId, thresholds: config, ...analyzeRoutine(records, config, { limit: query.limit ?? 60, select }) };
}

export interface PerfAlert {
  routineId: string;
  /** `(run)` or a step id. */
  series: string;
  baselineMs: number;
  recentMs: number;
  ratio?: number;
  suspectBuild?: string;
  population: Population;
}

export interface PerfSummary {
  routineId: string;
  runs: number;
  greenRuns: number;
  population?: Population;
  run?: Pick<SeriesAnalysis, 'samples' | 'baselineMs' | 'recentMs' | 'ratio' | 'alert' | 'note'>;
  alerts: PerfAlert[];
}

export function alertsOf(routineId: string, analysis: RoutineAnalysis): PerfAlert[] {
  const { population } = analysis;
  if (!population) return [];
  const series = [analysis.run, ...analysis.steps].filter((item): item is SeriesAnalysis => item !== undefined);
  return series.flatMap((item) =>
    item.alert && item.baselineMs !== undefined && item.recentMs !== undefined
      ? [
          {
            routineId,
            series: item.id,
            baselineMs: item.baselineMs,
            recentMs: item.recentMs,
            ...(item.ratio === undefined ? {} : { ratio: item.ratio }),
            ...(item.suspectBuild ? { suspectBuild: item.suspectBuild } : {}),
            population,
          },
        ]
      : [],
  );
}

/** Every routine with a series: one line each, plus its alerts (the sparklines come from getRoutinePerformance). */
export async function listPerformance(): Promise<PerfSummary[]> {
  const out: PerfSummary[] = [];
  for (const routineId of await listPerfRoutines()) {
    const analysis = await getRoutinePerformance(routineId, { limit: 1 });
    if (!analysis) continue;
    const run = analysis.run;
    out.push({
      routineId,
      runs: analysis.runs,
      greenRuns: analysis.greenRuns,
      ...(analysis.population ? { population: analysis.population } : {}),
      ...(run
        ? {
            run: {
              samples: run.samples,
              alert: run.alert,
              ...(run.baselineMs === undefined ? {} : { baselineMs: run.baselineMs }),
              ...(run.recentMs === undefined ? {} : { recentMs: run.recentMs }),
              ...(run.ratio === undefined ? {} : { ratio: run.ratio }),
              ...(run.note ? { note: run.note } : {}),
            },
          }
        : {}),
      alerts: alertsOf(routineId, analysis),
    });
  }
  return out;
}

export async function listPerformanceAlerts(): Promise<PerfAlert[]> {
  return (await listPerformance()).flatMap((summary) => summary.alerts);
}
