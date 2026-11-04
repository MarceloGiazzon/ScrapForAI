import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildHealth,
  classifyRoutine,
  classifySchedule,
  summarizeVault,
  trendOf,
  type HealthInput,
  type RoutineHealthInput,
  type ScheduleInput,
  type VaultItemInput,
} from '../src/health/healthAnalysis.js';

const at = '2026-11-03T12:00:00.000Z';

function routine(over: Partial<RoutineHealthInput> = {}): RoutineHealthInput {
  return {
    id: 'crud',
    title: 'CRUD',
    version: 1,
    status: 'active',
    targetProfile: 'app-dev',
    lastRun: { jobId: 'job_1', at, status: 'passed' },
    results: ['passed', 'passed', 'passed'],
    flaky: false,
    slower: [],
    ...over,
  };
}

const item = (over: Partial<VaultItemInput> = {}): VaultItemInput => ({ id: 'REG-1', title: 'bug', status: 'ACTIVE', severity: 'HIGH', surface: 'cart', routineId: 'crud', ...over });

const schedule = (over: Partial<ScheduleInput> = {}): ScheduleInput => ({
  id: 'nightly',
  enabled: true,
  cron: '0 3 * * *',
  timezone: 'America/Montevideo',
  target: { kind: 'routine', routineId: 'crud' },
  next: [at],
  notify: 0,
  ...over,
});

function health(over: Partial<HealthInput> = {}) {
  return buildHealth({ now: at, schedulerRunning: true, targets: [{ id: 'app-dev', name: 'App', environment: 'dev' }], routines: [], vault: [], schedules: [], ...over });
}

test('trendOf: compares the share of failures in the older and newer half; fewer than 6 results is unknown', () => {
  assert.equal(trendOf(['passed', 'failed', 'passed']), 'unknown');
  assert.equal(trendOf(['passed', 'passed', 'passed', 'passed', 'failed', 'failed']), 'worsening');
  assert.equal(trendOf(['failed', 'failed', 'failed', 'passed', 'passed', 'passed']), 'improving');
  assert.equal(trendOf(['passed', 'failed', 'passed', 'passed', 'failed', 'passed']), 'steady');
  assert.equal(trendOf(['passed', 'failed', 'passed', 'failed', 'passed', 'failed']), 'worsening', 'one more failure in the newer half is a clear change');
  assert.equal(trendOf(['passed', 'passed', 'passed', 'passed', 'passed', 'passed']), 'steady');
});

test('classifyRoutine: failing beats flaky beats slower; quarantined and inactive are apart; no run is never-run', () => {
  const failed = { jobId: 'j', at, status: 'failed' as const };
  assert.equal(classifyRoutine(routine()).state, 'passing');
  assert.equal(classifyRoutine(routine({ lastRun: failed })).state, 'failing');
  assert.equal(classifyRoutine(routine({ lastRun: failed, flaky: true })).state, 'failing');
  assert.equal(classifyRoutine(routine({ flaky: true, slower: [{ series: '(run)' }] })).state, 'flaky');
  assert.equal(classifyRoutine(routine({ suggestion: { action: 'quarantine', reason: 'x' } })).state, 'flaky');
  assert.equal(classifyRoutine(routine({ slower: [{ series: 'open', ratio: 2 }] })).state, 'slower');
  assert.equal(classifyRoutine(routine({ status: 'quarantined', lastRun: failed })).state, 'quarantined', 'a quarantined failure is reported apart');
  assert.equal(classifyRoutine(routine({ status: 'retired' })).state, 'inactive');
  assert.equal(classifyRoutine(routine({ status: 'draft', lastRun: failed })).state, 'inactive');
  const never = routine();
  delete never.lastRun;
  assert.equal(classifyRoutine({ ...never, results: [] }).state, 'never-run');
});

test('classifyRoutine: the streak counts the trailing runs with the last result', () => {
  assert.deepEqual(classifyRoutine(routine({ results: ['passed', 'failed', 'failed', 'failed'] })).streak, { status: 'failed', runs: 3 });
  assert.deepEqual(classifyRoutine(routine({ results: ['failed', 'passed'] })).streak, { status: 'passed', runs: 1 });
  assert.equal(classifyRoutine(routine({ results: [] })).streak, undefined);
});

