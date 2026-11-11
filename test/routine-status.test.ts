import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// Changing a routine's status (quarantine, release, retire...) from the Health screen: POST /v1/routines/:id/status. The same content under
// another status, as the next immutable version, by a runner or an admin; the content is not judged again; the reason is linted and audited.

const MASTER = 'test-api-key-1234567890';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-routine-status-test-'));
process.env.SCRAPFORAI_API_KEY = MASTER;
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.SCRAPFORAI_VAULT_KEY = crypto.randomBytes(32).toString('base64');
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';
process.env.SCHEDULER_ENABLED = 'false';

const express = (await import('express')).default;
const users = await import('../src/team/userStore.js');
const { apiAuth } = await import('../src/security/apiAuth.js');
const { routinesRouter } = await import('../src/routes/routines.routes.js');
const { saveTarget } = await import('../src/targets/targetStore.js');
const { saveRoutine } = await import('../src/library/routineService.js');
const { getRoutine, listVersions, saveRoutineVersion } = await import('../src/library/routineLibrary.js');
const { requiredRole } = await import('../src/team/roles.js');
const vault = await import('../src/vault/credentials/credentialVault.js');

let server: http.Server;
let base: string;
let aliceKey = '';
let veraKey = '';

const profile = (id: string) => ({
  id, name: id, platform: 'generic' as const, environment: 'dev' as const, baseUrl: 'https://dev.example.com', credentialSets: [],
  noiseFilters: [], surfaces: {}, screens: [], flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
});
const steps = [{ id: 'open', action: 'goto', url: '$targetUrl' }] as never;

