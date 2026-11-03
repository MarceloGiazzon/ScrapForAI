import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const API_KEY = 'test-api-key-1234567890';
const ORIGIN = 'https://dev.example.com';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-targets-test-'));
process.env.SCRAPFORAI_API_KEY = API_KEY;
process.env.SCRAPFORAI_DATA_DIR = dataDir;
// .env may pin ARTIFACT_DIR; dotenv never overrides an existing variable, so this keeps evidence in the temp dir.
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = ORIGIN;
process.env.ALLOWED_RESOURCE_ORIGINS = ORIGIN;

const express = (await import('express')).default;
const { targetsRouter } = await import('../src/routes/targets.routes.js');
const { apiAuth, UI_REQUEST_HEADER } = await import('../src/security/apiAuth.js');
const { createSession, SESSION_COOKIE_NAME } = await import('../src/security/sessionStore.js');
const { resolveExplorationRequest, RequestResolutionError } = await import('../src/runner/resolveRequest.js');
const { explorationRequestSchema } = await import('../src/schemas/explorationRequest.schema.js');
const { getTarget, saveTarget, InvalidTargetProfileIdError } = await import('../src/targets/targetStore.js');

let server: http.Server;
let baseUrl: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(apiAuth);
  app.use('/v1/targets', targetsRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const bearer = { authorization: `Bearer ${API_KEY}` };

async function call(method: string, urlPath: string, headers: Record<string, string>, body?: unknown) {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as Record<string, any>) : undefined };
}

const validProfile = { name: 'App (dev)', environment: 'dev', baseUrl: `${ORIGIN}/app` };

test('PUT stores a profile with defaults, and GET lists/reads it', async () => {
  const put = await call('PUT', '/v1/targets/app-dev', bearer, validProfile);
  assert.equal(put.status, 200);
  assert.equal(put.json?.platform, 'generic');
  assert.deepEqual(put.json?.credentialSets, []);
  assert.deepEqual(put.json?.flags, { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 });

  const one = await call('GET', '/v1/targets/app-dev', bearer);
  assert.equal(one.status, 200);
  assert.equal(one.json?.baseUrl, `${ORIGIN}/app`);

  const list = await call('GET', '/v1/targets', bearer);
  assert.deepEqual(list.json?.targets.map((t: { id: string }) => t.id), ['app-dev']);

  assert.equal((await call('GET', '/v1/targets/missing', bearer)).status, 404);
});

test('a profile whose baseUrl is outside ALLOWED_TARGET_ORIGINS is refused and not written', async () => {
  const put = await call('PUT', '/v1/targets/evil', bearer, { ...validProfile, baseUrl: 'https://evil.example.org/' });
  assert.equal(put.status, 400);
  assert.equal(put.json?.error.type, 'TargetUrlNotAllowed');
  assert.equal(await getTarget('evil'), undefined);

  // Localhost/private/metadata stay blocked too (they go through validateTargetUrl).
  for (const baseUrl of ['http://localhost:3000/', 'http://169.254.169.254/', 'http://10.0.0.5/']) {
    assert.equal((await call('PUT', '/v1/targets/blocked', bearer, { ...validProfile, baseUrl })).status, 400, baseUrl);
  }
});

test('PUT with a UI session and no bearer is 403', async () => {
  const { token } = createSession();
  const session = { cookie: `${SESSION_COOKIE_NAME}=${token}`, [UI_REQUEST_HEADER]: '1' };

  assert.equal((await call('GET', '/v1/targets', session)).status, 200, 'a session may read');
  assert.equal((await call('PUT', '/v1/targets/via-session', session, validProfile)).status, 403);
  assert.equal(await getTarget('via-session'), undefined);
});

test('ids are validated: no path traversal, body id must match the URL', async () => {
  assert.equal((await call('PUT', '/v1/targets/..%2Fescape', bearer, validProfile)).status, 400);
  assert.equal((await call('PUT', '/v1/targets/a', bearer, { ...validProfile, id: 'b' })).status, 400);
  await assert.rejects(() => saveTarget({ ...(validProfile as never), id: '../escape' } as never));
  await assert.rejects(() => getTarget('../escape'), InvalidTargetProfileIdError);
  assert.ok(!fs.existsSync(path.join(dataDir, 'escape.json')));
});

test('unknown fields and bad enums are rejected (strict schema)', async () => {
  assert.equal((await call('PUT', '/v1/targets/x', bearer, { ...validProfile, surprise: 1 })).status, 400);
  assert.equal((await call('PUT', '/v1/targets/x', bearer, { ...validProfile, environment: 'prod' })).status, 400);
});

test('targetProfile supplies the default targetUrl; an explicit targetUrl still wins', async () => {
  const steps = [{ action: 'reload' }];

  const fromProfile = await resolveExplorationRequest(explorationRequestSchema.parse({ targetProfile: 'app-dev', steps }));
  assert.equal(fromProfile.targetUrl, `${ORIGIN}/app`);

  const explicit = await resolveExplorationRequest(
    explorationRequestSchema.parse({ targetProfile: 'app-dev', targetUrl: `${ORIGIN}/other`, steps }),
  );
  assert.equal(explicit.targetUrl, `${ORIGIN}/other`);

  await assert.rejects(
    () => resolveExplorationRequest(explorationRequestSchema.parse({ targetProfile: 'nope', steps })),
    (error: Error) => error instanceof RequestResolutionError && error.name === 'TargetProfileNotFound' && error.status === 404,
  );
});

test('a profile whose origin is later removed from the allowlist cannot be used', async () => {
  // Written while allowed, as if the operator then tightened ALLOWED_TARGET_ORIGINS.
  fs.writeFileSync(
    path.join(dataDir, 'targets', 'stale.json'),
    JSON.stringify({ id: 'stale', name: 'Stale', environment: 'dev', baseUrl: 'https://removed.example.com/' }),
  );

  await assert.rejects(
    () => resolveExplorationRequest(explorationRequestSchema.parse({ targetProfile: 'stale', steps: [{ action: 'reload' }] })),
    (error: Error) => error.name === 'TargetUrlNotAllowed',
  );
});

test('regression: a routine without targetProfile validates and resolves exactly as before', async () => {
  const routine = { targetUrl: `${ORIGIN}/x`, credentials: { loginUser: 'u' }, steps: [{ action: 'reload' }] };
  const parsed = explorationRequestSchema.parse(routine);
  const resolved = await resolveExplorationRequest(parsed);

  assert.equal(resolved.targetUrl, `${ORIGIN}/x`);
  assert.deepEqual(resolved.credentials, { loginUser: 'u' });
  assert.equal(resolved.credentialBinding, undefined, 'inline credentials are never origin-bound');
  assert.equal(explorationRequestSchema.safeParse({ steps: [{ action: 'reload' }] }).success, false, 'still needs a target');
});
