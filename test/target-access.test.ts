import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// Who may start a run THROUGH a target profile: `allowedUsers` on the profile, checked where a run resolves its profile (the same place and the same
// rule as a credential set's list). No browser: a refusal happens before one starts. The limit is tested too, so it stays honest: a run that
// names no profile is not stopped by a profile's list.

const MASTER = 'test-api-key-1234567890';
const ORIGIN = 'https://dev.example.com';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-targetaccess-test-'));
process.env.SCRAPFORAI_API_KEY = MASTER;
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.SCRAPFORAI_VAULT_KEY = crypto.randomBytes(32).toString('base64');
process.env.ALLOWED_TARGET_ORIGINS = ORIGIN;
process.env.ALLOWED_RESOURCE_ORIGINS = ORIGIN;

const express = (await import('express')).default;
const users = await import('../src/team/userStore.js');
const { apiAuth } = await import('../src/security/apiAuth.js');
const { targetsRouter } = await import('../src/routes/targets.routes.js');
const { explorationRouter } = await import('../src/routes/exploration.routes.js');
const { mayUseCredentialSet, mayUseRestricted, mayUseTargetProfile, SYSTEM_INITIATOR } = await import('../src/team/initiator.js');
const { resolveExplorationRequest } = await import('../src/runner/resolveRequest.js');
const { explorationRequestSchema } = await import('../src/schemas/explorationRequest.schema.js');
const { getTarget } = await import('../src/targets/targetStore.js');
const { targetProfileSchema } = await import('../src/schemas/targetProfile.schema.js');
const { requiredRole } = await import('../src/team/roles.js');

let server: http.Server;
let base: string;
const keys: Record<string, string> = {};

