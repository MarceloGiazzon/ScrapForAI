/**
 * T3.4: performance series of a routine, pure (no I/O, no configuration import, so it is testable with plain numbers).
 *
 * One record per run of a library routine: how long each step took. From the records of ONE population we compute, per step and for the run as a whole:
 *   baseline = median of up to `baselineRuns` green samples that came BEFORE the last `recentRuns` (so a regression is not averaged into its own baseline);
 *   recent   = median of the last `recentRuns` green samples;
 *   alert    = recent > baseline x alertRatio AND recent - baseline >= minDeltaMs.
 * Only GREEN runs and steps that PASSED count: a failed run is cut short (or waited for a timeout), so its times say nothing about speed.
 *
 * A population is (routine version, profile, origin): a new version has different steps, `functional` runs stub images and are faster, and another
 * environment is another machine. The analysis looks at the population of the LATEST run; older records stay in the file and are listed by `populations`.
 */

export interface PerfStep {
  /** The step id, or `#<index>` when the routine did not name it. Included routines' steps are `<includeId>.<stepId>`. */
  id: string;
  durationMs: number;
  status: 'passed' | 'failed' | 'skipped';
}

export interface PerfRecord {
  jobId: string;
  /** When the run started (ISO). */
  at: string;
  version: number;
  profile: 'full' | 'functional';
  /** Origin of the page the run started on (another environment is another population). */
  env: string;
  buildId?: string;
  status: 'passed' | 'failed';
  durationMs: number;
  steps: PerfStep[];
  /** T3.5: 2 for the automatic new attempt of a scheduled run; absent for a first (or only) attempt. */
  attempt?: number;
  /** T3.5: with `attempt`, the job id of the attempt it repeats. Both attempts stay in the series: a retry never hides a failure. */
  retryOf?: string;
  /** T3.5: the run drew generated values (parameters/generators). Its outcome depends on the values, so it says nothing about flakiness. */
  parametric?: true;
}

export interface PerfConfig {
  baselineRuns: number;
  recentRuns: number;
  minBaselineRuns: number;
  alertRatio: number;
  minDeltaMs: number;
}

export interface PerfPoint {
  at: string;
  jobId: string;
  durationMs: number;
  buildId?: string;
}

export interface SeriesAnalysis {
  /** `(run)` for the whole run, otherwise the step id. */
  id: string;
  /** The last samples (oldest first), at most `limit`. */
  points: PerfPoint[];
  /** Green samples in the population (not only the ones in `points`). */
  samples: number;
  baselineMs?: number;
  recentMs?: number;
  ratio?: number;
  /** Why there is no baseline yet. */
  note?: string;
  alert: boolean;
  /** Indices into `points` where the build differs from the previous sample's (a marker for the sparkline). */
  buildChanges: number[];
  /** With an alert: the build seen in the recent samples but not in the baseline ones, the usual suspect. */
  suspectBuild?: string;
}

export interface Population {
  version: number;
  profile: 'full' | 'functional';
  env: string;
  runs: number;
  lastAt: string;
}

export interface RoutineAnalysis {
  population?: Population;
  /** Every population found in the records, newest first. */
  populations: Population[];
  runs: number;
  greenRuns: number;
  run?: SeriesAnalysis;
  steps: SeriesAnalysis[];
  alerts: string[];
}

export const RUN_SERIES_ID = '(run)';

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const round = (value: number): number => Math.round(value * 10) / 10;
const keyOf = (record: Pick<PerfRecord, 'version' | 'profile' | 'env'>): string => `${record.version}|${record.profile}|${record.env}`;
const knownBuild = (buildId: string | undefined): string | undefined => (buildId && buildId !== 'unknown' ? buildId : undefined);

interface Sample extends PerfPoint {}

