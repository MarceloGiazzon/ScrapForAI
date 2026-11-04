import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildExecutive,
  DAY_MS,
  type ExecPinInput,
  type ExecRoutineInput,
  type ExecVaultInput,
  rateOf,
  regressionEvents,
  trendOf,
  type WeekPoint,
  weeklySeries,
} from '../src/executive/executiveAnalysis.js';
import type { HealthReport } from '../src/health/healthAnalysis.js';
import type { PerfRecord } from '../src/metrics/perfAnalysis.js';

// T9.4: the executive overview is pure. These tests pin each rule written at the top of executiveAnalysis.ts.

const NOW = '2026-11-04T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const at = (daysAgo: number): string => new Date(NOW_MS - daysAgo * DAY_MS).toISOString();

let counter = 0;
function run(daysAgo: number, status: 'passed' | 'failed', extra: Partial<PerfRecord> = {}): PerfRecord {
  counter += 1;
  return {
    jobId: `job_${counter}`,
    at: at(daysAgo),
    version: 1,
    profile: 'full',
    env: 'https://dev.example.com',
    buildId: 'r1',
    status,
    durationMs: 1000,
    steps: [{ id: 'open', durationMs: 500, status: status === 'passed' ? 'passed' : 'failed' }],
    ...extra,
  };
}

function routine(id: string, records: PerfRecord[], extra: Partial<ExecRoutineInput> = {}): ExecRoutineInput {
  return { id, title: id, status: 'active', targetProfile: 'app-dev', unstable: false, records, ...extra };
}

function health(...targets: Array<{ id: string; status?: 'red' | 'yellow' | 'green' | 'empty'; reasons?: string[]; known?: boolean }>): HealthReport {
  return {
    generatedAt: NOW,
    schedulerRunning: true,
    targets: targets.map((target) => ({ id: target.id, name: `Name ${target.id}`, environment: 'dev', known: target.known ?? true, status: target.status ?? 'green', reasons: target.reasons ?? [] })) as unknown as HealthReport['targets'],
    unscoped: {} as HealthReport['unscoped'],
    totals: { targets: targets.length, red: 0, yellow: 0, green: 0, empty: 0 },
  };
}

interface Options {
  routines?: ExecRoutineInput[];
  vault?: ExecVaultInput[];
  pins?: ExecPinInput[];
  targets?: string[];
  days?: number;
  weeks?: number;
  perfCap?: number;
  health?: HealthReport;
}

function build(options: Options = {}) {
  return buildExecutive({
    now: NOW,
    days: options.days ?? 30,
    weeks: options.weeks ?? 8,
    ...(options.targets ? { targets: options.targets } : {}),
    health: options.health ?? health({ id: 'app-dev' }),
    routines: options.routines ?? [],
    vault: options.vault ?? [],
    pins: options.pins ?? [],
    perfCap: options.perfCap ?? 500,
  });
}

// ---------------------------------------------------------------------------------------------------------------------

test('weeklySeries: 7-day buckets ending at the end of the period, an empty week has a null rate, not 0%', () => {
  const runs = [run(1, 'passed'), run(2, 'failed'), run(9, 'passed'), run(10, 'passed'), run(11, 'passed')];
  const weekly = weeklySeries(runs, NOW_MS, 4);
  assert.equal(weekly.length, 4);
  assert.deepEqual(weekly.map((week) => week.runs), [0, 0, 3, 2], 'oldest first; the last bucket is the 7 days before the end');
  assert.deepEqual(weekly.map((week) => week.rate), [null, null, 1, 0.5]);
  assert.equal(weekly[3]!.to, NOW);
  assert.equal(Date.parse(weekly[3]!.to) - Date.parse(weekly[3]!.from), 7 * DAY_MS);
  // The bucket boundary: a run exactly at the start of a bucket belongs to the one before it.
  const edge = weeklySeries([run(7, 'failed')], NOW_MS, 4);
  assert.deepEqual(edge.map((week) => week.runs), [0, 0, 1, 0]);
});

