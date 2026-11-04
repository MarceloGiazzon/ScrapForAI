import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// T3.5: the flakiness score (pure), what to propose, the automatic new attempt, what a retry records, and the service on disk. No browser.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-flaky-test-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';

const { analyzeFlakiness, suggestionFor } = await import('../src/metrics/flakyAnalysis.js');
const { attemptMetadata, runAttempts } = await import('../src/orchestrator/retry.js');
const { perfRecordOf } = await import('../src/metrics/perfRecorder.js');
const { appendPerfRecord } = await import('../src/metrics/perfStore.js');
const { getRoutineFlakiness, listFlakiness } = await import('../src/metrics/flakyService.js');
const { saveTarget } = await import('../src/targets/targetStore.js');
const { saveRoutine } = await import('../src/library/routineService.js');

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const CONFIG = { window: 20, minRuns: 10, threshold: 0.2 };
type Rec = Parameters<typeof analyzeFlakiness>[0][number];

/** 'P' passed, 'F' failed; every run on the same version, profile, origin and (unless `build` says otherwise) build. */
function runs(pattern: string, options: { build?: (index: number) => string | undefined; version?: number; extra?: (index: number) => Partial<Rec> } = {}): Rec[] {
  return [...pattern].map((letter, index) => {
    const build = options.build ? options.build(index) : 'r100';
    return {
      jobId: `job_${options.version ?? 1}_${String(index).padStart(3, '0')}`,
      at: `2026-11-03T10:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
      version: options.version ?? 1,
      profile: 'full' as const,
      env: 'https://dev.example.com',
      ...(build ? { buildId: build } : {}),
      status: letter === 'P' ? ('passed' as const) : ('failed' as const),
      durationMs: 1000,
      steps: [],
      ...(options.extra?.(index) ?? {}),
    };
  });
}

// ---- the score -----------------------------------------------------------------------------------------------------------------------

test('a steady routine scores 0, an alternating one scores 1 and is flaky', () => {
  const steady = analyzeFlakiness(runs('P'.repeat(20)), CONFIG);
  assert.deepEqual([steady.score, steady.transitions, steady.comparablePairs, steady.flaky], [0, 0, 19, false]);

  const alternating = analyzeFlakiness(runs('PF'.repeat(10)), CONFIG);
  assert.deepEqual([alternating.score, alternating.transitions, alternating.flaky], [1, 19, true]);
});

test('two isolated failures in 20 runs cross the default threshold; one does not', () => {
  const one = analyzeFlakiness(runs('PPPPPPPPPFPPPPPPPPPP'), CONFIG);
  assert.equal(one.transitions, 2);
  assert.equal(one.flaky, false, '2/19 = 0.105');

  const two = analyzeFlakiness(runs('PPPFPPPPPPPPFPPPPPPP'), CONFIG);
  assert.equal(two.transitions, 4);
  assert.equal(two.score, 0.211);
  assert.equal(two.flaky, true);
});

test('a real regression (pass...pass fail...fail) is one change, not flakiness', () => {
  const regression = analyzeFlakiness(runs('P'.repeat(10) + 'F'.repeat(10)), CONFIG);
  assert.equal(regression.transitions, 1);
  assert.equal(regression.flaky, false);
});

test('a pass/fail change across a NEW BUILD is not counted: it is a regression or a fix, not instability', () => {
  const across = analyzeFlakiness(runs('P'.repeat(10) + 'F'.repeat(10), { build: (i) => (i < 10 ? 'r100' : 'r101') }), CONFIG);
  assert.deepEqual([across.transitions, across.skippedAtBuildChange, across.comparablePairs], [0, 1, 18]);

  // The same alternation on ONE build is flaky; with the build changing every run nothing is comparable at all.
  assert.equal(analyzeFlakiness(runs('PF'.repeat(10), { build: () => 'r100' }), CONFIG).flaky, true);
  const everyRun = analyzeFlakiness(runs('PF'.repeat(10), { build: (i) => `r${i}` }), CONFIG);
  assert.deepEqual([everyRun.comparablePairs, everyRun.score, everyRun.flaky], [0, undefined, false]);
});

test('a run whose build is unknown is compared with its neighbours (nothing says it differs)', () => {
  const unknown = analyzeFlakiness(runs('PF'.repeat(10), { build: (i) => (i % 2 === 0 ? undefined : 'unknown') }), CONFIG);
  assert.equal(unknown.flaky, true);
  const mixed = analyzeFlakiness(runs('PF'.repeat(10), { build: (i) => (i % 2 === 0 ? 'r100' : undefined) }), CONFIG);
  assert.equal(mixed.transitions, 19);
});

test('nothing is suggested before there are enough runs, but the score is shown and says why', () => {
  const few = analyzeFlakiness(runs('PFPFPF'), CONFIG);
  assert.equal(few.score, 1);
  assert.equal(few.flaky, false);
  assert.match(few.note ?? '', /6 of the 10 runs/);
});

test('only the last 20 runs count', () => {
  const analysis = analyzeFlakiness(runs('PF'.repeat(10) + 'P'.repeat(25)), CONFIG);
  assert.equal(analysis.runs, 20);
  assert.equal(analysis.transitions, 0, 'the old instability fell out of the window');
});

test('a new routine version is a new test: the old version\'s instability does not follow it', () => {
  const records = [...runs('PF'.repeat(10), { version: 1 }), ...runs('P'.repeat(12), { version: 2 }).map((r, i) => ({ ...r, at: `2026-11-03T12:00:${String(i).padStart(2, '0')}.000Z` }))];
  const latest = analyzeFlakiness(records, CONFIG);
  assert.equal(latest.population?.version, 2);
  assert.equal(latest.flaky, false);
  assert.equal(analyzeFlakiness(records, CONFIG, { version: 1 }).flaky, true, 'the old version can still be asked for');
  assert.equal(latest.populations.length, 2);
});

test('runs that drew generated values are left out: an edge value failing on purpose is not instability', () => {
  const records = runs('PF'.repeat(10), { extra: () => ({ parametric: true as const }) });
  const analysis = analyzeFlakiness(records, CONFIG);
  assert.equal(analysis.runs, 0);
  assert.equal(analysis.flaky, false);
});

test('a failure followed by a pass on the automatic new attempt is one change and is counted as recovered on retry', () => {
  const base = runs('PPPPPPPPPP' + 'F' + 'P' + 'PPPPPPPP');
  base[11] = { ...base[11]!, attempt: 2, retryOf: base[10]!.jobId };
  const analysis = analyzeFlakiness(base, CONFIG);
  assert.equal(analysis.recoveredOnRetry, 1);
  assert.equal(analysis.transitions, 2, 'P->F and F->P');
  assert.equal(analysis.failed, 1, 'the retry does not erase the failure from the window');
});

// ---- what to propose -----------------------------------------------------------------------------------------------------------------

test('suggestions: quarantine a flaky routine, release a quarantined one that has been clean, never touch the rest', () => {
  const flaky = analyzeFlakiness(runs('PF'.repeat(10)), CONFIG);
  assert.equal(suggestionFor('active', flaky, CONFIG)?.action, 'quarantine');
  assert.equal(suggestionFor('quarantined', flaky, CONFIG), undefined, 'already quarantined and still unstable: nothing to propose');
  assert.equal(suggestionFor('retired', flaky, CONFIG), undefined);
  assert.equal(suggestionFor('draft', flaky, CONFIG), undefined);

  const recovered = analyzeFlakiness(runs('PF'.repeat(5) + 'P'.repeat(10)), CONFIG);
  assert.equal(suggestionFor('quarantined', recovered, CONFIG)?.action, 'release', 'its last 10 runs all passed');
  assert.equal(suggestionFor('active', recovered, CONFIG)?.action, 'quarantine', 'the 20-run window still holds the earlier instability; "release" looks only at the last 10');

  const notYet = analyzeFlakiness(runs('PF'.repeat(5) + 'P'.repeat(9)), CONFIG);
  assert.equal(suggestionFor('quarantined', notYet, CONFIG), undefined, '9 clean runs are not enough');

  const broken = analyzeFlakiness(runs('F'.repeat(20)), CONFIG);
  assert.equal(suggestionFor('quarantined', broken, CONFIG), undefined, 'always failing is broken, not flaky');
  assert.equal(suggestionFor('active', broken, CONFIG), undefined);
});

// ---- the automatic new attempt -------------------------------------------------------------------------------------------------------

const outcome = (statuses: string[]) => {
  const calls: Array<{ attempt: number; previous?: string }> = [];
  return {
    calls,
    run: async (attempt: number, previous?: { jobId: string }) => {
      calls.push({ attempt, ...(previous ? { previous: previous.jobId } : {}) });
      return { jobId: `j${attempt}`, status: statuses[attempt - 1] ?? 'failed' };
    },
  };
};

test('runAttempts: a pass is never repeated; a failure is tried once more and both results are kept', async () => {
  const passed = outcome(['passed']);
  assert.equal((await runAttempts(passed.run, { retries: 1 })).results.length, 1);
  assert.equal(passed.calls.length, 1);

  const recovered = outcome(['failed', 'passed']);
  const done = await runAttempts(recovered.run, { retries: 1 });
  assert.deepEqual(done.results.map((r) => [r.jobId, r.status]), [['j1', 'failed'], ['j2', 'passed']]);
  assert.deepEqual(recovered.calls, [{ attempt: 1 }, { attempt: 2, previous: 'j1' }]);

  const stays = outcome(['failed', 'failed', 'passed']);
  assert.equal((await runAttempts(stays.run, { retries: 1 })).results.length, 2, 'at most `retries` new attempts');
  assert.equal((await runAttempts(outcome(['failed']).run, { retries: 0 })).results.length, 1, 'retries 0 = never');
});

test('runAttempts: a run that could not execute is not retried; a new attempt that cannot run keeps the first result', async () => {
  const boom = async () => {
    throw new Error('credential refused');
  };
  await assert.rejects(runAttempts(boom, { retries: 1 }), /credential refused/);

  let calls = 0;
  const second = await runAttempts(
    async () => {
      calls += 1;
      if (calls === 2) throw new Error('cancelled');
      return { jobId: 'j1', status: 'failed' };
    },
    { retries: 1 },
  );
  assert.deepEqual(second.results.map((r) => r.jobId), ['j1']);
  assert.match(String((second.retryError as Error).message), /cancelled/);

  const blocked = await runAttempts(outcome(['failed', 'passed']).run, { retries: 1, canRetry: () => false });
  assert.equal(blocked.results.length, 1, 'a cancelled suite does not start a new attempt');
});

test('attemptMetadata: the second attempt names the first; the first says nothing', () => {
  assert.deepEqual(attemptMetadata(1, undefined), {});
  assert.deepEqual(attemptMetadata(2, { jobId: 'job_first' }), { attempt: '2', retryOf: 'job_first' });
});

// ---- what a run records --------------------------------------------------------------------------------------------------------------

const fakeResult = (overrides: Record<string, unknown> = {}) =>
  ({
    jobId: 'job_abc',
    status: 'failed',
    startedAt: '2026-11-03T12:00:00.000Z',
    durationMs: 2000,
    targetUrl: 'https://dev.example.com/app',
    caller: null,
    routine: { id: 'crud', version: 3, sha256: 'a'.repeat(64) },
    steps: [{ index: 0, id: 'open', action: 'goto', status: 'passed', durationMs: 700 }],
    ...overrides,
  }) as never;

test('perfRecordOf: the retry carries attempt and retryOf from the caller metadata; a first attempt carries neither', () => {
  const first = perfRecordOf(fakeResult({ caller: { source: 'schedule', metadata: { occurrence: 'x' } } }))!;
  assert.equal(first.attempt, undefined);
  assert.equal(first.retryOf, undefined);

  const retry = perfRecordOf(fakeResult({ jobId: 'job_def', caller: { source: 'schedule', metadata: { attempt: '2', retryOf: 'job_abc' } } }))!;
  assert.deepEqual([retry.attempt, retry.retryOf], [2, 'job_abc']);

  assert.equal(perfRecordOf(fakeResult({ caller: { metadata: { attempt: '2' } } }))!.attempt, undefined, 'an attempt without the run it repeats is ignored');
});

test('perfRecordOf: a run that drew generated values is marked parametric', () => {
  assert.equal(perfRecordOf(fakeResult())!.parametric, undefined);
  assert.equal(perfRecordOf(fakeResult({ parameters: { seed: 's', sample: 0, values: {}, sources: {} } }))!.parametric, true);
});

// ---- the service on disk -------------------------------------------------------------------------------------------------------------

test('the service reads the series with the routine\'s CURRENT status and proposes accordingly', async () => {
  await saveTarget({
    id: 'app-dev', name: 'App', platform: 'generic', environment: 'dev', baseUrl: 'https://dev.example.com', credentialSets: [],
    noiseFilters: [], surfaces: {}, screens: [], flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  });
  const steps = [{ id: 'open', action: 'goto', url: '$targetUrl' }] as never;
  await saveRoutine('wobbly', { title: 'wobbly', targetProfile: 'app-dev', steps });
  await saveRoutine('solid', { title: 'solid', targetProfile: 'app-dev', steps });
  await saveRoutine('healed', { title: 'healed', targetProfile: 'app-dev', steps, status: 'quarantined' });

  for (const record of runs('PF'.repeat(10))) await appendPerfRecord('wobbly', record);
  for (const record of runs('P'.repeat(20))) await appendPerfRecord('solid', record);
  for (const record of runs('PF'.repeat(5) + 'P'.repeat(10))) await appendPerfRecord('healed', record);

  const wobbly = (await getRoutineFlakiness('wobbly'))!;
  assert.deepEqual([wobbly.status, wobbly.flaky, wobbly.suggestion?.action], ['active', true, 'quarantine']);
  assert.match(wobbly.suggestion!.reason, /19 state change/);

  assert.equal((await getRoutineFlakiness('solid'))!.suggestion, undefined);
  assert.equal((await getRoutineFlakiness('healed'))!.suggestion?.action, 'release');
  assert.equal(await getRoutineFlakiness('never-ran'), undefined);

  const list = await listFlakiness();
  assert.deepEqual(list.map((item) => item.routineId), ['wobbly', 'healed', 'solid'], 'the ones with something to say first, then by score');
  assert.ok(list.every((item) => !('results' in item) && !('populations' in item)), 'the list is a summary');
});
