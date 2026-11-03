import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// T6.1 end to end (real Chromium, through the HTTP API). The fixture app has three roles and denies access in the three
// ways apps do: a redirect to the login (/settings), a "Not authorized" page with status 200 (/reports) and a bare 403
// (/audit). /orders has a delete button that is enabled for admin, disabled for seller and absent for viewer, and
// /orders/delete is the action. Then the app "regresses": viewer reaches /settings, and the second run must say so.

const API_KEY = 'test-api-key-1234567890';
const PASSWORDS: Record<string, string> = { ana: 'pw-admin-7f3a', sam: 'pw-seller-91bc', vic: 'pw-viewer-0d2e' };
const ROLE_OF: Record<string, 'admin' | 'seller' | 'viewer'> = { ana: 'admin', sam: 'seller', vic: 'viewer' };
let viewerGetsSettings = false;
const sessionsSeen = new Set<string>();

const page = (body: string) => `<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`;

const site = await new Promise<{ server: http.Server; origin: string }>((resolve) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const cookie = /(?:^|;\s*)user=([a-z]+)/.exec(req.headers.cookie ?? '')?.[1];
    const role = cookie ? ROLE_OF[cookie] : undefined;
    const html = (status: number, body: string) => {
      res.writeHead(status, { 'content-type': 'text/html' });
      res.end(page(body));
    };
    const toLogin = () => {
      res.writeHead(302, { location: `/login?next=${encodeURIComponent(url.pathname)}` });
      res.end();
    };

    switch (url.pathname) {
      case '/login':
        return html(200, '<form action="/do-login"><input id="u" name="u"><input id="p" name="p" type="password"><button id="go">Sign in</button></form>');
      case '/do-login': {
        const user = url.searchParams.get('u') ?? '';
        if (PASSWORDS[user] !== url.searchParams.get('p')) return html(200, '<p>Wrong password</p>');
        sessionsSeen.add(user);
        res.writeHead(302, { 'set-cookie': `user=${user}; Path=/`, location: '/home' });
        return res.end();
      }
      case '/home':
        return role ? html(200, `<h1 id="home">Home of ${role}</h1>`) : toLogin();
      case '/settings':
        if (role === 'admin' || (role === 'viewer' && viewerGetsSettings)) return html(200, '<h1>Settings</h1>');
        return toLogin();
      case '/reports':
        return role === 'seller' || role === 'viewer' ? html(200, '<p>Not authorized</p>') : html(200, '<h1>Reports</h1>');
      case '/audit':
        return role === 'admin' ? html(200, '<h1>Audit</h1>') : html(403, '<p>Forbidden</p>');
      case '/orders':
        if (!role) return toLogin();
        if (role === 'admin') return html(200, '<h1>Orders</h1><button id="del">Delete</button>');
        if (role === 'seller') return html(200, '<h1>Orders</h1><button id="del" disabled>Delete</button>');
        return html(200, '<h1>Orders</h1>');
      case '/orders/delete':
        if (!role) return toLogin();
        if (role === 'viewer') return toLogin();
        return role === 'admin' ? html(200, '<p id="deleted">Deleted</p>') : html(403, '<p>Forbidden</p>');
      default:
        return html(404, 'not found');
    }
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-perm-smoke-'));
process.env.SCRAPFORAI_API_KEY = API_KEY;
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.SCRAPFORAI_VAULT_KEY = crypto.randomBytes(32).toString('base64');
process.env.ALLOWED_TARGET_ORIGINS = site.origin;
process.env.ALLOWED_RESOURCE_ORIGINS = site.origin;
process.env.MAX_PARALLEL_JOBS = '3';
process.env.INTERACTIVE_RESERVED_SLOTS = '1';

const express = (await import('express')).default;
const { apiAuth } = await import('../src/security/apiAuth.js');
const { permissionsRouter } = await import('../src/routes/permissions.routes.js');
const { saveTarget } = await import('../src/targets/targetStore.js');
const { saveRoutine } = await import('../src/library/routineService.js');
const { saveCredentialSet } = await import('../src/vault/credentials/credentialVault.js');
const { listRuns } = await import('../src/history/runHistoryStore.js');

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

async function finished(runId: string): Promise<Record<string, any>> {
  for (;;) {
    const state = (await call('GET', `/v1/permissions/runs/${runId}?wait=20`)).json;
    if (state.status !== 'running') return state;
  }
}

const table = (state: Record<string, any>) =>
  Object.fromEntries(
    (state.cells as Array<Record<string, any>>).map((cell) => [
      `${cell.role}/${cell.probeId}`,
      cell.outcome === 'error' ? `error:${cell.errorType}` : cell.state ?? cell.outcome,
    ]),
  );

before(async () => {
  await saveTarget({
    id: 'fixture', name: 'Fixture', platform: 'generic', environment: 'dev', baseUrl: site.origin, credentialSets: ['admin', 'seller', 'viewer'],
    noiseFilters: [], surfaces: {}, screens: [], flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  });
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
  await saveRoutine('delete-order', {
    title: 'delete an order',
    targetProfile: 'fixture',
    steps: [
      { id: 'open', action: 'goto', url: `${site.origin}/orders/delete` },
      { id: 'done', action: 'waitForSelector', selector: '#deleted', state: 'visible', timeoutMs: 2000 },
    ] as never,
  });

  const app = express();
  app.use(express.json());
  app.use(apiAuth);
  app.use('/v1/permissions', permissionsRouter);
  api = app.listen(0);
  await new Promise<void>((resolve) => api.once('listening', resolve));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await new Promise<void>((resolve) => site.server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const MATRIX = {
  title: 'Fixture roles',
  targetProfile: 'fixture',
  loginRoutine: 'login',
  roles: ['admin', 'seller', 'viewer'],
  deniedWhen: [{ urlContains: '/login' }, { textVisible: 'Not authorized' }, { status: 403 }],
  settleMs: 300,
  controlWaitMs: 1000,
  probes: [
    { kind: 'url', id: 'settings', url: '/settings' },
    { kind: 'url', id: 'reports', url: '/reports' },
    { kind: 'url', id: 'audit', url: '/audit' },
    { kind: 'control', id: 'delete-btn', url: '/orders', selector: '#del', screen: 'Orders' },
    { kind: 'action', id: 'delete', routineId: 'delete-order' },
  ],
  expected: {
    admin: { settings: 'allowed', 'delete-btn': 'enabled', delete: 'allowed' },
    seller: { settings: 'denied', 'delete-btn': 'disabled', delete: 'denied' },
  },
};

test('refused: a probe outside the allowlist, a role the profile does not list', async () => {
  const outside = await call('PUT', '/v1/permissions/bad', { ...MATRIX, probes: [{ kind: 'url', id: 'x', url: 'http://169.254.169.254/latest/meta-data' }], expected: undefined });
  assert.equal(outside.status, 400);
  assert.equal(outside.json.error.type, 'TargetUrlNotAllowed');

  const stranger = await call('PUT', '/v1/permissions/bad', { ...MATRIX, roles: ['admin', 'root'], expected: undefined });
  assert.equal(stranger.status, 403);
  assert.equal(stranger.json.error.type, 'CredentialSetNotAllowed');
});

test('run 1: every role x probe answered, the three denial styles recognised, expectations met (green)', async () => {
  const saved = await call('PUT', '/v1/permissions/fixture-roles', MATRIX);
  assert.equal(saved.status, 201, saved.text);

  const started = await call('POST', '/v1/permissions/fixture-roles/run', { buildId: 'b1' });
  assert.equal(started.status, 202, started.text);
  assert.equal(started.json.cells, 15);
  assert.equal(started.json.sessions, 6, 'one page session + one action session per role');

  const state = await finished(started.json.runId);
  assert.deepEqual(table(state), {
    'admin/settings': 'allowed', 'admin/reports': 'allowed', 'admin/audit': 'allowed', 'admin/delete-btn': 'enabled', 'admin/delete': 'allowed',
    'seller/settings': 'denied', 'seller/reports': 'denied', 'seller/audit': 'denied', 'seller/delete-btn': 'disabled', 'seller/delete': 'denied',
    'viewer/settings': 'denied', 'viewer/reports': 'denied', 'viewer/audit': 'denied', 'viewer/delete-btn': 'hidden', 'viewer/delete': 'denied',
  });

  const by = (key: string) => (state.cells as Array<Record<string, any>>).find((cell) => `${cell.role}/${cell.probeId}` === key)!;
  assert.match(by('seller/settings').deniedBy, /urlContains/);
  assert.match(by('seller/reports').deniedBy, /textVisible/);
  assert.match(by('seller/audit').deniedBy, /status 403/);
  assert.match(by('seller/delete').deniedBy, /status 403/);
  assert.match(by('viewer/delete').deniedBy, /urlContains/);
  assert.ok((state.cells as Array<Record<string, any>>).every((cell) => /^job_/.test(cell.jobId)), 'every cell points at its evidence');

  assert.equal(state.verdict, 'green', state.verdictReason);
  assert.equal(state.exitCode, 0);
  assert.equal(state.counts.mismatches, 0);
  assert.equal(state.comparedTo, undefined, 'the first run has nothing to compare with');
  assert.deepEqual([...sessionsSeen].sort(), ['ana', 'sam', 'vic'], 'every role really logged in with its own vault credentials');

  const history = await listRuns({ limit: 100 });
  const mine = history.items.filter((entry) => entry.callerCorrelationId === state.runId);
  assert.equal(mine.length, 6, 'each session is an ordinary run in the history, tagged with the matrix run');
  assert.ok(mine.every((entry) => entry.callerSource === 'permissions'));

  const raw = fs.readFileSync(path.join(dataDir, 'permissions', 'runs', `${state.runId}.json`), 'utf8');
  for (const secret of Object.values(PASSWORDS)) {
    assert.ok(!raw.includes(secret), 'no credential value in the stored matrix run');
  }
});

test('run 2: the app regresses (viewer reaches /settings): the gain of access is an alert and the run is red', async () => {
  viewerGetsSettings = true;
  try {
    const started = await call('POST', '/v1/permissions/fixture-roles/run', { buildId: 'b2' });
    assert.equal(started.status, 202, started.text);
    assert.ok(started.json.comparedTo?.runId, 'compared with run 1');

    const state = await finished(started.json.runId);
    assert.equal(table(state)['viewer/settings'], 'allowed');
    assert.deepEqual(state.changes, [{ role: 'viewer', probeId: 'settings', from: 'denied', to: 'allowed', change: 'gainedAccess', alert: true }]);
    assert.equal(state.verdict, 'red');
    assert.equal(state.exitCode, 1);
    assert.match(state.verdictReason, /gained access/);
    assert.equal(state.comparedTo.buildId, 'b1');
  } finally {
    viewerGetsSettings = false;
  }
});

test('a broken expectation is red even without history (seller expected allowed on /audit)', async () => {
  const saved = await call('PUT', '/v1/permissions/strict', {
    ...MATRIX,
    roles: ['seller'],
    probes: [{ kind: 'url', id: 'audit', url: '/audit' }],
    expected: { seller: { audit: 'allowed' } },
    isolation: 'perProbe',
  });
  assert.equal(saved.status, 201, saved.text);
  const state = await finished((await call('POST', '/v1/permissions/strict/run', {})).json.runId);
  assert.equal(state.cells[0].matches, false);
  assert.equal(state.verdict, 'red');
});

test('T6.2: the screen catalogue is probed by URL for every role; reaching a screen the menu does not offer is red', async () => {
  await saveTarget({
    id: 'fixture', name: 'Fixture', platform: 'generic', environment: 'dev', baseUrl: site.origin, credentialSets: ['admin', 'seller', 'viewer'],
    noiseFilters: [], surfaces: {}, flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
    screens: [
      { id: 'home', name: 'Home', reach: { url: '/home' }, offeredTo: ['admin', 'seller', 'viewer'] },
      { id: 'settings', name: 'Settings', reach: { url: '/settings' }, offeredTo: ['admin'] },
      { id: 'audit', name: 'Audit', reach: { url: '/audit' }, offeredTo: ['admin'] },
      { id: 'delete-wizard', name: 'Only through a routine', reach: { routineId: 'delete-order' } },
    ],
  });
  const saved = await call('PUT', '/v1/permissions/fixture-catalog', {
    targetProfile: 'fixture',
    loginRoutine: 'login',
    roles: ['admin', 'seller', 'viewer'],
    deniedWhen: [{ urlContains: '/login' }, { textVisible: 'Not authorized' }, { status: 403 }],
    settleMs: 300,
    screensFromCatalog: true,
  });
  assert.equal(saved.status, 201, saved.text);

  const green = await call('POST', '/v1/permissions/fixture-catalog/run', { buildId: 'c1' });
  assert.equal(green.status, 202, green.text);
  assert.equal(green.json.cells, 9, '3 roles x 3 screens with a url (the routine-only screen is not probed)');
  const first = await finished(green.json.runId);
  assert.deepEqual(table(first), {
    'admin/screen-home': 'allowed', 'admin/screen-settings': 'allowed', 'admin/screen-audit': 'allowed',
    'seller/screen-home': 'allowed', 'seller/screen-settings': 'denied', 'seller/screen-audit': 'denied',
    'viewer/screen-home': 'allowed', 'viewer/screen-settings': 'denied', 'viewer/screen-audit': 'denied',
  });
  assert.equal(first.verdict, 'green', first.verdictReason);
  assert.equal(first.counts.unofferedAccess, 0);

  viewerGetsSettings = true;
  try {
    const state = await finished((await call('POST', '/v1/permissions/fixture-catalog/run', { buildId: 'c2' })).json.runId);
    const cell = (state.cells as Array<Record<string, any>>).find((candidate) => candidate.role === 'viewer' && candidate.probeId === 'screen-settings')!;
    assert.deepEqual([cell.outcome, cell.expected, cell.expectedBy, cell.matches], ['allowed', 'denied', 'menu', false]);
    assert.equal(state.verdict, 'red');
    assert.equal(state.counts.unofferedAccess, 1);
    assert.match(state.verdictReason, /opened a page the role's menu does not offer/);
  } finally {
    viewerGetsSettings = false;
  }
});
