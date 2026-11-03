import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';

// T3.2: the scheduler engine with a fake clock and a fake dispatcher (no browser), the pure decision, the validation, and the evaluate gate.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-scheduler-test-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';
process.env.ALLOWED_RESOURCE_ORIGINS = 'https://dev.example.com';
process.env.ALLOW_EVALUATE = 'true'; // so a routine with evaluate can be saved; scheduled runs must still refuse it

const { parseCron } = await import('../src/scheduler/cron.js');
const { decideTick, jitterMs } = await import('../src/scheduler/plan.js');
const { Scheduler } = await import('../src/scheduler/scheduler.js');
const { createDispatcher } = await import('../src/scheduler/dispatcher.js');
const { getSchedule, getState, listSchedules, putSchedule } = await import('../src/scheduler/scheduleStore.js');
const { saveScheduleDefinition, getScheduleView, removeSchedule } = await import('../src/scheduler/scheduleService.js');
const { saveTarget } = await import('../src/targets/targetStore.js');
const { saveRoutine } = await import('../src/library/routineService.js');
const { scheduleSchema } = await import('../src/schemas/schedule.schema.js');

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
// Every engine ticks ALL stored schedules, so each test starts from an empty store.
beforeEach(async () => {
  for (const { schedule } of await listSchedules()) await removeSchedule(schedule.id);
});

const T = (text: string): number => Date.parse(text);
const make = (id: string, extra: Record<string, unknown> = {}) =>
  scheduleSchema.parse({ id, cron: '*/10 * * * *', timezone: 'UTC', target: { kind: 'routine', routineId: 'crud' }, ...extra });

// ---- the decision, pure -------------------------------------------------------------------------------------------------------------

test('decideTick: nothing before the first occurrence; one run when it arrives; the cursor moves to it', () => {
  const input = { id: 's', spec: parseCron('*/10 * * * *'), timeZone: 'UTC', jitterSeconds: 0 };
  assert.deepEqual(decideTick({ ...input, cursorMs: T('2026-11-03T12:03:00Z'), nowMs: T('2026-11-03T12:09:59Z') }), { missed: [], cursor: T('2026-11-03T12:03:00Z'), truncated: false });

  const due = decideTick({ ...input, cursorMs: T('2026-11-03T12:03:00Z'), nowMs: T('2026-11-03T12:10:05Z') });
  assert.deepEqual([due.fire, due.missed, due.cursor], [{ at: T('2026-11-03T12:10:00Z'), recovered: false }, [], T('2026-11-03T12:10:00Z')]);
});

test('decideTick: a long gap makes ONE run (the latest, flagged as a recovery) and lists the rest as missed', () => {
  const decision = decideTick({ id: 's', spec: parseCron('*/10 * * * *'), timeZone: 'UTC', jitterSeconds: 0, cursorMs: T('2026-11-03T12:00:00Z'), nowMs: T('2026-11-03T15:00:30Z') });
  assert.equal(decision.fire?.at, T('2026-11-03T15:00:00Z'));
  assert.equal(decision.fire?.recovered, false, 'the latest occurrence was 30 s ago: on time');
  assert.equal(decision.missed.length, 17, '12:10 ... 14:50 = 17 occurrences before the latest');

  const late = decideTick({ id: 's', spec: parseCron('*/10 * * * *'), timeZone: 'UTC', jitterSeconds: 0, cursorMs: T('2026-11-03T12:00:00Z'), nowMs: T('2026-11-03T15:07:00Z') });
  assert.equal(late.fire?.recovered, true, 'seven minutes late = a recovery');
});

test('decideTick: jitter delays an occurrence by a stable amount, and the next ones wait for theirs', () => {
  const delay = jitterMs('s', T('2026-11-03T12:10:00Z'), 120);
  assert.ok(delay >= 0 && delay <= 120_000);
  assert.equal(delay, jitterMs('s', T('2026-11-03T12:10:00Z'), 120), 'always the same for the same occurrence');
  assert.notEqual(jitterMs('a', T('2026-11-03T12:10:00Z'), 600), jitterMs('b', T('2026-11-03T12:10:00Z'), 600), 'different schedules spread out');
  assert.equal(jitterMs('s', 1, 0), 0);

  const input = { id: 's', spec: parseCron('*/10 * * * *'), timeZone: 'UTC', jitterSeconds: 120, cursorMs: T('2026-11-03T12:03:00Z') };
  const at = T('2026-11-03T12:10:00Z');
  assert.equal(decideTick({ ...input, nowMs: at + delay - 1 }).fire, undefined, 'not yet');
  assert.equal(decideTick({ ...input, nowMs: at + delay }).fire?.at, at);
});