test('weeklySeries: a week that starts before the history cut-off is marked partial', () => {
  const weekly = weeklySeries([run(1, 'passed')], NOW_MS, 4, NOW_MS - 15 * DAY_MS);
  assert.deepEqual(weekly.map((week) => week.partial === true), [true, true, false, false]);
});

test('rateOf: four decimals, but a failure never rounds away to 1 and a pass never to 0', () => {
  assert.equal(rateOf(0, 0), null);
  assert.equal(rateOf(5, 5), 1);
  assert.equal(rateOf(0, 5), 0);
  assert.equal(rateOf(24, 25), 0.96);
  assert.equal(rateOf(99_999, 100_000), 0.9999, 'one failure in a hundred thousand is still not 100%');
  assert.equal(rateOf(1, 100_000), 0.0001, 'one pass is still not 0%');
});

const weeks = (...pairs: Array<[number, number]>): WeekPoint[] =>
  pairs.map(([runs, passed], index) => ({ from: `w${index}`, to: `w${index}`, runs, passed, rate: runs === 0 ? null : passed / runs }));

test('trendOf: the last two weeks against the two before, five points of change, five runs on each side', () => {
  assert.equal(trendOf(weeks([10, 8], [10, 8], [10, 10], [10, 10])).direction, 'improving');
  assert.equal(trendOf(weeks([10, 10], [10, 10], [10, 8], [10, 8])).direction, 'worsening');
  assert.equal(trendOf(weeks([10, 9], [10, 9], [10, 9], [10, 9])).direction, 'steady');
  // 96% -> 92%: a change of four points is not a direction.
  assert.equal(trendOf(weeks([50, 48], [50, 48], [50, 46], [50, 46])).direction, 'steady');
  // Too little to say: 4 runs on one side.
  const thin = trendOf(weeks([10, 8], [0, 0], [2, 2], [2, 2]));
  assert.equal(thin.direction, 'unknown');
  assert.equal(thin.recent?.runs, 4);
  assert.equal(trendOf(weeks([0, 0], [0, 0], [10, 10], [10, 10])).direction, 'unknown', 'no runs before: nothing to compare with');
  assert.equal(trendOf(weeks([10, 10], [10, 10])).direction, 'unknown', 'fewer than four weeks');
  const improving = trendOf(weeks([10, 8], [10, 8], [10, 10], [10, 10]));
  assert.deepEqual([improving.before, improving.recent], [{ runs: 20, rate: 0.8 }, { runs: 20, rate: 1 }]);
});

test('regressionEvents: a test that passed and then failed; one that never passed has not regressed', () => {
  const r = { id: 'login', title: 'Login' };
  const from = NOW_MS - 30 * DAY_MS;

  // pass, pass, FAIL, fail, pass: one regression, resolved by the last pass; two failures in a row are one episode.
  const runs = [run(10, 'passed', { buildId: 'r1' }), run(9, 'passed', { buildId: 'r1' }), run(8, 'failed', { buildId: 'r2' }), run(7, 'failed', { buildId: 'r2' }), run(6, 'passed', { buildId: 'r2' })];
  const events = regressionEvents(r, runs, from, NOW_MS);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.at, at(8));
  assert.equal(events[0]!.build, 'r2');
  assert.equal(events[0]!.previousBuild, 'r1', 'the last build that passed');
  assert.equal(events[0]!.failedStep, 'open');
  assert.equal(events[0]!.resolvedAt, at(6));

  assert.deepEqual(regressionEvents(r, [run(5, 'failed'), run(4, 'failed')], from, NOW_MS), [], 'failing from the first run is not a regression');
  assert.equal(regressionEvents(r, [run(5, 'passed'), run(4, 'failed')], from, NOW_MS)[0]!.resolvedAt, undefined, 'still failing');

  // Alternating: every pass -> fail is an episode.
  assert.equal(regressionEvents(r, [run(6, 'passed'), run(5, 'failed'), run(4, 'passed'), run(3, 'failed')], from, NOW_MS).length, 2);
});

