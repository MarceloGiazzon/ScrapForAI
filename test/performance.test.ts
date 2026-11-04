import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, beforeEach } from 'node:test';

// T3.4: baseline = median of the green runs BEFORE the last 3, alert when the median of the last 3 is > baseline x 1.3 (and slower by a real amount);
// the pure analysis, what a run records, and the store/service on disk. No browser.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-perf-test-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';
process.env.PERF_MAX_RECORDS = '30';

const { analyzeRoutine, analyzeSamples, median, populationsOf } = await import('../src/metrics/perfAnalysis.js');
const { perfRecordOf, recordRunMetrics } = await import('../src/metrics/perfRecorder.js');
const { appendPerfRecord, deletePerfRecords, listPerfRoutines, readPerfRecords } = await import('../src/metrics/perfStore.js');
const { getRoutinePerformance, listPerformance, listPerformanceAlerts, perfConfig } = await import('../src/metrics/perfService.js');
const { metricsDir } = await import('../src/config/paths.js');

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
beforeEach(async () => {
  for (const id of await listPerfRoutines()) await deletePerfRecords(id);
});

const CONFIG = { baselineRuns: 20, recentRuns: 3, minBaselineRuns: 5, alertRatio: 1.3, minDeltaMs: 100 };
const sample = (index: number, durationMs: number, buildId?: string) => ({ at: `2026-11-03T10:${String(index % 60).padStart(2, '0')}:00.000Z`, jobId: `job_${index}`, durationMs, ...(buildId ? { buildId } : {}) });
const series = (values: number[], build?: (index: number) => string | undefined) => values.map((value, index) => sample(index, value, build?.(index)));

