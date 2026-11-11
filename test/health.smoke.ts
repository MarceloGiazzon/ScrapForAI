import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// T3.7: the Health screen renders in Chromium under the server's CSP, from stores seeded on disk (no routine is run: the series, vault and
// schedule are written directly, so this is quick), and shows the status, the reasons, the strip of results and the scheduler warning.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-health-smoke-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';
process.env.SCHEDULER_ENABLED = 'false';

const express = (await import('express')).default;
const { healthRouter } = await import('../src/routes/health.routes.js');
const { routinesRouter } = await import('../src/routes/routines.routes.js');
const { getRoutine } = await import('../src/library/routineLibrary.js');
const { appendPerfRecord } = await import('../src/metrics/perfStore.js');
const { saveTarget } = await import('../src/targets/targetStore.js');
const { saveRoutine } = await import('../src/library/routineService.js');
const { saveItem, recordLastRun } = await import('../src/vault/regression/regressionVault.js');
const { saveScheduleDefinition } = await import('../src/scheduler/scheduleService.js');

// The same CSP as src/server.ts: no inline script or style.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'";
const app = express();
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  next();
});
app.use('/v1/health', healthRouter);
// Who the page thinks is signed in, switchable per test. The roles and the audit are proved over HTTP with real keys in test/routine-status.test.ts; here the screen is.
let role: 'viewer' | 'runner' = 'viewer';
app.get('/v1/auth/me', (_req, res) => res.json({ user: { id: 'ana', role } }));
app.use('/v1/routines', express.json(), routinesRouter);
app.use('/ui', express.static(path.resolve(import.meta.dirname, '..', 'public'), { index: 'index.html' }));
const api = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => api.once('listening', resolve));
const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

after(async () => {
  await new Promise<void>((resolve) => api.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const series = (pattern: string) =>
  [...pattern].map((letter, index) => ({
    jobId: `job_${index}`,
    at: `2026-11-03T10:${String(index).padStart(2, '0')}:00.000Z`,
    version: 1,
    profile: 'full' as const,
    env: 'https://dev.example.com',
    buildId: 'r100',
    status: letter === 'P' ? ('passed' as const) : ('failed' as const),
    durationMs: 1000,
    steps: [{ id: 'open', durationMs: 500, status: 'passed' as const }],
  }));

test('the Health screen renders targets, statuses, reasons, result strips and the scheduler warning in Chromium under the CSP', async () => {
  const profile = (id: string, name: string) => ({
    id, name, platform: 'generic' as const, environment: 'dev' as const, baseUrl: 'https://dev.example.com', credentialSets: [],
    noiseFilters: [], surfaces: {}, screens: [], flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  });
  await saveTarget(profile('app-dev', 'App <b>dev</b>')); // markup in a name must stay text
  await saveTarget(profile('app-qa', 'App QA'));
  const steps = [{ id: 'open', action: 'goto', url: '$targetUrl' }] as never;
  await saveRoutine('broken', { title: 'broken', targetProfile: 'app-dev', steps });
  await saveRoutine('solid', { title: 'solid', targetProfile: 'app-qa', steps });
  for (const record of series('P'.repeat(8) + 'FFFF')) await appendPerfRecord('broken', record);
  for (const record of series('P'.repeat(10))) await appendPerfRecord('solid', record);
  await saveItem('REG-1', { title: 'cart total', type: 'BUG', severity: 'HIGH', status: 'ACTIVE', surface: 'cart', tags: [], routine: { id: 'broken', version: 1 }, opened: '2026-10-01', redNotCapturedReason: 'fixture' } as never);
  await recordLastRun('REG-1', { jobId: 'job_9', status: 'failed', at: '2026-11-03T11:00:00.000Z' });
  await saveScheduleDefinition('solid-nightly', { cron: '0 3 * * *', timezone: 'America/Montevideo', target: { kind: 'routine', routineId: 'solid' }, enabled: true, overlap: 'skip', jitterSeconds: 0, notify: [], retries: 1 });

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const problems: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });
    page.on('pageerror', (error) => problems.push(error.message));

    await page.goto(`${apiUrl}/ui/health.html`);
    await page.locator('#health-targets .card').first().waitFor();

    const summary = (await page.locator('#health-summary').textContent()) ?? '';
    assert.match(summary, /2 target\(s\): 1 need attention, 1 to watch, 0 healthy, 0 without results/);

    const cards = page.locator('#health-targets .card');
    assert.equal(await cards.count(), 2);
    const first = cards.first();
    assert.match((await first.locator('h2').textContent()) ?? '', /App <b>dev<\/b> \(app-dev\)/, 'the name is shown as text, never as markup');
    assert.equal(await first.locator('h2 b').count(), 0);
    assert.match((await first.locator('.badge').first().textContent()) ?? '', /needs attention/);
    assert.match((await first.locator('.reasons').textContent()) ?? '', /1 routine failing in the last run/);
    assert.match((await first.locator('.reasons').textContent()) ?? '', /1 vault item failing/);

    const row = first.locator('tbody tr', { hasText: 'broken v1' });
    assert.match((await row.textContent()) ?? '', /failing/);
    assert.match((await row.textContent()) ?? '', /4 failed/);
    assert.equal(await row.locator('svg.strip rect').count(), 12, 'one cell per recent run');
    assert.equal(await row.locator('svg.strip rect.strip-fail').count(), 4);
    const box = await row.locator('svg.strip').boundingBox();
    assert.ok(box && box.width > 50 && box.height >= 10, 'the strip really has a size (the right SVG namespace)');

    const second = cards.nth(1);
    assert.match((await second.locator('.badge').first().textContent()) ?? '', /to watch/, 'the schedule cannot fire: yellow, not red');
    assert.match((await second.textContent()) ?? '', /solid-nightly/);
    assert.match((await second.textContent()) ?? '', /not firing/);

    assert.match((await page.locator('#health-banner .warn-banner').textContent()) ?? '', /scheduler is not running/);
    assert.match((await page.locator('header.topbar nav a.active').textContent()) ?? '', /Health/);

    assert.deepEqual(problems, [], 'no CSP violation or script error');
  } finally {
    await browser.close();
  }
});