test('summarizeVault: only ACTIVE items are judged; failing before not-run; quarantined failures are counted apart', () => {
  const run = (status: 'passed' | 'failed') => ({ jobId: 'j', status, at });
  const summary = summarizeVault([
    item({ id: 'REG-2', lastRun: run('failed') }),
    item({ id: 'REG-1', lastRun: run('passed') }),
    item({ id: 'REG-10' }),
    item({ id: 'REG-3', status: 'QUARANTINED', lastRun: run('failed') }),
    item({ id: 'REG-4', status: 'RETIRED', lastRun: run('failed') }),
  ]);
  assert.deepEqual({ total: summary.total, active: summary.active, passing: summary.passing, failing: summary.failing, notRun: summary.notRun, quarantined: summary.quarantined, retired: summary.retired, quarantinedFailing: summary.quarantinedFailing }, {
    total: 5, active: 3, passing: 1, failing: 1, notRun: 1, quarantined: 1, retired: 1, quarantinedFailing: 1,
  });
  assert.deepEqual(summary.attention.map((entry) => `${entry.id}:${entry.state}`), ['REG-2:failing', 'REG-10:not-run']);
});

test('classifySchedule: disabled, not firing without a scheduler, failing at the last occurrence, never ran, ok', () => {
  assert.equal(classifySchedule(schedule({ enabled: false }), true).state, 'disabled');
  assert.equal(classifySchedule(schedule(), false).state, 'not-firing');
  assert.equal(classifySchedule(schedule({ lastRun: { outcome: 'failed', at } }), true).state, 'failing');
  assert.equal(classifySchedule(schedule({ lastRun: { outcome: 'error', at } }), true).state, 'failing');
  assert.equal(classifySchedule(schedule(), true).state, 'never-ran');
  assert.equal(classifySchedule(schedule({ lastRun: { outcome: 'passed', at, passedOnRetry: true } }), true).state, 'ok', 'a pass on the new attempt is a pass');
  assert.equal(classifySchedule(schedule({ next: [at, at] }), true).next, at);
  assert.equal(classifySchedule(schedule({ notify: 2 }), true).notifies, true);
});

test('target status: red for a failing routine, vault item or schedule; yellow for flaky/slower/suggestions/unfired schedules; green; empty', () => {
  assert.equal(health({ routines: [routine()] }).targets[0]!.status, 'green');
  assert.equal(health().targets[0]!.status, 'empty', 'nothing has run');
  assert.equal(health({ routines: [routine({ lastRun: undefined, results: [] })] }).targets[0]!.status, 'empty');

  const failed = { jobId: 'j', at, status: 'failed' as const };
  const red = health({ routines: [routine({ lastRun: failed })] }).targets[0]!;
  assert.equal(red.status, 'red');
  assert.match(red.reasons[0]!, /1 routine failing/);

  assert.equal(health({ routines: [routine()], vault: [item({ lastRun: { jobId: 'j', status: 'failed', at } })] }).targets[0]!.status, 'red');
  assert.equal(health({ routines: [routine()], schedules: [schedule({ lastRun: { outcome: 'failed', at } })] }).targets[0]!.status, 'red');

  assert.equal(health({ routines: [routine({ flaky: true })] }).targets[0]!.status, 'yellow');
  assert.equal(health({ routines: [routine({ slower: [{ series: 'open' }] })] }).targets[0]!.status, 'yellow');
  assert.equal(health({ routines: [routine()], schedules: [schedule()], schedulerRunning: false }).targets[0]!.status, 'yellow');
  const release = health({ routines: [routine({ status: 'quarantined', suggestion: { action: 'release', reason: 'all passed' } })] }).targets[0]!;
  assert.equal(release.status, 'yellow');
  assert.match(release.reasons.join(), /could be released/);
});

test('a quarantined routine or vault item never turns a target red', () => {
  const failed = { jobId: 'j', at, status: 'failed' as const };
  const report = health({
    routines: [routine(), routine({ id: 'unstable', status: 'quarantined', lastRun: failed })],
    vault: [item({ status: 'QUARANTINED', lastRun: { jobId: 'j', status: 'failed', at } })],
  });
  assert.equal(report.targets[0]!.status, 'green');
  assert.equal(report.targets[0]!.routines.counts.quarantined, 1);
});

