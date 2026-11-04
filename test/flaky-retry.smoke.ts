import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// T3.5 end to end (real Chromium). The fixture "application" fails its first N page loads and then works, and COUNTS the loads server-side:
// that count is the evidence of how many times a run was really attempted. Proves: a failed scheduled/suite run is tried once more and both
// attempts stay recorded; a pass on the new attempt counts as passed but says so; two failures stay red; no retry unless asked; a quarantined
// routine runs but does not move the verdict or stop failFast; the series and the flakiness endpoint see the retry.

let failuresLeft = 0;
let hits = 0;
const site = await new Promise<{ server: http.Server; origin: string }>((resolve) => {
  const server = http.createServer((req, res) => {
    if (!req.url?.startsWith('/app')) {
      res.statusCode = 404; // favicon and the like are not page loads
      res.end();
      return;
    }
    hits += 1;
    const broken = failuresLeft > 0;
    if (broken) failuresLeft -= 1;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>App</title>${broken ? '<p>maintenance</p>' : '<h1 id="ready">ready</h1>'}`);
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-flaky-smoke-'));
const API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_API_KEY = API_KEY;
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = site.origin;
process.env.ALLOWED_RESOURCE_ORIGINS = site.origin;
process.env.MAX_PARALLEL_JOBS = '2';

const express = (await import('express')).default;
const { apiAuth } = await import('../src/security/apiAuth.js');
const { suitesRouter } = await import('../src/routes/suites.routes.js');
const { routinesRouter } = await import('../src/routes/routines.routes.js');
const { metricsRouter } = await import('../src/routes/metrics.routes.js');
const { saveTarget } = await import('../src/targets/targetStore.js');
const { readPerfRecords } = await import('../src/metrics/perfStore.js');
const { createDispatcher } = await import('../src/scheduler/dispatcher.js');
const { scheduleSchema } = await import('../src/schemas/schedule.schema.js');

let api: http.Server;
let apiUrl: string;

async function call(method: string, urlPath: string, body?: unknown) {
  const response = await fetch(`${apiUrl}${urlPath}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, json: JSON.parse(text) as Record<string, any> };
}

async function finished(suiteRunId: string): Promise<Record<string, any>> {
  for (;;) {
    const state = (await call('GET', `/v1/suites/${suiteRunId}?wait=20`)).json;
    if (state.status !== 'running') return state;
  }
}

const runSuite = async (body: Record<string, unknown>) => finished((await call('POST', '/v1/suites', body)).json.suiteRunId);
const arrange = (failures: number) => {
  failuresLeft = failures;
  hits = 0;
};

before(async () => {
  await saveTarget({
    id: 'fixture', name: 'Fixture', platform: 'generic', environment: 'dev', baseUrl: `${site.origin}/app`,
    credentialSets: [], noiseFilters: [], surfaces: {}, screens: [],
    flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  });

  const app = express();
  app.use(express.json());
  app.use(apiAuth);
  app.use('/v1/suites', suitesRouter);
  app.use('/v1/routines', routinesRouter);
  app.use('/v1/metrics', metricsRouter);
  api = app.listen(0);
  await new Promise<void>((resolve) => api.once('listening', resolve));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  const needsReady = [{ id: 'open', action: 'goto', url: '$targetUrl' }, { id: 'ready', action: 'assertVisible', selector: '#ready', timeoutMs: 300 }];
  const alwaysBad = [{ id: 'open', action: 'goto', url: '$targetUrl' }, { id: 'nope', action: 'assertVisible', selector: '#nope', timeoutMs: 300 }];
  for (const [id, steps, status] of [
    ['needs-ready', needsReady, 'active'],
    ['always-bad', alwaysBad, 'active'],
    ['bad-but-quarantined', alwaysBad, 'quarantined'],
    ['ok', [{ id: 'open', action: 'goto', url: '$targetUrl' }], 'active'],
  ] as const) {
    assert.equal((await call('PUT', `/v1/routines/${id}`, { title: id, targetProfile: 'fixture', status, steps })).status, 201, id);
  }
});

after(async () => {
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await new Promise<void>((resolve) => site.server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('a suite with retries: 1 tries a failed run once more; the pass counts, and the failed attempt stays', async () => {
  arrange(1);
  const state = await runSuite({ name: 'retry', items: [{ routineId: 'needs-ready' }], retries: 1 });
  const variant = state.variants[0];

  assert.equal(variant.status, 'passed');
  assert.equal(variant.passedOnRetry, true);
  assert.equal(hits, 2, 'the page was loaded once per attempt');
  assert.deepEqual(variant.attempts.map((a: any) => a.status), ['failed', 'passed']);
  assert.equal(variant.attempts[0].errorType !== undefined, true, 'the failed attempt keeps its error');
  assert.notEqual(variant.attempts[0].jobId, variant.attempts[1].jobId, 'two runs, two evidence folders');
  assert.equal(variant.jobId, variant.attempts[1].jobId, 'the variant is the attempt that decided');
  assert.deepEqual([state.verdict, state.exitCode, state.passedOnRetry], ['green', 0, 1]);
  assert.match(state.verdictReason, /1 passed only on a new attempt/);

  // The series holds BOTH runs; the second names the first.
  const records = await readPerfRecords('needs-ready');
  assert.equal(records.length, 2);
  assert.deepEqual([records[0]!.status, records[1]!.status], ['failed', 'passed']);
  assert.deepEqual([records[1]!.attempt, records[1]!.retryOf], [2, records[0]!.jobId]);

  const flaky = await call('GET', '/v1/metrics/flaky/needs-ready');
  assert.equal(flaky.status, 200, flaky.text);
  assert.deepEqual([flaky.json.runs, flaky.json.transitions, flaky.json.recoveredOnRetry], [2, 1, 1]);
  assert.equal(flaky.json.suggestion, undefined, 'two runs are not enough to suggest anything');
  assert.match(flaky.json.note, /2 of the 10 runs/);
  assert.equal((await call('GET', '/v1/metrics/flaky')).json.count >= 1, true);
});

test('a run that fails again stays red after exactly one new attempt', async () => {
  arrange(0);
  const state = await runSuite({ name: 'still red', items: [{ routineId: 'always-bad' }], retries: 1 });
  const variant = state.variants[0];

  assert.equal(variant.status, 'failed');
  assert.equal(variant.attempts.length, 2, 'one new attempt, not more');
  assert.equal(variant.passedOnRetry, undefined);
  assert.deepEqual([state.verdict, state.exitCode], ['red', 1]);
  assert.equal(hits, 2);
});

test('without retries a suite fails as it always did: one attempt, no attempts list', async () => {
  arrange(1);
  const state = await runSuite({ name: 'no retry', items: [{ routineId: 'needs-ready' }] });
  assert.equal(state.variants[0].status, 'failed');
  assert.equal(state.variants[0].attempts, undefined);
  assert.equal(state.verdict, 'red');
  assert.equal(hits, 1);
});

test('a quarantined routine runs, is reported apart, and neither turns the suite red nor stops failFast', async () => {
  arrange(0);
  const state = await runSuite({ name: 'with quarantine', items: [{ routineId: 'bad-but-quarantined' }, { routineId: 'ok' }], failFast: true, retries: 1 });
  const [quarantined, ok] = state.variants;

  assert.equal(quarantined.quarantined, true);
  assert.equal(quarantined.status, 'failed', 'it ran, and its failure is shown');
  assert.equal(quarantined.attempts, undefined, 'a quarantined routine is not retried: it does not count');
  assert.equal(ok.status, 'passed', 'failFast was not triggered by a quarantined failure');
  assert.deepEqual([state.verdict, state.exitCode], ['green', 0]);
  assert.deepEqual(state.quarantine, { total: 1, passed: 0, failed: 1, error: 0, notRun: 0 });
  assert.match(state.verdictReason, /quarantined run\(s\) did not pass \(not counted\)/);

  // The HTML report keeps it out of the counted table.
  const report = await fetch(`${apiUrl}/v1/suites/${state.suiteRunId}/report`, { headers: { authorization: `Bearer ${API_KEY}` } });
  assert.equal(report.status, 200);
  const html = await report.text();
  assert.ok(html.includes('Quarantined routines'), 'the quarantine block is in the report');
  assert.ok(html.indexOf('bad-but-quarantined') > html.indexOf('Quarantined routines'), 'and the quarantined run is listed under it');
});

test('the scheduler\'s dispatcher retries a failed routine run by default and records both attempts', async () => {
  const dispatcher = createDispatcher();
  const schedule = scheduleSchema.parse({ id: 'nightly', cron: '0 3 * * *', target: { kind: 'routine', routineId: 'needs-ready' } });
  assert.equal(schedule.retries, 1, 'one new attempt is the default of a schedule');

  arrange(1);
  const recovered = await dispatcher.start(schedule, '2026-11-04T03:00:00.000Z');
  assert.ok(recovered.started);
  const settled = await recovered.done;
  assert.equal(settled.outcome, 'passed');
  assert.equal(settled.passedOnRetry, true);
  assert.deepEqual(settled.attempts?.map((a) => a.status), ['failed', 'passed']);
  assert.match(settled.message ?? '', /passed on a new attempt/);

  arrange(5);
  const stillBad = await (await dispatcher.start(schedule, '2026-11-05T03:00:00.000Z') as { done: Promise<any> }).done;
  assert.equal(stillBad.outcome, 'failed');
  assert.equal(stillBad.attempts.length, 2);
  assert.equal(stillBad.passedOnRetry, undefined);
  assert.equal(hits, 2);

  arrange(5);
  const never = scheduleSchema.parse({ id: 'strict', cron: '0 3 * * *', retries: 0, target: { kind: 'routine', routineId: 'needs-ready' } });
  const single = await (await dispatcher.start(never, '2026-11-06T03:00:00.000Z') as { done: Promise<any> }).done;
  assert.equal(single.outcome, 'failed');
  assert.equal(single.attempts, undefined);
  assert.equal(hits, 1, 'retries: 0 means never');
});

test('the scheduler passes its retries on to the suites it starts', async () => {
  const dispatcher = createDispatcher();
  const schedule = scheduleSchema.parse({ id: 'suite-nightly', cron: '0 3 * * *', target: { kind: 'suite', suite: { name: 'nightly', items: [{ routineId: 'needs-ready' }] } } });

  arrange(1);
  const started = await dispatcher.start(schedule, '2026-11-04T03:00:00.000Z');
  assert.ok(started.started);
  const settled = await started.done;
  assert.equal(settled.outcome, 'passed');

  const state = await finished(started.run.id);
  assert.equal(state.request.retries, 1);
  assert.equal(state.variants[0].passedOnRetry, true);
});
