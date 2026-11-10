import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// Who may USE a credential set (T10.1 follow-up): `allowedUsers` on the set, carried to the place every run loads it as an `initiator`.
// No browser here: a refusal happens before one starts, and the allowed paths are checked where the values are loaded.

const MASTER = 'test-api-key-1234567890';
const ORIGIN = 'https://dev.example.com';
const SECRET = 'S3NT1NEL-access-value-77c1';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-credaccess-test-'));
process.env.SCRAPFORAI_API_KEY = MASTER;
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.SCRAPFORAI_VAULT_KEY = crypto.randomBytes(32).toString('base64');
process.env.ALLOWED_TARGET_ORIGINS = ORIGIN;
process.env.ALLOWED_RESOURCE_ORIGINS = ORIGIN;

const express = (await import('express')).default;
const vault = await import('../src/vault/credentials/credentialVault.js');
const users = await import('../src/team/userStore.js');
const { apiAuth } = await import('../src/security/apiAuth.js');
const { credentialsRouter } = await import('../src/routes/credentials.routes.js');
const { explorationRouter } = await import('../src/routes/exploration.routes.js');
const { initiatorOf, mayUseCredentialSet, SYSTEM_INITIATOR } = await import('../src/team/initiator.js');
const { resolveExplorationRequest } = await import('../src/runner/resolveRequest.js');
const { explorationRequestSchema } = await import('../src/schemas/explorationRequest.schema.js');

let server: http.Server;
let base: string;
let aliceKey = '';
let bobKey = '';
let veraKey = '';
let carolKey = '';

