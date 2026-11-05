import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// T10.1: roles, personal API keys, sessions of a person, and the audit log (hash chain, no secrets, no content).

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-team-test-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';

const express = (await import('express')).default;
const { apiAuth, requireBearer, UI_REQUEST_HEADER } = await import('../src/security/apiAuth.js');
const { authRouter } = await import('../src/routes/auth.routes.js');
const { teamRouter, auditRouter } = await import('../src/routes/team.routes.js');
const { generateKey, parseKeyId, hashKey } = await import('../src/team/keys.js');
const { requiredRole, roleAtLeast } = await import('../src/team/roles.js');
const { appendAudit, readAudit, verifyAudit } = await import('../src/team/audit.js');
const users = await import('../src/team/userStore.js');

const MASTER = process.env.SCRAPFORAI_API_KEY;
let server: http.Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(apiAuth);
  app.use('/v1/auth', authRouter);
  app.use('/v1/team', teamRouter);
  app.use('/v1/audit', auditRouter);
  // Stand-ins for the rest of the API: a read, a write a runner may do, a write only the API key may do.
  app.get('/v1/runs', (_req, res) => void res.json({ runs: [] }));
  app.post('/v1/explorations/run', (_req, res) => void res.json({ jobId: 'job-123', status: 'passed' }));
  app.put('/v1/credentials/:id', requireBearer, (_req, res) => void res.json({ ok: true }));
  app.put('/v1/config', (_req, res) => void res.json({ ok: true }));
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const call = async (method: string, url: string, key?: string, body?: unknown, extra: Record<string, string> = {}) => {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as any) : undefined, headers: response.headers };
};

// ---- pure parts

test('policy: who may do what, in one table', () => {
  const cases: Array<[string, string, string]> = [
    ['GET', '/v1/runs', 'viewer'],
    ['HEAD', '/v1/runs/x/report', 'viewer'],
    ['POST', '/v1/explorations/run', 'runner'],
    ['PUT', '/v1/routines/login', 'runner'],
    ['DELETE', '/v1/credentials/x', 'runner'], // the route adds requireBearer on top
    ['GET', '/v1/config', 'viewer'],
    ['PUT', '/v1/config', 'admin'],
    ['GET', '/v1/team/users', 'admin'],
    ['POST', '/v1/team/users', 'admin'],
    ['GET', '/v1/audit', 'admin'],
    ['GET', '/v1/audit/verify', 'admin'],
    ['POST', '/v1/auth/logout', 'viewer'],
    ['GET', '/v1/auth/me', 'viewer'],
    ['GET', '/v1/teammates', 'viewer'], // not under /v1/team
  ];
  for (const [method, url, expected] of cases) assert.equal(requiredRole(method, url), expected, `${method} ${url}`);
  assert.ok(roleAtLeast('admin', 'runner') && roleAtLeast('runner', 'viewer') && !roleAtLeast('viewer', 'runner') && !roleAtLeast('runner', 'admin'));
});

test('keys: shaped sfa_<id>_<secret>, hashed, and nothing else parses', () => {
  const a = generateKey();
  const b = generateKey();
  assert.match(a.key, /^sfa_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.key, b.key);
  assert.equal(parseKeyId(a.key), a.keyId);
  assert.equal(a.hash, hashKey(a.key));
  assert.ok(!a.hash.includes(a.key.slice(-10)));
  for (const wrong of ['', MASTER, 'sfa_zzzzzzzzzzzz_' + 'a'.repeat(43), `sfa_${a.keyId}_short`, `${a.key}x`]) assert.equal(parseKeyId(wrong), undefined, wrong);
});

// ---- the store

