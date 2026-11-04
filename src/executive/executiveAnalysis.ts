import type { HealthReport, TargetStatus } from '../health/healthAnalysis.js';
import type { PerfRecord } from '../metrics/perfAnalysis.js';
import { effectiveRuns } from '../summary/summaryAnalysis.js';

/**
 * T9.4: the executive panel, pure (no I/O, no configuration import). For people who do not read run logs: how many tests there are, how many
 * regressions the tests caught, whether quality is going up or down, and whether each system is ready for a person to sign off its latest build.
 * Like the health panel and the summary it only RE-READS what the other pieces store; it starts no run and changes no status.
 *
 * Definitions (the page prints them too, they are `notes`):
 *  - A test is an ACTIVE library routine, or an ACTIVE regression-vault item. Quarantined ones are counted apart and never judged; draft and
 *    retired ones are left out.
 *  - A RUN is the last attempt: a first attempt that an automatic new attempt repeated (T3.5 `retryOf`) is left out, so a pass on the retry is a pass,
 *    and runs that drew generated values (`parametric`) are left out, because their edge values fail on purpose (same rule as the summary, T9.3).
 *  - A REGRESSION CAUGHT is a test that passed and then failed. ScrapForAI cannot know whether the change would have reached users, so the roadmap's
 *    "regressions prevented" is stated as what it can show: caught by the tests. A routine that is flaky now (T3.5) is not claimed to have regressed:
 *    its pass -> fail changes are counted as `unstable`. A test that never passed has not regressed. `guardedBugs` = ACTIVE vault items with a
 *    first green: bugs that were fixed and now have permanent proof.
 *  - QUALITY TREND: the share of runs that passed, per week (7-day buckets ending at the end of the period). `improving`/`worsening` compares the last
 *    two weeks with the two before (needs 5 runs on each side and a change of 5 points), else `steady` or `unknown`. A routine's series keeps only its
 *    newest runs (`PERF_MAX_RECORDS`): weeks older than that are marked `partial` rather than shown as if complete.
 *  - READINESS (homologation) of a system for its LATEST BUILD (the build of the most recent run that reported one): `ready` = every test that counts
 *    passed on that build; `blocked` = a test failed in its last run; `incomplete` = nothing failed but some test has not run on that build;
 *    `no-data` = nothing has run. ScrapForAI never approves a build: a person does. Signed evidence = pinned passing runs of this system's tests on that
 *    build whose signature checks against the installation's key (the files themselves are verified by the evidence chain check).
 */

export type QualityTrend = 'improving' | 'worsening' | 'steady' | 'unknown';
export type Readiness = 'ready' | 'blocked' | 'incomplete' | 'no-data';

export interface ExecRoutineInput {
  id: string;
  title: string;
  status: 'draft' | 'active' | 'quarantined' | 'retired';
  targetProfile: string;
  /** T3.5 flagged it flaky, or proposes quarantining it. */
  unstable: boolean;
  records: PerfRecord[];
}

export interface ExecVaultInput {
  id: string;
  status: 'ACTIVE' | 'QUARANTINED' | 'RETIRED';
  routineId: string;
  /** Has a first green: the fix was confirmed. */
  guarded: boolean;
  lastRun?: { status: 'passed' | 'failed'; at: string; buildId?: string };
}

export interface ExecPinInput {
  jobId: string;
  routineId?: string;
  buildId?: string;
  status?: 'passed' | 'failed';
  /** The signature checks against the installation's public key. */
  signed: boolean;
}

export interface ExecutiveInput {
  /** End of the period. */
  now: string;
  days: number;
  weeks: number;
  /** The caller's filter (absent = every target). */
  targets?: string[];
  health: HealthReport;
  routines: ExecRoutineInput[];
  vault: ExecVaultInput[];
  pins: ExecPinInput[];
  /** `PERF_MAX_RECORDS`: a series this long may have dropped older runs. */
  perfCap: number;
}

export interface WeekPoint {
  from: string;
  to: string;
  runs: number;
  passed: number;
  /** passed / runs, null when no run. */
  rate: number | null;
  /** The series of some routine no longer reaches back this far: the figure is for the runs still kept. */
  partial?: true;
}

