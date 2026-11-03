import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const API_KEY = 'test-api-key-1234567890';
const SENTINEL = 'S3NT1NEL-vault-value-9f3a';
const ORIGIN = 'https://dev.example.com';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-vault-test-'));
process.env.SCRAPFORAI_API_KEY = API_KEY;
process.env.SCRAPFORAI_DATA_DIR = dataDir;
// .env may pin ARTIFACT_DIR; dotenv never overrides an existing variable, so this keeps evidence in the temp dir.
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.SCRAPFORAI_VAULT_KEY = crypto.randomBytes(32).toString('base64');
process.env.ALLOWED_TARGET_ORIGINS = ORIGIN;
process.env.ALLOWED_RESOURCE_ORIGINS = ORIGIN;

const express = (await import('express')).default;
const vault = await import('../src/vault/credentials/credentialVault.js');
const { credentialsRouter } = await import('../src/routes/credentials.routes.js');
const { apiAuth, UI_REQUEST_HEADER } = await import('../src/security/apiAuth.js');
const { createSession, SESSION_COOKIE_NAME } = await import('../src/security/sessionStore.js');
const { resolveExplorationRequest, RequestResolutionError } = await import('../src/runner/resolveRequest.js');
const { assertCredentialOrigin, CredentialOriginMismatchError } = await import('../src/security/credentialBinding.js');
const { saveTarget } = await import('../src/targets/targetStore.js');
const { explorationRequestSchema, mcpExplorationRequestSchema } = await import('../src/schemas/explorationRequest.schema.js');
const { credentialVaultFile } = await import('../src/config/paths.js');
const { z } = await import('zod');

let server: http.Server;
let baseUrl: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(apiAuth);
  app.use('/v1/credentials', credentialsRouter);
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
  return { status: response.status, text, json: text ? (JSON.parse(text) as Record<string, unknown>) : undefined };
}

test('vault file is encrypted at rest and contains no plaintext', async () => {
  await vault.saveCredentialSet('gam-admin', { boundOrigins: [ORIGIN], values: { loginUser: 'admin', loginPassword: SENTINEL }, tags: ['role:admin'] }, 'create');

  const onDisk = fs.readFileSync(credentialVaultFile(), 'utf8');
  assert.ok(!onDisk.includes(SENTINEL), 'secret value must not appear in the file');
  assert.ok(!onDisk.includes('gam-admin'), 'set ids are inside the ciphertext too');
  assert.ok(!onDisk.includes('loginPassword'), 'field names are inside the ciphertext too');
});

test('resolveCredentialSet returns the values (runner-only path)', async () => {
  const set = await vault.resolveCredentialSet('gam-admin');
  assert.equal(set?.values.loginPassword, SENTINEL);
  assert.deepEqual(set?.boundOrigins, [ORIGIN]);
});

test('a tampered vault file fails closed with VaultDecryptFailed', async () => {
  const file = credentialVaultFile();
  const original = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(original) as { data: string };
  const bytes = Buffer.from(parsed.data, 'base64');
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  fs.writeFileSync(file, JSON.stringify({ ...parsed, data: bytes.toString('base64') }));

  try {
    await assert.rejects(() => vault.listCredentialSets(), (error: Error) => error.name === 'VaultDecryptFailed');
  } finally {
    fs.writeFileSync(file, original);
  }
});

test('the wrong key fails closed with VaultDecryptFailed', async () => {
  const realKey = process.env.SCRAPFORAI_VAULT_KEY;
  process.env.SCRAPFORAI_VAULT_KEY = crypto.randomBytes(32).toString('base64');
  try {
    await assert.rejects(() => vault.listCredentialSets(), (error: Error) => error.name === 'VaultDecryptFailed');
  } finally {
    process.env.SCRAPFORAI_VAULT_KEY = realKey;
  }
});