test('store: create, authenticate, revoke, expire, disable; the file holds hashes and no key', async () => {
  const { user, key } = await users.createUser({ id: 'ana', name: 'Ana', role: 'runner' }, 'root');
  assert.equal(user.keys.length, 1);
  const identity = await users.authenticateUserKey(key);
  assert.deepEqual(identity, { userId: 'ana', role: 'runner', keyId: user.keys[0]!.id });

  const raw = fs.readFileSync(path.join(dataDir, 'team', 'users.json'), 'utf8');
  assert.ok(!raw.includes(key), 'the key itself is never stored');
  assert.ok(raw.includes(hashKey(key)));
  assert.ok(!JSON.stringify(await users.listUsers()).includes(hashKey(key)), 'no hash leaves the store either');

  assert.equal(await users.authenticateUserKey(key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A')), undefined, 'a key off by one character');

  await users.updateUser('ana', { disabled: true });
  assert.equal(await users.authenticateUserKey(key), undefined);
  await users.updateUser('ana', { disabled: false });
  assert.ok(await users.authenticateUserKey(key));

  const second = await users.addKey('ana', { label: 'laptop' });
  assert.ok(await users.authenticateUserKey(second.key));
  await users.revokeKey('ana', second.view.id);
  assert.equal(await users.authenticateUserKey(second.key), undefined, 'a revoked key stops working at once');
  assert.ok(await users.authenticateUserKey(key), 'the other key is untouched');

  await assert.rejects(() => users.addKey('ana', { expiresAt: '2000-01-01T00:00:00Z' }), /past/);
  await assert.rejects(() => users.createUser({ id: 'root', name: 'x', role: 'admin' }, 'root'), (e: any) => e.name === 'ReservedUserId');
  await assert.rejects(() => users.createUser({ id: 'ana', name: 'x', role: 'admin' }, 'root'), (e: any) => e.status === 409);
  await assert.rejects(() => users.revokeKey('ana', 'ffffffffffff'), (e: any) => e.name === 'KeyNotFound');
  await users.deleteUser('ana');
  assert.equal(await users.authenticateUserKey(key), undefined);
});

test('store: changes survive a restart, and many at once are all kept', async () => {
  await Promise.all(Array.from({ length: 15 }, (_, index) => users.createUser({ id: `bulk-${index}`, name: `Bulk ${index}`, role: 'viewer' }, 'root')));
  assert.equal((await users.listUsers()).filter((user) => user.id.startsWith('bulk-')).length, 15);
  users.resetTeamCacheForTests();
  assert.equal((await users.listUsers()).filter((user) => user.id.startsWith('bulk-')).length, 15, 'read back from the file');
  for (let index = 0; index < 15; index += 1) await users.deleteUser(`bulk-${index}`);
});

test('store: a damaged users file is an error, not an empty team', async () => {
  const file = path.join(dataDir, 'team', 'users.json');
  const good = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, '{"version":1,"users":[{"id":"BAD ID"}]}');
  users.resetTeamCacheForTests();
  await assert.rejects(() => users.listUsers(), (e: any) => e.name === 'UsersFileInvalid');
  fs.writeFileSync(file, good);
  users.resetTeamCacheForTests();
  await users.listUsers();
});

// ---- over HTTP

let viewerKey = '';
let runnerKey = '';
let adminKey = '';
let runnerKeyId = '';

test('the installation key is root/admin and creates people; each key is shown once', async () => {
  for (const [id, role] of [['vera', 'viewer'], ['rui', 'runner'], ['ada', 'admin']] as const) {
    const created = await call('POST', '/v1/team/users', MASTER, { id, name: id.toUpperCase(), role });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.headers.get('cache-control'), 'no-store');
    assert.match(created.json.key, /^sfa_/);
    if (id === 'vera') viewerKey = created.json.key;
    if (id === 'rui') {
      runnerKey = created.json.key;
      runnerKeyId = created.json.user.keys[0].id;
    }
    if (id === 'ada') adminKey = created.json.key;
  }
  const listed = await call('GET', '/v1/team/users', MASTER);
  assert.equal(listed.json.users.length, 3);
  assert.ok(!JSON.stringify(listed.json).includes(viewerKey), 'the list never shows a key');
  const me = await call('GET', '/v1/auth/me', MASTER);
  assert.deepEqual(me.json.user, { id: 'root', role: 'admin' });
});

test('viewer reads only; runner also starts runs; neither may use the API-key-only writes or manage people', async () => {
  assert.equal((await call('GET', '/v1/runs', viewerKey)).status, 200);
  const viewerPost = await call('POST', '/v1/explorations/run', viewerKey, {});
  assert.equal(viewerPost.status, 403);
  assert.equal(viewerPost.json.error.type, 'InsufficientRole');

  assert.equal((await call('POST', '/v1/explorations/run', runnerKey, {})).status, 200);
  const credential = await call('PUT', '/v1/credentials/x', runnerKey, {});
  assert.equal(credential.status, 403);
  assert.equal(credential.json.error.type, 'InsufficientRole');
  assert.equal((await call('PUT', '/v1/config', runnerKey, {})).status, 403, 'a runner does not edit the configuration');
  assert.equal((await call('GET', '/v1/team/users', runnerKey)).status, 403);
  assert.equal((await call('GET', '/v1/audit', viewerKey)).status, 403);
  assert.equal((await call('POST', '/v1/team/users', runnerKey, { id: 'evil', name: 'x', role: 'admin' })).status, 403);

  // An admin's own key does what the installation's key does.
  assert.equal((await call('PUT', '/v1/credentials/x', adminKey, {})).status, 200);
  const created = await call('POST', '/v1/team/users', adminKey, { id: 'made-by-ada', name: 'x', role: 'viewer' });
  assert.equal(created.status, 201);
  assert.equal((await call('DELETE', '/v1/team/users/made-by-ada', adminKey)).status, 200);
});