export interface TrendBlock {
  direction: QualityTrend;
  weekly: WeekPoint[];
  recent?: { runs: number; rate: number };
  before?: { runs: number; rate: number };
}

export interface TestCounts {
  routines: number;
  quarantined: number;
  vaultItems: number;
  guardedBugs: number;
  runs: number;
  passed: number;
  failed: number;
  passRate: number | null;
}

export interface RegressionCounts {
  /** Tests that passed and then failed, in the period (not counting unstable routines). */
  caught: number;
  /** Of those, the ones that later passed again. */
  resolved: number;
  /** Of those, the ones still failing. */
  open: number;
  /** pass -> fail changes of routines that are flaky now: not claimed as regressions. */
  unstable: number;
}

export interface RegressionEvent {
  routineId: string;
  title: string;
  at: string;
  build?: string;
  previousBuild?: string;
  failedStep?: string;
  resolvedAt?: string;
}

export interface Homologation {
  status: Readiness;
  /** The latest build any test reported. Absent when none did. */
  build?: string;
  /** Tests that passed (on the build, when it is known) / tests that are judged. */
  passed: number;
  total: number;
  failed: number;
  notRun: number;
  /** Routines whose every run drew generated values: no verdict to give. */
  notJudged: number;
  quarantined: number;
  /** Why it is not ready, plain words, most important first. Empty when ready. */
  reasons: string[];
  /** Things to know about this reading whatever the status (no build reported, routines not judged). */
  notes: string[];
  /** Pinned, signed, passing runs of this system's tests on `build`. Absent when the build is unknown. */
  evidence?: { runs: number; tests: number };
}

export interface ExecutiveTarget {
  id: string;
  name?: string;
  environment?: string;
  known: boolean;
  health: { status: TargetStatus; reasons: string[] };
  tests: TestCounts;
  regressions: RegressionCounts & { recent: RegressionEvent[] };
  trend: TrendBlock;
  homologation: Homologation;
}

export interface ExecutiveReport {
  kind: 'scrapforai-executive';
  generatedAt: string;
  period: { from: string; to: string; days: number };
  weeks: number;
  targets?: string[];
  totals: {
    systems: number;
    readiness: Record<Readiness, number>;
    health: { red: number; yellow: number; green: number; empty: number };
    tests: TestCounts;
    regressions: RegressionCounts;
  };
  trend: TrendBlock;
  systems: ExecutiveTarget[];
  /** Routines whose series is at its cap: weeks before their oldest kept run are `partial`. */
  historyLimited: string[];
  notes: string[];
}

export const DAY_MS = 24 * 60 * 60_000;
export const WEEK_MS = 7 * DAY_MS;
/** Runs needed on each side of the comparison before a direction is claimed. */
export const MIN_RUNS_PER_SIDE = 5;
/** A change in the share of passing runs (0..1) that counts as a direction. */
export const TREND_THRESHOLD = 0.05;
export const MAX_RECENT_REGRESSIONS = 5;
export const MAX_HEALTH_REASONS = 3;

const knownBuild = (buildId: string | undefined): string | undefined => (buildId && buildId !== 'unknown' ? buildId : undefined);
/**
 * passed / runs to four decimals, but never 1 unless every run passed (nor 0 unless none did): a failure must not vanish in the rounding.
 * Null when there is no run.
 */
export function rateOf(passed: number, runs: number): number | null {
  if (runs === 0) return null;
  if (passed === runs) return 1;
  if (passed === 0) return 0;
  return Math.min(0.9999, Math.max(0.0001, Math.round((passed / runs) * 10_000) / 10_000));
}
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------------------------------------------------
// Quality trend

export function weeklySeries(runs: PerfRecord[], toMs: number, weeks: number, partialBefore?: number): WeekPoint[] {
  const points: WeekPoint[] = [];
  for (let index = 0; index < weeks; index += 1) {
    const end = toMs - (weeks - 1 - index) * WEEK_MS;
    const start = end - WEEK_MS;
    let total = 0;
    let passed = 0;
    for (const run of runs) {
      const at = Date.parse(run.at);
      if (at > start && at <= end) {
        total += 1;
        if (run.status === 'passed') passed += 1;
      }
    }
    points.push({
      from: new Date(start).toISOString(),
      to: new Date(end).toISOString(),
      runs: total,
      passed,
      rate: rateOf(passed, total),
      ...(partialBefore !== undefined && start < partialBefore ? { partial: true as const } : {}),
    });
  }
  return points;
}