// ---- the engine ---------------------------------------------------------------------------------------------------------------------

interface Fake {
  starts: Array<{ id: string; at: string }>;
  pending: Array<(outcome: 'passed' | 'failed' | 'error') => void>;
  dispatcher: import('../src/scheduler/scheduler.js').Dispatcher;
  settled?: { outcome: 'passed' | 'failed' | 'error'; message?: string };
  refuse?: 'skipped-evaluate' | 'error';
}

function fakeDispatcher(): Fake {
  const fake: Fake = {
    starts: [],
    pending: [],
    dispatcher: {
      async start(schedule, at) {
        if (fake.refuse) return { started: false, outcome: fake.refuse, message: 'refused by the test' };
        fake.starts.push({ id: schedule.id, at });
        const done = new Promise<{ outcome: 'passed' | 'failed' | 'error' }>((resolve) => fake.pending.push((outcome) => resolve({ outcome })));
        return { started: true, run: { kind: 'suite', id: `suite_${fake.starts.length}` }, done };
      },
      async settledState() {
        return fake.settled;
      },
    },
  };
  return fake;
}

let clock = T('2026-11-03T12:03:00Z');
const scheduler = (fake: Fake) => new Scheduler({ dispatcher: fake.dispatcher, now: () => clock });

async function register(id: string, extra: Record<string, unknown> = {}, at = '2026-11-03T12:03:00Z') {
  await putSchedule(make(id, extra), at);
}
const history = async (id: string) => (await getState(id))!.history;

test('overlap: the second occurrence while the first still runs is skipped and recorded, not queued; then it runs again', async () => {
  const fake = fakeDispatcher();
  const engine = scheduler(fake);
  await register('overlap');

  clock = T('2026-11-03T12:09:00Z');
  await engine.tick();
  assert.equal(fake.starts.length, 0, 'before 12:10 nothing happens');

  clock = T('2026-11-03T12:10:05Z');
  await engine.tick();
  assert.deepEqual(fake.starts, [{ id: 'overlap', at: '2026-11-03T12:10:00.000Z' }]);
  assert.equal((await getState('overlap'))!.running?.id, 'suite_1');

  clock = T('2026-11-03T12:20:05Z');
  await engine.tick();
  assert.equal(fake.starts.length, 1, 'the first run is still going: the 12:20 occurrence did not start another');
  const skipped = (await history('overlap')).at(-1)!;
  assert.deepEqual([skipped.at, skipped.outcome], ['2026-11-03T12:20:00.000Z', 'skipped-overlap']);
  assert.match(skipped.message ?? '', /suite_1/);
  assert.equal((await getState('overlap'))!.cursor, '2026-11-03T12:20:00.000Z', 'the skipped occurrence is consumed');

  fake.pending[0]!('passed');
  await engine.idle();
  const state = (await getState('overlap'))!;
  assert.equal(state.running, undefined);
  assert.deepEqual(state.history.map((entry) => entry.outcome), ['passed', 'skipped-overlap']);
  assert.ok(state.history[0]!.finishedAt);

  clock = T('2026-11-03T12:30:05Z');
  await engine.tick();
  assert.equal(fake.starts.length, 2, 'after the run ended, the next occurrence runs');
  assert.equal((await history('overlap')).at(-1)!.outcome, 'started');
  fake.pending[1]!('failed');
  await engine.idle();
  assert.equal((await history('overlap')).at(-1)!.outcome, 'failed');
});

