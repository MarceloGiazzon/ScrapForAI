/**
 * T3.5: flakiness of a library routine, pure (no I/O, no configuration import).
 *
 * Flaky = the SAME thing gives different answers. So a change of answer only counts when nothing else changed between the two runs:
 *   - same population (routine version, profile, origin): a new version or another environment is a different test;
 *   - same build, when both runs know it: pass -> fail across a new build is a regression (or a fix), not flakiness. A run whose build is unknown
 *     is compared with its neighbours (nothing says it differs).
 * score = state changes (pass <-> fail) / comparable pairs, over the last `window` runs of the latest run's population. An alternating
 * pass/fail series is 1, a series with one switch (a real regression) is 1 / (n - 1), a steady series is 0.
 *
 * Runs that drew generated values (`parametric`) are left out: edge values fail ON PURPOSE, and a run that fails only for some values is a finding,
 * not instability. A retry (`attempt` 2) is a run like any other: "failed, then passed on the new attempt" is exactly one state change.
 */

import type { PerfRecord, Population } from './perfAnalysis.js';

export interface FlakyConfig {
  /** How many of the latest runs are looked at. */
  window: number;
  /** Fewer runs than this in the window: the score is shown but nothing is suggested. */
  minRuns: number;
  /** Score at or above which quarantine is suggested. */
  threshold: number;
}

export type RoutineStatusName = 'draft' | 'active' | 'quarantined' | 'retired';

export interface FlakyAnalysis {
  /** The population the score is about (that of the latest eligible run). */
  population?: Population;
  populations: Population[];
  /** Runs in the window. */
  runs: number;
  passed: number;
  failed: number;
  /** Pass <-> fail changes between two consecutive, comparable runs. */
  transitions: number;
  /** Consecutive pairs that were compared (a pair across a build change is not). */
  comparablePairs: number;
  /** Pairs left out because the build changed between the two runs. */
  skippedAtBuildChange: number;
  /** Undefined until there is a pair to compare. */
  score?: number;
  /** Failed on a first attempt and passed on the automatic new attempt, in the window. */
  recoveredOnRetry: number;
  /** True when the window is full enough (`minRuns`) and the score is at or above the threshold. */
  flaky: boolean;
  /** The last results, oldest first, for a sparkline of passes and failures. */
  results: Array<{ jobId: string; at: string; status: 'passed' | 'failed'; buildId?: string; attempt?: number }>;
  /** Why nothing is suggested yet. */
  note?: string;
}

const same = (a: PerfRecord, b: PerfRecord): boolean => a.version === b.version && a.profile === b.profile && a.env === b.env;

function populationsOf(records: PerfRecord[]): Population[] {
  const found = new Map<string, Population>();
  for (const record of records) {
    const key = `${record.version}|${record.profile}|${record.env}`;
    const known = found.get(key);
    if (known) {
      known.runs += 1;
      if (record.at > known.lastAt) known.lastAt = record.at;
    } else {
      found.set(key, { version: record.version, profile: record.profile, env: record.env, runs: 1, lastAt: record.at });
    }
  }
  return [...found.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
}

/** Both builds known and different. An absent build or `unknown` is never proof of a change. */
function buildChanged(a: PerfRecord, b: PerfRecord): boolean {
  const known = (record: PerfRecord): string | undefined => (record.buildId && record.buildId !== 'unknown' ? record.buildId : undefined);
  const left = known(a);
  const right = known(b);
  return left !== undefined && right !== undefined && left !== right;
}

export function analyzeFlakiness(records: PerfRecord[], config: FlakyConfig, select: { version?: number; profile?: 'full' | 'functional'; env?: string } = {}): FlakyAnalysis {
  const eligible = records.filter((record) => !record.parametric).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const populations = populationsOf(eligible);
  const latest = eligible[eligible.length - 1];

  const target = select.version !== undefined || select.profile !== undefined || select.env !== undefined ? populations.find((item) => (select.version === undefined || item.version === select.version) && (select.profile === undefined || item.profile === select.profile) && (select.env === undefined || item.env === select.env)) : populations[0];
  if (!latest || !target) {
    return { populations, runs: 0, passed: 0, failed: 0, transitions: 0, comparablePairs: 0, skippedAtBuildChange: 0, recoveredOnRetry: 0, flaky: false, results: [], note: 'no runs of this routine yet' };
  }

  const inPopulation = eligible.filter((record) => record.version === target.version && record.profile === target.profile && record.env === target.env);
  const window = inPopulation.slice(-Math.max(1, config.window));

  let transitions = 0;
  let comparablePairs = 0;
  let skippedAtBuildChange = 0;
  let recoveredOnRetry = 0;
  for (let index = 1; index < window.length; index += 1) {
    const before = window[index - 1]!;
    const after = window[index]!;
    if (!same(before, after)) continue; // cannot happen inside one population; kept so the rule reads on its own
    if (buildChanged(before, after)) {
      skippedAtBuildChange += 1;
      continue;
    }
    comparablePairs += 1;
    if (before.status !== after.status) transitions += 1;
    if (after.attempt !== undefined && after.attempt > 1 && after.status === 'passed' && after.retryOf === before.jobId && before.status === 'failed') recoveredOnRetry += 1;
  }

  const passed = window.filter((record) => record.status === 'passed').length;
  const score = comparablePairs === 0 ? undefined : Math.round((transitions / comparablePairs) * 1000) / 1000;
  const enough = window.length >= config.minRuns;
  const flaky = enough && score !== undefined && score >= config.threshold;

  return {
    population: target,
    populations,
    runs: window.length,
    passed,
    failed: window.length - passed,
    transitions,
    comparablePairs,
    skippedAtBuildChange,
    ...(score === undefined ? {} : { score }),
    recoveredOnRetry,
    flaky,
    results: window.map((record) => ({ jobId: record.jobId, at: record.at, status: record.status, ...(record.buildId ? { buildId: record.buildId } : {}), ...(record.attempt ? { attempt: record.attempt } : {}) })),
    ...(enough ? {} : { note: `${window.length} of the ${config.minRuns} runs needed before anything is suggested` }),
  };
}

export type FlakySuggestion = { action: 'quarantine' | 'release'; reason: string };

/**
 * What to propose, given the routine's current status. Never applied by the server: changing a status is a new routine version, a person's decision.
 *   - not quarantined and flaky -> quarantine;
 *   - quarantined, and its last `minRuns` runs all passed -> release (back to `active`): it ran clean for as long as it takes to suggest quarantine at all.
 * A quarantined routine that only fails is not flaky, it is broken: nothing is suggested, the failures stay visible in its runs.
 */
export function suggestionFor(status: RoutineStatusName, analysis: FlakyAnalysis, config: FlakyConfig): FlakySuggestion | undefined {
  if (status === 'retired' || status === 'draft') return undefined;
  if (status !== 'quarantined' && analysis.flaky) {
    return { action: 'quarantine', reason: `${analysis.transitions} state change(s) in ${analysis.comparablePairs} comparable pair(s) over the last ${analysis.runs} run(s) (score ${analysis.score}, threshold ${config.threshold})` };
  }
  const lately = analysis.results.slice(-config.minRuns);
  if (status === 'quarantined' && lately.length >= config.minRuns && lately.every((result) => result.status === 'passed')) {
    return { action: 'release', reason: `the last ${lately.length} run(s) all passed` };
  }
  return undefined;
}