test('red wins over yellow, and its reasons list the yellow ones after', () => {
  const failed = { jobId: 'j', at, status: 'failed' as const };
  const target = health({ routines: [routine({ id: 'a', lastRun: failed }), routine({ id: 'b', flaky: true })] }).targets[0]!;
  assert.equal(target.status, 'red');
  assert.deepEqual(target.reasons, ['1 routine failing in the last run', '1 flaky routine']);
});

test('grouping: vault items follow their routine, schedules follow their routine or an explicit profile, suites and the vault are unscoped', () => {
  const report = health({
    targets: [{ id: 'app-dev' }, { id: 'app-qa' }],
    routines: [routine(), routine({ id: 'qa-smoke', targetProfile: 'app-qa' })],
    vault: [item({ id: 'REG-1', routineId: 'crud' }), item({ id: 'REG-2', routineId: 'qa-smoke' }), item({ id: 'REG-3', routineId: 'gone' })],
    schedules: [
      schedule({ id: 'by-routine', target: { kind: 'routine', routineId: 'qa-smoke' } }),
      schedule({ id: 'explicit', target: { kind: 'routine', routineId: 'crud', targetProfile: 'app-qa' } }),
      schedule({ id: 'snapshot', target: { kind: 'evolutionSnapshot', targetProfile: 'app-dev' } }),
      schedule({ id: 'whole-suite', target: { kind: 'suite' } }),
      schedule({ id: 'vault-nightly', target: { kind: 'vault' } }),
    ],
  });
  const dev = report.targets.find((target) => target.id === 'app-dev')!;
  const qa = report.targets.find((target) => target.id === 'app-qa')!;
  assert.deepEqual(dev.vault.attention.map((entry) => entry.id), ['REG-1']);
  assert.deepEqual(qa.vault.attention.map((entry) => entry.id), ['REG-2']);
  assert.deepEqual(dev.schedules.map((entry) => entry.id), ['snapshot']);
  assert.deepEqual(qa.schedules.map((entry) => entry.id), ['by-routine', 'explicit']);
  assert.deepEqual(report.unscoped.schedules.map((entry) => entry.id), ['vault-nightly', 'whole-suite']);
  assert.deepEqual(report.unscoped.vault.attention.map((entry) => entry.id), ['REG-3'], 'its routine no longer exists');
});

test('a routine that points at a profile that is not stored still gets a card, marked unknown', () => {
  const report = health({ targets: [], routines: [routine({ targetProfile: 'ghost' })] });
  assert.equal(report.targets[0]!.id, 'ghost');
  assert.equal(report.targets[0]!.known, false);
  assert.equal(health().targets[0]!.known, true);
});

test('targets are ordered worst first, then by id; totals count each status', () => {
  const failed = { jobId: 'j', at, status: 'failed' as const };
  const report = health({
    targets: [{ id: 'a-green' }, { id: 'b-empty' }, { id: 'c-red' }, { id: 'd-yellow' }],
    routines: [
      routine({ id: 'r1', targetProfile: 'a-green' }),
      routine({ id: 'r3', targetProfile: 'c-red', lastRun: failed }),
      routine({ id: 'r4', targetProfile: 'd-yellow', flaky: true }),
    ],
  });
  assert.deepEqual(report.targets.map((target) => target.id), ['c-red', 'd-yellow', 'a-green', 'b-empty']);
  assert.deepEqual(report.totals, { targets: 4, red: 1, yellow: 1, green: 1, empty: 1 });
});

test('routines inside a target are ordered by what needs attention, then by id', () => {
  const failed = { jobId: 'j', at, status: 'failed' as const };
  const list = health({ routines: [routine({ id: 'b' }), routine({ id: 'a', status: 'retired' }), routine({ id: 'c', lastRun: failed }), routine({ id: 'd', flaky: true })] }).targets[0]!.routines.list;
  assert.deepEqual(list.map((entry) => `${entry.id}:${entry.state}`), ['c:failing', 'd:flaky', 'b:passing', 'a:inactive']);
});

test('the report carries nothing a run extracted: only ids, statuses, times, builds and reasons', () => {
  const json = JSON.stringify(health({ routines: [routine({ flaky: true, suggestion: { action: 'quarantine', reason: '6 state changes' } })], vault: [item()], schedules: [schedule()] }));
  assert.ok(!/password|secret|token|credential/i.test(json));
});
