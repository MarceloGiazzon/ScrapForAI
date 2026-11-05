import type { PerfRecord } from '../metrics/perfAnalysis.js';
import type { HistoryPoint } from './render.js';

/**
 * T9.1: "since when", from the run history alone: the last run of the routine that PASSED before this failure and the first run that failed after
 * it, with the builds they report. It is the evidence-only start of the bisect the roadmap calls T3.6 (which would add the list of suspects from a
 * ChangeSource); on its own it says WHEN it broke, never WHY. Pure.
 *
 * One population: the same environment (origin) and run profile, the way the performance and flakiness series are read. A run that drew generated
 * values is left out (it fails on edge values on purpose), and so is a first attempt that a new attempt repeated (a pass on the retry is a pass).
 */

export interface SinceWhen {
  lastGreen: HistoryPoint;
  firstRed: HistoryPoint;
  /** Both builds are known: did they differ? Undefined when one of them is not known. */
  buildChanged?: boolean;
}

export interface CurrentFailure {
  jobId: string;
  at: string;
  buildId?: string;
  version: number;
  env: string;
  profile: 'full' | 'functional';
}

const point = (record: Pick<PerfRecord, 'jobId' | 'at' | 'buildId' | 'version'>): HistoryPoint => ({
  jobId: record.jobId,
  at: record.at,
  ...(record.buildId ? { buildId: record.buildId } : {}),
  version: record.version,
});

export function sinceWhen(records: PerfRecord[], current: CurrentFailure): SinceWhen | undefined {
  let population = records.filter((record) => record.env === current.env && record.profile === current.profile && record.parametric !== true);
  const superseded = new Set(population.flatMap((record) => (record.retryOf ? [record.retryOf] : [])));
  population = population.filter((record) => !superseded.has(record.jobId));

  // The failure itself may not be in the series (a parametric run is not recorded, an old run predates it): it is still where the walk starts.
  if (!population.some((record) => record.jobId === current.jobId)) {
    population.push({ jobId: current.jobId, at: current.at, version: current.version, profile: current.profile, env: current.env, ...(current.buildId ? { buildId: current.buildId } : {}), status: 'failed', durationMs: 0, steps: [] });
  }
  population.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const at = population.findIndex((record) => record.jobId === current.jobId);
  let greenIndex = -1;
  for (let i = at - 1; i >= 0; i -= 1) {
    if (population[i]!.status === 'passed') {
      greenIndex = i;
      break;
    }
  }
  if (greenIndex < 0) return undefined; // never seen passing: there is no "since"

  const green = population[greenIndex]!;
  const firstRed = population.slice(greenIndex + 1, at + 1).find((record) => record.status === 'failed') ?? population[at]!;
  return {
    lastGreen: point(green),
    firstRed: point(firstRed),
    ...(green.buildId && firstRed.buildId ? { buildChanged: green.buildId !== firstRed.buildId } : {}),
  };
}