test('a wrong, malformed, revoked or disabled key is a 401', async () => {
  assert.equal((await call('GET', '/v1/runs')).status, 401);
  assert.equal((await call('GET', '/v1/runs', 'sfa_000000000000_' + 'a'.repeat(43))).status, 401);
  assert.equal((await call('GET', '/v1/runs', 'nonsense')).status, 401);

  const extra = await call('POST', '/v1/team/users/rui/keys', MASTER, { label: 'temp' });
  assert.equal(extra.status, 201);
  assert.equal((await call('GET', '/v1/runs', extra.json.key)).status, 200);
  assert.equal((await call('DELETE', `/v1/team/users/rui/keys/${extra.json.keyId}`, MASTER)).status, 200);
  assert.equal((await call('GET', '/v1/runs', extra.json.key)).status, 401);

  await call('PATCH', '/v1/team/users/vera', MASTER, { disabled: true });
  assert.equal((await call('GET', '/v1/runs', viewerKey)).status, 401);
  await call('PATCH', '/v1/team/users/vera', MASTER, { disabled: false });
  assert.equal((await call('GET', '/v1/runs', viewerKey)).status, 200);
});

test('a session is the person: their role, their limits, and it ends with their key', async () => {
  const login = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: runnerKey }) });
  assert.equal(login.status, 200);
  assert.deepEqual((await login.json()).user, { id: 'rui', role: 'runner' });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  const session = (method: string, url: string, body?: unknown) =>
    call(method, url, undefined, body, { cookie, [UI_REQUEST_HEADER]: '1' });

  assert.equal((await session('GET', '/v1/runs')).status, 200);
  assert.equal((await session('POST', '/v1/explorations/run', {})).status, 200);
  assert.equal((await session('PUT', '/v1/credentials/x', {})).json.error.type, 'BearerTokenRequired', 'a session is never enough for the API-key-only writes');
  assert.deepEqual((await session('GET', '/v1/auth/me')).json.user, { id: 'rui', role: 'runner' });

  // Demoted: the next request of the SAME session already has the new role.
  await call('PATCH', '/v1/team/users/rui', MASTER, { role: 'viewer' });
  assert.equal((await session('POST', '/v1/explorations/run', {})).status, 403);
  assert.equal((await session('GET', '/v1/runs')).status, 200);
  await call('PATCH', '/v1/team/users/rui', MASTER, { role: 'runner' });
  assert.equal((await session('POST', '/v1/explorations/run', {})).status, 200);

  // Revoking the key that signed in ends the session.
  await call('DELETE', `/v1/team/users/rui/keys/${runnerKeyId}`, MASTER);
  assert.equal((await session('GET', '/v1/runs')).status, 401);
});

test('an admin SESSION can read the team and the audit, but not create a key (that needs the key itself)', async () => {
  const login = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: adminKey }) });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  const session = (method: string, url: string, body?: unknown) => call(method, url, undefined, body, { cookie, [UI_REQUEST_HEADER]: '1' });
  assert.equal((await session('GET', '/v1/team/users')).status, 200);
  assert.equal((await session('GET', '/v1/audit')).status, 200);
  const create = await session('POST', '/v1/team/users', { id: 'nope', name: 'x', role: 'viewer' });
  assert.equal(create.status, 403);
  assert.equal(create.json.error.type, 'BearerTokenRequired');
});

test('login: a bad key and a revoked key get the same answer', async () => {
  const attempt = async (apiKey: string) => {
    const response = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey }) });
    return { status: response.status, body: await response.json() };
  };
  const wrong = await attempt('sfa_111111111111_' + 'b'.repeat(43));
  const revoked = await attempt(runnerKey);
  assert.equal(wrong.status, 401);
  assert.deepEqual(revoked, wrong);
});

// ---- audit

