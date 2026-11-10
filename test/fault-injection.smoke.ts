import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// T7.2 end to end (real Chromium): a page that copes with a failing API (generic message) and one that does not (prints the raw error).
// Faults are injected by steps; the server counts what REALLY reached it, so "the request never arrived" is measured, not assumed.

const hits: string[] = [];
const other = await new Promise<{ server: http.Server; origin: string }>((resolve) => {
  const server = http.createServer((req, res) => {
    hits.push(`other${req.url}`);
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
});

const page = (otherOrigin: string) => `<!doctype html><title>Faults</title>
<button id="save">Save</button> <button id="raw">Save (raw errors)</button> <button id="load">Load</button>
<button id="slow">Search</button> <button id="cross">Cross</button>
<div id="msg">idle</div><div id="list">-</div><div id="out">-</div><div id="x">-</div>
<script>
document.getElementById('save').onclick = function () {
  fetch('/api/save', { method: 'POST' })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function () { document.getElementById('msg').textContent = 'Saved'; })
    .catch(function () { document.getElementById('msg').textContent = 'Could not save, please try again'; });
};
document.getElementById('raw').onclick = function () {
  fetch('/api/save', { method: 'POST' })
    .then(function (r) { return r.text().then(function (t) { document.getElementById('msg').textContent = r.ok ? 'Saved' : t; }); });
};
document.getElementById('load').onclick = function () {
  fetch('/api/list')
    .then(function (r) { return r.json(); })
    .then(function (d) { document.getElementById('list').textContent = d.items.length + ' items'; })
    .catch(function () { document.getElementById('list').textContent = 'Invalid data received'; });
};
document.getElementById('slow').onclick = function () {
  document.getElementById('out').textContent = 'waiting';
  fetch('/api/search').then(function () { document.getElementById('out').textContent = 'done'; var d = document.createElement('i'); d.id = 'done'; document.body.appendChild(d); });
};
document.getElementById('cross').onclick = function () {
  fetch(${JSON.stringify(otherOrigin)} + '/api/x')
    .then(function (r) { document.getElementById('x').textContent = 'HTTP ' + r.status; })
    .catch(function () { document.getElementById('x').textContent = 'network error'; });
};
</script>`;

const site = await new Promise<{ server: http.Server; origin: string }>((resolve) => {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url.startsWith('/api/')) {
      hits.push(`${req.method} ${url}`);
      res.setHeader('content-type', 'application/json');
      return res.end(url.startsWith('/api/list') ? '{"items":[1,2,3]}' : '{"ok":true}');
    }
    res.setHeader('content-type', 'text/html');
    res.end(page(other.origin));
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-faults-smoke-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = site.origin;
process.env.ALLOWED_RESOURCE_ORIGINS = `${site.origin},${other.origin}`;

const { resolveExplorationRequest } = await import('../src/runner/resolveRequest.js');
const { runExploration } = await import('../src/runner/runExploration.js');
const { explorationRequestSchema } = await import('../src/schemas/explorationRequest.schema.js');

after(async () => {
  await new Promise<void>((resolve) => site.server.close(() => resolve()));
  await new Promise<void>((resolve) => other.server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function run(steps: unknown[], teardown?: unknown[]) {
  hits.length = 0;
  const request = explorationRequestSchema.parse({ targetUrl: `${site.origin}/`, steps: [{ id: 'open', action: 'goto', url: `${site.origin}/` }, ...steps], ...(teardown ? { teardown } : {}) });
  return runExploration(await resolveExplorationRequest(request, { initiator: 'system' }));
}

const settle = { action: 'waitForTimeout', timeoutMs: 400 };
// The page answers after a fetch, so every check waits for its text to appear (up to 5 s) instead of sleeping a fixed time: a fixed sleep races the fetch under load.
const becomes = (selector: string, text: string) => ({
  action: 'assertTextContains',
  selector,
  text,
  waitFor: { selector: `${selector}:has-text(${JSON.stringify(text)})`, state: 'visible', timeoutMs: 5000 },
});
const msgIs = (text: string) => becomes('#msg', text);

test('HTTP 500 once: the page shows its generic message, the request never reached the server, the next click works', async () => {
  const result = await run([
    { action: 'injectFault', match: { urlContains: '/api/save', method: 'POST' }, fault: { status: 500, body: '{"error":"boom"}' }, times: 1 },
    { action: 'click', selector: '#save' },
    settle,
    msgIs('Could not save'),
    { action: 'assertNoTextMatches', selector: '#msg' },
    { action: 'click', selector: '#save' },
    settle,
    msgIs('Saved'),
  ]);
  assert.equal(result.status, 'passed', JSON.stringify(result.error));
  assert.deepEqual(hits, ['POST /api/save'], 'only the second click reached the server');
  assert.deepEqual(
    (result.evidence.routing ?? []).map((e) => [e.pathname, e.method, e.handledBy, e.action, e.detail]),
    [['/api/save', 'POST', 'fault', 'fulfill', 'status 500']],
  );
  assert.deepEqual(result.evidence.networkFailures, [], 'a 500 we wrote ourselves is not the application failing');
});

test('delay: the REAL request arrives late, the page shows its waiting state, and the delay is on the evidence', async () => {
  const result = await run([
    { action: 'injectFault', match: { urlContains: '/api/search' }, fault: { delayMs: 1500 } },
    { action: 'click', selector: '#slow' },
    msgIs('idle'),
    { id: 'wait-done', action: 'waitForSelector', selector: '#done', state: 'attached', timeoutMs: 8000 },
    { action: 'assertTextContains', selector: '#out', text: 'done' },
  ]);
  assert.equal(result.status, 'passed', JSON.stringify(result.error));
  assert.ok(hits.includes('GET /api/search'), 'a delayed request still goes to the server');
  const waited = result.steps.find((s) => s.id === 'wait-done')!;
  assert.ok(waited.durationMs >= 1000, `the page really waited (${waited.durationMs} ms)`);
  assert.deepEqual((result.evidence.routing ?? []).map((e) => [e.action, e.detail]), [['delay', 'delay 1500 ms']]);
});

test('malformed JSON: the page copes, and the server is not called (nothing changes there)', async () => {
  const result = await run([
    { action: 'injectFault', match: { urlContains: '/api/list' }, fault: { malformedJson: true } },
    { action: 'click', selector: '#load' },
    settle,
    becomes('#list', 'Invalid data received'),
  ]);
  assert.equal(result.status, 'passed', JSON.stringify(result.error));
  assert.deepEqual(hits, []);
  assert.deepEqual((result.evidence.routing ?? []).map((e) => e.detail), ['malformed JSON']);
});

test('abort failed and timedout: the page shows its error message; the aborts are not network failures of the application', async () => {
  for (const abort of ['failed', 'timedout'] as const) {
    const result = await run([
      { action: 'injectFault', match: { urlContains: '/api/save' }, fault: { abort } },
      { action: 'click', selector: '#save' },
      settle,
      msgIs('Could not save'),
    ]);
    assert.equal(result.status, 'passed', `${abort}: ${JSON.stringify(result.error)}`);
    assert.deepEqual(hits, []);
    assert.deepEqual((result.evidence.routing ?? []).map((e) => [e.action, e.detail]), [['abort', `abort ${abort}`]]);
    assert.deepEqual(result.evidence.networkFailures, [], abort);
  }
});

test('assertNoTextMatches: a page that prints the raw error FAILS the step, naming the kinds and not copying the page', async () => {
  const trace = 'java.lang.NullPointerException\n\tat com.acme.sales.OrderService.save(OrderService.java:42)\nORA-00942: table or view does not exist';
  const leaky = await run([
    { action: 'injectFault', match: { urlContains: '/api/save' }, fault: { status: 500, body: trace, contentType: 'text/plain' } },
    { action: 'click', selector: '#raw' },
    becomes('#msg', 'OrderService'),
    { id: 'no-leak', action: 'assertNoTextMatches', selector: '#msg' },
  ]);
  assert.equal(leaky.status, 'failed');
  const step = leaky.steps.find((s) => s.id === 'no-leak')!;
  assert.equal(step.status, 'failed');
  assert.match(step.error!.message, /assertNoTextMatches: the page shows/);
  for (const kind of ['stackTrace', 'exception', 'sqlError']) assert.match(step.error!.message, new RegExp(kind));
  assert.ok(step.error!.message.length < 600, 'a summary, not the page');

  // the same step with only a kind that is not there passes: the filter works
  const onlyPaths = await run([
    { action: 'injectFault', match: { urlContains: '/api/save' }, fault: { status: 500, body: trace, contentType: 'text/plain' } },
    { action: 'click', selector: '#raw' },
    becomes('#msg', 'OrderService'),
    { action: 'assertNoTextMatches', selector: '#msg', kinds: ['serverPath'] },
  ]);
  assert.equal(onlyPaths.status, 'passed', JSON.stringify(onlyPaths.error));
});

test('untilStep: the fault ends when that step finishes; a teardown never sees a fault', async () => {
  const result = await run(
    [
      { action: 'injectFault', match: { urlContains: '/api/save' }, fault: { status: 500 }, untilStep: 'first-click' },
      { id: 'first-click', action: 'click', selector: '#save' },
      settle,
      msgIs('Could not save'),
      { action: 'click', selector: '#save' },
      settle,
      msgIs('Saved'),
      // a fault with no end of its own, left on at the end of the steps
      { action: 'injectFault', match: { urlContains: '/api/save' }, fault: { abort: 'failed' } },
    ],
    [{ action: 'click', selector: '#save' }, settle, msgIs('Saved')],
  );
  assert.equal(result.status, 'passed', JSON.stringify(result.error));
  assert.equal(result.teardownStatus, 'passed', JSON.stringify(result.teardown));
  assert.deepEqual(hits, ['POST /api/save', 'POST /api/save'], 'the second click and the teardown click reached the server');
});

test('a fault on an allowed OTHER origin is answered with CORS, so the page sees the 500 and not a CORS error', async () => {
  const result = await run([
    { action: 'injectFault', match: { urlContains: '/api/x' }, fault: { status: 500 } },
    { action: 'click', selector: '#cross' },
    settle,
    becomes('#x', 'HTTP 500'),
  ]);
  assert.equal(result.status, 'passed', JSON.stringify(result.error));
  assert.deepEqual(hits, [], 'the other origin was never reached');
});

test('a run without injectFault installs nothing: no routing evidence at all', async () => {
  const result = await run([{ action: 'click', selector: '#save' }, settle, msgIs('Saved')]);
  assert.equal(result.status, 'passed', JSON.stringify(result.error));
  assert.equal(result.evidence.routing, undefined);
});
