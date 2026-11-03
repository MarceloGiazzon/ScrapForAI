import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const API_KEY = 'test-api-key-1234567890';
const ORIGIN = 'https://dev.example.com';
const SECRET = 'Tr0ub4dor&3-vault-secret';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-library-test-'));
process.env.SCRAPFORAI_API_KEY = API_KEY;
process.env.SCRAPFORAI_DATA_DIR = dataDir;
// .env may pin ARTIFACT_DIR; dotenv never overrides an existing variable, so this keeps evidence in the temp dir.
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.SCRAPFORAI_VAULT_KEY = crypto.randomBytes(32).toString('base64');
process.env.ALLOWED_TARGET_ORIGINS = ORIGIN;
process.env.ALLOWED_RESOURCE_ORIGINS = ORIGIN;
delete process.env.ROUTINE_LIBRARY_DIR;

const express = (await import('express')).default;
const { apiAuth } = await import('../src/security/apiAuth.js');
const { routinesRouter } = await import('../src/routes/routines.routes.js');
const { saveTarget } = await import('../src/targets/targetStore.js');
const { saveCredentialSet } = await import('../src/vault/credentials/credentialVault.js');
const { mcpSaveRoutineSchema } = await import('../src/schemas/libraryRoutine.schema.js');
const { env } = await import('../src/config/env.js');

let server: http.Server;
let baseUrl: string;

before(async () => {
  await saveTarget({
    id: 'app-dev',
    name: 'App',
    platform: 'generic',
    environment: 'dev',
    baseUrl: ORIGIN,
    credentialSets: [],
    noiseFilters: [],
    surfaces: {},
    screens: [],
    flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  });
  await saveCredentialSet('gam', { boundOrigins: [ORIGIN], values: { loginPassword: SECRET }, tags: [] }, 'create');

  const app = express();
  app.use(express.json());
  app.use(apiAuth);
  app.use('/v1/routines', routinesRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method: string, urlPath: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, json: text ? (JSON.parse(text) as Record<string, any>) : undefined };
}

const base = { title: 'Open home', targetProfile: 'app-dev', steps: [{ id: 'open', action: 'goto', url: '$targetUrl' }] };

test('saving the same content twice does not create a new version', async () => {
  const first = await call('PUT', '/v1/routines/home', base);
  assert.equal(first.status, 201);
  assert.equal(first.json?.routine.version, 1);
  assert.equal(first.json?.routine.sha256.length, 64);

  const again = await call('PUT', '/v1/routines/home', base);
  assert.equal(again.status, 200);
  assert.equal(again.json?.created, false);
  assert.equal(again.json?.routine.version, 1);
  assert.equal(again.json?.routine.sha256, first.json?.routine.sha256);

  // Key order and omitted-vs-default fields must not change the digest.
  const reordered = await call('PUT', '/v1/routines/home', { steps: base.steps, targetProfile: 'app-dev', title: 'Open home', tags: [] , status: 'active' });
  assert.equal(reordered.json?.created, false);

  assert.deepEqual((await call('GET', '/v1/routines/home')).json?.versions, [1]);
});

test('changed content becomes v2; v1 stays retrievable and unchanged', async () => {
  const v2 = await call('PUT', '/v1/routines/home', { ...base, steps: [...base.steps, { id: 'wait', action: 'waitForLoadState', state: 'load' }] });
  assert.equal(v2.status, 201);
  assert.equal(v2.json?.routine.version, 2);

  const current = await call('GET', '/v1/routines/home');
  assert.equal(current.json?.routine.version, 2);
  assert.equal(current.json?.routine.steps.length, 2);

  const pinned = await call('GET', '/v1/routines/home?version=1');
  assert.equal(pinned.json?.routine.version, 1);
  assert.equal(pinned.json?.routine.steps.length, 1);
  assert.deepEqual(pinned.json?.versions, [1, 2]);

  assert.equal((await call('GET', '/v1/routines/home?version=9')).status, 404);
  assert.equal((await call('GET', '/v1/routines/home?version=abc')).status, 400);
  assert.equal((await call('GET', '/v1/routines/nope')).status, 404);

  const list = await call('GET', '/v1/routines');
  assert.deepEqual(list.json?.routines.map((r: { id: string; version: number }) => [r.id, r.version]), [['home', 2]]);
});

test('a status change is a new, auditable version', async () => {
  const quarantined = await call('PUT', '/v1/routines/home', { ...base, steps: [...base.steps, { id: 'wait', action: 'waitForLoadState', state: 'load' }], status: 'quarantined' });
  assert.equal(quarantined.json?.routine.version, 3);
  assert.equal((await call('GET', '/v1/routines')).json?.routines[0].status, 'quarantined');
});

test('lint refuses a literal that equals a vault value, without echoing it', async () => {
  const leaky = await call('PUT', '/v1/routines/leaky', {
    ...base,
    steps: [{ id: 'pw', action: 'fill', selector: '#p', value: SECRET }],
  });
  assert.equal(leaky.status, 422);
  assert.equal(leaky.json?.error.type, 'RoutineLintError');
  assert.equal(leaky.json?.error.details[0].path, 'steps.0.value');
  assert.ok(!leaky.text.includes(SECRET));
  assert.equal((await call('GET', '/v1/routines/leaky')).status, 404, 'nothing was stored');

  const embedded = await call('PUT', '/v1/routines/leaky', {
    ...base,
    steps: [{ id: 'js', action: 'fill', selector: '#p', value: `prefix-${SECRET}-suffix` }],
  });
  assert.equal(embedded.status, 422, 'a vault value inside a longer literal is refused too');
});

test('lint refuses well-known secret shapes', async () => {
  const samples = [
    `sk-${'a1B2c3D4'.repeat(4)}`,
    `ghp_${'a1B2c3D4e5'.repeat(4)}`,
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    'AKIAIOSFODNN7EXAMPLE',
  ];

  for (const value of samples) {
    const response = await call('PUT', '/v1/routines/shapes', { ...base, steps: [{ id: 'x', action: 'fill', selector: '#t', value }] });
    assert.equal(response.status, 422, value.slice(0, 6));
    assert.ok(!response.text.includes(value));
  }

  const innocent = await call('PUT', '/v1/routines/shapes', { ...base, steps: [{ id: 'x', action: 'fill', selector: '#t', value: 'Cliente de prueba 123' }] });
  assert.equal(innocent.status, 201, 'ordinary text still saves');
});

test('validation: unknown target profile, unrunnable steps, bad id, unknown fields', async () => {
  assert.equal((await call('PUT', '/v1/routines/x', { ...base, targetProfile: 'nope' })).json?.error.type, 'TargetProfileNotFound');

  const duplicate = await call('PUT', '/v1/routines/x', { ...base, steps: [base.steps[0], base.steps[0]] });
  assert.equal(duplicate.status, 400, 'duplicate step ids cannot run, so they cannot be saved');

  assert.equal((await call('PUT', '/v1/routines/..%2Fescape', base)).status, 400);
  assert.equal((await call('PUT', '/v1/routines/x', { ...base, surprise: 1 })).status, 400);
  assert.equal((await call('PUT', '/v1/routines/x', { steps: base.steps })).status, 400, 'title and targetProfile are required');
  assert.equal((await call('PUT', '/v1/routines/x', { ...base, fromJobId: 'job_abc' })).status, 400, 'steps and fromJobId are exclusive');
  assert.ok(!fs.existsSync(path.join(dataDir, 'escape')));
});

test('a version file edited by hand fails its integrity check', async () => {
  await call('PUT', '/v1/routines/tamper', base);
  const file = path.join(dataDir, 'library', 'tamper', 'v1.json');
  const edited = JSON.parse(fs.readFileSync(file, 'utf8')) as { steps: Array<{ url: string }> };
  edited.steps[0]!.url = 'https://dev.example.com/elsewhere';
  fs.writeFileSync(file, JSON.stringify(edited));

  const response = await call('GET', '/v1/routines/tamper');
  assert.equal(response.status, 500);
  assert.equal(response.json?.error.type, 'RoutineIntegrityError');
});

function writeJob(jobId: string, files: { request?: unknown; result?: unknown }): void {
  const dir = path.join(env.ARTIFACT_DIR, jobId);
  fs.mkdirSync(dir, { recursive: true });
  if (files.request !== undefined) fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify(files.request));
  if (files.result !== undefined) fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(files.result));
}