/** Last two weeks against the two before. Needs `MIN_RUNS_PER_SIDE` runs on each side, else `unknown`. */
export function trendOf(weekly: WeekPoint[]): TrendBlock {
  if (weekly.length < 4) return { direction: 'unknown', weekly };
  const side = (points: WeekPoint[]): { runs: number; rate: number } | undefined => {
    const runs = points.reduce((sum, point) => sum + point.runs, 0);
    const passed = points.reduce((sum, point) => sum + point.passed, 0);
    return runs === 0 ? undefined : { runs, rate: rateOf(passed, runs)! };
  };
  const recent = side(weekly.slice(-2));
  const before = side(weekly.slice(-4, -2));
  const parts = { ...(recent ? { recent } : {}), ...(before ? { before } : {}) };
  if (!recent || !before || recent.runs < MIN_RUNS_PER_SIDE || before.runs < MIN_RUNS_PER_SIDE) return { direction: 'unknown', weekly, ...parts };
  const change = recent.rate - before.rate;
  const direction: QualityTrend = change >= TREND_THRESHOLD ? 'improving' : change <= -TREND_THRESHOLD ? 'worsening' : 'steady';
  return { direction, weekly, ...parts };
}

// ---------------------------------------------------------------------------------------------------------------------
// Regressions

const failedStepOf = (record: PerfRecord): string | undefined => {
  const index = record.steps.findIndex((step) => step.status === 'failed');
  if (index < 0) return undefined;
  return record.steps[index]!.id ?? `#${index}`;
};

/** Every pass -> fail change of a routine's runs (oldest first) whose failing run is in (fromMs, toMs]. A pass after `toMs` does not resolve it. */
export function regressionEvents(routine: { id: string; title: string }, runs: PerfRecord[], fromMs: number, toMs: number): RegressionEvent[] {
  const events: RegressionEvent[] = [];
  let open: RegressionEvent | undefined;
  let previous: PerfRecord | undefined;
  for (const run of runs) {
    if (run.status === 'failed') {
      if (previous?.status === 'passed') {
        const at = Date.parse(run.at);
        const step = failedStepOf(run);
        const event: RegressionEvent = {
          routineId: routine.id,
          title: routine.title,
          at: run.at,
          ...(knownBuild(run.buildId) ? { build: knownBuild(run.buildId)! } : {}),
          ...(knownBuild(previous.buildId) ? { previousBuild: knownBuild(previous.buildId)! } : {}),
          ...(step ? { failedStep: step } : {}),
        };
        open = event;
        if (at > fromMs && at <= toMs) events.push(event);
      }
    } else if (open) {
      if (Date.parse(run.at) <= toMs) open.resolvedAt = run.at;
      open = undefined;
    }
    previous = run;
  }
  return events;
}

// ---------------------------------------------------------------------------------------------------------------------
// Homologation

type Cell = 'passed' | 'failed' | 'not-run' | 'not-judged';