before(async () => {
  keys.alice = (await users.createUser({ id: 'alice', name: 'Alice', role: 'runner' }, 'root')).key;
  keys.bob = (await users.createUser({ id: 'bob', name: 'Bob', role: 'runner' }, 'root')).key;
  keys.vera = (await users.createUser({ id: 'vera', name: 'Vera', role: 'viewer' }, 'root')).key;
  keys.carol = (await users.createUser({ id: 'carol', name: 'Carol', role: 'admin' }, 'root')).key;

  const app = express();
  app.use(express.json());
  app.use(apiAuth);
  app.use('/v1/targets', targetsRouter);
  app.use('/v1/explorations', explorationRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise((resolve) => setTimeout(resolve, 250)); // the last request's audit line is written after the answer
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const call = async (method: string, url: string, key: string, body?: unknown) => {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, text, json: text ? (JSON.parse(text) as any) : undefined };
};

const profile = (extra: Record<string, unknown> = {}) => ({ name: 'Prod-like', platform: 'generic', environment: 'qa', baseUrl: `${ORIGIN}/`, credentialSets: [], ...extra });
const person = (userId: string, role: 'viewer' | 'runner' | 'admin') => ({ userId, role });
const runRequest = (targetProfile?: string) =>
  explorationRequestSchema.parse({ ...(targetProfile ? { targetProfile } : { targetUrl: `${ORIGIN}/` }), steps: [{ action: 'goto', url: '$targetUrl' }] });

test('rule: one function for every restrictable thing, so the profile and the credential set cannot drift apart', () => {
  assert.equal(mayUseTargetProfile, mayUseRestricted);
  assert.equal(mayUseCredentialSet, mayUseRestricted);
  const alice = person('alice', 'runner');
  const bob = person('bob', 'runner');
  assert.equal(mayUseTargetProfile(undefined, bob), true, 'no list: as before');
  assert.equal(mayUseTargetProfile(['alice'], alice), true);
  assert.equal(mayUseTargetProfile(['alice'], bob), false);
  assert.equal(mayUseTargetProfile(['alice'], person('carol', 'admin')), true, 'an admin always');
  assert.equal(mayUseTargetProfile(['alice'], SYSTEM_INITIATOR), true, 'the scheduler always');
  assert.equal(mayUseTargetProfile([], alice), false, 'an empty list is admins only');
  assert.equal(mayUseTargetProfile([], person('carol', 'admin')), true);
});

test('a profile stored before the field existed still loads and is open to everyone', () => {
  const old = targetProfileSchema.parse({ id: 'old-app', name: 'Old', environment: 'dev', baseUrl: `${ORIGIN}/` });
  assert.equal(old.allowedUsers, undefined);
  assert.equal(targetProfileSchema.safeParse({ ...old, allowedUsers: ['ok-user'] }).success, true);
  assert.equal(targetProfileSchema.safeParse({ ...old, allowedUsers: ['Not A User!'] }).success, false, 'ids have the team\'s shape');
});

test('http: writing the list is an admin key\'s; an unknown person is refused and nothing is stored', async () => {
  assert.equal(requiredRole('PUT', '/v1/targets/prod-like'), 'runner', 'the role floor is runner; the key-only rule is requireBearer, as for every profile write');
  assert.equal((await call('PUT', '/v1/targets/prod-like', keys.alice!, profile({ allowedUsers: ['alice'] }))).status, 403, 'a runner\'s key does not reach it');

  const typo = await call('PUT', '/v1/targets/prod-like', MASTER, profile({ allowedUsers: ['alice', 'alicia'] }));
  assert.equal(typo.status, 400);
  assert.equal(typo.json.error.type, 'UnknownUser');
  assert.match(typo.json.error.message, /alicia/);
  assert.equal(await getTarget('prod-like'), undefined, 'nothing stored');

  const saved = await call('PUT', '/v1/targets/prod-like', MASTER, profile({ allowedUsers: ['alice', 'alice'] }));
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(saved.json.allowedUsers, ['alice'], 'duplicates collapse');
  assert.equal(saved.json.restricted, true);
});

test('http: an omitted list is KEPT by a later PUT, null opens the profile, [] means admins only', async () => {
  const fixed = await call('PUT', '/v1/targets/prod-like', MASTER, profile({ name: 'Prod-like (renamed)' }));
  assert.equal(fixed.status, 200);
  assert.deepEqual(fixed.json.allowedUsers, ['alice'], 'fixing a name must never open a restricted profile');
  assert.deepEqual((await getTarget('prod-like'))!.allowedUsers, ['alice']);

  const adminsOnly = await call('PUT', '/v1/targets/prod-like', MASTER, profile({ allowedUsers: [] }));
  assert.deepEqual(adminsOnly.json.allowedUsers, []);
  assert.equal(adminsOnly.json.restricted, true, 'an empty list is still a restriction');

  const opened = await call('PUT', '/v1/targets/prod-like', MASTER, profile({ allowedUsers: null }));
  assert.equal(opened.json.restricted, false);
  assert.equal('allowedUsers' in opened.json, false);
  assert.equal((await getTarget('prod-like'))!.allowedUsers, undefined);

  await call('PUT', '/v1/targets/prod-like', MASTER, profile({ allowedUsers: ['alice'] }));
});

test('http: everyone learns THAT it is restricted; only an admin learns who may use it', async () => {
  for (const name of ['alice', 'bob', 'vera']) {
    const one = await call('GET', '/v1/targets/prod-like', keys[name]!);
    assert.equal(one.json.restricted, true, name);
    assert.equal('allowedUsers' in one.json, false, `${name} does not see the list`);
    const list = (await call('GET', '/v1/targets', keys[name]!)).json.targets.find((item: { id: string }) => item.id === 'prod-like');
    assert.equal(list.restricted, true);
    assert.equal('allowedUsers' in list, false);
  }
  const admin = await call('GET', '/v1/targets/prod-like', keys.carol!);
  assert.deepEqual(admin.json.allowedUsers, ['alice']);
});

test('a run through the profile is refused with 403 for anyone not listed, before a browser starts, without saying who may', async () => {
  const bob = await call('POST', '/v1/explorations/run', keys.bob!, { targetProfile: 'prod-like', steps: [{ action: 'goto', url: '$targetUrl' }] });
  assert.equal(bob.status, 403);
  assert.equal(bob.json.error.type, 'TargetProfileForbidden');
  assert.ok(!bob.text.includes('alice'), 'the refusal does not name the people allowed');

  await assert.rejects(resolveExplorationRequest(runRequest('prod-like'), { initiator: person('bob', 'runner') }), { name: 'TargetProfileForbidden' });
  await assert.rejects(resolveExplorationRequest(runRequest('prod-like'), { initiator: person('vera', 'viewer') }), { name: 'TargetProfileForbidden' });

  // The people who may: the listed one, an admin, and the server itself (the scheduler).
  for (const initiator of [person('alice', 'runner'), person('carol', 'admin'), SYSTEM_INITIATOR]) {
    const resolved = await resolveExplorationRequest(runRequest('prod-like'), { initiator });
    assert.equal(resolved.targetUrl, `${ORIGIN}/`);
  }
});

test('the 403 carries its own status and name, so every caller (a suite variant, a snapshot, a matrix) reports it like any resolution error', async () => {
  try {
    await resolveExplorationRequest(runRequest('prod-like'), { initiator: person('bob', 'runner') });
    assert.fail('should have been refused');
  } catch (error) {
    assert.equal((error as { status?: number }).status, 403);
    assert.equal((error as Error).name, 'TargetProfileForbidden');
  }
});

test('THE LIMIT, on purpose: a run that names no profile is not stopped by a profile\'s list (the origin allowlist and the credential set\'s own list are what protect that)', async () => {
  const resolved = await resolveExplorationRequest(runRequest(), { initiator: person('bob', 'runner') });
  assert.equal(resolved.targetUrl, `${ORIGIN}/`);
});

test('a profile that was never restricted stays open to every runner', async () => {
  await call('PUT', '/v1/targets/open-app', MASTER, profile({ name: 'Open' }));
  const resolved = await resolveExplorationRequest(runRequest('open-app'), { initiator: person('bob', 'runner') });
  assert.equal(resolved.targetUrl, `${ORIGIN}/`);
});

test('the audit log records that the list changed, never the names', async () => {
  let lines: string[] = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    lines = fs.readFileSync(path.join(dataDir, 'audit', 'audit.jsonl'), 'utf8').split('\n').filter((line) => line.includes('/v1/targets/prod-like'));
    if (lines.length >= 6) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const details = lines.map((line) => JSON.parse(line)).filter((entry) => entry.method === 'PUT' && entry.status === 200).map((entry) => entry.detail?.access);
  assert.deepEqual(details, [1, 'unchanged', 0, 'open', 1]);
  assert.ok(!lines.join('\n').includes('allowedUsers'), 'the log never holds the list, only that it changed');
});