test('median: odd, even, unsorted', () => {
  assert.equal(median([5]), 5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('analyzeSamples: too few green runs gives no baseline and no alert, and says what it is waiting for', () => {
  const result = analyzeSamples('s', series([100, 100, 100, 100, 100, 100, 100]), CONFIG, 60);
  assert.equal(result.alert, false);
  assert.equal(result.baselineMs, undefined);
  assert.match(result.note ?? '', /needs 8 green runs/);
});

test('analyzeSamples: the roadmap rule - median of the last 3 above baseline x 1.3 alerts; the baseline does not include those 3', () => {
  const baseline = Array.from({ length: 20 }, (_, i) => 1000 + (i % 3) * 10); // median 1010
  const slow = analyzeSamples('s', series([...baseline, 1500, 1500, 1500]), CONFIG, 60);
  assert.equal(slow.alert, true);
  assert.equal(slow.baselineMs, 1010, 'the slow runs are not averaged into their own baseline');
  assert.equal(slow.recentMs, 1500);
  assert.equal(slow.ratio, 1.49);

  const steady = analyzeSamples('s', series([...baseline, 1300, 1300, 1300]), CONFIG, 60);
  assert.equal(steady.alert, false, '1300 / 1010 = 1.29: under the ratio');
  assert.equal(analyzeSamples('s', series([...baseline, 1320, 1320, 1320]), CONFIG, 60).alert, true, 'just over');
});

test('analyzeSamples: one slow run among the last 3 is noise (the median decides); two are a trend', () => {
  const baseline = Array.from({ length: 10 }, () => 1000);
  assert.equal(analyzeSamples('s', series([...baseline, 1000, 1000, 9000]), CONFIG, 60).alert, false);
  assert.equal(analyzeSamples('s', series([...baseline, 1000, 2000, 2000]), CONFIG, 60).alert, true);
});

test('analyzeSamples: a big ratio on a tiny step is not an alert (minDeltaMs)', () => {
  const tiny = analyzeSamples('s', series([...Array.from({ length: 10 }, () => 20), 40, 40, 40]), CONFIG, 60);
  assert.equal(tiny.ratio, 2);
  assert.equal(tiny.alert, false, '20 ms -> 40 ms is 20 ms: noise');
  assert.equal(analyzeSamples('s', series([...Array.from({ length: 10 }, () => 20), 40, 40, 40]), { ...CONFIG, minDeltaMs: 10 }, 60).alert, true, 'configurable');
});

test('analyzeSamples: the baseline is the last 20 samples before the recent ones, not the whole history', () => {
  const old = Array.from({ length: 30 }, () => 5000); // an old, slow era
  const now = Array.from({ length: 20 }, () => 1000);
  const result = analyzeSamples('s', series([...old, ...now, 1100, 1100, 1100]), CONFIG, 60);
  assert.equal(result.baselineMs, 1000);
  assert.equal(result.alert, false);
  assert.equal(result.samples, 53);
  assert.equal(result.points.length, 53 > 60 ? 60 : 53);
  assert.equal(analyzeSamples('s', series(Array.from({ length: 100 }, () => 10)), CONFIG, 60).points.length, 60, 'points are capped for the sparkline');
});

test('analyzeSamples: marks where the build changes and names the new build as the suspect of an alert', () => {
  const values = [...Array.from({ length: 10 }, () => 1000), 1600, 1600, 1600];
  const result = analyzeSamples('s', series(values, (i) => (i < 10 ? 'r100' : i === 10 ? 'unknown' : 'r101')), CONFIG, 60);
  assert.deepEqual(result.buildChanges, [11], '"unknown" is not a build: the change is marked where r101 first shows');
  assert.equal(result.alert, true);
  assert.equal(result.suspectBuild, 'r101');

  const same = analyzeSamples('s', series(values, () => 'r100'), CONFIG, 60);
  assert.equal(same.alert, true);
  assert.equal(same.suspectBuild, undefined, 'slower on the same build: no build to blame');
  assert.deepEqual(same.buildChanges, []);
});

// ---- a routine (several populations, steps) ---------------------------------------------------------------------------------------------

const record = (index: number, overrides: Record<string, unknown> = {}, stepMs: Record<string, number> = { open: 200, save: 800 }) => {
  const steps = Object.entries(stepMs).map(([id, durationMs]) => ({ id, durationMs, status: 'passed' as const }));
  return {
    jobId: `job_${index}`,
    at: new Date(Date.UTC(2026, 10, 3, 0, index)).toISOString(),
    version: 1,
    profile: 'full' as const,
    env: 'https://dev.example.com',
    status: 'passed' as const,
    durationMs: steps.reduce((total, step) => total + step.durationMs, 0),
    steps,
    ...overrides,
  };
};

test('analyzeRoutine: finds WHICH step got slower, with the run as a whole; failed runs do not count', () => {
  const records = [
    ...Array.from({ length: 12 }, (_, i) => record(i)),
    record(12, { status: 'failed', durationMs: 60000 }, { open: 200, save: 30000 }), // a timeout: says nothing about speed
    ...Array.from({ length: 3 }, (_, i) => record(13 + i, {}, { open: 205, save: 1400 })),
  ];
  const analysis = analyzeRoutine(records, CONFIG);
  assert.equal(analysis.runs, 16);
  assert.equal(analysis.greenRuns, 15);
  assert.deepEqual(analysis.steps.map((step) => step.id), ['open', 'save'], 'the steps of the latest green run, in order');
  assert.deepEqual(analysis.steps.map((step) => step.alert), [false, true]);
  assert.equal(analysis.run?.alert, true);
  assert.deepEqual(analysis.alerts, ['(run)', 'save']);
  assert.equal(analysis.steps[1]!.baselineMs, 800);
});

test('analyzeRoutine: a new version, another profile and another environment are separate populations; the latest run picks, select overrides', () => {
  const v1 = Array.from({ length: 10 }, (_, i) => record(i));
  const v2 = Array.from({ length: 10 }, (_, i) => record(20 + i, { version: 2 }, { open: 900, save: 3000 }));
  const functional = Array.from({ length: 10 }, (_, i) => record(40 + i, { profile: 'functional' }, { open: 50, save: 300 }));
  const all = [...v1, ...v2, ...functional];

  assert.equal(populationsOf(all).length, 3);
  const latest = analyzeRoutine(all, CONFIG);
  assert.deepEqual([latest.population?.version, latest.population?.profile], [1, 'functional'], 'the most recent run decides');
  assert.equal(latest.run?.alert, false, 'a faster profile is not a regression of the slow one');

  const second = analyzeRoutine(all, CONFIG, { select: { version: 2 } });
  assert.equal(second.population?.version, 2);
  assert.equal(second.run?.samples, 10);
  assert.equal(second.run?.alert, false, 'version 2 was always slow: slow is its normal');

  assert.equal(analyzeRoutine(all, CONFIG, { select: { version: 9 } }).population, undefined);
  assert.equal(analyzeRoutine([], CONFIG).steps.length, 0);
});

test('analyzeRoutine: a step added later has fewer samples and waits for its own baseline', () => {
  const records = [...Array.from({ length: 10 }, (_, i) => record(i)), ...Array.from({ length: 3 }, (_, i) => record(10 + i, {}, { open: 200, save: 800, extra: 5000 }))];
  const extra = analyzeRoutine(records, CONFIG).steps.find((step) => step.id === 'extra')!;
  assert.equal(extra.samples, 3);
  assert.equal(extra.alert, false);
  assert.match(extra.note ?? '', /needs/);
});

// ---- what a run records ------------------------------------------------------------------------------------------------------------------

const fakeResult = (overrides: Record<string, unknown> = {}) =>
  ({
    jobId: 'job_abc',
    status: 'passed',
    startedAt: '2026-11-03T12:00:00.000Z',
    finishedAt: '2026-11-03T12:00:02.000Z',
    durationMs: 2000.4,
    targetUrl: 'https://dev.example.com/app/home?x=secret',
    caller: null,
    routine: { id: 'crud', version: 3, sha256: 'a'.repeat(64) },
    buildId: 'r101',
    steps: [
      { index: 0, id: 'open', action: 'goto', status: 'passed', startedAt: 'a', finishedAt: 'b', durationMs: 700.6 },
      { index: 1, action: 'click', status: 'failed', startedAt: 'a', finishedAt: 'b', durationMs: 1300, error: { type: 'Timeout', message: 'password=hunter2' } },
    ],
    teardown: [{ index: 0, id: 'cleanup', action: 'click', status: 'passed', startedAt: 'a', finishedAt: 'b', durationMs: 900 }],
    extracted: { secretLooking: 'hunter2' },
    ...overrides,
  }) as never;

test('perfRecordOf: ids and times only - no URL path or query, no error text, no extracted values, no teardown', () => {
  const rec = perfRecordOf(fakeResult())!;
  assert.deepEqual(
    [rec.jobId, rec.version, rec.profile, rec.env, rec.buildId, rec.status, rec.durationMs],
    ['job_abc', 3, 'full', 'https://dev.example.com', 'r101', 'passed', 2000],
  );
  assert.deepEqual(rec.steps, [
    { id: 'open', durationMs: 701, status: 'passed' },
    { id: '#1', durationMs: 1300, status: 'failed' },
  ]);
  assert.ok(!JSON.stringify(rec).includes('hunter2'));
  assert.ok(!JSON.stringify(rec).includes('secret'));
  assert.equal(perfRecordOf(fakeResult({ profile: 'functional' }))!.profile, 'functional');
  assert.equal(perfRecordOf(fakeResult({ routine: undefined })), undefined, 'a run that is not a library routine has no series');
  assert.equal(perfRecordOf(fakeResult({ steps: [] })), undefined);
});

test('recordRunMetrics: appends to the routine\'s file; a run with fixed parameters (a shrink probe) is not recorded; a failure to write never throws', async () => {
  await recordRunMetrics(fakeResult());
  await recordRunMetrics(fakeResult({ jobId: 'job_probe' }), { fixedParameters: true });
  assert.deepEqual((await readPerfRecords('crud')).map((rec) => rec.jobId), ['job_abc']);
  assert.ok(fs.existsSync(path.join(metricsDir(), 'crud.jsonl')));

  const blocked = path.join(metricsDir(), 'broken.jsonl');
  fs.mkdirSync(blocked, { recursive: true }); // a directory where the file should be
  try {
    await assert.doesNotReject(recordRunMetrics(fakeResult({ routine: { id: 'broken', version: 1, sha256: 'a'.repeat(64) } })));
  } finally {
    fs.rmSync(blocked, { recursive: true, force: true });
  }
});

// ---- the store and the service -----------------------------------------------------------------------------------------------------------

test('store: skips corrupt lines, keeps only the newest records past the cap, ignores unsafe ids', async () => {
  const file = path.join(metricsDir(), 'cap.jsonl');
  fs.mkdirSync(metricsDir(), { recursive: true });
  fs.writeFileSync(file, `not json\n{"jobId":"x"}\n${JSON.stringify(record(0))}\n`);
  assert.equal((await readPerfRecords('cap')).length, 1, 'a half-written or foreign line is skipped');

  for (let i = 1; i <= 60; i += 1) await appendPerfRecord('cap', record(i) as never);
  const kept = await readPerfRecords('cap');
  assert.ok(kept.length <= 33 && kept.length >= 30, `capped near 30, has ${kept.length}`);
  assert.equal(kept.at(-1)!.jobId, 'job_60', 'the newest survive');

  await appendPerfRecord('../escape', record(1) as never);
  assert.deepEqual(await readPerfRecords('../escape'), []);
  assert.ok(!fs.existsSync(path.join(dataDir, 'escape.jsonl')));
});

test('service: a regression shows up in the list, the alerts and the routine detail with thresholds', async () => {
  for (let i = 0; i < 12; i += 1) await appendPerfRecord('slowing', record(i, { buildId: 'r100' }) as never);
  for (let i = 12; i < 15; i += 1) await appendPerfRecord('slowing', record(i, { buildId: 'r101' }, { open: 200, save: 1500 }) as never);
  for (let i = 0; i < 12; i += 1) await appendPerfRecord('steady', record(i) as never);

  assert.equal(await getRoutinePerformance('nothing'), undefined);
  const detail = (await getRoutinePerformance('slowing'))!;
  assert.equal(detail.thresholds.alertRatio, perfConfig().alertRatio);
  assert.deepEqual(detail.alerts, ['(run)', 'save']);
  assert.equal(detail.steps.find((step) => step.id === 'save')!.suspectBuild, 'r101');
  assert.deepEqual(detail.run!.buildChanges, [12]);

  const list = await listPerformance();
  assert.deepEqual(list.map((item) => [item.routineId, item.alerts.length]), [['slowing', 2], ['steady', 0]]);
  const alerts = await listPerformanceAlerts();
  assert.deepEqual(alerts.map((alert) => [alert.routineId, alert.series, alert.baselineMs, alert.recentMs, alert.suspectBuild]), [
    ['slowing', '(run)', 1000, 1700, 'r101'],
    ['slowing', 'save', 800, 1500, 'r101'],
  ]);
});