test('audit: who changed what, with ids the answer created, and never a key, a body or a query', async () => {
  const marker = 'QUERY-MARKER-9f3a';
  await call('POST', '/v1/explorations/run', adminKey, { secretLooking: 'BODY-MARKER-77c1' });
  await call('PUT', `/v1/credentials/x?token=${marker}`, adminKey, {});
  await call('GET', '/v1/runs', MASTER); // a read: not recorded
  await call('GET', '/v1/runs', 'sfa_222222222222_' + 'c'.repeat(43)); // a failed sign-in
  await new Promise((resolve) => setTimeout(resolve, 100));

  const all = (await readAudit({ limit: 1000 })).entries;
  const run = all.find((entry) => entry.path === '/v1/explorations/run' && entry.actor?.userId === 'ada');
  assert.ok(run, 'the run is recorded');
  assert.equal(run.actor?.role, 'admin');
  assert.equal(run.actor?.via, 'bearer');
  assert.equal(run.status, 200);
  assert.equal(run.area, 'explorations');
  assert.equal(run.refs?.jobId, 'job-123');

  const credential = all.find((entry) => entry.path === '/v1/credentials/x');
  assert.ok(credential && credential.method === 'PUT', 'a change to a credential is recorded');
  assert.equal(all.filter((entry) => entry.method === 'GET' && entry.event === 'request').length, 0, 'reads are not');

  const created = all.find((entry) => entry.path === '/v1/team/users' && entry.method === 'POST' && entry.detail?.user === 'ada');
  assert.ok(created && created.detail?.role === 'admin' && created.actor?.userId === 'root', 'who made whom what');
  const denied = all.find((entry) => entry.event === 'auth.denied');
  assert.ok(denied && denied.detail?.needed, 'a refusal is recorded');
  const failed = all.find((entry) => entry.event === 'auth.failed');
  assert.ok(failed && failed.actor === undefined, 'a failed sign-in has no person');
  assert.ok(all.some((entry) => entry.event === 'auth.login' && entry.actor?.userId === 'rui'));

  const file = fs.readFileSync(path.join(dataDir, 'audit', 'audit.jsonl'), 'utf8');
  for (const secret of [marker, 'BODY-MARKER-77c1', adminKey, runnerKey, viewerKey, MASTER]) assert.ok(!file.includes(secret), `the audit file must not contain ${secret.slice(0, 12)}...`);
  assert.ok(!file.includes('token='), 'no query string');
});

test('audit: filters and paging', async () => {
  const byUser = await readAudit({ user: 'ada', limit: 1000 });
  assert.ok(byUser.entries.length > 0 && byUser.entries.every((entry) => entry.actor?.userId === 'ada'));
  const first = await readAudit({ limit: 2 });
  assert.equal(first.entries.length, 2);
  assert.ok(first.hasMore && first.entries[0]!.seq > first.entries[1]!.seq, 'newest first');
  const older = await readAudit({ limit: 2, before: first.entries[1]!.seq });
  assert.ok(older.entries.every((entry) => entry.seq < first.entries[1]!.seq));
  const http = await call('GET', '/v1/audit?area=team&method=POST&limit=5', MASTER);
  assert.equal(http.status, 200);
  assert.ok(http.json.entries.every((entry: any) => entry.area === 'team' && entry.method === 'POST'));
});

test('audit: the chain verifies, and an edit or a removed line in the middle is found', async () => {
  const intact = await verifyAudit();
  assert.ok(intact.ok, JSON.stringify(intact.problems));
  assert.ok(intact.entries >= 10);
  assert.equal((await call('GET', '/v1/audit/verify', MASTER)).json.ok, true);

  const file = path.join(dataDir, 'audit', 'audit.jsonl');
  const original = fs.readFileSync(file, 'utf8');
  const lines = original.trimEnd().split('\n');

  const edited = [...lines];
  edited[3] = edited[3]!.replace(/"status":\d+/, '"status":200').replace('"event":"request"', '"event":"request","x":1');
  fs.writeFileSync(file, `${edited.join('\n')}\n`);
  const afterEdit = await verifyAudit();
  assert.ok(!afterEdit.ok && afterEdit.problems.some((problem) => /edited/.test(problem.problem)));

  fs.writeFileSync(file, `${lines.filter((_, index) => index !== 4).join('\n')}\n`);
  const afterRemoval = await verifyAudit();
  assert.ok(!afterRemoval.ok && afterRemoval.problems.some((problem) => /removed or inserted|follow/.test(problem.problem)));

  fs.writeFileSync(file, original);
  assert.ok((await verifyAudit()).ok);
});

test('audit: appends continue the chain after a restart', async () => {
  const before = await verifyAudit();
  const { resetAuditForTests } = await import('../src/team/audit.js');
  resetAuditForTests();
  await appendAudit({ event: 'request', method: 'POST', path: '/v1/after-restart', status: 200 });
  const after = await verifyAudit();
  assert.ok(after.ok, JSON.stringify(after.problems));
  assert.equal(after.lastSeq, before.lastSeq + 1);
});

test('audit: a flood of failed sign-ins is capped, so it cannot fill the disk', async () => {
  const { droppedFailedAuthEntries, resetAuditForTests } = await import('../src/team/audit.js');
  resetAuditForTests();
  const before = (await readAudit({ limit: 1000, event: 'auth.failed' })).entries.length;
  await Promise.all(Array.from({ length: 150 }, () => appendAudit({ event: 'auth.failed', status: 401 })));
  const written = (await readAudit({ limit: 1000, event: 'auth.failed' })).entries.length - before;
  assert.ok(written <= 60, `wrote ${written}`);
  assert.ok(droppedFailedAuthEntries() >= 90);
  assert.ok((await verifyAudit()).ok);
});
