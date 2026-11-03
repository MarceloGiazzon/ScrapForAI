import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// T4.4 end to end (real Chromium, through the HTTP API, into a real git repository). The fixture app has a login, two
// roles, a build endpoint and pages full of values. A snapshot must: record the structure of every catalogue screen (one
// login per role), commit it with the build in the message, be idempotent per build, replace on force, refuse to write a
// snapshot with a missing screen (unless allowPartial), honour --no-screenshots, and NEVER put a value or a password on disk.

const API_KEY = 'test-api-key-1234567890';
const PASSWORDS: Record<string, string> = { ana: 'pw-admin-7f3a', vic: 'pw-viewer-0d2e' };
const ROLE_OF: Record<string, 'admin' | 'viewer'> = { ana: 'admin', vic: 'viewer' };
const VALUES = ['Ada Lovelace', 'row-secret-99', 'typed-note-value'];
let build = 'rev-1';
let phoneField = false;
const logins: string[] = [];

const page = (body: string) => `<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`;

const site = await new Promise<{ server: http.Server; origin: string }>((resolve) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const user = /(?:^|;\s*)user=([a-z]+)/.exec(req.headers.cookie ?? '')?.[1];
    const role = user ? ROLE_OF[user] : undefined;
    const html = (status: number, body: string) => {
      res.writeHead(status, { 'content-type': 'text/html' });
      res.end(page(body));
    };
    const toLogin = () => {
      res.writeHead(302, { location: '/login' });
      res.end();
    };
    switch (url.pathname) {
      case '/info':
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ app: { version: build } }));
      case '/login':
        return html(200, '<form action="/do-login"><input id="u" name="u"><input id="p" name="p" type="password"><button id="go">Sign in</button></form>');
      case '/do-login': {
        const who = url.searchParams.get('u') ?? '';
        if (PASSWORDS[who] !== url.searchParams.get('p')) return html(200, '<p>Wrong password</p>');
        logins.push(who);
        res.writeHead(302, { 'set-cookie': `user=${who}; Path=/`, location: '/home' });
        return res.end();
      }
      case '/home':
        return role ? html(200, '<h1 id="home">Home</h1>') : toLogin();
      case '/customers':
        if (!role) return toLogin();
        return html(
          200,
          `<form><label for="cname">Name</label><input id="cname" name="name" maxlength="80" required value="Ada Lovelace">
           <label for="state">State</label><select id="state" name="state"><option>SP</option><option selected>RJ</option></select>
           ${phoneField ? '<label for="phone">Phone</label><input id="phone" name="phone">' : ''}
           <button id="save" type="submit">Save</button></form>`,
        );
      case '/orders':
        if (!role) return toLogin();
        return html(200, '<table id="orders"><thead><tr><th>Id</th><th>Total</th></tr></thead><tbody><tr><td>row-secret-99</td><td>10</td></tr></tbody></table>');
      case '/viewer-home':
        if (role !== 'viewer') return toLogin();
        return html(200, '<label for="note">Note</label><textarea id="note" name="note">typed-note-value</textarea>');
      default:
        return html(404, 'not found');
    }
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-evo-smoke-'));
const evolutionDir = path.join(dataDir, 'evolution-repo');
fs.mkdirSync(evolutionDir);
process.env.SCRAPFORAI_API_KEY = API_KEY;
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.SYSTEM_EVOLUTION_DIR = evolutionDir;
process.env.SCRAPFORAI_VAULT_KEY = crypto.randomBytes(32).toString('base64');
process.env.ALLOWED_TARGET_ORIGINS = site.origin;
process.env.ALLOWED_RESOURCE_ORIGINS = site.origin;
process.env.MAX_PARALLEL_JOBS = '3';
process.env.INTERACTIVE_RESERVED_SLOTS = '1';

const git = (...args: string[]) => execFileSync('git', ['-C', evolutionDir, ...args], { encoding: 'utf8' }).trim();

