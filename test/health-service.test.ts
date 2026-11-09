import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// T3.7: the health service over real stores on disk (target profile, library, perf series, vault, schedules) and the route. No browser.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-health-test-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';
process.env.SCHEDULER_ENABLED = 'false';

const { getHealth } = await import('../src/health/healthService.js');
const { appendPerfRecord } = await import('../src/metrics/perfStore.js');
const { saveTarget } = await import('../src/targets/targetStore.js');
const { saveRoutine } = await import('../src/library/routineService.js');
const { saveItem, recordLastRun } = await import('../src/vault/regression/regressionVault.js');
const { saveScheduleDefinition } = await import('../src/scheduler/scheduleService.js');
const { updateState } = await import('../src/scheduler/scheduleStore.js');
const { healthRouter } = await import('../src/routes/health.routes.js');
const { default: express } = await import('express');

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const profile = (id: string) => ({
  id, name: id, platform: 'generic' as const, environment: 'dev' as const, baseUrl: 'https://dev.example.com', credentialSets: [],
  noiseFilters: [], surfaces: {}, screens: [], flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
});

/** 'P' passed, 'F' failed, one run a minute on the same version, profile, origin and build. */
const series = (pattern: string) =>
  [...pattern].map((letter, index) => ({
    jobId: `job_${index}`,
    at: `2026-11-03T10:${String(index).padStart(2, '0')}:00.000Z`,
    version: 1,
    profile: 'full' as const,
    env: 'https://dev.example.com',
    buildId: 'r100',
    status: letter === 'P' ? ('passed' as const) : ('failed' as const),
    durationMs: 1000,
    steps: [{ id: 'open', durationMs: 500, status: 'passed' as const }],
  }));

