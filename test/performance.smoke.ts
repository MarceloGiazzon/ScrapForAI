import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// T3.4 end to end: real routine runs in Chromium record their step times; a site that gets slower after a "new build" raises an alert that names
// the step and the build; the REST routes serve it; and the Performance screen renders the sparklines in Chromium under the server's CSP.

let delayMs = 0;
const site = await new Promise<{ server: http.Server; origin: string }>((resolve) => {
  const server = http.createServer((req, res) => {
    const respond = () => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<!doctype html><title>T</title><h1 id="t">ok</h1>');
    };
    if (req.url?.startsWith('/work')) setTimeout(respond, delayMs);
    else respond();
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-perf-smoke-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = site.origin;
process.env.ALLOWED_RESOURCE_ORIGINS = site.origin;
process.env.MAX_PARALLEL_JOBS = '1';

const express = (await import('express')).default;
const { metricsRouter } = await import('../src/routes/metrics.routes.js');
const { saveTarget } = await import('../src/targets/targetStore.js');
const { saveRoutine, runLibraryRoutine } = await import('../src/library/routineService.js');
const { getRoutinePerformance } = await import('../src/metrics/perfService.js');
const { readPerfRecords } = await import('../src/metrics/perfStore.js');

// The same CSP as src/server.ts: no inline script or style.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'";
const app = express();
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  next();
});
app.use('/v1/metrics', metricsRouter);
app.use('/ui', express.static(path.resolve(import.meta.dirname, '..', 'public'), { index: 'index.html' }));
const api = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => api.once('listening', resolve));
const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

after(async () => {
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await new Promise<void>((resolve) => site.server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('a step that gets slower after a new build raises an alert naming the step and the build', async () => {
  await saveTarget({
    id: 'app', name: 'App', platform: 'generic', environment: 'dev', baseUrl: `${site.origin}/`, credentialSets: [],
    noiseFilters: [], surfaces: {}, screens: [], flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  });
  await saveRoutine('work', {
    title: 'work',
    targetProfile: 'app',
    steps: [{ id: 'open', action: 'goto', url: `${site.origin}/work` }, { id: 'check', action: 'assertVisible', selector: '#t' }] as never,
  });

  delayMs = 0;
  for (let i = 0; i < 8; i += 1) assert.equal((await runLibraryRoutine('work', undefined, { buildId: 'r100' }, { initiator: 'system' })).status, 'passed');
  let detail = (await getRoutinePerformance('work'))!;
  assert.equal(detail.greenRuns, 8);
  assert.deepEqual(detail.alerts, [], 'steady');

  // A run with fixed parameters (a shrink probe) is not part of the series.
  await runLibraryRoutine('work', undefined, { buildId: 'r100', parameterValues: {} }, { initiator: 'system' }).catch(() => undefined);
  assert.equal((await readPerfRecords('work')).length, 8);

  delayMs = 1200; // the "new build" is slow on the navigation
  for (let i = 0; i < 3; i += 1) assert.equal((await runLibraryRoutine('work', undefined, { buildId: 'r101' }, { initiator: 'system' })).status, 'passed');

  detail = (await getRoutinePerformance('work'))!;
  assert.ok(detail.alerts.includes('open'), `alerts: ${detail.alerts.join(',')}`);
  // The run as a whole also contains the browser start-up, which varies by seconds: whether '(run)' alerts is not asserted, the step is.
  assert.ok(!detail.alerts.includes('check'), 'the step that did not change is not blamed');
  const open = detail.steps.find((step) => step.id === 'open')!;
  assert.equal(open.suspectBuild, 'r101');
  assert.ok(open.recentMs! >= 1000 && open.baselineMs! < 500, `${open.baselineMs} -> ${open.recentMs}`);
  assert.deepEqual(open.buildChanges, [8]);
});

test('the REST routes serve the list, the alerts and one routine; an unknown routine is a 404', async () => {
  const get = async (urlPath: string) => {
    const response = await fetch(`${apiUrl}${urlPath}`);
    return { status: response.status, body: await response.json() };
  };
  const list = await get('/v1/metrics/routines');
  assert.equal(list.status, 200);
  assert.equal(list.body.routines[0].routineId, 'work');
  assert.ok(list.body.routines[0].alerts.some((alert: { series: string }) => alert.series === 'open'));

  const alerts = await get('/v1/metrics/alerts');
  assert.ok(alerts.body.count >= 1);
  assert.ok(alerts.body.alerts.every((alert: { suspectBuild?: string }) => alert.suspectBuild === 'r101'));

  assert.equal((await get('/v1/metrics/routines/work?limit=5')).body.steps[0].points.length, 5);
  assert.equal((await get('/v1/metrics/routines/ghost')).status, 404);
  assert.equal((await get('/v1/metrics/routines/work?limit=0')).status, 400);
  assert.equal((await get('/v1/metrics/routines/work?bogus=1')).status, 400);
});

test('the Performance screen renders sparklines, the alert and the build tick in Chromium under the CSP', async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const problems: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });
    page.on('pageerror', (error) => problems.push(error.message));

    await page.goto(`${apiUrl}/ui/performance.html`);
    await page.getByText('work', { exact: true }).waitFor();
    assert.match((await page.locator('#perf-summary').textContent()) ?? '', /1 routine\(s\) measured, 1 slower than usual/);
    assert.match((await page.locator('#perf-body tr').first().textContent()) ?? '', /slower/);

    await page.locator('#perf-body tr').first().click();
    await page.locator('svg.spark').first().waitFor();
    assert.equal(await page.locator('svg.spark').count(), 3, 'the whole run and the two steps');
    assert.ok((await page.locator('circle.spark-alert').count()) >= 3, 'the recent runs of a slow series are highlighted');
    assert.ok((await page.locator('line.spark-build').count()) >= 1, 'the build change is marked');
    assert.ok((await page.locator('line.spark-base').count()) >= 1, 'the baseline is drawn');
    assert.match((await page.locator('.warn-banner').textContent()) ?? '', /open/);
    assert.match((await page.locator('#perf-detail').textContent()) ?? '', /new build in the slow runs: r101/);
    // The drawing really has a size (an SVG with the wrong namespace would be 0x0).
    const box = await page.locator('svg.spark').first().boundingBox();
    assert.ok(box && box.width > 100 && box.height > 20);

    assert.deepEqual(problems, [], 'no CSP violation or script error');
  } finally {
    await browser.close();
  }
});
