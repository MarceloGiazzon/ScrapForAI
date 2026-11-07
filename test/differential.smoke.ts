import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// T6.3 end to end (real Chromium, real HTTP API). Two "environments" serve the same page. The second one (the candidate) differs on purpose:
// the order total is 105 instead of 100, the audit call answers 500 and the page logs an error, and the orders call is slow. The order id in
// the URL is random on every click, so a comparison that does not mask ids would report a difference on EVERY run.

const API_KEY = 'test-api-key-1234567890';

function startSite(candidate: boolean): Promise<{ server: http.Server; origin: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url ?? '/';
      if (url.startsWith('/app')) {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(`<!doctype html><meta charset="utf-8"><title>Orders</title>
<div id="title">Orders</div><button id="load">Load</button><div id="out" hidden></div>
<script>
  document.getElementById('load').onclick = async () => {
    const id = 1000 + Math.floor(Math.random() * 9000);
    const order = await (await fetch('/api/orders/' + id)).json();
    const audit = await fetch('/api/audit');
    if (!audit.ok) console.error('audit failed');
    const out = document.getElementById('out');
    out.textContent = 'total=' + order.total;
    out.hidden = false;
  };
</script>`);
      } else if (url.startsWith('/api/orders/')) {
        const answer = () => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ total: candidate ? 105 : 100 }));
        };
        if (candidate) setTimeout(answer, 700);
        else answer();
      } else if (url.startsWith('/api/audit')) {
        res.statusCode = candidate ? 500 : 200;
        res.setHeader('content-type', 'application/json');
        res.end('{}');
      } else {
        res.statusCode = 404;
        res.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

const baseline = await startSite(false);
const candidate = await startSite(true);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-differential-smoke-'));
process.env.SCRAPFORAI_API_KEY = API_KEY;
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = `${baseline.origin},${candidate.origin}`;
process.env.ALLOWED_RESOURCE_ORIGINS = `${baseline.origin},${candidate.origin}`;
process.env.MAX_PARALLEL_JOBS = '3';

const express = (await import('express')).default;
const { apiAuth } = await import('../src/security/apiAuth.js');
const { differentialsRouter } = await import('../src/routes/differentials.routes.js');
const { routinesRouter } = await import('../src/routes/routines.routes.js');
const { saveTarget } = await import('../src/targets/targetStore.js');

let api: http.Server;
let apiUrl: string;

async function call(method: string, urlPath: string, body?: unknown) {
  const response = await fetch(`${apiUrl}${urlPath}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch {
    // markdown
  }
  return { status: response.status, text, json };
}

async function finished(id: string): Promise<Record<string, any>> {
  for (;;) {
    const state = (await call('GET', `/v1/differentials/${id}?wait=20`)).json;
    if (state.status !== 'running') return state;
  }
}

const profile = (id: string, origin: string, environment: 'dev' | 'qa', credentialSets: string[] = []) => ({
  id, name: id, platform: 'generic' as const, environment, baseUrl: `${origin}/app`, credentialSets,
  noiseFilters: [], surfaces: {}, screens: [], flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
});

before(async () => {
  await saveTarget(profile('app-v17', baseline.origin, 'dev') as never);
  await saveTarget(profile('app-v18', candidate.origin, 'qa') as never);
  await saveTarget(profile('app-ghost', candidate.origin, 'qa', ['ghost']) as never);

  const app = express();
  app.use(express.json());
  app.use(apiAuth);
  app.use('/v1/differentials', differentialsRouter);
  app.use('/v1/routines', routinesRouter);
  api = app.listen(0);
  await new Promise<void>((resolve) => api.once('listening', resolve));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  const put = async (id: string, steps: unknown[]) => {
    const saved = await call('PUT', `/v1/routines/${id}`, { title: id, targetProfile: 'app-v17', steps });
    assert.equal(saved.status, 201, saved.text);
  };
  await put('diff-title', [
    { id: 'open', action: 'goto', url: '$targetUrl' },
    { id: 'title', action: 'extractText', selector: '#title', name: 'title' },
  ]);
  await put('diff-orders', [
    { id: 'open', action: 'goto', url: '$targetUrl' },
    { id: 'load', action: 'click', selector: '#load' },
    { id: 'shown', action: 'waitForSelector', selector: '#out', state: 'visible', timeoutMs: 5000 },
    { id: 'total', action: 'extractText', selector: '#out', name: 'total' },
  ]);
  await put('diff-fixed', [
    { id: 'open', action: 'goto', url: `${baseline.origin}/app` },
    { id: 'title', action: 'extractText', selector: '#title', name: 'title' },
  ]);
});

after(async () => {
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await new Promise<void>((resolve) => baseline.server.close(() => resolve()));
  await new Promise<void>((resolve) => candidate.server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('the same routines on two environments: what is the same stays quiet, what differs is told in plain words (value, console, network shape, time)', async () => {
  const started = await call('POST', '/v1/differentials', {
    routines: [{ routineId: 'diff-title' }, { routineId: 'diff-orders' }],
    left: { targetProfile: 'app-v17', label: 'v17' },
    right: { targetProfile: 'app-v18', label: 'v18' },
  });
  assert.equal(started.status, 202, started.text);
  assert.equal(started.json.warnings, undefined);
  const state = await finished(started.json.differentialId);

  assert.equal(state.status, 'completed');
  assert.equal(state.verdict, 'different', JSON.stringify(state.pairs));
  assert.equal(state.exitCode, 1);
  assert.deepEqual(state.counts, { total: 2, same: 1, different: 1, infraError: 0, notRun: 0 });
  assert.deepEqual(state.pairs.map((pair: any) => [pair.routineId, pair.outcome]), [['diff-title', 'same'], ['diff-orders', 'different']]);

  const orders = state.pairs[1];
  const lines: string[] = orders.lines;
  assert.ok(lines.some((line) => /extracted .*total/.test(line) && /100/.test(line) && /105/.test(line)), lines.join('\n'));
  assert.ok(lines.some((line) => /console, new on v18: audit failed/.test(line)), lines.join('\n'));
  assert.ok(lines.some((line) => /network GET \/api\/audit: v17 200, v18 500/.test(line)), lines.join('\n'));
  assert.ok(!lines.some((line) => /\/api\/orders/.test(line)), `the random order id must be masked:\n${lines.join('\n')}`);
  assert.ok(!lines.some((line) => /127\.0\.0\.1/.test(line)), 'the origin never counts');
  assert.equal(orders.comparison.counts.steps, 0);

  // Time is information: the slow call is listed apart and did not decide the verdict by itself.
  assert.ok((orders.timeLines as string[]).some((line) => /shown: slower on v18/.test(line)), JSON.stringify(orders.timeLines));
  assert.ok(orders.left.jobId && orders.right.jobId && orders.left.jobId !== orders.right.jobId);

  const markdown = await call('GET', `/v1/differentials/${started.json.differentialId}?format=md`);
  assert.equal(markdown.status, 200);
  assert.match(markdown.text, /## diff-orders@v1: different/);
  assert.doesNotMatch(markdown.text, /## diff-title/);

  assert.ok(fs.existsSync(path.join(dataDir, 'differentials', `${started.json.differentialId}.json`)));

  // The same two runs can be compared again later, from their evidence.
  const again = await call('POST', '/v1/differentials/compare', { leftJobId: orders.left.jobId, rightJobId: orders.right.jobId });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.verdict, 'different');
  // a past run has no label of its own: the sides are named by their target profile
  assert.deepEqual(again.json.lines, lines.map((line) => line.replace(/\bv17\b/g, 'app-v17').replace(/\bv18\b/g, 'app-v18')));
  const title = state.pairs[0];
  const sameAgain = await call('POST', '/v1/differentials/compare', { leftJobId: title.left.jobId, rightJobId: title.right.jobId });
  assert.equal(sameAgain.json.verdict, 'same');
});

test('a tolerance makes a small numeric difference disappear; dimensions limit what is compared', async () => {
  const started = await call('POST', '/v1/differentials', {
    routines: [{ routineId: 'diff-orders' }],
    left: { targetProfile: 'app-v17' },
    right: { targetProfile: 'app-v18' },
    tolerance: { dimensions: ['steps', 'extracted'], diff: { maskPatterns: [{ pattern: 'total=\\d+', replacement: 'total' }] } },
  });
  const state = await finished(started.json.differentialId);
  assert.equal(state.verdict, 'same', JSON.stringify(state.pairs[0].lines));
  assert.equal(state.exitCode, 0);
});

test('a routine that opens a fixed address is flagged: both sides would open the same application (and the result is "same")', async () => {
  const started = await call('POST', '/v1/differentials', {
    routines: [{ routineId: 'diff-fixed' }],
    left: { targetProfile: 'app-v17' },
    right: { targetProfile: 'app-v18' },
  });
  assert.equal(started.status, 202, started.text);
  assert.match(started.json.warnings[0], /diff-fixed.*fixed address.*\$targetUrl/);
  const state = await finished(started.json.differentialId);
  // The same application on both sides must read "same"; if it ever does not (seen once in a loaded full run, never alone), say WHAT differed.
  assert.equal(state.verdict, 'same', JSON.stringify({ lines: state.pairs[0]?.lines, notes: state.pairs[0]?.notes, status: state.pairs[0]?.status }));
  assert.match((await call('GET', `/v1/differentials/${started.json.differentialId}?format=md`)).text, /Warning:/);
});

test('a side that cannot run is infra-error (exit 2), never a difference; a difference elsewhere still wins', async () => {
  const started = await call('POST', '/v1/differentials', {
    routines: [{ routineId: 'diff-title' }],
    left: { targetProfile: 'app-v17' },
    right: { targetProfile: 'app-ghost', credentialSet: 'ghost' },
  });
  assert.equal(started.status, 202, started.text);
  const state = await finished(started.json.differentialId);
  assert.equal(state.verdict, 'infra-error');
  assert.equal(state.exitCode, 2);
  assert.equal(state.pairs[0].outcome, 'infra-error');
  assert.match(state.pairs[0].error, /right: .*CredentialSetNotFound/);
  assert.ok(state.pairs[0].left.jobId, 'the side that could run is kept');
  assert.equal(state.pairs[0].comparison, undefined);
});

test('mistakes are refused before any browser starts', async () => {
  const ok = { left: { targetProfile: 'app-v17' }, right: { targetProfile: 'app-v18' } };
  assert.equal((await call('POST', '/v1/differentials', { ...ok, routines: [{ routineId: 'nope' }] })).status, 404);
  assert.equal((await call('POST', '/v1/differentials', { routines: [{ routineId: 'diff-title' }], left: { targetProfile: 'app-v17' }, right: { targetProfile: 'nope' } })).status, 404);
  assert.equal((await call('POST', '/v1/differentials', { ...ok, routines: [{ routineId: 'diff-title' }], right: { targetProfile: 'app-v18', credentialSet: 'other' } })).status, 400);
  assert.equal((await call('POST', '/v1/differentials', { ...ok, routines: [{ routineId: 'diff-title' }, { routineId: 'diff-title' }] })).status, 400);
  assert.equal((await call('POST', '/v1/differentials', { ...ok, routines: [{ routineId: 'diff-title' }], extra: true })).status, 400);
  assert.equal((await call('GET', '/v1/differentials/diff_doesnotexist')).status, 404);
  assert.equal((await call('GET', '/v1/differentials/..%2Fx')).status, 404);
  assert.equal((await call('POST', '/v1/differentials/compare', { leftJobId: 'job_x', rightJobId: 'job_x' })).status, 400);
  assert.equal((await call('POST', '/v1/differentials/compare', { leftJobId: 'job_none1', rightJobId: 'job_none2' })).status, 404);
});