test('downtime: at startup ONE recovery run is made and the other missed occurrences are summarized', async () => {
  const fake = fakeDispatcher();
  const engine = scheduler(fake);
  clock = T('2026-11-03T12:03:00Z');
  await register('downtime');

  clock = T('2026-11-03T15:07:00Z'); // the server was off for three hours
  await engine.start();
  engine.stop();
  assert.equal(fake.starts.length, 1, 'exactly one recovery run, not eighteen');
  assert.equal(fake.starts[0]!.at, '2026-11-03T15:00:00.000Z');

  const entries = await history('downtime');
  const missed = entries.find((entry) => entry.outcome === 'missed')!;
  assert.equal(missed.count, 17);
  const recovery = entries.find((entry) => entry.outcome === 'started')!;
  assert.equal(recovery.recovered, true);

  fake.pending[0]!('passed');
  await engine.idle();
});

test('a disabled schedule never fires; enabling it does not replay the time it was off... only what its cursor says', async () => {
  const fake = fakeDispatcher();
  const engine = scheduler(fake);
  clock = T('2026-11-03T12:03:00Z');
  await register('off', { enabled: false });
  clock = T('2026-11-03T13:00:00Z');
  await engine.tick();
  assert.equal(fake.starts.length, 0);
});

test('run-now starts outside the clock, honors overlap, and does not move the cursor', async () => {
  const fake = fakeDispatcher();
  const engine = scheduler(fake);
  clock = T('2026-11-03T12:03:00Z');
  await register('manual');

  clock = T('2026-11-03T12:05:00Z');
  const first = await engine.runNow('manual');
  assert.deepEqual([first.outcome, first.manual], ['started', true]);
  assert.equal(Date.parse((await getState('manual'))!.cursor), T('2026-11-03T12:03:00Z'));

  const second = await engine.runNow('manual');
  assert.equal(second.outcome, 'skipped-overlap');
  assert.equal(fake.starts.length, 1);

  fake.pending[0]!('passed');
  await engine.idle();
  await assert.rejects(() => engine.runNow('ghost'), /does not exist/);
});

test('a target that cannot start is recorded with the reason and the occurrence is consumed (no retry loop)', async () => {
  const fake = fakeDispatcher();
  fake.refuse = 'skipped-evaluate';
  const engine = scheduler(fake);
  clock = T('2026-11-03T12:03:00Z');
  await register('refused');

  clock = T('2026-11-03T12:10:05Z');
  await engine.tick();
  await engine.tick();
  const entries = await history('refused');
  assert.equal(entries.length, 1, 'ticking again does not retry the same occurrence');
  assert.deepEqual([entries[0]!.outcome, entries[0]!.message], ['skipped-evaluate', 'refused by the test']);
  assert.equal((await getState('refused'))!.running, undefined);
});

test('a run left "in progress" by a dead process is settled at startup: with what the target says, or as an error', async () => {
  const fake = fakeDispatcher();
  const engine = scheduler(fake);
  clock = T('2026-11-03T12:03:00Z');
  await register('orphan');
  clock = T('2026-11-03T12:10:05Z');
  await engine.tick();
  // simulate the restart: a new engine, the state file still says "running", nothing live in memory
  const reborn = scheduler(fake);

  fake.settled = undefined;
  await reborn.reconcile();
  let last = (await history('orphan')).at(-1)!;
  assert.equal(last.outcome, 'error');
  assert.match(last.message ?? '', /server stopped/);
  assert.equal((await getState('orphan'))!.running, undefined);

  await register('orphan2');
  clock = T('2026-11-03T12:10:05Z');
  await engine.tick();
  fake.settled = { outcome: 'failed', message: '1 of 3 run(s) failed' };
  await reborn.reconcile();
  last = (await history('orphan2')).at(-1)!;
  assert.deepEqual([last.outcome, last.message], ['failed', '1 of 3 run(s) failed']);
});

// ---- validation and the evaluate gate -----------------------------------------------------------------------------------------------

