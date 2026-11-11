import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// The MCP server acts as ONE person when SCRAPFORAI_MCP_API_KEY holds a personal key, so what the team restricts holds for an agent too
// (a viewer cannot run, a credential set's or a target profile's `allowedUsers` apply). Without the variable it is the installation key, as before.

const MASTER = 'test-api-key-1234567890';
const ORIGIN = 'https://dev.example.com';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-mcpid-test-'));
process.env.SCRAPFORAI_API_KEY = MASTER;
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.SCRAPFORAI_VAULT_KEY = crypto.randomBytes(32).toString('base64');
process.env.ALLOWED_TARGET_ORIGINS = ORIGIN;
process.env.ALLOWED_RESOURCE_ORIGINS = ORIGIN;
delete process.env.SCRAPFORAI_MCP_API_KEY;

const express = (await import('express')).default;
const users = await import('../src/team/userStore.js');
const { generateKey } = await import('../src/team/keys.js');
const { apiAuth } = await import('../src/security/apiAuth.js');
const { authRouter } = await import('../src/routes/auth.routes.js');
const { targetsRouter } = await import('../src/routes/targets.routes.js');
const { explorationRouter } = await import('../src/routes/exploration.routes.js');
const vault = await import('../src/vault/credentials/credentialVault.js');
// src/mcp/identity.js reads the environment ONCE, when first imported: every import of it is lazy, after `before()` has set the personal key and the base URL.

let server: http.Server;
let base: string;
let aliceKey = '';
let veraKey = '';