test('getHealth groups routines, vault items and schedules by target profile, from what is on disk', async () => {
  await saveTarget(profile('app-dev'));
  await saveTarget(profile('app-qa'));
  const steps = [{ id: 'open', action: 'goto', url: '$targetUrl' }] as never;
  await saveRoutine('solid', { title: 'solid', targetProfile: 'app-dev', steps });
  await saveRoutine('broken', { title: 'broken', targetProfile: 'app-dev', steps });
  await saveRoutine('wobbly', { title: 'wobbly', targetProfile: 'app-dev', steps });
  await saveRoutine('parked', { title: 'parked', targetProfile: 'app-dev', steps, status: 'quarantined' });
  await saveRoutine('fresh', { title: 'fresh', targetProfile: 'app-dev', steps });
  await saveRoutine('qa-smoke', { title: 'qa smoke', targetProfile: 'app-qa', steps });

  for (const record of series('P'.repeat(12))) await appendPerfRecord('solid', record);
  for (const record of series('P'.repeat(8) + 'FFFF')) await appendPerfRecord('broken', record);
  for (const record of series('FP'.repeat(10))) await appendPerfRecord('wobbly', record);
  for (const record of series('PPFFPFFPF')) await appendPerfRecord('parked', record);
  for (const record of series('P'.repeat(6))) await appendPerfRecord('qa-smoke', record);

  await saveItem('REG-1', { title: 'cart total', type: 'BUG', severity: 'HIGH', status: 'ACTIVE', surface: 'cart', tags: [], routine: { id: 'solid', version: 1 }, opened: '2026-10-01', redNotCapturedReason: 'test fixture' } as never);
  await saveItem('REG-2', { title: 'search', type: 'BUG', severity: 'LOW', status: 'ACTIVE', surface: 'search', tags: [], routine: { id: 'qa-smoke', version: 1 }, opened: '2026-10-01', redNotCapturedReason: 'test fixture' } as never);
  await recordLastRun('REG-1', { jobId: 'job_9', status: 'passed', at: '2026-11-03T11:00:00.000Z' });

  await saveScheduleDefinition('solid-nightly', { cron: '0 3 * * *', timezone: 'America/Montevideo', target: { kind: 'routine', routineId: 'solid' }, enabled: true, overlap: 'skip', jitterSeconds: 0, notify: [], retries: 1 });

  await updateState('solid-nightly', (state) => {
    state.history.push({ at: '2026-11-03T06:00:00.000Z', finishedAt: '2026-11-03T06:01:00.000Z', outcome: 'failed', run: { kind: 'run', id: 'job_19' } });
  }, '2026-11-03T06:00:00.000Z');

  const report = await getHealth(new Date('2026-11-03T12:00:00.000Z'));
  assert.equal(report.generatedAt, '2026-11-03T12:00:00.000Z');
  assert.equal(report.schedulerRunning, false, 'SCHEDULER_ENABLED=false: nothing fires and the panel says so');

  const dev = report.targets.find((target) => target.id === 'app-dev')!;
  const qa = report.targets.find((target) => target.id === 'app-qa')!;
  const states = Object.fromEntries(dev.routines.list.map((routine) => [routine.id, routine.state]));
  assert.deepEqual(states, { broken: 'failing', wobbly: 'flaky', solid: 'passing', fresh: 'never-run', parked: 'quarantined' });
  assert.equal(dev.status, 'red');
  assert.equal(dev.known, true);
  assert.equal(dev.environment, 'dev');
  assert.deepEqual(dev.routines.list.map((routine) => routine.id).slice(0, 2), ['broken', 'wobbly'], 'the ones that need a look first');

  const broken = dev.routines.list.find((routine) => routine.id === 'broken')!;
  assert.deepEqual(broken.streak, { status: 'failed', runs: 4 });
  assert.equal(broken.trend, 'worsening');
  assert.equal(broken.lastRun?.buildId, 'r100');
  assert.equal(broken.lastRun?.jobId, 'job_11', 'the latest run of the series, for the link to its report');
  assert.equal(broken.lastFailedRun, undefined, 'the last run is the failure: it is not listed twice');
  const solid = dev.routines.list.find((routine) => routine.id === 'solid')!;
  assert.equal(solid.lastRun?.jobId, 'job_11');
  assert.equal(solid.lastFailedRun, undefined, 'never failed');
  const wobbly = dev.routines.list.find((routine) => routine.id === 'wobbly')!;
  assert.equal(wobbly.suggestion?.action, 'quarantine', 'the same suggestion T3.5 shows');
  assert.ok((wobbly.flakyScore ?? 0) > 0.9);
  assert.equal(wobbly.lastRun?.jobId, 'job_19');
  assert.equal(wobbly.lastFailedRun?.jobId, 'job_18', 'it passed since: the last failure is linked apart');

  assert.equal(qa.status, 'green', 'a vault item that never ran is shown (not run), but it is not a warning by itself');
  assert.deepEqual(qa.vault.attention.map((entry) => `${entry.id}:${entry.state}`), ['REG-2:not-run']);
  assert.equal(dev.vault.passing, 1);

  assert.deepEqual(dev.schedules.map((entry) => [entry.id, entry.state]), [['solid-nightly', 'not-firing']]);
  assert.match(dev.reasons.join(' | '), /scheduler is not running/);
  assert.ok(dev.schedules[0]!.next, 'the next occurrence is shown');
  assert.deepEqual(dev.schedules[0]!.lastRun?.run, { kind: 'run', id: 'job_19' }, 'what the last occurrence started, for its report link');
});

test('GET /v1/health answers the report, ?target= narrows it, an unknown target is 404', async () => {
  const app = express();
  app.use('/v1/health', healthRouter);
  const server = app.listen(0);
  try {
    const { port } = server.address() as { port: number };
    const base = `http://127.0.0.1:${port}/v1/health`;

    const all = (await (await fetch(base)).json()) as { targets: Array<{ id: string }>; totals: { targets: number } };
    assert.ok(all.targets.length >= 2);
    assert.equal(all.totals.targets, all.targets.length);

    const one = (await (await fetch(`${base}?target=app-qa`)).json()) as { targets: Array<{ id: string; status: string }>; totals: Record<string, number> };
    assert.deepEqual(one.targets.map((target) => target.id), ['app-qa']);
    assert.equal(one.totals.targets, 1);
    assert.equal(one.totals[one.targets[0]!.status], 1);

    const missing = await fetch(`${base}?target=ghost`);
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as { error: { type: string } }).error.type, 'TargetNotFound');
  } finally {
    server.close();
  }
});