test('a runner quarantines a flaky routine from the screen (the suggestion preselected), a viewer has no button, an empty reason is refused', async () => {
  const profile = {
    id: 'app-ops', name: 'App Ops', platform: 'generic' as const, environment: 'dev' as const, baseUrl: 'https://dev.example.com', credentialSets: [],
    noiseFilters: [], surfaces: {}, screens: [], flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  };
  await saveTarget(profile);
  await saveRoutine('wobbly', { title: 'wobbly', targetProfile: 'app-ops', steps: [{ id: 'open', action: 'goto', url: '$targetUrl' }] as never });
  for (const record of series('FP'.repeat(10))) await appendPerfRecord('wobbly', record);

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const problems: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });
    page.on('pageerror', (error) => problems.push(error.message));
    const card = () => page.locator('#health-targets .card', { hasText: 'App Ops' });
    // The version moves with the status (a status is the next version), so the row is found by id.
    const row = () => card().locator('tbody tr', { hasText: /wobbly v\d/ });

    role = 'viewer';
    await page.goto(`${apiUrl}/ui/health.html`);
    await row().waitFor();
    assert.equal(await page.getByRole('button', { name: 'Status…' }).count(), 0, 'a viewer only reads');

    role = 'runner';
    await page.reload();
    await row().waitFor();
    assert.match((await row().textContent()) ?? '', /quarantine suggested/);
    await row().getByRole('button', { name: 'Status…' }).click();
    const dialog = page.locator('#status-dialog');
    await dialog.waitFor({ state: 'visible' });
    assert.equal(await page.locator('#status-select').inputValue(), 'quarantined', 'the analysis suggestion is preselected, never applied by itself');
    assert.ok(((await page.locator('#status-reason').inputValue()) ?? '').length > 5, 'and its reason is a starting point for the person');
    await page.screenshot({ path: path.join(dataDir, 'health-status-dialog.png') });

    // Nothing is applied by opening; an empty reason is refused before the server is asked.
    await page.locator('#status-reason').fill('  ');
    await page.locator('#status-apply').click();
    assert.match((await page.locator('#status-error').textContent()) ?? '', /Say why/);
    assert.equal((await getRoutine('wobbly'))!.status, 'active');

    await page.locator('#status-reason').fill('flaky since build r104, parked until the fix is in');
    await page.locator('#status-apply').click();
    await dialog.waitFor({ state: 'hidden' });
    assert.match((await page.locator('#status-message').textContent()) ?? '', /wobbly is now quarantined \(version 2, was active\)/);
    await row().locator('.badge', { hasText: 'quarantined' }).waitFor();

    const stored = (await getRoutine('wobbly'))!;
    assert.equal(stored.status, 'quarantined');
    assert.equal(stored.version, 2);

    // A refusal from the server is shown in the dialog, not lost (a secret in the reason).
    await row().getByRole('button', { name: 'Status…' }).click();
    await page.locator('#status-select').selectOption('retired');
    await page.locator('#status-reason').fill('see sk-abcdefghijklmnopqrstuvwxyz0123');
    await page.locator('#status-apply').click();
    await page.locator('#status-error').waitFor({ state: 'visible' });
    assert.match((await page.locator('#status-error').textContent()) ?? '', /secret/i);
    assert.equal((await getRoutine('wobbly'))!.version, 2, 'nothing stored');

    assert.deepEqual(problems.filter((problem) => !/status of 400|status of 422|Failed to load resource/.test(problem)), [], 'no CSP violation or script error');
  } finally {
    await browser.close();
  }
});