test('regressionEvents: only failures inside the period count; a pass after the period does not resolve one', () => {
  const r = { id: 'login', title: 'Login' };
  const periodFrom = NOW_MS - 7 * DAY_MS;
  const periodTo = NOW_MS - 2 * DAY_MS;
  const runs = [run(20, 'passed'), run(15, 'failed'), run(14, 'passed'), run(5, 'passed'), run(4, 'failed'), run(1, 'passed')];
  const events = regressionEvents(r, runs, periodFrom, periodTo);
  assert.equal(events.length, 1, 'the failure of 15 days ago is before the period');
  assert.equal(events[0]!.at, at(4));
  assert.equal(events[0]!.resolvedAt, undefined, 'the pass at day -1 is after the end of the period');
});

// ---------------------------------------------------------------------------------------------------------------------

test('tests and runs: active routines and vault items count, quarantined ones are apart, a retried first attempt and a generated-values run are left out', () => {
  const report = build({
    routines: [
      routine('solid', [run(3, 'passed'), run(2, 'passed')]),
      // First attempt failed, the automatic new attempt passed: ONE run, a pass.
      routine('retried', [run(3, 'failed', { jobId: 'job_first' }), run(3, 'passed', { attempt: 2, retryOf: 'job_first' })]),
      routine('edges', [run(3, 'failed', { parametric: true }), run(2, 'failed', { parametric: true })]),
      routine('parked', [run(3, 'failed'), run(2, 'failed')], { status: 'quarantined' }),
      routine('wip', [run(3, 'failed')], { status: 'draft' }),
    ],
    vault: [
      { id: 'REG-1', status: 'ACTIVE', routineId: 'solid', guarded: true, lastRun: { status: 'passed', at: at(1) } },
      { id: 'REG-2', status: 'ACTIVE', routineId: 'solid', guarded: false },
      { id: 'REG-3', status: 'QUARANTINED', routineId: 'solid', guarded: true },
      { id: 'REG-4', status: 'ACTIVE', routineId: 'ghost', guarded: true },
    ],
  });
  const tests = report.systems[0]!.tests;
  assert.equal(tests.routines, 3, 'solid, retried and edges are active');
  assert.equal(tests.quarantined, 1);
  assert.equal(tests.vaultItems, 2, 'REG-4 has no routine in the library: it belongs to no system');
  assert.equal(tests.guardedBugs, 1);
  assert.equal(tests.runs, 3, 'solid x2 and the retried routine once; the generated-values runs and the quarantined routine are not counted');
  assert.equal(tests.passed, 3);
  assert.equal(tests.failed, 0);
  assert.equal(tests.passRate, 1);
  assert.deepEqual(report.totals.tests, tests, 'one system: the totals are the system');
});

test('the period: runs before it are not counted, and a period without runs has a null pass rate', () => {
  const report = build({ days: 7, routines: [routine('old', [run(40, 'failed'), run(20, 'passed')])] });
  assert.equal(report.systems[0]!.tests.runs, 0);
  assert.equal(report.systems[0]!.tests.passRate, null);
  assert.equal(report.totals.tests.passRate, null);
  assert.equal(report.period.days, 7);
  assert.equal(report.period.to, NOW);
  assert.equal(report.period.from, at(7));
});

test('regressions: caught, resolved and open; a flaky routine is "unstable", not a regression; a quarantined one is not counted', () => {
  const report = build({
    routines: [
      routine('broke', [run(10, 'passed'), run(5, 'failed', { buildId: 'r2' })]),
      routine('fixed', [run(10, 'passed'), run(8, 'failed'), run(6, 'passed')]),
      routine('wobbly', [run(10, 'passed'), run(9, 'failed'), run(8, 'passed'), run(7, 'failed')], { unstable: true }),
      routine('parked', [run(10, 'passed'), run(9, 'failed')], { status: 'quarantined' }),
      routine('never-green', [run(10, 'failed'), run(9, 'failed')]),
    ],
  });
  const { regressions } = report.systems[0]!;
  assert.deepEqual({ caught: regressions.caught, resolved: regressions.resolved, open: regressions.open, unstable: regressions.unstable }, { caught: 2, resolved: 1, open: 1, unstable: 2 });
  assert.deepEqual(regressions.recent.map((event) => event.routineId), ['broke', 'fixed'], 'most recent first');
  assert.deepEqual(report.totals.regressions, { caught: 2, resolved: 1, open: 1, unstable: 2 });
});