test('fromJobId saves the steps of a run that passed', async () => {
  writeJob('job_goodrun', {
    request: { scenarioName: 'From a run', targetUrl: `${ORIGIN}/`, targetProfile: 'app-dev', credentialSet: 'gam', options: { headless: true, trace: false, screenshots: 'onFailure', collectDomOnFailure: false }, steps: base.steps },
    result: { status: 'passed' },
  });

  const saved = await call('PUT', '/v1/routines/fromjob', { fromJobId: 'job_goodrun' });
  assert.equal(saved.status, 201, saved.text);
  assert.equal(saved.json?.routine.title, 'From a run');
  assert.equal(saved.json?.routine.credentialSet, 'gam');
  assert.deepEqual(saved.json?.routine.steps, base.steps);

  const overridden = await call('PUT', '/v1/routines/fromjob2', { fromJobId: 'job_goodrun', title: 'Renamed', tags: ['smoke'] });
  assert.equal(overridden.json?.routine.title, 'Renamed');
  assert.deepEqual(overridden.json?.routine.tags, ['smoke']);
});

test('fromJobId: failed runs, expired evidence and redacted literals are refused', async () => {
  writeJob('job_badrun', { request: { targetProfile: 'app-dev', steps: base.steps, scenarioName: 's' }, result: { status: 'failed' } });
  assert.equal((await call('PUT', '/v1/routines/r1', { fromJobId: 'job_badrun' })).status, 409);

  assert.equal((await call('PUT', '/v1/routines/r2', { fromJobId: 'job_gone' })).json?.error.type, 'JobRequestUnavailable');

  writeJob('job_redacted', {
    request: { targetProfile: 'app-dev', scenarioName: 's', steps: [{ id: 'pw', action: 'fill', selector: '#p', value: '[REDACTED]' }] },
    result: { status: 'passed' },
  });
  assert.equal((await call('PUT', '/v1/routines/r3', { fromJobId: 'job_redacted' })).json?.error.type, 'RoutineContainsRedactedValues');

  assert.equal((await call('PUT', '/v1/routines/r4', { fromJobId: '../../etc' })).status, 400, 'job ids are validated');
});

test('the MCP save_routine schema carries the id and the same either/or rule', () => {
  assert.equal(mcpSaveRoutineSchema.safeParse({ id: 'x', ...base }).success, true);
  assert.equal(mcpSaveRoutineSchema.safeParse({ id: 'x', fromJobId: 'job_abc123' }).success, true);
  assert.equal(mcpSaveRoutineSchema.safeParse({ id: 'x' }).success, false);
  assert.equal(mcpSaveRoutineSchema.safeParse({ id: 'x', ...base, credentials: { a: 'b' } }).success, false, 'no inline credentials on this path either');
});