/** Analyses one series of green samples (oldest first). */
export function analyzeSamples(id: string, samples: Sample[], config: PerfConfig, limit: number): SeriesAnalysis {
  const points = samples.slice(-limit);
  const buildChanges: number[] = [];
  let previous: string | undefined;
  points.forEach((point, index) => {
    const build = knownBuild(point.buildId);
    if (previous !== undefined && build !== undefined && build !== previous) buildChanges.push(index);
    if (build !== undefined) previous = build;
  });

  const base: SeriesAnalysis = { id, points, samples: samples.length, alert: false, buildChanges };
  if (samples.length < config.recentRuns + config.minBaselineRuns) {
    return { ...base, note: `needs ${config.recentRuns + config.minBaselineRuns} green runs for a baseline (has ${samples.length})` };
  }

  const recent = samples.slice(-config.recentRuns);
  const baseline = samples.slice(Math.max(0, samples.length - config.recentRuns - config.baselineRuns), samples.length - config.recentRuns);
  const baselineMs = median(baseline.map((sample) => sample.durationMs));
  const recentMs = median(recent.map((sample) => sample.durationMs));
  const ratio = baselineMs > 0 ? recentMs / baselineMs : recentMs > 0 ? Number.POSITIVE_INFINITY : 1;
  const alert = recentMs > baselineMs * config.alertRatio && recentMs - baselineMs >= config.minDeltaMs;

  let suspectBuild: string | undefined;
  if (alert) {
    const seen = new Set(baseline.map((sample) => knownBuild(sample.buildId)).filter(Boolean));
    suspectBuild = recent.map((sample) => knownBuild(sample.buildId)).find((build) => build !== undefined && !seen.has(build));
  }

  return {
    ...base,
    baselineMs: round(baselineMs),
    recentMs: round(recentMs),
    ...(Number.isFinite(ratio) ? { ratio: Math.round(ratio * 100) / 100 } : {}),
    alert,
    ...(suspectBuild ? { suspectBuild } : {}),
  };
}

export function populationsOf(records: PerfRecord[]): Population[] {
  const found = new Map<string, Population>();
  for (const record of records) {
    const key = keyOf(record);
    const current = found.get(key);
    if (!current) found.set(key, { version: record.version, profile: record.profile, env: record.env, runs: 1, lastAt: record.at });
    else {
      current.runs += 1;
      if (record.at > current.lastAt) current.lastAt = record.at;
    }
  }
  return [...found.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
}

/**
 * `records` in any order. `select` picks a population (default: the one of the most recent record).
 * Steps are the ones of the latest green run of the population, in their order.
 */
export function analyzeRoutine(records: PerfRecord[], config: PerfConfig, options: { limit?: number; select?: Partial<Pick<Population, 'version' | 'profile' | 'env'>> } = {}): RoutineAnalysis {
  const limit = options.limit ?? 60;
  const ordered = [...records].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const populations = populationsOf(ordered);
  const empty: RoutineAnalysis = { populations, runs: ordered.length, greenRuns: 0, steps: [], alerts: [] };

  const select = options.select ?? {};
  const target = populations.find((population) => (select.version === undefined || population.version === select.version) && (select.profile === undefined || population.profile === select.profile) && (select.env === undefined || population.env === select.env));
  if (!target) return empty;

  const group = ordered.filter((record) => keyOf(record) === keyOf(target));
  const green = group.filter((record) => record.status === 'passed');
  const toSample = (record: PerfRecord, durationMs: number): Sample => ({ at: record.at, jobId: record.jobId, durationMs, ...(record.buildId ? { buildId: record.buildId } : {}) });

  const run = analyzeSamples(RUN_SERIES_ID, green.map((record) => toSample(record, record.durationMs)), config, limit);

  const latest = green[green.length - 1];
  const steps: SeriesAnalysis[] = [];
  for (const step of latest?.steps ?? []) {
    if (step.status !== 'passed') continue;
    const samples = green.flatMap((record) => {
      const same = record.steps.find((candidate) => candidate.id === step.id && candidate.status === 'passed');
      return same ? [toSample(record, same.durationMs)] : [];
    });
    steps.push(analyzeSamples(step.id, samples, config, limit));
  }

  const alerts = [run, ...steps].filter((series) => series.alert).map((series) => series.id);
  return { population: target, populations, runs: ordered.length, greenRuns: green.length, run, steps, alerts };
}
