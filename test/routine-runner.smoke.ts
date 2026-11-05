import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import test, { after, afterEach, before, beforeEach } from 'node:test';

// env.js parses process.env on import - set required vars first.
process.env.SCRAPFORAI_API_KEY ??= 'test-api-key-123456';
process.env.ALLOWED_TARGET_ORIGINS ??= 'https://dev.example.com';
process.env.ALLOWED_RESOURCE_ORIGINS ??= 'https://dev.example.com';
process.env.CORS_ALLOWED_ORIGINS ??= 'http://localhost:3000';

const { chromium } = await import('playwright');
const { resolveFrame, resolveFrameWhenReady, applyWaitCondition, runEvaluate, waitForResponseCondition } = await import('../src/runner/runExploration.js');

let browser: Awaited<ReturnType<typeof chromium.launch>>;
let context: Awaited<ReturnType<typeof browser.newContext>>;
let page: Awaited<ReturnType<typeof context.newPage>>;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});

beforeEach(async () => {
  context = await browser.newContext();
  page = await context.newPage();
});

afterEach(async () => {
  await context?.close();
});

// Poll until Playwright has attached at least `n` frames (main + children).
async function waitForFrameCount(target: typeof page, n: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (target.frames().length < n) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`expected >= ${n} frames, found ${target.frames().length}`);
    }
    await sleep(25);
  }
}

test('runEvaluate returns JSON-serializable values from the page', async () => {
  await page.setContent('<div class="item"></div><div class="item"></div><div class="item"></div>');
  const count = await runEvaluate(page.mainFrame(), 'return document.querySelectorAll(".item").length');
  assert.equal(count, 3);

  const obj = await runEvaluate(page.mainFrame(), 'return { ok: true, title: document.title }');
  assert.deepEqual(obj, { ok: true, title: '' });
});

test('runEvaluate rejects when the script exceeds EVALUATE_TIMEOUT_MS', async () => {
  // A script that never resolves should be cut off by the evaluate timeout race.
  await page.setContent('<body></body>');
  await assert.rejects(runEvaluate(page.mainFrame(), 'return new Promise(() => {})'), /evaluate timeout/);
});

test('resolveFrame targets iframes by name and index, and falls back to main', async () => {
  await page.setContent('<iframe name="child" srcdoc="<p class=&quot;inner&quot;>hi</p>"></iframe>');
  await waitForFrameCount(page, 2);

  const byName = resolveFrame(page, { name: 'child' });
  assert.equal(byName.name(), 'child');

  const byIndex = resolveFrame(page, { index: 1 });
  assert.equal(byIndex, page.frames()[1]);

  const missing = resolveFrame(page, { name: 'does-not-exist' });
  assert.equal(missing, page.mainFrame());

  const none = resolveFrame(page);
  assert.equal(none, page.mainFrame());
});

test('resolveFrameWhenReady waits for an iframe that a script injects after the step starts (a GeneXus prompt)', async () => {
  await page.setContent(
    '<body><script>setTimeout(function(){var f=document.createElement("iframe");f.name="late-child";f.srcdoc="<input id=inner>";document.body.appendChild(f);},400);</script></body>',
  );
  // Right now there is no such frame: the sync resolver answers main, as it always has.
  assert.equal(resolveFrame(page, { name: 'late-child' }), page.mainFrame());

  const byName = await resolveFrameWhenReady(page, { name: 'late-child' }, 3000);
  assert.notEqual(byName, page.mainFrame());
  assert.equal(byName.name(), 'late-child');
  await byName.locator('#inner').waitFor({ state: 'visible', timeout: 2000 });
});

test('resolveFrameWhenReady waits for a frame by url too, and for one whose address is not set yet', async () => {
  await page.route('**/inner-page', (route) => route.fulfill({ contentType: 'text/html', body: '<input id=inner>' }));
  await page.route('**/host', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<body><script>setTimeout(function(){var f=document.createElement("iframe");f.src="/inner-page";document.body.appendChild(f);},300);</script></body>',
    }),
  );
  await page.goto('http://localhost:1/host');

  const frame = await resolveFrameWhenReady(page, { urlContains: 'inner-page' }, 3000);
  assert.notEqual(frame, page.mainFrame());
  assert.match(frame.url(), /inner-page/);
});

test('resolveFrameWhenReady gives up after the timeout and answers main, like resolveFrame; it never waits without a reference', async () => {
  await page.setContent('<body></body>');
  const started = Date.now();
  assert.equal(await resolveFrameWhenReady(page, { name: 'never' }, 300), page.mainFrame());
  const waited = Date.now() - started;
  assert.ok(waited >= 250 && waited < 2000, `waited ${waited} ms`);

  const noRefStarted = Date.now();
  assert.equal(await resolveFrameWhenReady(page, undefined, 5000), page.mainFrame());
  assert.ok(Date.now() - noRefStarted < 100);
});

test('applyWaitCondition resolves when a delayed selector appears', async () => {
  await page.setContent(
    '<body><script>setTimeout(function(){var d=document.createElement("div");d.id="late";d.textContent="ready";document.body.appendChild(d);},200);</script></body>',
  );
  await applyWaitCondition(page, undefined, { selector: '#late', state: 'visible', timeoutMs: 2000 });
  assert.equal(await page.locator('#late').count(), 1);
});

test('applyWaitCondition rejects when the selector never appears', async () => {
  await page.setContent('<body></body>');
  await assert.rejects(applyWaitCondition(page, undefined, { selector: '#never', state: 'visible', timeoutMs: 300 }));
});

test('waitForResponseCondition catches a response triggered AFTER it is armed (pre-arm)', async () => {
  await page.route('**/api/ping', (route) => route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' }));
  await page.setContent('<button id="go" onclick="fetch(\'https://example.com/api/ping\').catch(function(){})">go</button>');

  // Arm BEFORE the action that triggers the request - this is the pre-arm pattern.
  const waiter = waitForResponseCondition(page, { response: { urlContains: '/api/ping' } });
  await page.click('#go');
  const response = await waiter;
  assert.ok(response);
});

test('waitForResponseCondition honors the status filter and times out on mismatch', async () => {
  await page.route('**/api/ping', (route) => route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' }));
  await page.setContent('<button id="go" onclick="fetch(\'https://example.com/api/ping\').catch(function(){})">go</button>');

  // Expecting 500 but the route returns 200 -> should never match -> times out fast.
  const waiter = waitForResponseCondition(page, {
    response: { urlContains: '/api/ping', status: 500 },
    timeoutMs: 500,
  });
  await page.click('#go');
  await assert.rejects(waiter);
});