const express = (await import('express')).default;
const { apiAuth } = await import('../src/security/apiAuth.js');
const { evolutionRouter } = await import('../src/routes/evolution.routes.js');
const { saveTarget } = await import('../src/targets/targetStore.js');
const { saveRoutine } = await import('../src/library/routineService.js');
const { saveCredentialSet } = await import('../src/vault/credentials/credentialVault.js');
const { diffInventories } = await import('../src/inventory/diffInventory.js');

let api: http.Server;
let apiUrl: string;

async function call(method: string, urlPath: string, body?: unknown) {
  const response = await fetch(`${apiUrl}${urlPath}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, json: JSON.parse(text) as Record<string, any> };
}

async function snapshot(body: Record<string, unknown>): Promise<Record<string, any>> {
  const started = await call('POST', '/v1/evolution/snapshots', { targetProfile: 'fixture', ...body });
  assert.equal(started.status, 202, started.text);
  for (;;) {
    const state = (await call('GET', `/v1/evolution/snapshots/${started.json.snapshotId}?wait=20`)).json;
    if (state.status !== 'running') return state;
  }
}

const read = (folder: string, file: string) => fs.readFileSync(path.join(evolutionDir, folder, file), 'utf8');
const today = new Date().toISOString().slice(0, 10);

async function setTarget(screens: unknown[]) {
  await saveTarget({
    id: 'fixture', name: 'Fixture', platform: 'generic', environment: 'dev', baseUrl: site.origin, credentialSets: ['admin', 'viewer'],
    loginRoutine: 'login', buildInfo: { kind: 'jsonEndpoint', url: `${site.origin}/info`, jsonPath: 'app.version' },
    noiseFilters: [], surfaces: {}, screens: screens as never, flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  });
}

const GOOD_SCREENS = [
  { id: 'customers', name: 'Customers', reach: { url: '/customers' } },
  { id: 'orders', name: 'Orders', reach: { url: '/orders' } },
  { id: 'viewer-home', name: 'Viewer home', reach: { url: '/viewer-home' }, credentialSet: 'viewer' },
];

before(async () => {
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  await setTarget(GOOD_SCREENS); // routines can only be saved for a profile that exists
  for (const [user, role] of Object.entries(ROLE_OF)) {
    await saveCredentialSet(role, { boundOrigins: [site.origin], values: { user, pass: PASSWORDS[user]! }, tags: [] }, 'create');
  }
  await saveRoutine('login', {
    title: 'login',
    targetProfile: 'fixture',
    steps: [
      { id: 'open', action: 'goto', url: `${site.origin}/login` },
      { id: 'user', action: 'fill', selector: '#u', valueFromCredential: 'user' },
      { id: 'pass', action: 'fill', selector: '#p', valueFromCredential: 'pass' },
      { id: 'submit', action: 'click', selector: '#go' },
      { id: 'gate', action: 'waitForSelector', selector: '#home', state: 'visible' },
    ] as never,
  });
  await saveRoutine('open-broken', {
    title: 'a routine that cannot reach its screen',
    targetProfile: 'fixture',
    steps: [
      { id: 'open', action: 'goto', url: `${site.origin}/customers` },
      { id: 'never', action: 'waitForSelector', selector: '#never-there', state: 'visible', timeoutMs: 500 },
    ] as never,
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
  await new Promise<void>((resolve) => site.server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('1. a snapshot: build read from the app, one login per role, inventory + screenshot per screen, committed with the build', async () => {
  const state = await snapshot({});
  assert.equal(state.status, 'completed', JSON.stringify(state));
  assert.equal(state.exitCode, 0);
  assert.equal(state.buildId, 'rev-1');
  assert.equal(state.buildIdSource, 'probe');
  assert.equal(state.folder, `fixture/${today}_rev-1`);
  assert.equal(state.sessions, 2, 'admin: customers + orders in ONE session; viewer: its own');
  assert.deepEqual([...logins].sort(), ['ana', 'vic']);

  assert.deepEqual(state.warnings, [], 'no warning: every screenshot was readable');
  const folder = state.folder as string;
  const manifest = JSON.parse(read(folder, 'snapshot.json'));
  assert.deepEqual([manifest.buildId, manifest.complete, manifest.screenshots, manifest.environment], ['rev-1', true, true, 'dev']);
  assert.deepEqual(manifest.screens.map((s: any) => s.id), ['customers', 'orders', 'viewer-home']);
  for (const entry of manifest.screens) {
    const inventoryText = read(folder, entry.inventory);
    assert.equal(crypto.createHash('sha256').update(inventoryText).digest('hex'), entry.inventorySha256);
    const png = fs.readFileSync(path.join(evolutionDir, folder, entry.screenshot));
    assert.equal(crypto.createHash('sha256').update(png).digest('hex'), entry.screenshotSha256);
    assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47], 'a real PNG');
  }

  const customers = JSON.parse(read(folder, 'screens/customers.json'));
  assert.deepEqual(customers.fields.map((f: any) => f.key), ['name', 'state']);
  assert.deepEqual([customers.fields[0].label, customers.fields[0].required, customers.fields[0].maxLength], ['Name', true, 80]);
  assert.deepEqual(customers.actions.map((a: any) => [a.key, a.label]), [['save', 'Save']]);
  assert.deepEqual(JSON.parse(read(folder, 'screens/orders.json')).grids, [{ key: 'orders', columns: ['Id', 'Total'] }]);

  assert.equal(git('log', '-1', '--format=%s'), 'evolution(fixture): rev-1');
  assert.equal(state.git.committed, true);
  assert.equal(git('status', '--short'), '', 'everything written is committed');
});

test('2. no value and no password reaches the evolution directory, the run state or the git history', () => {
  const everything: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!entry.name.endsWith('.png')) everything.push(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(evolutionDir);
  const runStates = fs.readdirSync(path.join(dataDir, 'evolution-runs')).map((f) => fs.readFileSync(path.join(dataDir, 'evolution-runs', f), 'utf8'));
  const log = git('log', '-p');
  for (const text of [...everything, ...runStates, log]) {
    for (const secret of [...VALUES, ...Object.values(PASSWORDS)]) assert.ok(!text.includes(secret), `leaked: ${secret}`);
  }
});

test('3. the same build is idempotent: refused up front when named, refused after capture when probed, nothing new written', async () => {
  const commits = git('rev-list', '--count', 'HEAD');
  const named = await call('POST', '/v1/evolution/snapshots', { targetProfile: 'fixture', buildId: 'rev-1' });
  assert.equal(named.status, 409);
  assert.equal(named.json.error.type, 'SnapshotExists');

  const probed = await snapshot({});
  assert.equal(probed.status, 'failed');
  assert.match(probed.reason, /already has a snapshot/);
  assert.equal(git('rev-list', '--count', 'HEAD'), commits);
  assert.equal((await call('GET', '/v1/evolution/fixture')).json.snapshots.length, 1);
});

test('4. a new build with a new field: second snapshot, and the diff of the two inventories says exactly that', async () => {
  build = 'rev-2';
  phoneField = true;
  const state = await snapshot({ screenshots: false });
  assert.equal(state.status, 'completed', JSON.stringify(state));
  assert.equal(state.buildId, 'rev-2');
  assert.equal(git('log', '-1', '--format=%s'), 'evolution(fixture): rev-2');

  const listing = (await call('GET', '/v1/evolution/fixture')).json.snapshots as Array<Record<string, any>>;
  assert.deepEqual(listing.map((s) => s.buildId), ['rev-1', 'rev-2']);
  const manifest = JSON.parse(read(state.folder, 'snapshot.json'));
  assert.equal(manifest.screenshots, false);
  assert.ok(manifest.screens.every((s: any) => s.screenshot === undefined));
  assert.ok(!fs.existsSync(path.join(evolutionDir, state.folder, 'screens', 'customers.png')), '--no-screenshots takes none');

  const before = JSON.parse(read(`fixture/${today}_rev-1`, 'screens/customers.json'));
  const after = JSON.parse(read(state.folder, 'screens/customers.json'));
  const changes = diffInventories(before, after);
  assert.deepEqual(changes.added.map((c) => c.path), ['fields[key=phone]']);
  assert.equal(changes.removed.length + changes.changed.length, 0);
  const untouched = diffInventories(JSON.parse(read(`fixture/${today}_rev-1`, 'screens/orders.json')), JSON.parse(read(state.folder, 'screens/orders.json')));
  assert.equal(untouched.added.length + untouched.removed.length + untouched.changed.length, 0);
});

test('5. force replaces the snapshot of that build in one commit', async () => {
  const before = git('rev-list', '--count', 'HEAD');
  const state = await snapshot({ buildId: 'rev-2', force: true });
  assert.equal(state.status, 'completed', JSON.stringify(state));
  assert.equal(state.buildIdSource, 'provided');
  assert.equal((await call('GET', '/v1/evolution/fixture')).json.snapshots.filter((s: any) => s.buildId === 'rev-2').length, 1, 'replaced, not duplicated');
  assert.ok(Number(git('rev-list', '--count', 'HEAD')) <= Number(before) + 1);
});

test('6. a screen that cannot be captured: nothing is written, unless allowPartial, which says what is missing', async () => {
  await setTarget([...GOOD_SCREENS, { id: 'hard', name: 'Hard', reach: { routineId: 'open-broken' } }]);
  const commits = git('rev-list', '--count', 'HEAD');

  const strict = await snapshot({ buildId: 'rev-3' });
  assert.equal(strict.status, 'failed');
  assert.equal(strict.exitCode, 2);
  assert.deepEqual(strict.screens.filter((s: any) => s.status === 'error').map((s: any) => s.screenId), ['hard']);
  assert.equal(git('rev-list', '--count', 'HEAD'), commits);
  assert.ok(!(await call('GET', '/v1/evolution/fixture')).json.snapshots.some((s: any) => s.buildId === 'rev-3'));

  const partial = await snapshot({ buildId: 'rev-3', allowPartial: true, screenshots: false });
  assert.equal(partial.status, 'completed');
  assert.equal(partial.exitCode, 2, 'a partial snapshot is not a clean one');
  assert.match(partial.reason, /partial/);
  const manifest = JSON.parse(read(partial.folder, 'snapshot.json'));
  assert.equal(manifest.complete, false);
  assert.deepEqual(manifest.notCaptured.map((n: any) => n.id), ['hard']);
  assert.match(git('log', '-1', '--format=%s'), /evolution\(fixture\): rev-3 \(partial\)/);
});

test('7. requests that cannot run are refused before anything starts', async () => {
  assert.equal((await call('POST', '/v1/evolution/snapshots', { targetProfile: 'ghost' })).status, 404);
  assert.equal((await call('POST', '/v1/evolution/snapshots', { targetProfile: 'fixture', screens: ['nope'] })).json.error.type, 'SnapshotNotPlannable');
  assert.equal((await call('POST', '/v1/evolution/snapshots', { targetProfile: 'fixture', surprise: true })).status, 400);
  assert.equal((await call('GET', '/v1/evolution/snapshots/evo_doesnotexist')).status, 404);
  assert.equal((await call('GET', '/v1/evolution/..%2Fx')).status, 400);
  await setTarget([{ id: 'outside', name: 'Outside', reach: { url: 'https://not-allowed.example.org/x' } }]);
  assert.equal((await call('POST', '/v1/evolution/snapshots', { targetProfile: 'fixture' })).json.error.type, 'SnapshotNotPlannable');
});