test('regressions: the list keeps the five most recent, the count stays complete', () => {
  const routines = Array.from({ length: 7 }, (_, index) => routine(`r${index}`, [run(20, 'passed'), run(index + 1, 'failed')]));
  const { regressions } = build({ routines }).systems[0]!;
  assert.equal(regressions.caught, 7);
  assert.equal(regressions.recent.length, 5);
  assert.equal(regressions.recent[0]!.routineId, 'r0', 'failed 1 day ago');
});

// ---------------------------------------------------------------------------------------------------------------------

test('readiness: ready when every test passed on the latest build, with the signed evidence of that build', () => {
  const pins: ExecPinInput[] = [
    { jobId: 'p1', routineId: 'a', buildId: 'r2', status: 'passed', signed: true },
    { jobId: 'p2', routineId: 'a', buildId: 'r2', status: 'passed', signed: true },
    { jobId: 'p3', routineId: 'b', buildId: 'r2', status: 'passed', signed: false }, // signature does not check
    { jobId: 'p4', routineId: 'b', buildId: 'r1', status: 'passed', signed: true }, // another build
    { jobId: 'p5', routineId: 'zzz', buildId: 'r2', status: 'passed', signed: true }, // not a test of this system
    { jobId: 'p6', routineId: 'b', buildId: 'r2', status: 'failed', signed: true }, // a failing run is not evidence of readiness
  ];
  const report = build({
    routines: [routine('a', [run(3, 'passed', { buildId: 'r1' }), run(1, 'passed', { buildId: 'r2' })]), routine('b', [run(2, 'passed', { buildId: 'r2' })])],
    vault: [{ id: 'REG-1', status: 'ACTIVE', routineId: 'a', guarded: true, lastRun: { status: 'passed', at: at(1), buildId: 'r2' } }],
    pins,
  });
  const homologation = report.systems[0]!.homologation;
  assert.equal(homologation.status, 'ready');
  assert.equal(homologation.build, 'r2');
  assert.deepEqual([homologation.passed, homologation.total, homologation.failed, homologation.notRun], [3, 3, 0, 0], 'two routines and one vault item');
  assert.deepEqual(homologation.reasons, []);
  assert.deepEqual(homologation.evidence, { runs: 2, tests: 1 }, 'only p1 and p2: signed, passing, this build, this system');
  assert.equal(report.totals.readiness.ready, 1);
});

test('readiness: blocked when a test failed in its last run, a failing vault item included', () => {
  const routineFails = build({ routines: [routine('a', [run(2, 'passed')]), routine('b', [run(3, 'passed'), run(1, 'failed')])] }).systems[0]!.homologation;
  assert.equal(routineFails.status, 'blocked');
  assert.deepEqual(routineFails.reasons, ['1 test failed in the last run']);

  const vaultFails = build({
    routines: [routine('a', [run(2, 'passed')])],
    vault: [{ id: 'REG-1', status: 'ACTIVE', routineId: 'a', guarded: true, lastRun: { status: 'failed', at: at(1), buildId: 'r1' } }],
  }).systems[0]!.homologation;
  assert.equal(vaultFails.status, 'blocked', 'a guarded bug that came back blocks the build');
});

