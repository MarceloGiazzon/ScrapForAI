import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// A step that names a frame that never appears used to act on the MAIN page. With the same selector in both (`#vFILTER`, as in a GeneXus prompt over
// its form) that is a silent wrong answer: a fill landed on the page behind the dialog, and "assertCount 0" counted the page's own control. Now the step
// fails with FrameNotFoundError, except the assertions of ABSENCE, which a frame that is gone satisfies. Real Chromium, a fixture with both frames.

const site = await new Promise<{ server: http.Server; origin: string }>((resolve) => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if ((req.url ?? '/').startsWith('/dialog')) {
      return res.end(`<!doctype html><title>Dialog</title>
<input id="vFILTER" oninput="document.getElementById('inner-echo').textContent = this.value">
<div id="inner-echo"></div>
<button id="close" onclick="setTimeout(function () { var f = parent.document.getElementById('dlg'); f.parentNode.removeChild(f); }, 200)">Close</button>`);
    }
    res.end(`<!doctype html><title>Host</title>
<input id="vFILTER" oninput="document.getElementById('echo').textContent = this.value"><div id="echo"></div>
<button id="openDialog" onclick="setTimeout(function () { var f = document.createElement('iframe'); f.id = 'dlg'; f.name = 'dialog'; f.src = '/dialog'; document.body.appendChild(f); }, 300)">Open</button>
<button id="closeDialog" onclick="var f = document.getElementById('dlg'); if (f) f.parentNode.removeChild(f);">Close</button>`);
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-frame-smoke-'));
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

async function run(steps: unknown[], teardown?: unknown[]) {
  const request = explorationRequestSchema.parse({ targetUrl: `${site.origin}/`, steps, ...(teardown ? { teardown } : {}) });
  return runExploration(await resolveExplorationRequest(request, { initiator: 'system' }));
}
const open = { id: 'open', action: 'goto', url: `${site.origin}/` };
const dialog = { name: 'dialog' };
const openDialog = [
  { id: 'open-dialog', action: 'click', selector: '#openDialog' },
  // The iframe is injected 300 ms after the click: this is the step that has to wait for it to exist.
  { id: 'ready', action: 'waitForSelector', selector: '#inner-echo', state: 'attached', frame: dialog, timeoutMs: 5000 },
];

test('a frame that appears late is still found (the wait for it is unchanged)', async () => {
  const result = await run([
    open,
    ...openDialog,
    { id: 'type', action: 'fill', selector: '#vFILTER', value: 'abc', frame: dialog },
    { name: 'echoed', action: 'extractText', selector: '#inner-echo', frame: dialog },
  ]);
  assert.equal(result.status, 'passed', JSON.stringify(result.error));
  assert.equal(result.extracted.echoed, 'abc');
});

test('a step aimed at a frame that never appears FAILS with FrameNotFoundError instead of acting on the main page', async () => {
  const started = Date.now();
  const result = await run([open, { id: 'type', action: 'fill', selector: '#vFILTER', value: 'abc', frame: { name: 'nope' }, timeoutMs: 600 }]);
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.type, 'FrameNotFoundError');
  assert.match(result.error?.message ?? '', /No such frame: name "nope"/);
  assert.equal(result.failedStepIndex, 1);
  assert.ok(Date.now() - started < 8000, 'it gives up after the step timeout, not the whole 5 s grace plus the selector timeout');
});

test('every way of pointing at a frame says what was asked for (name, url, index)', async () => {
  for (const [frame, expected] of [
    [{ urlContains: '/nowhere' }, /url containing "\/nowhere"/],
    [{ index: 7 }, /index 7/],
  ] as const) {
    const result = await run([open, { id: 'read', action: 'assertVisible', selector: '#vFILTER', frame, timeoutMs: 300 }]);
    assert.equal(result.error?.type, 'FrameNotFoundError');
    assert.match(result.error?.message ?? '', expected);
  }
});

