import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// T10.1 against the REAL server process (src/server.ts), not a hand-built app: the routes are mounted where the policy expects them, TRUST_PROXY
// sets the address the audit log records, the CLI creates people and reads the audit log, and the data directory holds hashes and no key.

const ROOT_KEY = 'smoke-root-key-0123456789abcdef';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-team-smoke-'));
const repo = path.resolve(import.meta.dirname, '..');

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
// A port nothing listens on: a run against it fails fast and by itself (TargetUnreachable), which is all the "who started it" check needs.
const deadOrigin = `http://127.0.0.1:${await freePort()}`;
const env = {
  ...process.env,
  PORT: String(port),
  HOST: '127.0.0.1',
  NODE_ENV: 'development',
  LOG_LEVEL: 'silent',
  SCRAPFORAI_API_KEY: ROOT_KEY,
  SCRAPFORAI_DATA_DIR: dataDir,
  ARTIFACT_DIR: path.join(dataDir, 'artifacts'),
  ALLOWED_TARGET_ORIGINS: `https://dev.example.com,${deadOrigin}`,
  TRUST_PROXY: '1',
  SCHEDULER_ENABLED: 'false',
  UI_ENABLED: 'true',
};

let child: ChildProcess;

before(async () => {
  child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout?.on('data', (chunk) => (output += chunk));
  child.stderr?.on('data', (chunk) => (output += chunk));
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`the server exited early:\n${output}`);
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the server did not start:\n${output}`);
});

after(async () => {
  child?.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const cli = (args: string[], key = ROOT_KEY) => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args, '--url', base], {
    cwd: repo,
    env: { ...env, SCRAPFORAI_API_KEY: key },
    encoding: 'utf8',
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
};
const api = async (method: string, url: string, key: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : undefined };
};

test('the CLI makes people with the root key; each key is printed once and works', () => {
  const ana = cli(['users', 'create', 'ana', '--role', 'runner', '--name', 'Ana', '--json']);
  assert.equal(ana.code, 0, ana.stderr);
  const created = JSON.parse(ana.stdout);
  assert.equal(created.command, 'users create');
  assert.match(created.result.key, /^sfa_[0-9a-f]{12}_/);
  anaKey = created.result.key;

  const vera = JSON.parse(cli(['users', 'create', 'vera', '--role', 'viewer', '--json']).stdout);
  veraKey = vera.result.key;

  const list = cli(['users', 'list']);
  assert.match(list.stdout, /ana\s+runner\s+Ana/);
  assert.ok(!list.stdout.includes(anaKey), 'a list never shows a key');

  const stored = fs.readFileSync(path.join(dataDir, 'team', 'users.json'), 'utf8');
  assert.ok(!stored.includes(anaKey) && !stored.includes(veraKey), 'the data directory holds hashes, not keys');
});
let anaKey = '';
let veraKey = '';

test('roles hold on the real routes: viewer reads, runner runs, only an admin key reaches the key-only writes and the team', async () => {
  assert.equal((await api('GET', '/v1/runs', veraKey)).status, 200);
  const viewerWrite = await api('POST', '/v1/explorations/inspect-dom', veraKey, { url: 'https://dev.example.com/' });
  assert.equal(viewerWrite.status, 403);
  assert.equal(viewerWrite.json.error.type, 'InsufficientRole');

  // A runner passes the role check (the request then fails on its own merits: nothing listens at dev.example.com in a smoke -- we only need "not 403").
  const runnerWrite = await api('POST', '/v1/explorations/run', anaKey, { targetUrl: 'https://dev.example.com/', steps: [] });
  assert.notEqual(runnerWrite.status, 403);
  assert.notEqual(runnerWrite.status, 401);

  const keyOnly = await api('PUT', '/v1/credentials/x', anaKey, {});
  assert.equal(keyOnly.status, 403);
  assert.equal(keyOnly.json.error.type, 'InsufficientRole');
  assert.equal((await api('GET', '/v1/team/users', anaKey)).status, 403);
  assert.equal((await api('GET', '/v1/audit', anaKey)).status, 403);

  assert.equal((await api('GET', '/v1/team/users', ROOT_KEY)).status, 200);
  const me = await api('GET', '/v1/auth/me', anaKey);
  assert.deepEqual(me.json.user, { id: 'ana', role: 'runner' });
  assert.equal((await api('GET', '/v1/runs', 'sfa_000000000000_' + 'x'.repeat(43))).status, 401);
});

test('a real run records who started it: the person, root for the installation key; the history filters on it and the report names it', async () => {
  const run = (key: string) => api('POST', '/v1/explorations/run', key, { targetUrl: `${deadOrigin}/`, steps: [{ id: 'open', action: 'goto', url: '$targetUrl' }] });

  const byAna = await run(anaKey);
  assert.equal(byAna.status, 500, 'the target is down, so the run fails, and the result is in the body');
  assert.deepEqual(byAna.json.startedBy, { userId: 'ana', role: 'runner' });
  const byRoot = await run(ROOT_KEY);
  assert.deepEqual(byRoot.json.startedBy, { userId: 'root', role: 'admin' });

  const mine = await api('GET', '/v1/runs?startedBy=ana', veraKey);
  assert.equal(mine.json.total, 1, 'a viewer may read who ran what');
  assert.equal(mine.json.items[0].jobId, byAna.json.jobId);
  assert.equal(mine.json.items[0].startedBy, 'ana');
  assert.equal((await api('GET', '/v1/runs?startedBy=root', ROOT_KEY)).json.items[0].jobId, byRoot.json.jobId);

  const report = await fetch(`${base}/v1/runs/${byAna.json.jobId}/report?lang=en`, { headers: { authorization: `Bearer ${ROOT_KEY}` } });
  assert.equal(report.status, 200);
  assert.match(await report.text(), /ana \(ScrapForAI\)/);
});

test('a target profile limited to some people: the listed runner gets a real run, another runner is refused with 403 before a browser starts', async () => {
  const ben = JSON.parse(cli(['users', 'create', 'ben', '--role', 'runner', '--json']).stdout).result.key as string;
  const profile = { name: 'Locked', environment: 'dev', baseUrl: `${deadOrigin}/`, credentialSets: [], allowedUsers: ['ana'] };
  assert.equal((await api('PUT', '/v1/targets/locked', ROOT_KEY, profile)).status, 200);
  const through = (key: string) => api('POST', '/v1/explorations/run', key, { targetProfile: 'locked', steps: [{ id: 'open', action: 'goto', url: '$targetUrl' }] });

  const listed = await through(anaKey);
  assert.equal(listed.status, 500, 'ana may: the run starts, and fails by itself because the target is down');
  assert.equal(listed.json.error.type, 'TargetUnreachable');

  const refused = await through(ben);
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error.type, 'TargetProfileForbidden');
  assert.ok(!JSON.stringify(refused.json).includes('ana'), 'it does not say who may');

  assert.equal((await api('GET', '/v1/targets/locked', ben)).json.restricted, true);
  assert.equal((await api('GET', '/v1/targets/locked', ben)).json.allowedUsers, undefined, 'a runner does not read the list');
  assert.deepEqual((await api('GET', '/v1/targets/locked', ROOT_KEY)).json.allowedUsers, ['ana']);
  assert.equal((await through(ROOT_KEY)).status, 500, 'the installation key is an admin: it may');
});

test('revoking and disabling take effect at once', async () => {
  const key2 = JSON.parse(cli(['users', 'key-create', 'ana', '--label', 'second', '--json']).stdout).result;
  assert.equal((await api('GET', '/v1/runs', key2.key)).status, 200);
  assert.equal(cli(['users', 'key-revoke', 'ana', key2.keyId]).code, 0);
  assert.equal((await api('GET', '/v1/runs', key2.key)).status, 401);

  assert.equal(cli(['users', 'set', 'vera', '--disabled', 'true']).code, 0);
  assert.equal((await api('GET', '/v1/runs', veraKey)).status, 401);
  assert.equal(cli(['users', 'set', 'vera', '--disabled', 'false']).code, 0);
  assert.equal((await api('GET', '/v1/runs', veraKey)).status, 200);
});

test('a refusal from the CLI of a non-admin names the reason and exits 2', () => {
  const refused = cli(['users', 'list'], anaKey);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /InsufficientRole/);
});

test('audit: the real server records who did what, with the client address behind a proxy, and the chain verifies', async () => {
  await api('POST', '/v1/explorations/run', anaKey, { targetUrl: 'https://dev.example.com/', steps: [] }, { 'x-forwarded-for': '203.0.113.9' });
  await new Promise((resolve) => setTimeout(resolve, 200));

  const log = cli(['audit', '--user', 'ana', '--json']);
  assert.equal(log.code, 0, log.stderr);
  const entries = JSON.parse(log.stdout).result.entries as Array<Record<string, any>>;
  const run = entries.find((entry) => entry.path === '/v1/explorations/run' && entry.ip === '203.0.113.9');
  assert.ok(run, `the run, with the address the proxy reported: ${JSON.stringify(entries.map((e) => [e.path, e.ip]))}`);
  assert.deepEqual([run.actor.userId, run.actor.role, run.actor.via], ['ana', 'runner', 'bearer']);

  const root = JSON.parse(cli(['audit', '--user', 'root', '--area', 'team', '--json']).stdout).result.entries as Array<Record<string, any>>;
  assert.ok(root.some((entry) => entry.method === 'POST' && entry.detail?.user === 'vera' && entry.detail?.role === 'viewer'), 'root made vera a viewer');

  const everything = fs.readFileSync(path.join(dataDir, 'audit', 'audit.jsonl'), 'utf8');
  for (const secret of [anaKey, veraKey, ROOT_KEY]) assert.ok(!everything.includes(secret), 'no key in the audit file');

  const verify = cli(['audit', 'verify']);
  assert.equal(verify.code, 0, verify.stdout + verify.stderr);
  assert.match(verify.stdout, /intact/);
});

test('the web console signs in with a personal key, and the session is that person', async () => {
  const login = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: veraKey }) });
  assert.equal(login.status, 200);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  const asSession = (method: string, url: string) => fetch(`${base}${url}`, { method, headers: { cookie, 'x-scrapforai-ui': '1' } });
  assert.equal((await asSession('GET', '/v1/runs')).status, 200);
  assert.equal((await asSession('POST', '/v1/explorations/inspect-dom')).status, 403, 'a viewer session cannot start a browser');
  assert.equal((await asSession('GET', '/v1/team/users')).status, 403);
});