test('readiness: a pass that passed on an OLDER build, or a test that never ran, makes it incomplete', () => {
  const report = build({
    routines: [
      routine('a', [run(5, 'passed', { buildId: 'r1' }), run(1, 'passed', { buildId: 'r2' })]),
      routine('stale', [run(5, 'passed', { buildId: 'r1' })]),
      routine('fresh', []),
    ],
  });
  const homologation = report.systems[0]!.homologation;
  assert.equal(homologation.status, 'incomplete');
  assert.equal(homologation.build, 'r2', 'the build of the most recent run');
  assert.deepEqual([homologation.passed, homologation.notRun, homologation.total], [1, 2, 3]);
  assert.deepEqual(homologation.reasons, ['2 of 3 tests have not run on build r2']);
});

test('readiness: no-data when nothing has run; quarantined tests never decide it', () => {
  const empty = build({ routines: [routine('fresh', [])] }).systems[0]!.homologation;
  assert.equal(empty.status, 'no-data');
  assert.equal(build({ routines: [] }).systems[0]!.homologation.status, 'no-data');

  const withQuarantine = build({ routines: [routine('a', [run(1, 'passed')]), routine('parked', [run(1, 'failed')], { status: 'quarantined' })] }).systems[0]!.homologation;
  assert.equal(withQuarantine.status, 'ready', 'a failing quarantined test does not block, as in suites');
  assert.equal(withQuarantine.quarantined, 1);
});

test('readiness: without a build in the results it is judged on the last result and says so; no evidence is claimed', () => {
  const { buildId: _dropped, ...withoutBuild } = run(1, 'passed');
  const report = build({
    routines: [routine('a', [run(2, 'passed', { buildId: 'unknown' })]), routine('b', [withoutBuild])],
    pins: [{ jobId: 'p1', routineId: 'a', buildId: 'r1', status: 'passed', signed: true }],
  });
  const homologation = report.systems[0]!.homologation;
  assert.equal(homologation.status, 'ready');
  assert.equal(homologation.build, undefined);
  assert.equal(homologation.evidence, undefined, 'evidence is tied to a build; with none, none is claimed');
  assert.match(homologation.notes.join(' '), /not tied to a build/);
});

test('readiness: a routine that only ran with generated values is not judged and does not hold the system back', () => {
  const homologation = build({ routines: [routine('a', [run(1, 'passed')]), routine('edges', [run(1, 'failed', { parametric: true })])] }).systems[0]!.homologation;
  assert.equal(homologation.status, 'ready');
  assert.equal(homologation.notJudged, 1);
  assert.equal(homologation.total, 1);
  assert.match(homologation.notes.join(' '), /generated values/);
});

test('readiness is per system: each target is judged by its own routines, in the order of the health panel', () => {
  const report = build({
    health: health({ id: 'app-dev', status: 'red', reasons: ['1 routine failing in the last run', 'b', 'c', 'd', 'e'] }, { id: 'app-qa' }, { id: 'ghost', known: false }),
    routines: [routine('dev-a', [run(1, 'failed'), run(2, 'passed')], { targetProfile: 'app-dev' }), routine('qa-a', [run(1, 'passed')], { targetProfile: 'app-qa' })],
  });
  assert.deepEqual(report.systems.map((system) => [system.id, system.homologation.status]), [['app-dev', 'blocked'], ['app-qa', 'ready'], ['ghost', 'no-data']]);
  assert.deepEqual(report.totals.readiness, { ready: 1, blocked: 1, incomplete: 0, 'no-data': 1 });
  assert.equal(report.systems[0]!.health.reasons.length, 3, 'the health reasons are shortened to three');
  assert.equal(report.systems[0]!.name, 'Name app-dev');
  assert.equal(report.systems[2]!.known, false);
  assert.deepEqual(report.totals.health, { red: 1, yellow: 0, green: 2, empty: 0 });
  assert.equal(report.totals.systems, 3);
  assert.equal(report.totals.tests.runs, 3, 'the totals add the systems up: two runs of dev-a and one of qa-a');
  assert.equal(report.totals.regressions.caught, 1);
});