before(async () => {
  aliceKey = (await users.createUser({ id: 'alice', name: 'Alice', role: 'runner' }, 'root')).key;
  bobKey = (await users.createUser({ id: 'bob', name: 'Bob', role: 'runner' }, 'root')).key;
  veraKey = (await users.createUser({ id: 'vera', name: 'Vera', role: 'viewer' }, 'root')).key;
  carolKey = (await users.createUser({ id: 'carol', name: 'Carol', role: 'admin' }, 'root')).key;

  const app = express();
  app.use(express.json());
  app.use(apiAuth);
  app.use('/v1/credentials', credentialsRouter);
  app.use('/v1/explorations', explorationRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
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

const person = (userId: string, role: 'viewer' | 'runner' | 'admin') => ({ userId, role });
const request = (credentialSet: string, extra: Record<string, unknown> = {}) =>
  explorationRequestSchema.parse({ targetUrl: `${ORIGIN}/login`, credentialSet, steps: [{ action: 'fill', selector: '#p', valueFromCredential: 'pass' }], ...extra });

// ---- the rule

test('rule: no list = anyone, a list = those named, admins and the system always, an empty list = admins only', () => {
  const alice = person('alice', 'runner');
  const bob = person('bob', 'runner');
  const admin = person('carol', 'admin');

  assert.equal(mayUseCredentialSet(undefined, alice), true, 'a set that was never restricted behaves as before');
  assert.equal(mayUseCredentialSet(undefined, person('anonymous', 'viewer')), true);
  assert.equal(mayUseCredentialSet(['alice'], alice), true);
  assert.equal(mayUseCredentialSet(['alice'], bob), false);
  assert.equal(mayUseCredentialSet(['alice'], admin), true, 'an admin edits the list, so an exclusion would only be a detour');
  assert.equal(mayUseCredentialSet(['alice'], SYSTEM_INITIATOR), true);
  assert.equal(mayUseCredentialSet([], alice), false);
  assert.equal(mayUseCredentialSet([], admin), true);
  assert.equal(mayUseCredentialSet([], SYSTEM_INITIATOR), true);
  assert.equal(mayUseCredentialSet(['alice'], person('alice-2', 'runner')), false, 'whole ids, never a prefix');
});

test('initiatorOf: a person keeps id and role; a request with no principal is the anonymous viewer (fails closed)', () => {
  assert.deepEqual(initiatorOf({ userId: 'alice', role: 'runner', via: 'bearer', master: false, keyId: 'k1' }), { userId: 'alice', role: 'runner' });
  assert.deepEqual(initiatorOf({ userId: 'root', role: 'admin', via: 'bearer', master: true }), { userId: 'root', role: 'admin' });
  assert.deepEqual(initiatorOf(undefined), { userId: 'anonymous', role: 'viewer' });
  assert.equal(mayUseCredentialSet(['alice'], initiatorOf(undefined)), false);
});

// ---- the vault

test('vault: the list is stored with the set; omitted keeps it, null removes it, [] means admins only', async () => {
  const saved = await vault.saveCredentialSet('ops', { boundOrigins: [ORIGIN], values: { user: 'ops', pass: SECRET }, tags: [], allowedUsers: ['alice'] }, 'create');
  assert.equal(saved.restricted, true);
  assert.deepEqual(saved.allowedUsers, ['alice']);

  // A PUT that only fixes an origin or a note, with no `allowedUsers` in it, must not open the set.
  const edited = await vault.saveCredentialSet('ops', { boundOrigins: [ORIGIN], tags: ['a'], notes: 'edited' }, 'upsert');
  assert.equal(edited.restricted, true, 'omitted = keep');
  assert.deepEqual(edited.allowedUsers, ['alice']);

  const adminsOnly = await vault.saveCredentialSet('ops', { boundOrigins: [ORIGIN], tags: [], allowedUsers: [] }, 'upsert');
  assert.equal(adminsOnly.restricted, true, 'an empty list is still a restriction');
  assert.deepEqual(adminsOnly.allowedUsers, []);

  const opened = await vault.saveCredentialSet('ops', { boundOrigins: [ORIGIN], tags: [], allowedUsers: null }, 'upsert');
  assert.equal(opened.restricted, false, 'null removes the restriction');
  assert.equal(opened.allowedUsers, undefined);

  const plain = await vault.saveCredentialSet('open-set', { boundOrigins: [ORIGIN], values: { user: 'u', pass: 'p-open-value' }, tags: [] }, 'create');
  assert.equal(plain.restricted, false, 'a set created without a list is open, as every set was before');
  await vault.deleteCredentialSet('ops');
});

test('vault: resolving as someone not listed is a 403 that does not count as a use and does not name who is allowed', async () => {
  await vault.saveCredentialSet('locked', { boundOrigins: [ORIGIN], values: { user: 'l', pass: SECRET }, tags: [], allowedUsers: ['alice'] }, 'create');

  await assert.rejects(
    () => vault.resolveCredentialSet('locked', person('bob', 'runner')),
    (error: any) => error.status === 403 && error.name === 'CredentialSetForbidden' && !error.message.includes('alice') && !error.message.includes(SECRET),
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await vault.getCredentialSetMeta('locked'))?.lastUsedAt, undefined, 'a refused call is not a use');

  const own = await vault.resolveCredentialSet('locked', person('alice', 'runner'));
  assert.equal(own?.values.pass, SECRET);
  assert.ok(await vault.resolveCredentialSet('locked', person('carol', 'admin')), 'an admin');
  assert.ok(await vault.resolveCredentialSet('locked', SYSTEM_INITIATOR), 'the system (the scheduler, the webhook store)');
  assert.equal(await vault.resolveCredentialSet('missing-set', person('bob', 'runner')), undefined, 'not found stays not found');
});

// ---- where every run loads its sets

test('a run loads its set on the initiator\'s account: the run\'s own set and each actor\'s', async () => {
  await vault.saveCredentialSet('actor-only-alice', { boundOrigins: [ORIGIN], values: { user: 'a2', pass: 'actor-secret-b' }, tags: [], allowedUsers: ['alice'] }, 'create');

  const ok = await resolveExplorationRequest(request('locked'), { initiator: person('alice', 'runner') });
  assert.equal(ok.credentials?.pass, SECRET);

  await assert.rejects(
    () => resolveExplorationRequest(request('locked'), { initiator: person('bob', 'runner') }),
    (error: any) => error.status === 403 && error.name === 'CredentialSetForbidden',
  );

  // An actor's set is checked the same way (a person cannot borrow someone else's account through `actors`).
  const withActor = request('open-set', { actors: { second: { credentialSet: 'actor-only-alice' } }, steps: [{ actor: 'second', action: 'reload' }, { action: 'reload' }] });
  await assert.rejects(
    () => resolveExplorationRequest(withActor, { initiator: person('bob', 'runner') }),
    (error: any) => error.status === 403 && error.name === 'CredentialSetForbidden',
  );
  const allowed = await resolveExplorationRequest(withActor, { initiator: person('alice', 'runner') });
  assert.equal(allowed.actorCredentials?.second?.credentials.pass, 'actor-secret-b');

  assert.ok((await resolveExplorationRequest(request('open-set'), { initiator: person('bob', 'runner') })).credentials, 'an open set is unaffected');
  assert.ok((await resolveExplorationRequest(request('locked'), { initiator: SYSTEM_INITIATOR })).credentials, 'the scheduler');
});

// ---- HTTP

test('http: writing the list is for an admin key; an unknown user is refused; readers learn THAT it is restricted, not who', async () => {
  const create = await call('POST', '/v1/credentials/team-set', MASTER, { boundOrigins: [ORIGIN], values: { user: 'u', pass: 'team-secret-1' }, allowedUsers: ['alice', 'alice'] });
  assert.equal(create.status, 201);
  assert.deepEqual(create.json.allowedUsers, ['alice'], 'repeats collapse; an admin reads the list');
  assert.equal(create.json.restricted, true);

  const typo = await call('PUT', '/v1/credentials/team-set', MASTER, { boundOrigins: [ORIGIN], allowedUsers: ['alic'] });
  assert.equal(typo.status, 400);
  assert.equal(typo.json.error.type, 'UnknownUser');
  assert.match(typo.json.error.message, /alic/);
  assert.deepEqual((await call('GET', '/v1/credentials/team-set', MASTER)).json.allowedUsers, ['alice'], 'the refused write changed nothing');

  assert.equal((await call('PUT', '/v1/credentials/team-set', bobKey, { boundOrigins: [ORIGIN], allowedUsers: ['bob'] })).status, 403, 'a runner cannot add themselves');
  assert.deepEqual((await call('GET', '/v1/credentials/team-set', MASTER)).json.allowedUsers, ['alice']);

  for (const key of [aliceKey, bobKey, veraKey]) {
    const read = await call('GET', '/v1/credentials/team-set', key);
    assert.equal(read.status, 200);
    assert.equal(read.json.restricted, true);
    assert.ok(!('allowedUsers' in read.json), 'the list of people is for admins');
    const list = await call('GET', '/v1/credentials', key);
    const row = list.json.credentialSets.find((set: any) => set.id === 'team-set');
    assert.equal(row.restricted, true);
    assert.ok(!('allowedUsers' in row));
    assert.ok(!list.text.includes('team-secret-1'), 'no value, ever');
  }
  assert.deepEqual((await call('GET', '/v1/credentials/team-set', carolKey)).json.allowedUsers, ['alice'], 'a personal admin key reads the list too');

  // The edit that does not mention the list keeps it.
  assert.equal((await call('PUT', '/v1/credentials/team-set', MASTER, { boundOrigins: [ORIGIN], tags: ['x'] })).json.restricted, true);
  const opened = await call('PUT', '/v1/credentials/team-set', MASTER, { boundOrigins: [ORIGIN], allowedUsers: null });
  assert.equal(opened.json.restricted, false);
  await call('PUT', '/v1/credentials/team-set', MASTER, { boundOrigins: [ORIGIN], allowedUsers: ['alice'] });

  // The audit log says that who may use the set changed, and how many people are on the list: never the names, never a value.
  const { readAudit } = await import('../src/team/audit.js');
  const entries = (await readAudit({ limit: 1000 })).entries.filter((entry) => entry.path === '/v1/credentials/team-set' && entry.method !== 'GET');
  assert.equal(entries.find((entry) => entry.method === 'POST')?.detail?.access, 1, 'created with one person (the repeat collapsed)');
  assert.ok(entries.some((entry) => entry.detail?.access === 'unchanged'), 'an edit that left the list out');
  assert.ok(entries.some((entry) => entry.detail?.access === 'open'), 'the restriction removed');
  const logged = JSON.stringify(entries);
  assert.ok(!logged.includes('team-secret-1') && !logged.includes('alice'), 'no value and no name in the audit log');
});

test('http: a run with a restricted set is refused with 403 before any browser starts, for everyone but the people on the list', async () => {
  const run = (key: string) =>
    call('POST', '/v1/explorations/run', key, { targetUrl: `${ORIGIN}/login`, credentialSet: 'team-set', steps: [{ action: 'fill', selector: '#p', valueFromCredential: 'pass' }] });

  const bob = await run(bobKey);
  assert.equal(bob.status, 403);
  assert.equal(bob.json.error.type, 'CredentialSetForbidden');
  assert.ok(!bob.text.includes('team-secret-1'));
  assert.ok(!bob.text.includes('alice'), 'the refusal does not say who may');

  // Not run for alice here: she would pass this check and start a real browser, which is what the smoke tests are for.
  const resolved = await resolveExplorationRequest(request('team-set'), { initiator: person('alice', 'runner') });
  assert.equal(resolved.credentials?.pass, 'team-secret-1');
});
