import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// T4.5 / T4.6 / T4.7 through the HTTP API, with snapshots written straight to disk (no browser): diff between builds,
// CHANGES.md with a labelled narrative, expected vs unexpected changes, the timeline of a control, tamper detection, and the
// rule that a screen that failed to capture is "unknown", never "removed".

const API_KEY = 'test-api-key-1234567890';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-evo-hist-'));
const evolutionDir = path.join(dataDir, 'evolution-repo');
fs.mkdirSync(evolutionDir);
process.env.SCRAPFORAI_API_KEY = API_KEY;
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.SYSTEM_EVOLUTION_DIR = evolutionDir;
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';
process.env.ALLOWED_RESOURCE_ORIGINS = 'https://dev.example.com';

const git = (...args: string[]) => execFileSync('git', ['-C', evolutionDir, ...args], { encoding: 'utf8' }).trim();

const express = (await import('express')).default;
const { apiAuth } = await import('../src/security/apiAuth.js');
const { evolutionRouter } = await import('../src/routes/evolution.routes.js');
const { writeSnapshotFolder, MANIFEST_FILE, sha256 } = await import('../src/evolution/snapshotStore.js');
const { snapshotFolderName } = await import('../src/evolution/snapshotPlan.js');
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
    /* markdown */
  }
  return { status: response.status, text, json };
}

const field = (key: string, over: Record<string, unknown> = {}) => ({ key, label: key[0]!.toUpperCase() + key.slice(1), type: 'text', required: false, enabled: true, visible: true, ...over });
const inventory = (screenId: string, fields: unknown[], actions: string[] = ['save'], columns: string[] = []) => ({
  screenId,
  fields,
  actions: actions.map((key) => ({ key, label: key[0]!.toUpperCase() + key.slice(1), enabled: true })),
  grids: columns.length ? [{ key: 'orders', columns }] : [],
  unkeyed: 0,
});

interface SnapshotSpec {
  buildId: string;
  day: string;
  screens: Record<string, unknown>;
  notCaptured?: Record<string, string>;
}

async function writeSnapshot(spec: SnapshotSpec): Promise<string> {
  const createdAt = `${spec.day}T08:00:00.000Z`;
  const files: Array<{ relative: string; data: string }> = [];
  const screens = Object.entries(spec.screens).map(([id, inv]) => {
    const text = `${JSON.stringify(inv, null, 2)}\n`;
    files.push({ relative: `screens/${id}.json`, data: text });
    return { id, name: id[0]!.toUpperCase() + id.slice(1), inventory: `screens/${id}.json`, inventorySha256: sha256(text), jobId: 'job_x' };
  });
  const manifest = {
    schemaVersion: 1, targetProfile: 'app', environment: 'dev', buildId: spec.buildId, buildIdSource: 'provided', createdAt, screenshots: false,
    complete: !spec.notCaptured, screens, notCaptured: Object.entries(spec.notCaptured ?? {}).map(([id, reason]) => ({ id, reason })),
  };
  files.push({ relative: MANIFEST_FILE, data: `${JSON.stringify(manifest, null, 2)}\n` });
  const name = snapshotFolderName(createdAt, spec.buildId);
  await writeSnapshotFolder('app', name, files);
  return name;
}

