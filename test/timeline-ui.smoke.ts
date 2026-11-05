import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// T4.6 (web UI): the Evolution screen renders in Chromium under the server's CSP from snapshots written straight to disk (no run, no
// browser to capture): the builds, the changes grouped by build, a control's first sighting, filters, and markup in a label stays text.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-timeline-smoke-'));
const evolutionDir = path.join(dataDir, 'evolution');
fs.mkdirSync(evolutionDir);
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.SYSTEM_EVOLUTION_DIR = evolutionDir;
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';

const express = (await import('express')).default;
const { evolutionRouter } = await import('../src/routes/evolution.routes.js');
const { targetsRouter } = await import('../src/routes/targets.routes.js');
const { writeSnapshotFolder, MANIFEST_FILE, sha256 } = await import('../src/evolution/snapshotStore.js');
const { snapshotFolderName } = await import('../src/evolution/snapshotPlan.js');
const { saveTarget } = await import('../src/targets/targetStore.js');

// The same CSP as src/server.ts: no inline script or style.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'";
const app = express();
app.use(express.json());
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  next();
});
app.use('/v1/evolution', evolutionRouter);
app.use('/v1/targets', targetsRouter);
app.use('/ui', express.static(path.resolve(import.meta.dirname, '..', 'public'), { index: 'index.html' }));
const api = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => api.once('listening', resolve));
const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

after(async () => {
  await new Promise<void>((resolve) => api.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const field = (key: string, over: Record<string, unknown> = {}) => ({ key, label: key[0]!.toUpperCase() + key.slice(1), type: 'text', required: false, enabled: true, visible: true, ...over });
const inventory = (screenId: string, fields: unknown[], actions: string[] = ['save']) => ({
  screenId,
  fields,
  actions: actions.map((key) => ({ key, label: key[0]!.toUpperCase() + key.slice(1), enabled: true })),
  grids: [],
  unkeyed: 0,
});

async function writeSnapshot(buildId: string, day: string, screens: Record<string, unknown>): Promise<void> {
  const createdAt = `${day}T08:00:00.000Z`;
  const files: Array<{ relative: string; data: string }> = [];
  const entries = Object.entries(screens).map(([id, inv]) => {
    const text = `${JSON.stringify(inv, null, 2)}\n`;
    files.push({ relative: `screens/${id}.json`, data: text });
    return { id, name: id[0]!.toUpperCase() + id.slice(1), inventory: `screens/${id}.json`, inventorySha256: sha256(text), jobId: 'job_x' };
  });
  const manifest = {
    schemaVersion: 1, targetProfile: 'app', environment: 'dev', buildId, buildIdSource: 'provided', createdAt, screenshots: false,
    complete: true, screens: entries, notCaptured: [],
  };
  files.push({ relative: MANIFEST_FILE, data: `${JSON.stringify(manifest, null, 2)}\n` });
  await writeSnapshotFolder('app', snapshotFolderName(createdAt, buildId), files);
}

test('the Evolution screen shows builds, changes by build, a control history and filters in Chromium under the CSP', async () => {
  await saveTarget({
    id: 'app', name: 'App <b>dev</b>', platform: 'generic', environment: 'dev', baseUrl: 'https://dev.example.com', credentialSets: [], noiseFilters: [], surfaces: {},
    screens: [
      { id: 'customers', name: 'Customers', reach: { url: 'https://dev.example.com/customers' } },
      { id: 'orders', name: 'Orders', reach: { url: 'https://dev.example.com/orders' } },
    ],
    flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  } as never);
  await writeSnapshot('rev1', '2026-11-01', { customers: inventory('customers', [field('name'), field('zip')]), orders: inventory('orders', [field('qty')]) });
  await writeSnapshot('rev2', '2026-11-02', { customers: inventory('customers', [field('name'), field('zip', { required: true }), field('phone')]), orders: inventory('orders', [field('qty')]) });
  await writeSnapshot('rev3', '2026-11-03', { customers: inventory('customers', [field('name'), field('zip', { required: true }), field('phone')]), orders: inventory('orders', [field('qty'), field('note')]) });

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const problems: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });
    page.on('pageerror', (error) => problems.push(error.message));

    await page.goto(`${apiUrl}/ui/timeline.html`);
    await page.locator('#timeline-events .card').first().waitFor();

    assert.match((await page.locator('#timeline-target option').first().textContent()) ?? '', /App <b>dev<\/b> \(app\)/, 'the name is shown as text, never as markup');
    assert.equal(await page.locator('#timeline-target option b').count(), 0);
    assert.match((await page.locator('#timeline-summary').textContent()) ?? '', /3 snapshot\(s\), 3 change\(s\) shown/);
    assert.equal(await page.locator('#timeline-builds tbody tr').count(), 3);
    assert.match((await page.locator('#timeline-builds tbody tr').first().textContent()) ?? '', /rev3/, 'newest build first');

    const cards = page.locator('#timeline-events .card');
    assert.equal(await cards.count(), 2, 'rev3 and rev2 changed things; rev1 is only the baseline');
    assert.match((await cards.first().locator('h2').textContent()) ?? '', /Build rev3/);
    assert.match((await cards.first().textContent()) ?? '', /note/i);
    assert.match((await cards.nth(1).locator('h2').textContent()) ?? '', /Build rev2/);
    assert.ok((await cards.nth(1).locator('.badge.passed').count()) >= 1, 'phone was added');
    assert.ok((await cards.nth(1).locator('.badge.warn').count()) >= 1, 'zip became required');

    // filter by screen
    await page.locator('#timeline-screen').selectOption('orders');
    await page.locator('#timeline-show').click();
    await page.locator('#timeline-summary', { hasText: '1 change(s) shown' }).waitFor();
    assert.equal(await page.locator('#timeline-events .card').count(), 1);

    // history of one control
    await page.locator('#timeline-screen').selectOption('');
    await page.locator('#timeline-key').fill('phone');
    await page.locator('#timeline-show').click();
    await page.locator('#timeline-control .card').waitFor();
    const control = (await page.locator('#timeline-control').textContent()) ?? '';
    assert.match(control, /Control phone/);
    assert.match(control, /First seen in build rev2/);
    assert.match(control, /in the latest snapshot, on screen customers/);

    // a control that exists from the oldest snapshot: its real start is unknown
    await page.locator('#timeline-key').fill('name');
    await page.locator('#timeline-show').click();
    await page.locator('#timeline-control', { hasText: 'First seen in build rev1' }).waitFor();
    assert.match((await page.locator('#timeline-control').textContent()) ?? '', /oldest snapshot/);

    assert.match((await page.locator('header.topbar nav a.active').textContent()) ?? '', /Evolution/);
    assert.deepEqual(problems, [], 'no CSP violation or script error');
  } finally {
    await browser.close();
  }
});