before(async () => {
  await saveTarget({
    id: 'app-dev', name: 'App', platform: 'generic', environment: 'dev', baseUrl: 'https://dev.example.com', credentialSets: [],
    noiseFilters: [], surfaces: {}, screens: [], flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  });
  await saveRoutine('crud', { title: 'crud', targetProfile: 'app-dev', steps: [{ id: 'open', action: 'goto', url: '$targetUrl' }] as never });
  await saveRoutine('probe-js', {
    title: 'probe js', targetProfile: 'app-dev',
    steps: [{ id: 'open', action: 'goto', url: '$targetUrl' }, { id: 'js', action: 'evaluate', name: 'title', script: 'document.title' }] as never,
  });
  await saveRoutine('wraps-js', { title: 'wraps js', targetProfile: 'app-dev', steps: [{ id: 'inner', action: 'include', routineId: 'probe-js' }] as never });
});

test('saving validates the cron, the zone, the target and returns the next occurrences', async () => {
  const ok = await saveScheduleDefinition('nightly', { cron: '30 2 * * *', timezone: 'America/Montevideo', target: { kind: 'routine', routineId: 'crud' } }, T('2026-11-03T12:00:00Z'));
  assert.equal(ok.created, true);
  assert.deepEqual(ok.view.next, ['2026-11-04T05:30:00.000Z', '2026-11-05T05:30:00.000Z', '2026-11-06T05:30:00.000Z']);
  assert.equal((await saveScheduleDefinition('nightly', { cron: '30 3 * * *', target: { kind: 'routine', routineId: 'crud' } })).created, false);
  assert.equal((await getSchedule('nightly'))!.schedule.timezone, 'America/Montevideo', 'the default zone');

  const refused = async (body: unknown, name: string) => assert.rejects(() => saveScheduleDefinition('bad', body), (error: Error) => error.name === name, JSON.stringify(body));
  await refused({ cron: '61 * * * *', target: { kind: 'routine', routineId: 'crud' } }, 'InvalidSchedule');
  await refused({ cron: '0 0 31 2 *', target: { kind: 'routine', routineId: 'crud' } }, 'InvalidSchedule');
  await refused({ cron: '* * * * *', timezone: 'Mars/Base', target: { kind: 'routine', routineId: 'crud' } }, 'InvalidSchedule');
  await refused({ cron: '* * * * *', target: { kind: 'routine', routineId: 'ghost' } }, 'RoutineNotFound');
  await refused({ cron: '* * * * *', target: { kind: 'evolutionSnapshot', targetProfile: 'ghost' } }, 'TargetProfileNotFound');
  await refused({ cron: '* * * * *', target: { kind: 'suite', suite: { name: 's', items: [{ routineId: 'ghost' }] } } }, 'SuiteItemNotFound');
  await assert.rejects(() => saveScheduleDefinition('bad', { cron: '* * * * *', target: { kind: 'routine', routineId: 'crud' }, surprise: 1 }), /unrecognized|Unrecognized/);
  assert.equal(await getSchedule('bad'), undefined, 'a refused schedule is not stored');

  assert.equal((await getScheduleView('nightly'))!.schedule.jitterSeconds, 0);
  assert.equal(await removeSchedule('nightly'), true);
  assert.equal(await getScheduleView('nightly'), undefined);
});

test('scheduled runs refuse evaluate/watch, also through an include, unless SCHEDULED_ALLOW_EVALUATE is on', async () => {
  const dispatcher = createDispatcher();
  for (const routineId of ['probe-js', 'wraps-js']) {
    const result = await dispatcher.start(make(`js-${routineId}`, { target: { kind: 'routine', routineId } }), '2026-11-03T12:10:00.000Z');
    assert.equal(result.started, false, routineId);
    if (!result.started) {
      assert.equal(result.outcome, 'skipped-evaluate');
      assert.match(result.message, /SCHEDULED_ALLOW_EVALUATE/);
    }
  }

  const asSuite = await dispatcher.start(make('js-suite', { target: { kind: 'suite', suite: { name: 's', items: [{ routineId: 'crud' }, { routineId: 'wraps-js' }] } } }), '2026-11-03T12:10:00.000Z');
  assert.equal(asSuite.started, false);

  const missing = await dispatcher.start(make('gone', { target: { kind: 'routine', routineId: 'ghost' } }), '2026-11-03T12:10:00.000Z');
  assert.deepEqual(missing.started === false && missing.outcome, 'error');
});