test('without SCRAPFORAI_VAULT_KEY a key file is generated and reused', async () => {
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-vault-keyfile-'));
  const realDir = process.env.SCRAPFORAI_DATA_DIR;
  const realKey = process.env.SCRAPFORAI_VAULT_KEY;
  process.env.SCRAPFORAI_DATA_DIR = otherDir;
  delete process.env.SCRAPFORAI_VAULT_KEY;

  try {
    await vault.saveCredentialSet('k', { boundOrigins: [ORIGIN], values: { loginUser: 'u' }, tags: [] }, 'create');
    const keyFile = path.join(otherDir, 'vault.key');
    assert.equal(Buffer.from(fs.readFileSync(keyFile, 'utf8'), 'base64').length, 32);
    assert.equal((await vault.resolveCredentialSet('k'))?.values.loginUser, 'u');
  } finally {
    process.env.SCRAPFORAI_DATA_DIR = realDir;
    process.env.SCRAPFORAI_VAULT_KEY = realKey;
    fs.rmSync(otherDir, { recursive: true, force: true });
  }
});

test('create conflicts on an existing id; upsert without values keeps the stored values', async () => {
  await assert.rejects(
    () => vault.saveCredentialSet('gam-admin', { boundOrigins: [ORIGIN], values: { loginUser: 'x' }, tags: [] }, 'create'),
    (error: Error & { status?: number }) => error.status === 409,
  );

  await vault.saveCredentialSet('gam-admin', { boundOrigins: [ORIGIN], tags: ['role:admin', 'edited'] }, 'upsert');
  assert.equal((await vault.resolveCredentialSet('gam-admin'))?.values.loginPassword, SENTINEL);

  await assert.rejects(
    () => vault.saveCredentialSet('brand-new', { boundOrigins: [ORIGIN], tags: [] }, 'upsert'),
    (error: Error & { status?: number }) => error.status === 400,
  );
});

test('GET /v1/credentials never returns a value', async () => {
  const list = await call('GET', '/v1/credentials', bearer);
  const one = await call('GET', '/v1/credentials/gam-admin', bearer);

  assert.equal(list.status, 200);
  assert.equal(one.status, 200);
  assert.ok(!list.text.includes(SENTINEL) && !one.text.includes(SENTINEL));
  assert.deepEqual(one.json?.fields, ['loginPassword', 'loginUser']);
  assert.equal(one.json?.values, undefined);
});

test('writes need the bearer token: a UI session alone gets 403', async () => {
  const { token } = createSession();
  const session = { cookie: `${SESSION_COOKIE_NAME}=${token}`, [UI_REQUEST_HEADER]: '1' };
  const body = { boundOrigins: [ORIGIN], values: { loginPassword: SENTINEL } };

  assert.equal((await call('GET', '/v1/credentials', session)).status, 200, 'a session may read metadata');
  assert.equal((await call('POST', '/v1/credentials/viaSession', session, body)).status, 403);
  assert.equal((await call('PUT', '/v1/credentials/viaSession', session, body)).status, 403);
  assert.equal((await call('DELETE', '/v1/credentials/gam-admin', session)).status, 403);
  assert.equal((await call('GET', '/v1/credentials/viaSession', bearer)).status, 404, 'nothing was created');
});

test('POST/PUT/DELETE with the bearer token work and never echo values, even in errors', async () => {
  const created = await call('POST', '/v1/credentials/api-made', bearer, { boundOrigins: [`${ORIGIN}/some/path`], values: { loginPassword: SENTINEL } });
  assert.equal(created.status, 201);
  assert.ok(!created.text.includes(SENTINEL));
  assert.deepEqual(created.json?.boundOrigins, [ORIGIN], 'bound origins are normalized to origins');

  const duplicate = await call('POST', '/v1/credentials/api-made', bearer, { boundOrigins: [ORIGIN], values: { loginPassword: SENTINEL } });
  assert.equal(duplicate.status, 409);
  assert.ok(!duplicate.text.includes(SENTINEL));

  const invalid = await call('POST', '/v1/credentials/bad-one', bearer, { boundOrigins: ['not a url'], values: { loginPassword: SENTINEL }, extra: SENTINEL });
  assert.equal(invalid.status, 400);
  assert.ok(!invalid.text.includes(SENTINEL), 'validation errors must not echo submitted values');

  assert.equal((await call('DELETE', '/v1/credentials/api-made', bearer)).status, 204);
  assert.equal((await call('DELETE', '/v1/credentials/api-made', bearer)).status, 404);
});

