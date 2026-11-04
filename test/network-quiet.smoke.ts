import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// T8.2 end to end (real Chromium). The page answers a click with a CHAIN of requests (fetch, then an XHR started by the first answer), so no single
// "wait for response" covers it; an iframe does the same on its own; /api/hang never answers. The wait must follow all of them, and only them.

const site = await new Promise<{ server: http.Server; origin: string; hits: Map<string, number> }>((resolve) => {
  const hits = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    hits.set(url, (hits.get(url) ?? 0) + 1);
    const later = (ms: number, body: string) => setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end(body); }, ms);
    if (url.startsWith('/api/a')) return later(600, '{"next":"/api/b"}');
    if (url.startsWith('/api/b')) return later(500, '{"ok":true}');
    if (url.startsWith('/api/inner')) return later(900, '{"inner":"loaded"}');
    if (url.startsWith('/api/hang')) return; // never answers
    res.setHeader('content-type', 'text/html');
    if (url.startsWith('/inner')) {
      return res.end(`<!doctype html><title>Inner</title><div id="inner">waiting</div>
<script>fetch('/api/inner').then(function (r) { return r.json(); }).then(function (d) { document.getElementById('inner').textContent = d.inner; });</script>`);
    }
    res.end(`<!doctype html><title>Quiet</title>
<div id="out">idle</div><button id="go">Go</button><button id="hang">Hang</button>
<iframe id="frame" src="/inner" style="width:300px;height:60px"></iframe>
<script>
document.getElementById('go').onclick = function () {
  document.getElementById('out').textContent = 'working';
  fetch('/api/a').then(function (r) { return r.json(); }).then(function (d) {
    var x = new XMLHttpRequest();
    x.open('GET', d.next);
    x.onload = function () { document.getElementById('out').textContent = 'done'; };
    x.send();
  });
};
document.getElementById('hang').onclick = function () { fetch('/api/hang'); };
</script>`);
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits }));
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-quiet-smoke-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = site.origin;
process.env.ALLOWED_RESOURCE_ORIGINS = site.origin;

const { resolveExplorationRequest } = await import('../src/runner/resolveRequest.js');
const { runExploration } = await import('../src/runner/runExploration.js');
const { explorationRequestSchema } = await import('../src/schemas/explorationRequest.schema.js');

after(async () => {
  site.server.closeAllConnections();
  await new Promise<void>((resolve) => site.server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function run(steps: unknown[], options: Record<string, unknown> = {}) {
  const request = explorationRequestSchema.parse({ targetUrl: `${site.origin}/`, options, steps });
  return runExploration(await resolveExplorationRequest(request));
}
const open = { id: 'open', action: 'goto', url: `${site.origin}/` };
const frameText = { name: 'inner', action: 'extractText', selector: '#inner', frame: { urlContains: '/inner' } };

test('without waiting, the page is still "working" right after the click (the premise)', async () => {
  const result = await run([open, { action: 'click', selector: '#go' }, { name: 'out', action: 'extractText', selector: '#out' }]);
  assert.equal(result.status, 'passed', JSON.stringify(result.error));
  assert.equal(result.extracted.out, 'working');
});

test('waitForQuiet follows the whole chain (fetch -> XHR) and the iframe request; the text is final afterwards', async () => {
  const result = await run([
    open,
    { action: 'click', selector: '#go' },
    { id: 'settle', action: 'waitForQuiet', timeoutMs: 8000 },
    { name: 'out', action: 'extractText', selector: '#out' },
    frameText,
  ]);
  assert.equal(result.status, 'passed', JSON.stringify(result.error));
  assert.equal(result.extracted.out, 'done');
  assert.equal(result.extracted.inner, 'loaded', 'the iframe request counts too');
  const settle = result.steps.find((step) => step.id === 'settle')!;
  assert.ok(settle.durationMs >= 1000, `the chain takes ~1100 ms, the wait lasted ${settle.durationMs} ms`);
  assert.ok(settle.durationMs < 3500, `and does not run to the timeout (${settle.durationMs} ms)`);
});

test('afterWaitFor { quiet } on the click itself does the same, with idleMs of its own', async () => {
  const result = await run([
    open,
    { action: 'click', selector: '#go', afterWaitFor: { quiet: { idleMs: 200 }, timeoutMs: 8000 } },
    { name: 'out', action: 'extractText', selector: '#out' },
  ]);
  assert.equal(result.status, 'passed', JSON.stringify(result.error));
  assert.equal(result.extracted.out, 'done');
});

test('a request that never answers makes the wait fail at its timeout, naming how many are pending', async () => {
  const result = await run([open, { action: 'click', selector: '#hang' }, { id: 'settle', action: 'waitForQuiet', timeoutMs: 1500 }]);
  assert.equal(result.status, 'failed');
  assert.match(result.error?.message ?? '', /network quiet.*1 XHR\/fetch request\(s\) still pending after 1500 ms/s);
});

test('a run that never waits for quiet installs no counter: the page is untouched', async () => {
  const plain = await run([open, { action: 'click', selector: '#go' }, { name: 'out', action: 'extractText', selector: '#out' }]);
  assert.equal(plain.status, 'passed', JSON.stringify(plain.error));
  assert.equal(plain.extracted.out, 'working');
});