test('presence checks fail too: assertVisible, assertCount >= 1, extractText and a wait condition on a frame that is not there', async () => {
  const missing = { name: 'nope' };
  for (const step of [
    { id: 's', action: 'assertVisible', selector: '#vFILTER', frame: missing, timeoutMs: 300 },
    { id: 's', action: 'assertCount', selector: '#vFILTER', operator: '>=', count: 1, frame: missing },
    { id: 's', action: 'extractText', name: 'x', selector: '#vFILTER', frame: missing, timeoutMs: 300 },
    { id: 's', action: 'click', selector: '#closeDialog', waitFor: { selector: '#vFILTER', state: 'visible', timeoutMs: 300 }, frame: missing, timeoutMs: 300 },
  ]) {
    const result = await run([open, step]);
    assert.equal(result.status, 'failed', JSON.stringify(step));
    assert.equal(result.error?.type, 'FrameNotFoundError', JSON.stringify(step));
  }
});

test('assertions of ABSENCE are satisfied by a frame that is gone, and do not count the main page behind it', async () => {
  const result = await run([
    open,
    ...openDialog,
    { id: 'close', action: 'click', selector: '#closeDialog' },
    // The MAIN page still has a visible #vFILTER: under the old fallback each of these looked at it and failed.
    { id: 'gone-count', action: 'assertCount', selector: '#vFILTER', operator: '=', count: 0, frame: dialog },
    { id: 'gone-count-le', action: 'assertCount', selector: '#vFILTER', operator: '<=', count: 2, frame: dialog },
    { id: 'gone-hidden', action: 'assertHidden', selector: '#vFILTER', frame: dialog },
    { id: 'gone-wait-hidden', action: 'waitForSelector', selector: '#vFILTER', state: 'hidden', frame: dialog },
    { id: 'gone-wait-detached', action: 'waitForSelector', selector: '#vFILTER', state: 'detached', frame: dialog },
    { id: 'gone-waitfor', action: 'assertUrlContains', value: site.origin, waitFor: { selector: '#vFILTER', state: 'hidden' }, frame: dialog },
  ]);
  assert.equal(result.status, 'passed', JSON.stringify(result.error));
});

test('an absence check that a missing frame does NOT satisfy still fails (a count that needs one element)', async () => {
  const result = await run([open, { id: 'one', action: 'assertCount', selector: '#vFILTER', operator: '>', count: 0, frame: { name: 'gone' } }]);
  assert.equal(result.error?.type, 'FrameNotFoundError');
});

test('an absence check does not wait for a frame to appear: the frame being gone IS the answer', async () => {
  // The step's own duration, not the run's: closing the browser can take seconds on this machine (see AGENTS.md, HTTP mode).
  const result = await run([open, { id: 'gone', action: 'assertHidden', selector: '#vFILTER', frame: { name: 'gone' }, timeoutMs: 20000 }]);
  assert.equal(result.status, 'passed', JSON.stringify(result.error));
  const step = result.steps.find((each) => each.id === 'gone')!;
  assert.ok(step.durationMs < 1000, `the step took ${step.durationMs} ms: it must not wait out the 5 s grace for a frame to appear`);
});

test('afterWaitFor "hidden" on a click inside the dialog is satisfied when the dialog closes itself', async () => {
  const result = await run([
    open,
    ...openDialog,
    { id: 'close-in-dialog', action: 'click', selector: '#close', frame: dialog, afterWaitFor: { selector: '#vFILTER', state: 'hidden', timeoutMs: 5000 } },
    { id: 'main-still-there', action: 'assertVisible', selector: '#vFILTER' },
  ]);
  assert.equal(result.status, 'passed', JSON.stringify(result.error));
});

test('a frame reference on a step that never touches a frame is ignored, as it always was', async () => {
  const result = await run([
    open,
    { id: 'url', action: 'assertUrlContains', value: site.origin, frame: { name: 'nope' } },
    { id: 'shot', action: 'screenshot', name: 'plain', frame: { name: 'nope' } },
    { id: 'pause', action: 'waitForTimeout', timeoutMs: 50, frame: { name: 'nope' } },
  ]);
  assert.equal(result.status, 'passed', JSON.stringify(result.error));
});

test('a step with no frame, and one that names index 0 (the main frame), work on the main page as before', async () => {
  const result = await run([
    open,
    { id: 'plain', action: 'fill', selector: '#vFILTER', value: 'main', },
    { id: 'idx0', action: 'extractText', name: 'echo', selector: '#echo', frame: { index: 0 } },
  ]);
  assert.equal(result.status, 'passed', JSON.stringify(result.error));
  assert.equal(result.extracted.echo, 'main');
});