before(async () => {
  aliceKey = (await users.createUser({ id: 'alice', name: 'Alice', role: 'runner' }, 'root')).key;
  veraKey = (await users.createUser({ id: 'vera', name: 'Vera', role: 'viewer' }, 'root')).key;
  await saveTarget(profile('app-dev'));
  await saveRoutine('flaky-cart', {
    title: 'cart', targetProfile: 'app-dev', steps, tags: ['smoke'], surface: 'cart', description: 'adds an item',
    teardown: [{ id: 'bye', action: 'goto', url: '$targetUrl' }] as never,
    parameters: [{ name: 'qty', cases: ['1', '2'] }] as never,
  });

  const app = express();
  app.use(express.json());
  app.use(apiAuth);
  app.use('/v1/routines', routinesRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise((resolve) => setTimeout(resolve, 250)); // the last request's audit line is written after the answer
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const post = async (id: string, key: string, body: unknown) => {
  const response = await fetch(`${base}/v1/routines/${id}/status`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, json: text ? (JSON.parse(text) as any) : undefined };
};

test('policy: the route is a runner\'s (no new power: PUT /v1/routines/:id already is)', () => {
  assert.equal(requiredRole('POST', '/v1/routines/flaky-cart/status'), 'runner');
  assert.equal(requiredRole('PUT', '/v1/routines/flaky-cart'), 'runner');
});

test('a viewer is refused; a runner quarantines: the same content as the next version, by that person, the old one untouched', async () => {
  const before = (await getRoutine('flaky-cart'))!;
  assert.equal(before.status, 'active');

  const viewer = await post('flaky-cart', veraKey, { status: 'quarantined', reason: 'fails every other run' });
  assert.equal(viewer.status, 403);
  assert.equal((await listVersions('flaky-cart')).length, 1, 'nothing stored by a refused call');

  const done = await post('flaky-cart', aliceKey, { status: 'quarantined', reason: 'flaky score 0.31, build r104' });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.changed, true);
  assert.equal(done.json.previousStatus, 'active');
  assert.equal(done.json.previousVersion, 1);
  assert.equal(done.json.routine.version, 2);
  assert.equal(done.json.routine.status, 'quarantined');
  assert.equal(done.json.includedBy, undefined);

  const after = (await getRoutine('flaky-cart'))!;
  const { version: _v, sha256: _s, createdAt: _c, createdBy, status, ...contentAfter } = after;
  const { version: _v0, sha256: _s0, createdAt: _c0, createdBy: _by0, status: _status0, ...contentBefore } = before;
  assert.deepEqual(contentAfter, contentBefore, 'steps, teardown, parameters, tags... are exactly the same');
  assert.equal(status, 'quarantined');
  assert.equal(createdBy, 'alice');
  assert.notEqual(after.sha256, before.sha256);
  assert.equal((await getRoutine('flaky-cart', 1))!.status, 'active', 'version 1 is immutable');
});

test('the same status again changes nothing and stores nothing; release goes back to active as yet another version', async () => {
  const again = await post('flaky-cart', aliceKey, { status: 'quarantined', reason: 'still flaky, checking again' });
  assert.equal(again.status, 200);
  assert.equal(again.json.changed, false);
  assert.equal(again.json.routine.version, 2);
  assert.equal((await listVersions('flaky-cart')).length, 2);

  const released = await post('flaky-cart', aliceKey, { status: 'active', reason: 'stable for 10 runs' });
  assert.equal(released.json.routine.version, 3);
  assert.equal((await getRoutine('flaky-cart'))!.status, 'active');
});

test('the content is not judged again: a routine that no longer passes the save rules can still be quarantined', async () => {
  // Written straight to the library, as an older version of the rules would have let it in; saving it today is refused.
  const content = { title: 'old', targetProfile: 'app-dev', status: 'active' as const, tags: [], steps: [{ id: 'type', action: 'fill', selector: '#k', value: 'sk-abcdefghijklmnopqrstuvwxyz0123' }] as never };
  await saveRoutineVersion('old-secret', content as never);
  await assert.rejects(saveRoutine('old-secret', { title: 'old', targetProfile: 'app-dev', steps: content.steps }), /secret/i);

  const done = await post('old-secret', aliceKey, { status: 'quarantined', reason: 'has a literal key, fix first' });
  assert.equal(done.status, 200, done.text);
  assert.equal((await getRoutine('old-secret'))!.status, 'quarantined');
});

test('the reason is checked like a step value (a secret is refused, nothing stored) and must be a short sentence', async () => {
  await vault.saveCredentialSet('team-login', { boundOrigins: ['https://dev.example.com'], values: { user: 'ops', pass: 'Zx-vault-pass-9911' }, tags: [] }, 'create');
  const versions = (await listVersions('flaky-cart')).length;

  const shape = await post('flaky-cart', aliceKey, { status: 'retired', reason: 'see sk-abcdefghijklmnopqrstuvwxyz0123 for details' });
  assert.equal(shape.status, 422);
  assert.equal(shape.json.error.type, 'RoutineLintError');
  assert.ok(!shape.text.includes('sk-abcdefghijklmnopqrstuvwxyz0123'), 'the answer never echoes the text');

  const vaulted = await post('flaky-cart', aliceKey, { status: 'retired', reason: 'password is Zx-vault-pass-9911' });
  assert.equal(vaulted.status, 422);
  assert.ok(!vaulted.text.includes('Zx-vault-pass-9911'));
  assert.equal((await listVersions('flaky-cart')).length, versions);

  assert.equal((await post('flaky-cart', aliceKey, { status: 'retired', reason: 'x' })).status, 400, 'too short');
  assert.equal((await post('flaky-cart', aliceKey, { status: 'retired' })).status, 400, 'a reason is required');
  assert.equal((await post('flaky-cart', aliceKey, { status: 'deleted', reason: 'nope nope' })).status, 400, 'not a status');
  assert.equal((await post('flaky-cart', aliceKey, { status: 'retired', reason: 'ok ok ok', extra: 1 })).status, 400, 'strict');
  assert.equal((await post('no-such-routine', aliceKey, { status: 'retired', reason: 'does not exist' })).status, 404);
});

test('retiring a routine that others include says which ones will stop saving and running', async () => {
  await saveRoutine('login', { title: 'login', targetProfile: 'app-dev', steps });
  await saveRoutine('uses-login', { title: 'uses login', targetProfile: 'app-dev', steps: [{ id: 'in', action: 'include', routineId: 'login' }] as never });
  await saveRoutine('alone', { title: 'alone', targetProfile: 'app-dev', steps });

  const retired = await post('login', aliceKey, { status: 'retired', reason: 'replaced by sso-login' });
  assert.equal(retired.status, 200);
  assert.deepEqual(retired.json.includedBy, [{ id: 'uses-login', version: 1 }]);

  const quiet = await post('alone', aliceKey, { status: 'retired', reason: 'nobody uses it' });
  assert.equal(quiet.json.includedBy, undefined);
  const park = await post('login', aliceKey, { status: 'draft', reason: 'park it while sso is checked' });
  assert.equal(park.json.includedBy, undefined, 'only retiring warns');
});

test('the audit log has the person, the transition and the reason', async () => {
  let lines: string[] = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    lines = fs.readFileSync(path.join(dataDir, 'audit', 'audit.jsonl'), 'utf8').split('\n').filter((line) => line.includes('/v1/routines/flaky-cart/status'));
    if (lines.some((line) => line.includes('flaky score 0.31'))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const entry = lines.map((line) => JSON.parse(line)).find((item) => item.detail?.reason === 'flaky score 0.31, build r104');
  assert.ok(entry, 'the quarantine is in the audit log');
  assert.equal(entry.actor.userId, 'alice');
  assert.equal(entry.status, 200);
  assert.equal(entry.detail.routine, 'flaky-cart');
  assert.equal(entry.detail.from, 'active');
  assert.equal(entry.detail.to, 'quarantined');
  assert.ok(!lines.join('\n').includes('sk-abcdefghijklmnopqrstuvwxyz0123'), 'a refused reason never reaches the log');
});