test('credentialSet is loaded server-side; vault values win over inline ones; fields are bound', async () => {
  const resolved = await resolveExplorationRequest(
    explorationRequestSchema.parse({
      targetUrl: `${ORIGIN}/login`,
      credentialSet: 'gam-admin',
      credentials: { loginPassword: 'inline-attempt', extra: 'kept' },
      steps: [{ action: 'fill', selector: '#p', valueFromCredential: 'loginPassword' }],
    }),
  );

  assert.equal(resolved.credentials?.loginPassword, SENTINEL, 'an inline value must not shadow a vaulted one');
  assert.equal(resolved.credentials?.extra, 'kept');
  assert.deepEqual(resolved.credentialBinding?.fields.sort(), ['loginPassword', 'loginUser']);
  assert.deepEqual(resolved.credentialBinding?.boundOrigins, [ORIGIN]);
});

test('an unknown credential set is CredentialSetNotFound', async () => {
  await assert.rejects(
    () => resolveExplorationRequest(explorationRequestSchema.parse({ targetUrl: `${ORIGIN}/`, credentialSet: 'nope', steps: [{ action: 'reload' }] })),
    (error: Error) => error instanceof RequestResolutionError && error.name === 'CredentialSetNotFound',
  );
});

test('a target profile restricts which credential sets may be used', async () => {
  await saveTarget({
    id: 'restricted',
    name: 'Restricted',
    platform: 'generic',
    environment: 'dev',
    baseUrl: ORIGIN,
    credentialSets: ['someone-else'],
    noiseFilters: [],
    surfaces: {},
    screens: [],
    flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  });

  await assert.rejects(
    () => resolveExplorationRequest(explorationRequestSchema.parse({ targetProfile: 'restricted', credentialSet: 'gam-admin', steps: [{ action: 'reload' }] })),
    (error: Error) => error instanceof RequestResolutionError && error.name === 'CredentialSetNotAllowed',
  );
});

test('assertCredentialOrigin: bound origin passes; any other origin or about:blank is refused', () => {
  const binding = { setId: 'gam-admin', boundOrigins: [ORIGIN], fields: ['loginPassword'] };

  assert.doesNotThrow(() => assertCredentialOrigin(binding, 'loginPassword', `${ORIGIN}/servlet/login`));
  assert.throws(() => assertCredentialOrigin(binding, 'loginPassword', 'https://qa.example.com/login'), CredentialOriginMismatchError);
  assert.throws(() => assertCredentialOrigin(binding, 'loginPassword', 'about:blank'), CredentialOriginMismatchError);
  assert.doesNotThrow(() => assertCredentialOrigin(binding, 'inlineOnlyField', 'https://qa.example.com/'), 'non-vault fields are not bound');
  assert.doesNotThrow(() => assertCredentialOrigin(undefined, 'loginPassword', 'https://qa.example.com/'), 'no vault set, no binding');

  try {
    assertCredentialOrigin(binding, 'loginPassword', 'https://qa.example.com/login');
  } catch (error) {
    assert.equal((error as Error).name, 'CredentialOriginMismatch');
    assert.ok(!(error as Error).message.includes(SENTINEL));
  }
});

test('the MCP request schema exposes no `credentials`, but keeps every other validation', () => {
  const routine = { targetUrl: `${ORIGIN}/`, steps: [{ action: 'reload' }] };

  assert.equal(mcpExplorationRequestSchema.safeParse(routine).success, true);
  assert.equal(mcpExplorationRequestSchema.safeParse({ ...routine, credentialSet: 'gam-admin' }).success, true);
  assert.equal(mcpExplorationRequestSchema.safeParse({ ...routine, credentials: { loginPassword: 'x' } }).success, false, 'inline credentials are rejected');
  assert.equal(explorationRequestSchema.safeParse({ ...routine, credentials: { loginPassword: 'x' } }).success, true, 'REST keeps accepting them');

  const duplicateIds = { targetUrl: `${ORIGIN}/`, steps: [{ id: 'a', action: 'reload' }, { id: 'a', action: 'reload' }] };
  assert.equal(mcpExplorationRequestSchema.safeParse(duplicateIds).success, false, 'superRefine validations survive the derivation');
  assert.equal(mcpExplorationRequestSchema.safeParse({ steps: [{ action: 'reload' }] }).success, false, 'targetUrl or targetProfile is still required');

  const jsonSchema = z.toJSONSchema(mcpExplorationRequestSchema, { target: 'draft-2020-12', io: 'input' }) as { properties: Record<string, unknown> };
  assert.equal('credentials' in jsonSchema.properties, false);
  assert.equal('credentialSet' in jsonSchema.properties, true);
});