before(async () => {
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');

  await writeSnapshot({
    buildId: 'rev1', day: '2026-11-01',
    screens: {
      customers: inventory('customers', [field('name', { required: true, maxLength: 80 }), field('zip')], ['save', 'export'], ['Id', 'Date']),
      admin: inventory('admin', [field('role')]),
    },
  });
  await writeSnapshot({
    buildId: 'rev2', day: '2026-11-02',
    screens: {
      // phone added, zip now required, export removed, a column added, maxLength changed (noise by the profile's config below)
      customers: inventory('customers', [field('name', { required: true, maxLength: 120 }), field('zip', { required: true }), field('phone')], ['save'], ['Id', 'Date', 'Total']),
      // admin could not be captured in this build
    },
    notCaptured: { admin: 'LoginFailed: nope' },
  });
  await writeSnapshot({
    buildId: 'rev3', day: '2026-11-03',
    screens: {
      customers: inventory('customers', [field('name', { required: true, maxLength: 120 }), field('zip', { required: true })], ['save'], ['Id', 'Date', 'Total']),
      admin: inventory('admin', [field('role')]),
      orders: inventory('orders', [field('number')]),
    },
  });
  await saveTarget({
    id: 'app', name: 'App', platform: 'generic', environment: 'dev', baseUrl: 'https://dev.example.com', credentialSets: [], noiseFilters: [], surfaces: {}, screens: [],
    flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
    diff: { ignorePaths: ['fields[].maxLength'] },
  });

  const app = express();
  app.use(express.json());
  app.use(apiAuth);
  app.use('/v1/evolution', evolutionRouter);
  api = app.listen(0);
  await new Promise<void>((resolve) => api.once('listening', resolve));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => (api ? api.close(() => resolve()) : resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('diff: by default the last two builds; the profile config removes noise; every change in words', async () => {
  const { status, json } = await call('GET', '/v1/evolution/app/diff?from=rev1&to=rev2');
  assert.equal(status, 200);
  assert.deepEqual([json.from.buildId, json.to.buildId, json.classified], ['rev1', 'rev2', false]);
  const customers = json.screens.find((s: any) => s.id === 'customers');
  assert.deepEqual(customers.changes.map((c: any) => c.text).sort(), [
    '+ column "Total" in grid orders',
    '+ field Phone (phone) (text, optional)',
    '- action Export (export)',
    '~ field Zip (zip) is now required',
  ]);
  assert.ok(!customers.changes.some((c: any) => /maxLength|max length/.test(c.text)), 'maxLength is ignored by the profile diff config');
  assert.match(json.markdown, /^# Changes in app: rev1 -> rev2$/m);

  const latest = (await call('GET', '/v1/evolution/app/diff')).json;
  assert.deepEqual([latest.from.buildId, latest.to.buildId], ['rev2', 'rev3'], 'default: the latest build against the one before it');
});

test('a screen that failed to capture is unknown, never "removed" nor "added"', async () => {
  const toRev2 = (await call('GET', '/v1/evolution/app/diff?from=rev1&to=rev2')).json;
  const admin = toRev2.screens.find((s: any) => s.id === 'admin');
  assert.equal(admin.status, 'unknown');
  assert.match(admin.reason, /not captured in build rev2: LoginFailed/);
  assert.equal(toRev2.counts.screensRemoved, 0);

  const fromRev2 = (await call('GET', '/v1/evolution/app/diff?from=rev2&to=rev3')).json;
  assert.equal(fromRev2.screens.find((s: any) => s.id === 'admin').status, 'unknown', 'it came back, but rev2 cannot say what it looked like');
  assert.equal(fromRev2.screens.find((s: any) => s.id === 'orders').status, 'added');
});

test('refusals: a first build has nothing before it, an unknown build, bad refs, the same snapshot twice', async () => {
  const first = await call('GET', '/v1/evolution/app/diff?to=rev1');
  assert.equal(first.status, 409);
  assert.equal(first.json.error.type, 'NoPreviousSnapshot');
  assert.equal((await call('GET', '/v1/evolution/app/diff?from=rev9&to=rev2')).json.error.type, 'SnapshotNotFound');
  assert.equal((await call('GET', '/v1/evolution/app/diff?from=rev2&to=rev2')).json.error.type, 'SamePairNotComparable');
  assert.equal((await call('GET', '/v1/evolution/nobody/diff')).json.error.type, 'NoSnapshots');
  assert.equal((await call('GET', '/v1/evolution/app/diff?format=xml')).status, 400);
  assert.equal((await call('GET', '/v1/evolution/..%2Fx/diff')).status, 400);
});

test('expected changes: declared per build, committed, and the diff then says which changes nobody planned', async () => {
  assert.equal((await call('GET', '/v1/evolution/app/expected/rev2')).status, 404);

  const declared = {
    buildId: 'rev2',
    expected: [
      { screen: 'customers', kind: 'added', path: 'fields[key=phone]', ref: 'REG-301' },
      { screen: 'customers', kind: 'changed', path: 'fields[key=zip].*', note: 'zip is mandatory now' },
    ],
  };
  const saved = await call('PUT', '/v1/evolution/app/expected/rev2', declared);
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.git.committed, true);
  assert.equal(git('log', '-1', '--format=%s'), 'evolution(app): expected changes for rev2');
  assert.deepEqual((await call('GET', '/v1/evolution/app/expected/rev2')).json, declared);
  assert.equal((await call('GET', '/v1/evolution/app')).json.snapshots.length, 3, 'the expected/ folder is not a snapshot');

  const diff = (await call('GET', '/v1/evolution/app/diff?from=rev1&to=rev2')).json;
  assert.equal(diff.classified, true);
  assert.deepEqual([diff.counts.expected, diff.counts.unexpected], [2, 2]);
  const customers = diff.screens.find((s: any) => s.id === 'customers');
  const byText = Object.fromEntries(customers.changes.map((c: any) => [c.text, [c.classification, c.coveredBy]]));
  assert.deepEqual(byText['+ field Phone (phone) (text, optional)'], ['expected', 'REG-301']);
  assert.deepEqual(byText['- action Export (export)'], ['unexpected', undefined]);
  assert.match(diff.markdown, /- - action Export \(export\)  \*\*UNEXPECTED\*\*/);

  // rev3 declared nothing: not classified, so nothing there is an "alert"
  assert.equal((await call('GET', '/v1/evolution/app/diff?from=rev2&to=rev3')).json.classified, false);

  assert.equal((await call('PUT', '/v1/evolution/app/expected/rev2', { ...declared, buildId: 'rev3' })).status, 400, 'URL and body must agree');
  assert.equal((await call('PUT', '/v1/evolution/app/expected/rev2', { buildId: 'rev2', expected: [{ screen: 'x', surprise: 1 }] })).status, 400);
});

test('CHANGES.md: written next to the newer snapshot and committed; a narrative is labelled and the deterministic part is untouched', async () => {
  const plain = await call('POST', '/v1/evolution/app/changes', { from: 'rev1', to: 'rev2' });
  assert.equal(plain.status, 200, plain.text);
  assert.equal(plain.json.file, 'app/2026-11-02_rev2/CHANGES.md');
  assert.equal(plain.json.git.committed, true);
  assert.equal(git('log', '-1', '--format=%s'), 'evolution(app): changes rev1 -> rev2');
  const file = path.join(evolutionDir, 'app', '2026-11-02_rev2', 'CHANGES.md');
  const deterministic = fs.readFileSync(file, 'utf8');
  assert.match(deterministic, /\*\*UNEXPECTED\*\*/);
  assert.ok(!/AI-generated/.test(deterministic));

  const again = await call('POST', '/v1/evolution/app/changes', { from: 'rev1', to: 'rev2' });
  assert.equal(again.json.git.committed, false, 'same input, same file, no new commit');
  assert.equal(again.json.git.note, 'nothing to commit');

  const withNarrative = await call('POST', '/v1/evolution/app/changes', { from: 'rev1', to: 'rev2', narrative: 'Customers gained a phone field; Export is gone.' });
  assert.equal(withNarrative.json.git.committed, true);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith(deterministic.trimEnd()), 'the deterministic section comes first and is identical');
  assert.match(text, /## Narrative \(AI-generated summary, not verified\)\n\nCustomers gained a phone field; Export is gone\.\n$/);

  assert.equal((await call('POST', '/v1/evolution/app/changes', { narrative: 'x'.repeat(20_001) })).status, 400);
  assert.equal((await call('POST', '/v1/evolution/app/changes', { surprise: true })).status, 400);
  assert.equal((await call('POST', '/v1/evolution/app/changes', { to: 'rev1' })).json.error.type, 'NoPreviousSnapshot');
});

test('timeline: when a control appeared, changed or went away; per screen, per key, since a date', async () => {
  const all = (await call('GET', '/v1/evolution/app/timeline')).json;
  assert.equal(all.snapshots, 3);
  assert.deepEqual(all.builds.map((b: any) => [b.buildId, b.complete]), [['rev1', true], ['rev2', false], ['rev3', true]]);
  assert.ok(all.events.every((e: any, i: number, list: any[]) => i === 0 || list[i - 1].createdAt <= e.createdAt), 'oldest first');
  assert.ok(all.events.some((e: any) => e.kind === 'screen-added' && e.screen === 'orders' && e.buildId === 'rev3'));

  const phone = (await call('GET', '/v1/evolution/app/timeline?key=phone')).json;
  assert.deepEqual(phone.events.map((e: any) => [e.buildId, e.kind, e.path]), [
    ['rev2', 'added', 'fields[key=phone]'],
    ['rev3', 'removed', 'fields[key=phone]'],
  ]);
  assert.deepEqual(phone.control, { key: 'phone', presentInLatest: false, firstSeenIn: { buildId: 'rev2', createdAt: '2026-11-02T08:00:00.000Z', isFirstSnapshot: false } });

  const zip = (await call('GET', '/v1/evolution/app/timeline?key=zip')).json;
  assert.deepEqual(zip.events.map((e: any) => e.text), ['~ field Zip (zip) is now required']);
  assert.deepEqual([zip.control.presentInLatest, zip.control.screen, zip.control.firstSeenIn.isFirstSnapshot], [true, 'customers', true], 'present since the very first snapshot: earlier history is unknown');

  const recent = (await call('GET', '/v1/evolution/app/timeline?since=2026-11-03')).json;
  assert.ok(recent.events.length > 0 && recent.events.every((e: any) => e.buildId === 'rev3'));
  const onlyOrders = (await call('GET', '/v1/evolution/app/timeline?screen=orders')).json;
  assert.ok(onlyOrders.events.every((e: any) => e.screen === 'orders'));
  assert.equal((await call('GET', '/v1/evolution/app/timeline?since=yesterday')).status, 400);
  assert.equal((await call('GET', '/v1/evolution/app/timeline?limit=0')).status, 400);
  assert.equal((await call('GET', '/v1/evolution/app/timeline?limit=1')).json.events.length, 1);
});

test('tampering: an inventory edited after capture is refused, not trusted; so is a missing one', async () => {
  const file = path.join(evolutionDir, 'app', '2026-11-03_rev3', 'screens', 'orders.json');
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original.replace('number', 'NUMBER'));
  const tampered = await call('GET', '/v1/evolution/app/diff?from=rev2&to=rev3');
  assert.equal(tampered.status, 409);
  assert.equal(tampered.json.error.type, 'SnapshotTampered');
  assert.equal((await call('GET', '/v1/evolution/app/timeline')).json.error.type, 'SnapshotTampered');

  fs.rmSync(file);
  assert.equal((await call('GET', '/v1/evolution/app/diff?from=rev2&to=rev3')).json.error.type, 'SnapshotIncomplete');
  fs.writeFileSync(file, original);
  assert.equal((await call('GET', '/v1/evolution/app/diff?from=rev2&to=rev3')).status, 200, 'restored, readable again');
});