function homologationOf(
  routines: Array<{ routine: ExecRoutineInput; runs: PerfRecord[] }>,
  vault: ExecVaultInput[],
  pins: ExecPinInput[],
  quarantined: number,
): Homologation {
  // The latest build any counted test reported.
  let latest: { at: string; build: string } | undefined;
  const consider = (at: string, buildId: string | undefined): void => {
    const build = knownBuild(buildId);
    if (build && (!latest || at >= latest.at)) latest = { at, build };
  };
  for (const { runs } of routines) for (const run of runs) consider(run.at, run.buildId);
  for (const item of vault) if (item.lastRun) consider(item.lastRun.at, item.lastRun.buildId);
  const build = (latest as { at: string; build: string } | undefined)?.build;

  const cells: Cell[] = [];
  for (const { routine, runs } of routines) {
    const last = runs[runs.length - 1];
    if (!last) cells.push(routine.records.length > 0 ? 'not-judged' : 'not-run');
    else if (last.status === 'failed') cells.push('failed');
    else cells.push(build === undefined || knownBuild(last.buildId) === build ? 'passed' : 'not-run');
  }
  for (const item of vault) {
    const last = item.lastRun;
    if (!last) cells.push('not-run');
    else if (last.status === 'failed') cells.push('failed');
    else cells.push(build === undefined || knownBuild(last.buildId) === build ? 'passed' : 'not-run');
  }

  const count = (kind: Cell): number => cells.filter((cell) => cell === kind).length;
  const failed = count('failed');
  const passed = count('passed');
  const notRun = count('not-run');
  const notJudged = count('not-judged');
  const total = failed + passed + notRun;

  let status: Readiness;
  if (total === 0 || passed + failed === 0) status = 'no-data';
  else if (failed > 0) status = 'blocked';
  else if (notRun > 0) status = 'incomplete';
  else status = 'ready';

  const reasons: string[] = [];
  if (failed > 0) reasons.push(`${plural(failed, 'test', 'tests')} failed in the last run`);
  if (notRun > 0 && status !== 'no-data') {
    reasons.push(build ? `${notRun} of ${total} tests have not run on build ${build}` : `${plural(notRun, 'test has', 'tests have')} never run`);
  }
  if (status === 'no-data' && total > 0) reasons.push('No test has run yet');
  const notes: string[] = [];
  if (build === undefined && status !== 'no-data') notes.push('Results are not tied to a build: the target profile does not report one');
  if (notJudged > 0) notes.push(`${plural(notJudged, 'routine runs', 'routines run')} only with generated values and ${notJudged === 1 ? 'is' : 'are'} not judged here`);

  let evidence: Homologation['evidence'];
  if (build !== undefined) {
    const ids = new Set(routines.map(({ routine }) => routine.id));
    const matching = pins.filter((pin) => pin.signed && pin.status === 'passed' && pin.buildId === build && pin.routineId !== undefined && ids.has(pin.routineId));
    evidence = { runs: matching.length, tests: new Set(matching.map((pin) => pin.routineId)).size };
  }

  return { status, ...(build ? { build } : {}), passed, total, failed, notRun, notJudged, quarantined, reasons, notes, ...(evidence ? { evidence } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------------
// The report

const emptyCounts = (): RegressionCounts => ({ caught: 0, resolved: 0, open: 0, unstable: 0 });

function addCounts(into: RegressionCounts, from: RegressionCounts): void {
  into.caught += from.caught;
  into.resolved += from.resolved;
  into.open += from.open;
  into.unstable += from.unstable;
}

export function buildExecutive(input: ExecutiveInput): ExecutiveReport {
  const toMs = Date.parse(input.now);
  const fromMs = toMs - input.days * DAY_MS;
  const wanted = input.targets ? new Set(input.targets) : undefined;
  const healthTargets = input.health.targets.filter((target) => wanted === undefined || wanted.has(target.id));

  const routineOf = new Map(input.routines.map((routine) => [routine.id, routine]));
  const effective = new Map(input.routines.map((routine) => [routine.id, effectiveRuns(routine.records)]));

  const systems: ExecutiveTarget[] = [];
  const allRuns: PerfRecord[] = [];
  const limited: string[] = [];
  let limitedCutoff: number | undefined;
  const totalsTests: TestCounts = { routines: 0, quarantined: 0, vaultItems: 0, guardedBugs: 0, runs: 0, passed: 0, failed: 0, passRate: null };
  const totalsRegressions = emptyCounts();
  const readiness: Record<Readiness, number> = { ready: 0, blocked: 0, incomplete: 0, 'no-data': 0 };
  const healthTotals = { red: 0, yellow: 0, green: 0, empty: 0 };

  for (const target of healthTargets) {
    const mine = input.routines.filter((routine) => routine.targetProfile === target.id);
    const counted = mine.filter((routine) => routine.status === 'active');
    const quarantined = mine.filter((routine) => routine.status === 'quarantined').length;
    const items = input.vault.filter((item) => routineOf.get(item.routineId)?.targetProfile === target.id);
    const activeItems = items.filter((item) => item.status === 'ACTIVE');

    // Runs of the counted tests, and the cut-off of the series that no longer reach back.
    const targetRuns: PerfRecord[] = [];
    let targetCutoff: number | undefined;
    for (const routine of counted) {
      const runs = effective.get(routine.id) ?? [];
      targetRuns.push(...runs);
      if (routine.records.length >= input.perfCap) {
        const oldest = Math.min(...routine.records.map((record) => Date.parse(record.at)));
        targetCutoff = Math.max(targetCutoff ?? oldest, oldest);
        if (!limited.includes(routine.id)) limited.push(routine.id);
      }
    }
    if (targetCutoff !== undefined) limitedCutoff = Math.max(limitedCutoff ?? targetCutoff, targetCutoff);
    allRuns.push(...targetRuns);

    const inPeriod = targetRuns.filter((run) => Date.parse(run.at) > fromMs && Date.parse(run.at) <= toMs);
    const passedRuns = inPeriod.filter((run) => run.status === 'passed').length;
    const tests: TestCounts = {
      routines: counted.length,
      quarantined,
      vaultItems: activeItems.length,
      guardedBugs: activeItems.filter((item) => item.guarded).length,
      runs: inPeriod.length,
      passed: passedRuns,
      failed: inPeriod.length - passedRuns,
      passRate: rateOf(passedRuns, inPeriod.length),
    };

    const counts = emptyCounts();
    const events: RegressionEvent[] = [];
    for (const routine of counted) {
      const found = regressionEvents(routine, effective.get(routine.id) ?? [], fromMs, toMs);
      if (routine.unstable) {
        counts.unstable += found.length;
        continue;
      }
      for (const event of found) {
        counts.caught += 1;
        if (event.resolvedAt) counts.resolved += 1;
        else counts.open += 1;
        events.push(event);
      }
    }
    events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.routineId.localeCompare(b.routineId)));

    const homologation = homologationOf(
      counted.map((routine) => ({ routine, runs: effective.get(routine.id) ?? [] })),
      activeItems,
      input.pins,
      quarantined + items.filter((item) => item.status === 'QUARANTINED').length,
    );

    systems.push({
      id: target.id,
      ...(target.name ? { name: target.name } : {}),
      ...(target.environment ? { environment: target.environment } : {}),
      known: target.known,
      health: { status: target.status, reasons: target.reasons.slice(0, MAX_HEALTH_REASONS) },
      tests,
      regressions: { ...counts, recent: events.slice(0, MAX_RECENT_REGRESSIONS) },
      trend: trendOf(weeklySeries(targetRuns, toMs, input.weeks, targetCutoff)),
      homologation,
    });

    totalsTests.routines += tests.routines;
    totalsTests.quarantined += tests.quarantined;
    totalsTests.vaultItems += tests.vaultItems;
    totalsTests.guardedBugs += tests.guardedBugs;
    totalsTests.runs += tests.runs;
    totalsTests.passed += tests.passed;
    totalsTests.failed += tests.failed;
    addCounts(totalsRegressions, counts);
    readiness[homologation.status] += 1;
    healthTotals[target.status] += 1;
  }
  totalsTests.passRate = rateOf(totalsTests.passed, totalsTests.runs);

  const notes = [
    'A test is an active library routine or an active regression-vault item. Quarantined tests are shown apart and never judged.',
    'A run counts once: when a run was repeated automatically only the last attempt counts, and runs with generated values are left out (their edge values fail on purpose).',
    'Regressions caught = a test that passed and then failed. ScrapForAI cannot know whether the change would have reached users. A test that is flaky now is not claimed to have regressed.',
    'Ready = every test that counts passed on the latest build the system reported. ScrapForAI does not approve a build: a person does. Signed evidence = pinned passing runs whose signature checks against this installation\'s key; verify the files with the evidence chain check.',
    ...(limited.length > 0 ? [`The run history of ${plural(limited.length, 'test', 'tests')} is at its size limit: weeks before the oldest kept run are marked partial.`] : []),
  ];

  return {
    kind: 'scrapforai-executive',
    generatedAt: input.now,
    period: { from: new Date(fromMs).toISOString(), to: input.now, days: input.days },
    weeks: input.weeks,
    ...(input.targets ? { targets: input.targets } : {}),
    totals: { systems: systems.length, readiness, health: healthTotals, tests: totalsTests, regressions: totalsRegressions },
    trend: trendOf(weeklySeries(allRuns, toMs, input.weeks, limitedCutoff)),
    systems,
    historyLimited: limited.sort(),
    notes,
  };
}
