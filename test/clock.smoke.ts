import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// T7.3 end to end (real Chromium). The page shows the date its script sees and, from the server, the date the SERVER sees: the first moves
// with setClock, the second must not (the documented limit: only the browser's clock changes).

const site = await new Promise<{ server: http.Server; origin: string }>((resolve) => {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/now')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ serverNow: new Date().toISOString() }));
    }
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><title>Clock</title>
<div id="loaded"></div><div id="now">-</div><div id="server">-</div><div id="ticks">0</div><div id="offer"></div>
<button id="read">Read the clock</button><button id="srv">Ask the server</button>
<script>
document.getElementById('loaded').textContent = new Date().toISOString();
document.getElementById('offer').textContent = Date.now() > Date.parse('2030-01-01T00:00:00Z') ? 'Offer expired' : 'Offer valid';
var ticks = 0; setInterval(function () { ticks++; document.getElementById('ticks').textContent = String(ticks); }, 100);
document.getElementById('read').onclick = function () { document.getElementById('now').textContent = new Date().toISOString(); };
document.getElementById('srv').onclick = function () { fetch('/api/now').then(function (r) { return r.json(); }).then(function (d) { document.getElementById('server').textContent = d.serverNow; }); };
</script>`);
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-clock-smoke-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = site.origin;
process.env.ALLOWED_RESOURCE_ORIGINS = site.origin;

const { resolveExplorationRequest } = await import('../src/runner/resolveRequest.js');
const { runExploration } = await import('../src/runner/runExploration.js');
const { explorationRequestSchema } = await import('../src/schemas/explorationRequest.schema.js');

after(async () => {
  await new Promise<void>((resolve) => site.server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function run(steps: unknown[]) {
  const request = explorationRequestSchema.parse({ targetUrl: `${site.origin}/`, steps });
  return runExploration(await resolveExplorationRequest(request));
}
const open = { id: 'open', action: 'goto', url: `${site.origin}/` };
const text = (selector: string) => ({ action: 'extractText', selector });

test('fixedTime before the page opens: its script sees that date from the first line, timers keep running, and a date rule flips', async () => {
  const result = await run([
    { action: 'setClock', id: 'clock', fixedTime: '2030-06-15T12:00:00Z' },
    open,
    { action: 'waitForTimeout', timeoutMs: 500 },
    { ...text('#loaded'), name: 'loaded' },
    { ...text('#offer'), name: 'offer' },
    { ...text('#ticks'), name: 'ticks' },
  ]);
  assert.equal(result.status, 'passed', JSON.stringify(result.error));
  assert.equal(result.extracted.loaded, '2030-06-15T12:00:00.000Z');
  assert.equal(result.extracted.offer, 'Offer expired');
  assert.ok(Number(result.extracted.ticks) >= 2, `timers keep running under a fixed time (ticks=${String(result.extracted.ticks)})`);
  assert.deepEqual(result.clock, [{ stepId: 'clock', mode: 'fixed', time: '2030-06-15T12:00:00.000Z' }]);
});

test('fixedTime with an offset is the same instant; setting it AFTER the page opened changes what the page reads next', async () => {
  const result = await run([
    open,
    { action: 'setClock', fixedTime: '2030-06-15T09:00:00-03:00' },
    { action: 'click', selector: '#read' },
    { ...text('#now'), name: 'now' },
    { action: 'setClock', fixedTime: '2031-01-01T00:00:00Z' },
    { action: 'click', selector: '#read' },
    { ...text('#now'), name: 'later' },
  ]);
  assert.equal(result.status, 'passed', JSON.stringify(result.error));
  assert.equal(result.extracted.now, '2030-06-15T12:00:00.000Z');
  assert.equal(result.extracted.later, '2031-01-01T00:00:00.000Z');
  assert.equal(result.clock?.length, 2);
});

test('installAt starts the page clock there and lets it run; fastForwardMs jumps it forward', async () => {
  const result = await run([
    { action: 'setClock', installAt: '2030-01-02T03:04:05Z', fastForwardMs: 86_400_000, id: 'jump' },
    open,
    { action: 'waitForTimeout', timeoutMs: 600 },
    { ...text('#loaded'), name: 'loaded' },
    { ...text('#ticks'), name: 'ticks' },
    { action: 'click', selector: '#read' },
    { ...text('#now'), name: 'now' },
  ]);
  assert.equal(result.status, 'passed', JSON.stringify(result.error));
  const loaded = Date.parse(String(result.extracted.loaded));
  const base = Date.parse('2030-01-02T03:04:05Z');
  // The jump is applied to the clock before the page loads, so the page starts a day after the install time (the clock then runs).
  assert.ok(loaded >= base + 86_400_000 && loaded < base + 86_400_000 + 10_000, `loaded at ${String(result.extracted.loaded)}`);
  const now = Date.parse(String(result.extracted.now));
  assert.ok(now > loaded && now - loaded < 15_000, 'the clock runs at normal speed after the install');
  assert.ok(Number(result.extracted.ticks) >= 2, 'timers run');
  assert.deepEqual(result.clock, [{ stepId: 'jump', mode: 'install', time: '2030-01-02T03:04:05.000Z', fastForwardMs: 86_400_000 }]);
});

test('installAt twice in one run is refused (it would restart the time silently); fixedTime still works', async () => {
  const result = await run([
    { action: 'setClock', installAt: '2030-01-02T03:04:05Z' },
    open,
    { id: 'again', action: 'setClock', installAt: '2035-01-01T00:00:00Z' },
  ]);
  assert.equal(result.status, 'failed');
  const step = result.steps.find((s) => s.id === 'again')!;
  assert.match(step.error!.message, /installAt can be used once per run/);
  assert.equal(result.clock?.length, 1, 'the refused step left no trace in the clock evidence');

  const ok = await run([{ action: 'setClock', installAt: '2030-01-02T03:04:05Z' }, open, { action: 'setClock', fixedTime: '2040-01-01T00:00:00Z' }]);
  assert.equal(ok.status, 'passed', JSON.stringify(ok.error));
});

test('the limit: the SERVER keeps the real date while the page lives in 2030', async () => {
  const result = await run([
    { action: 'setClock', fixedTime: '2030-06-15T12:00:00Z' },
    open,
    { action: 'click', selector: '#srv' },
    { action: 'waitForSelector', selector: '#server', state: 'visible' },
    { action: 'waitForTimeout', timeoutMs: 400 },
    { ...text('#loaded'), name: 'browser' },
    { ...text('#server'), name: 'server' },
  ]);
  assert.equal(result.status, 'passed', JSON.stringify(result.error));
  assert.ok(String(result.extracted.browser).startsWith('2030-06-15'));
  assert.ok(String(result.extracted.server).startsWith(String(new Date().getUTCFullYear())), `the server answered ${String(result.extracted.server)}`);
});

test('a run without setClock has no clock evidence', async () => {
  const result = await run([open, { action: 'click', selector: '#read' }, { ...text('#now'), name: 'now' }]);
  assert.equal(result.status, 'passed', JSON.stringify(result.error));
  assert.equal(result.clock, undefined);
  assert.ok(String(result.extracted.now).startsWith(String(new Date().getUTCFullYear())));
});