test('a target filter narrows the systems and the totals', () => {
  const report = build({
    targets: ['app-qa'],
    health: health({ id: 'app-dev' }, { id: 'app-qa' }),
    routines: [routine('dev-a', [run(1, 'passed')], { targetProfile: 'app-dev' }), routine('qa-a', [run(1, 'passed')], { targetProfile: 'app-qa' })],
  });
  assert.deepEqual(report.systems.map((system) => system.id), ['app-qa']);
  assert.equal(report.totals.systems, 1);
  assert.equal(report.totals.tests.routines, 1);
  assert.deepEqual(report.targets, ['app-qa']);
});

// ---------------------------------------------------------------------------------------------------------------------

test('trend: the whole-installation series adds the systems; a target has its own', () => {
  // Days 1-12 are the last two weeks; days 16-26 are the two weeks before them.
  const lastTwoWeeks = [1, 3, 5, 8, 10, 12];
  const twoWeeksBefore = [16, 18, 20, 22, 24, 26];
  const dev = [...lastTwoWeeks.map((day) => run(day, 'passed')), ...twoWeeksBefore.map((day) => run(day, 'failed'))];
  const qa = [...lastTwoWeeks, ...twoWeeksBefore].map((day) => run(day, 'passed'));
  const report = build({
    weeks: 4,
    health: health({ id: 'app-dev' }, { id: 'app-qa' }),
    routines: [routine('d', dev, { targetProfile: 'app-dev' }), routine('q', qa, { targetProfile: 'app-qa' })],
  });
  const [devSystem, qaSystem] = report.systems;
  assert.equal(devSystem!.trend.direction, 'improving', 'failing in the two weeks before, passing in the last two');
  assert.deepEqual([devSystem!.trend.before?.rate, devSystem!.trend.recent?.rate], [0, 1]);
  assert.equal(qaSystem!.trend.direction, 'steady');
  assert.equal(report.trend.weekly.length, 4);
  assert.equal(report.trend.weekly[3]!.runs, 6, 'days 0-7: days 1, 3, 5 of both systems');
  assert.equal(report.trend.weekly[2]!.runs, 6, 'days 7-14: days 8, 10, 12 of both systems');
  assert.equal(report.trend.direction, 'improving', 'dev improved and qa held: the installation as a whole improved');
});

test('trend: with less than four weeks of runs there is no direction to claim', () => {
  const report = build({ weeks: 4, routines: [routine('a', [run(1, 'passed'), run(2, 'passed'), run(3, 'failed'), run(4, 'passed'), run(5, 'passed'), run(6, 'passed')])] });
  assert.equal(report.systems[0]!.trend.direction, 'unknown');
  assert.equal(report.trend.direction, 'unknown');
});

test('history at its size limit: the routine is named and the weeks before its oldest kept run are partial, not shown as complete', () => {
  // Six runs kept, the oldest 8 days ago: the series reaches back past the last week but not past the one before it.
  const capped = Array.from({ length: 6 }, (_, index) => run(8 - index * 0.5, 'passed'));
  const report = build({ weeks: 4, perfCap: 6, routines: [routine('busy', capped)] });
  assert.deepEqual(report.historyLimited, ['busy']);
  assert.deepEqual(report.systems[0]!.trend.weekly.map((week) => week.partial === true), [true, true, true, false]);
  assert.match(report.notes.join(' '), /size limit/);

  const roomy = build({ weeks: 4, perfCap: 500, routines: [routine('busy', capped)] });
  assert.deepEqual(roomy.historyLimited, []);
  assert.ok(roomy.systems[0]!.trend.weekly.every((week) => week.partial === undefined));
});

test('the report carries its definitions as notes and no free text from a run (ids, counts, builds and times only)', () => {
  const report = build({ routines: [routine('a', [run(2, 'passed'), run(1, 'failed')])] });
  assert.equal(report.kind, 'scrapforai-executive');
  assert.ok(report.notes.some((note) => /Regressions caught/.test(note)));
  assert.ok(report.notes.some((note) => /does not approve a build/.test(note)));
  const event = report.systems[0]!.regressions.recent[0]!;
  assert.deepEqual(Object.keys(event).sort(), ['at', 'build', 'failedStep', 'previousBuild', 'routineId', 'title']);
});