before(async () => {
  aliceKey = (await users.createUser({ id: 'alice', name: 'Alice', role: 'runner' }, 'root')).key;
  veraKey = (await users.createUser({ id: 'vera', name: 'Vera', role: 'viewer' }, 'root')).key;
  await users.createUser({ id: 'carol', name: 'Carol', role: 'admin' }, 'root');

  const app = express();
  app.use(express.json());
  app.use(apiAuth);
  app.use('/v1/auth', authRouter);
  app.use('/v1/targets', targetsRouter);
  app.use('/v1/explorations', explorationRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  // The MCP client of this process acts as alice against this API.
  process.env.SCRAPFORAI_MCP_API_KEY = aliceKey;
  process.env.SCRAPFORAI_MCP_BASE_URL = base;

  // Seed what the restrictions need, as the installation (admin key), not through the MCP.
  const put = (url: string, body: unknown) =>
    fetch(`${base}${url}`, { method: 'PUT', headers: { authorization: `Bearer ${MASTER}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await put('/v1/targets/locked', { name: 'Locked', environment: 'qa', baseUrl: `${ORIGIN}/`, credentialSets: [], allowedUsers: [] })).status, 200);
  await vault.saveCredentialSet('admin-only', { boundOrigins: [ORIGIN], values: { user: 'root', pass: 'S3NT1NEL-mcp-pass-4410' }, tags: [], allowedUsers: [] }, 'create');
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise((resolve) => setTimeout(resolve, 250));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('resolveMcpApiKey: unset or empty = the installation key; a personal key = that person; anything else is an error, never root by accident', async () => {
  const { resolveMcpApiKey } = await import('../src/mcp/identity.js');
  const installation = 'the-installation-key-0001';
  assert.deepEqual(resolveMcpApiKey({}, installation), { apiKey: installation, identity: { source: 'installation' } });
  assert.deepEqual(resolveMcpApiKey({ SCRAPFORAI_MCP_API_KEY: '' }, installation).identity, { source: 'installation' }, 'an unset ${VAR:-} expands to empty');
  assert.deepEqual(resolveMcpApiKey({ SCRAPFORAI_MCP_API_KEY: '   ' }, installation).identity, { source: 'installation' });

  const { key, keyId } = generateKey();
  const personal = resolveMcpApiKey({ SCRAPFORAI_MCP_API_KEY: `  ${key}\n` }, installation);
  assert.equal(personal.apiKey, key);
  assert.deepEqual(personal.identity, { source: 'personal', keyId });

  for (const bad of ['hello', installation, 'sfa_nothex_abc', `${key}x`, key.slice(0, -1), `sfa_${keyId}_`]) {
    assert.throws(() => resolveMcpApiKey({ SCRAPFORAI_MCP_API_KEY: bad }, installation), (error: Error) => {
      assert.ok(!error.message.includes(bad), 'the error never repeats what was typed');
      assert.match(error.message, /not a personal key/);
      return true;
    });
  }
});

test('the identity line names the key id and never the key', async () => {
  const { describeMcpIdentity, resolveMcpApiKey } = await import('../src/mcp/identity.js');
  const { key, keyId } = generateKey();
  const secret = key.split('_')[2]!;
  const line = describeMcpIdentity(resolveMcpApiKey({ SCRAPFORAI_MCP_API_KEY: key }, 'x'.repeat(20)).identity);
  assert.ok(line.includes(keyId));
  assert.ok(!line.includes(secret));
  assert.match(describeMcpIdentity({ source: 'installation' }), /installation key \(root, an admin\)/);
});

// ---- the real wiring: the MCP client with a personal key against a real API

test('the MCP client sends the personal key: the API sees alice, not root', async () => {
  const { getJson } = await import('../src/mcp/client.js');
  const { mcpCredentials } = await import('../src/mcp/identity.js');

  assert.equal(mcpCredentials.identity.source, 'personal');
  assert.equal(mcpCredentials.apiKey, aliceKey);
  const me = (await getJson('/v1/auth/me')) as { user: { id: string; role: string } };
  assert.deepEqual(me.user, { id: 'alice', role: 'runner' });
});

test('through the MCP client a runner meets the same refusals as at the keyboard: a restricted target profile and a restricted credential set', async () => {
  const { postJson, ScrapForAiRequestError } = await import('../src/mcp/client.js');

  await assert.rejects(postJson('/v1/explorations/run', { targetProfile: 'locked', steps: [{ action: 'goto', url: '$targetUrl' }] }), (error: unknown) => {
    assert.ok(error instanceof ScrapForAiRequestError);
    assert.equal(error.status, 403);
    assert.equal(error.type, 'TargetProfileForbidden');
    return true;
  });

  await assert.rejects(
    postJson('/v1/explorations/run', { targetUrl: `${ORIGIN}/login`, credentialSet: 'admin-only', steps: [{ action: 'fill', selector: '#p', valueFromCredential: 'pass' }] }),
    (error: unknown) => {
      assert.ok(error instanceof ScrapForAiRequestError);
      assert.equal(error.type, 'CredentialSetForbidden');
      assert.ok(!error.message.includes('S3NT1NEL-mcp-pass-4410'), 'and a value is never in the message');
      return true;
    },
  );
});

test('and a viewer\'s personal key can read but not run, whatever the agent asks', async () => {
  // A second client process would be needed to switch the key of the module-level config, so this one asks the API the way the client does.
  const asVera = (method: string, url: string, body?: unknown) =>
    fetch(`${base}${url}`, { method, headers: { authorization: `Bearer ${veraKey}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await asVera('GET', '/v1/auth/me')).status, 200);
  const run = await asVera('POST', '/v1/explorations/run', { targetUrl: `${ORIGIN}/`, steps: [{ action: 'goto', url: '$targetUrl' }] });
  assert.equal(run.status, 403);
  assert.equal(((await run.json()) as { error: { type: string } }).error.type, 'InsufficientRole');
});

test('the CLI never reads the MCP variable: it shares the MCP\'s address and timeout (config.ts), not its identity (identity.ts)', () => {
  const root = path.resolve(import.meta.dirname, '..', 'src');
  const withoutComments = (text: string) => text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const file of ['cli.ts', 'cli/runCli.ts', 'mcp/config.ts']) {
    const source = withoutComments(fs.readFileSync(path.join(root, file), 'utf8'));
    assert.ok(!/SCRAPFORAI_MCP_API_KEY/.test(source), `${file} must not read SCRAPFORAI_MCP_API_KEY`);
    assert.ok(!/identity\.js/.test(source), `${file} must not import the MCP identity`);
  }
  // And the two files that DO speak for the agent use it.
  for (const file of ['mcp/client.ts', 'mcp/server.ts']) {
    assert.match(fs.readFileSync(path.join(root, file), 'utf8'), /from '\.\/identity\.js'/, `${file} takes its key from identity.ts`);
  }
});
