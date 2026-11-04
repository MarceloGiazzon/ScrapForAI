import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// T9.4: the Executive screen renders in Chromium under the server's CSP, from stores seeded on disk (no routine is run): readiness badges,
// the figures, the weekly chart (real SVG with a size), a regression row, markup in a name shown as text, and the period selector.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-executive-smoke-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';
process.env.SCHEDULER_ENABLED = 'false';

const express = (await import('express')).default;
const { executiveRouter } = await import('../src/routes/executive.routes.js');
const { appendPerfRecord } = await import('../src/metrics/perfStore.js');
const { saveTarget } = await import('../src/targets/targetStore.js');
const { saveRoutine } = await import('../src/library/routineService.js');
const { saveItem, setFirstGreen, recordLastRun } = await import('../src/vault/regression/regressionVault.js');

// The same CSP as src/server.ts: no inline script or style.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'";
const requests: string[] = [];
const app = express();
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  if (req.path.startsWith('/v1/')) requests.push(req.originalUrl);
  next();
});
app.use('/v1/executive', executiveRouter);
app.use('/ui', express.static(path.resolve(import.meta.dirname, '..', 'public'), { index: 'index.html' }));
const api = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => api.once('listening', resolve));
const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

after(async () => {
  await new Promise<void>((resolve) => api.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const DAY_MS = 24 * 60 * 60_000;
let counter = 0;
const record = (daysAgo: number, status: 'passed' | 'failed', buildId: string) => {
  counter += 1;
  return {
    jobId: `job_${counter}`,
    at: new Date(Date.now() - daysAgo * DAY_MS).toISOString(),
    version: 1,
    profile: 'full' as const,
    env: 'https://dev.example.com',
    buildId,
    status,
    durationMs: 1000,
    steps: [{ id: 'save', durationMs: 500, status: status === 'passed' ? ('passed' as const) : ('failed' as const) }],
  };
};

test('the Executive screen renders systems, readiness, figures, the weekly chart and a regression in Chromium under the CSP', async () => {
  const profile = (id: string, name: string) => ({
    id, name, platform: 'generic' as const, environment: 'dev' as const, baseUrl: 'https://dev.example.com', credentialSets: [],
    noiseFilters: [], surfaces: {}, screens: [], flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  });
  await saveTarget(profile('app-dev', 'App <b>dev</b>')); // markup in a name must stay text
  await saveTarget(profile('app-qa', 'App QA'));
  const steps = [{ id: 'open', action: 'goto', url: '$targetUrl' }] as never;
  await saveRoutine('login', { title: 'login', targetProfile: 'app-dev', steps });
  await saveRoutine('qa-smoke', { title: 'qa smoke', targetProfile: 'app-qa', steps });

  // login passed on r1 for three weeks, then failed on r2 two days ago: blocked, one regression still open.
  for (const item of [record(20, 'passed', 'r1'), record(12, 'passed', 'r1'), record(6, 'passed', 'r1'), record(2, 'failed', 'r2')]) await appendPerfRecord('login', item);
  for (const item of [record(10, 'passed', 'r7'), record(5, 'passed', 'r7'), record(1, 'passed', 'r7')]) await appendPerfRecord('qa-smoke', item);
  await saveItem('REG-1', { title: 'cart total', type: 'BUG', severity: 'HIGH', status: 'ACTIVE', surface: 'cart', tags: [], routine: { id: 'login', version: 1 }, opened: '2026-10-01', redNotCapturedReason: 'fixture' } as never);
  await setFirstGreen('REG-1', { jobId: 'job_green', at: new Date(Date.now() - 6 * DAY_MS).toISOString(), buildId: 'r1', manifestSha256: 'c'.repeat(64) });
  await recordLastRun('REG-1', { jobId: 'job_vault', status: 'passed', at: new Date(Date.now() - 6 * DAY_MS).toISOString(), buildId: 'r1' });

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const problems: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });
    page.on('pageerror', (error) => problems.push(error.message));

    await page.goto(`${apiUrl}/ui/executive.html`);
    await page.locator('#exec-systems .card').first().waitFor();

    assert.match((await page.locator('#exec-summary').textContent()) ?? '', /2 system\(s\), last 30 days/);
    assert.match((await page.locator('header.topbar nav a.active').textContent()) ?? '', /Executive/);

    const stats = (await page.locator('#exec-stats').textContent()) ?? '';
    assert.match(stats, /Systems ready for sign-off1 of 2/);
    assert.match(stats, /Regressions caught1/);
    assert.match(stats, /1 fixed, 0 still open|0 fixed, 1 still open/);

    // The chart: one bar per week, a real SVG with a size (the right namespace).
    const bars = page.locator('#exec-trend svg.chart rect');
    assert.equal(await bars.count(), 8);
    const box = await page.locator('#exec-trend svg.chart').boundingBox();
    assert.ok(box && box.width > 100 && box.height >= 50, 'the chart really has a size');
    assert.ok((await page.locator('#exec-trend svg.chart rect.bar-good').count()) >= 1, 'a week where everything passed');
    assert.ok((await page.locator('#exec-trend svg.chart rect.bar-none').count()) >= 1, 'a week with no runs is drawn as empty, not as 0%');

    // Worst system first, as in the Health screen.
    const cards = page.locator('#exec-systems .card');
    assert.equal(await cards.count(), 2);
    const first = cards.first();
    assert.match((await first.locator('h2').textContent()) ?? '', /App <b>dev<\/b> \(app-dev\)/, 'the name is shown as text, never as markup');
    assert.equal(await first.locator('h2 b').count(), 0);
    assert.match((await first.locator('.badge').first().textContent()) ?? '', /Blocked/);
    assert.match((await first.locator('.reasons').first().textContent()) ?? '', /1 test failed in the last run/);
    const facts = (await first.locator('dl.kv').textContent()) ?? '';
    assert.match(facts, /Latest buildr2/);
    assert.match(facts, /Signed evidencenone pinned for build r2/);
    assert.match(facts, /1 caught \(0 fixed, 1 still open\)/);
    const regressionRow = first.locator('tbody tr', { hasText: 'login' });
    assert.match((await regressionRow.textContent()) ?? '', /r1 → r2/);
    assert.match((await regressionRow.textContent()) ?? '', /save/, 'the failed step');
    assert.match((await regressionRow.textContent()) ?? '', /still failing/);
    assert.ok((await first.locator('dl.kv svg.chart').boundingBox())!.width > 40, 'the small chart of the system');

    const second = cards.nth(1);
    assert.match((await second.locator('.badge').first().textContent()) ?? '', /Ready for sign-off/);
    assert.match((await second.locator('dl.kv').textContent()) ?? '', /Latest buildr7/);

    assert.match((await page.locator('#exec-notes').textContent()) ?? '', /does not approve a build/);

    // The period selector asks for another period and the page follows.
    await page.selectOption('#exec-days', '7');
    await page.waitForFunction(() => document.getElementById('exec-summary')?.textContent?.includes('last 7 days'));
    assert.ok(requests.some((url) => url.includes('/v1/executive?days=7')), requests.join(' '));

    assert.deepEqual(problems, [], 'no CSP violation or script error');
  } finally {
    await browser.close();
  }
});
