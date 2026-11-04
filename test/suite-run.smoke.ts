import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// End-to-end (real Chromium) for T1.6. The fixture "application" counts, SERVER-SIDE, how many
// sessions each user has open at once; that is the evidence for the one-session-per-credential rule.

const API_KEY = 'test-api-key-1234567890';
const HOLD_MS = 2500;

const active: Record<string, number> = {};
const maxActive: Record<string, number> = {};
const events: string[] = [];
let globalActive = 0;
let globalMax = 0;

const site = await new Promise<{ server: http.Server; origin: string }>((resolve) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const user = url.searchParams.get('u') ?? '';

    if (url.pathname === '/start') {
      active[user] = (active[user] ?? 0) + 1;
      maxActive[user] = Math.max(maxActive[user] ?? 0, active[user]!);
      globalActive += 1;
      globalMax = Math.max(globalMax, globalActive);
      events.push(`start:${user}`);
    } else if (url.pathname === '/end') {
      active[user] = (active[user] ?? 1) - 1;
      globalActive -= 1;
      events.push(`end:${user}`);
    }

    res.setHeader('content-type', 'text/html');
    res.end(
      '<!doctype html><title>App</title><input id="u"><button id="start" onclick="fetch(\'/start?u=\'+encodeURIComponent(u.value))">s</button>' +
        '<button id="end" onclick="fetch(\'/end?u=\'+encodeURIComponent(u.value))">e</button>',
    );
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-suite-smoke-'));
process.env.SCRAPFORAI_API_KEY = API_KEY;
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.SCRAPFORAI_VAULT_KEY = crypto.randomBytes(32).toString('base64');
process.env.ALLOWED_TARGET_ORIGINS = site.origin;
process.env.ALLOWED_RESOURCE_ORIGINS = site.origin;
process.env.MAX_PARALLEL_JOBS = '3';
process.env.INTERACTIVE_RESERVED_SLOTS = '1'; // suites get 2 of the 3 slots

const express = (await import('express')).default;
const { apiAuth } = await import('../src/security/apiAuth.js');
const { suitesRouter } = await import('../src/routes/suites.routes.js');
const { routinesRouter } = await import('../src/routes/routines.routes.js');
const { saveTarget } = await import('../src/targets/targetStore.js');
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

/** Polls the way an MCP client would: repeated long-polls, each far shorter than any client timeout. */
async function finished(suiteRunId: string): Promise<Record<string, any>> {
  for (;;) {
    const state = (await call('GET', `/v1/suites/${suiteRunId}?wait=20`)).json;
    if (state.status !== 'running') {
      return state;
    }
  }
}

const statuses = (state: Record<string, any>) => state.variants.map((v: { status: string }) => v.status);
const resetFixture = () => {
  events.length = 0;
  globalMax = 0;
  for (const key of Object.keys(maxActive)) delete maxActive[key];
};

before(async () => {
  await saveTarget({
    id: 'fixture', name: 'Fixture', platform: 'generic', environment: 'dev', baseUrl: `${site.origin}/app`,
    credentialSets: ['user1', 'user2'], noiseFilters: [], surfaces: {}, screens: [],
    flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  });
  await saveCredentialSet('user1', { boundOrigins: [site.origin], values: { loginUser: 'alice' }, tags: [] }, 'create');
  await saveCredentialSet('user2', { boundOrigins: [site.origin], values: { loginUser: 'bobby' }, tags: [] }, 'create');

  const app = express();
  app.use(express.json());
  app.use(apiAuth);
  app.use('/v1/suites', suitesRouter);
  app.use('/v1/routines', routinesRouter);
  api = app.listen(0);
  await new Promise<void>((resolve) => api.once('listening', resolve));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  // A session: log in as the credential's user, hold it a while, log out.
  const session = [
    { id: 'open', action: 'goto', url: '$targetUrl' },
    { id: 'who', action: 'fill', selector: '#u', valueFromCredential: 'loginUser' },
    { id: 'in', action: 'click', selector: '#start', timeoutMs: 3000 },
    { id: 'hold', action: 'waitForTimeout', timeoutMs: HOLD_MS },
    { id: 'out', action: 'click', selector: '#end', timeoutMs: 3000 },
  ];
  for (const id of ['hold-a', 'hold-b', 'hold-c']) {
    const saved = await call('PUT', `/v1/routines/${id}`, { title: id, targetProfile: 'fixture', credentialSet: 'user1', steps: session });
    assert.equal(saved.status, 201, saved.text);
  }
  assert.equal(
    (await call('PUT', '/v1/routines/bad', { title: 'bad', targetProfile: 'fixture', steps: [{ id: 'open', action: 'goto', url: '$targetUrl' }, { id: 'nope', action: 'assertVisible', selector: '#nope', timeoutMs: 300 }] })).status,
    201,
  );
  assert.equal((await call('PUT', '/v1/routines/ok', { title: 'ok', targetProfile: 'fixture', steps: [{ id: 'open', action: 'goto', url: '$targetUrl' }] })).status, 201);
  assert.equal((await call('PUT', '/v1/routines/quarantined', { title: 'q', targetProfile: 'fixture', status: 'quarantined', steps: [{ id: 'open', action: 'goto', url: '$targetUrl' }] })).status, 201);
});

after(async () => {
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await new Promise<void>((resolve) => site.server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('POST returns 202 at once; a credential is never in two sessions; history is tagged', async () => {
  resetFixture();
  const started = Date.now();
  const post = await call('POST', '/v1/suites', { name: 'same credential', items: [{ routineId: 'hold-a' }, { routineId: 'hold-b' }], mode: 'parallel', concurrency: 2 });

  assert.equal(post.status, 202, post.text);
  assert.ok(Date.now() - started < 1500, 'the suite is accepted without waiting for it to run');
  assert.match(post.json.suiteRunId, /^suite_/);
  const id = post.json.suiteRunId as string;

  // A short long-poll returns while the suite is still going: a client never waits out a whole suite.
  const before = Date.now();
  const midway = (await call('GET', `/v1/suites/${id}?wait=1`)).json;
  assert.equal(midway.status, 'running');
  assert.ok(Date.now() - before >= 800 && Date.now() - before < 4000);

  const state = await finished(id);
  assert.deepEqual(statuses(state), ['passed', 'passed'], JSON.stringify(state.variants));
  assert.equal(state.verdict, 'green');
  assert.equal(state.exitCode, 0);
  assert.deepEqual(state.variants.map((v: { variantKey: string }) => v.variantKey), ['hold-a', 'hold-b']);

  // Both routines use user1 (alice): parallel mode with two workers, yet the sessions were serialised.
  assert.equal(maxActive.alice, 1, 'the credential lock kept alice to one session');
  assert.deepEqual(events.filter((e) => e.endsWith(':alice')), ['start:alice', 'end:alice', 'start:alice', 'end:alice']);

  const { items } = await listRuns({ limit: 50, offset: 0 });
  const tagged = items.filter((run) => run.suiteRunId === id);
  assert.deepEqual(tagged.map((run) => run.variantKey).sort(), ['hold-a', 'hold-b']);

  // The persisted state is what the API serves after the in-memory copy is gone.
  assert.ok(fs.existsSync(path.join(dataDir, 'suites', `${id}.json`)));
});

test('different credentials DO run in parallel (2 routines x 2 credential sets = 4 runs)', async () => {
  resetFixture();
  const post = await call('POST', '/v1/suites', {
    name: 'matrix', items: [{ routineId: 'hold-a' }, { routineId: 'hold-b' }], variants: { credentialSets: ['user1', 'user2'] }, mode: 'parallel', concurrency: 2,
  });
  assert.equal(post.status, 202, post.text);
  assert.equal(post.json.total, 4);

  const state = await finished(post.json.suiteRunId);
  assert.deepEqual(statuses(state), ['passed', 'passed', 'passed', 'passed'], JSON.stringify(state.variants));
  assert.deepEqual(state.variants.map((v: { variantKey: string }) => v.variantKey), [
    'hold-a/cred:user1', 'hold-a/cred:user2', 'hold-b/cred:user1', 'hold-b/cred:user2',
  ]);
  assert.equal(maxActive.alice, 1);
  assert.equal(maxActive.bobby, 1);
  assert.equal(globalMax, 2, 'alice and bobby were logged in at the same time');
});

test('failFast stops at the first red run and lists the rest as not run; exit code 1', async () => {
  resetFixture();
  const post = await call('POST', '/v1/suites', { name: 'failfast', items: [{ routineId: 'ok' }, { routineId: 'bad' }, { routineId: 'hold-a' }, { routineId: 'hold-b' }], failFast: true });
  const state = await finished(post.json.suiteRunId);

  assert.deepEqual(statuses(state), ['passed', 'failed', 'notRun', 'notRun']);
  assert.match(state.variants[2].notRunReason, /failFast: bad/);
  assert.equal(state.variants[1].errorType, 'StepExecutionError');
  assert.equal(state.variants[1].failedStepIndex, 1);
  assert.deepEqual([state.verdict, state.exitCode], ['red', 1]);
  assert.deepEqual(events, [], 'the skipped routines never ran');
});

test('without failFast every run executes, and a red one makes the verdict red', async () => {
  const state = await finished((await call('POST', '/v1/suites', { name: 'all', items: [{ routineId: 'bad' }, { routineId: 'ok' }] })).json.suiteRunId);
  assert.deepEqual(statuses(state), ['failed', 'passed']);
  assert.equal(state.exitCode, 1);
});

test('a run that cannot execute is an infrastructure error (exit 2), not a red test', async () => {
  const post = await call('POST', '/v1/suites', { name: 'refused', items: [{ routineId: 'ok' }, { routineId: 'hold-a' }], variants: { credentialSets: ['user3'] } });
  const state = await finished(post.json.suiteRunId);

  assert.deepEqual(statuses(state), ['error', 'error']);
  assert.equal(state.variants[0].errorType, 'CredentialSetNotAllowed');
  assert.deepEqual([state.verdict, state.exitCode], ['infra-error', 2]);
});

test('T3.5: a quarantined routine runs but is not in the verdict; asking for active only lists it as not run; a suite where nothing counted is never green', async () => {
  const mixed = await finished((await call('POST', '/v1/suites', { name: 'mixed', items: [{ routineId: 'ok' }, { routineId: 'quarantined' }] })).json.suiteRunId);
  assert.deepEqual(statuses(mixed), ['passed', 'passed']);
  assert.equal(mixed.variants[1].quarantined, true);
  assert.equal(mixed.verdict, 'green');
  assert.deepEqual(mixed.quarantine, { total: 1, passed: 1, failed: 0, error: 0, notRun: 0 });

  const activeOnly = await finished((await call('POST', '/v1/suites', { name: 'active only', items: [{ routineId: 'ok' }, { routineId: 'quarantined' }], statuses: ['active'] })).json.suiteRunId);
  assert.deepEqual(statuses(activeOnly), ['passed', 'notRun']);
  assert.match(activeOnly.variants[1].notRunReason, /quarantined/);
  assert.equal(activeOnly.verdict, 'green');

  // It ran and passed, but a pass that does not count verifies nothing.
  const nothing = await finished((await call('POST', '/v1/suites', { name: 'nothing', items: [{ routineId: 'quarantined' }] })).json.suiteRunId);
  assert.deepEqual(statuses(nothing), ['passed']);
  assert.deepEqual([nothing.verdict, nothing.exitCode], ['infra-error', 2]);
  assert.match(nothing.verdictReason, /only quarantined/);
});

test('unknown routine: 404 and nothing is started', async () => {
  const response = await call('POST', '/v1/suites', { name: 'x', items: [{ routineId: 'ok' }, { routineId: 'ghost' }] });
  assert.equal(response.status, 404);
  assert.equal(response.json.error.type, 'SuiteItemNotFound');
  assert.equal((await call('GET', '/v1/suites/suite_doesnotexist')).status, 404);
  assert.equal((await call('GET', '/v1/suites/..%2Fx')).status, 404);
});

test('an interactive run with a credential a suite is using gets 409 CredentialInUse, then works', async () => {
  resetFixture();
  const post = await call('POST', '/v1/suites', { name: 'busy', items: [{ routineId: 'hold-a' }] });
  const id = post.json.suiteRunId as string;

  // Wait until alice is really logged in, i.e. the suite holds the credential.
  for (let i = 0; i < 100 && (active.alice ?? 0) < 1; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(active.alice, 1);

  const busy = await call('POST', '/v1/routines/hold-b/run', {});
  assert.equal(busy.status, 409, busy.text);
  assert.equal(busy.json.error.type, 'CredentialInUse');

  // A run that needs no credential is not affected: the reserved slot keeps ad-hoc work possible.
  const free = await call('POST', '/v1/routines/ok/run', {});
  assert.equal(free.status, 200, free.text);

  await finished(id);
  const after = await call('POST', '/v1/routines/ok/run', {});
  assert.equal(after.status, 200);
});

test('cancel: the run in progress finishes, the rest are not run; exit code 2', async () => {
  resetFixture();
  const post = await call('POST', '/v1/suites', { name: 'cancel me', items: [{ routineId: 'hold-a' }, { routineId: 'hold-b' }, { routineId: 'hold-c' }] });
  const id = post.json.suiteRunId as string;

  for (let i = 0; i < 100 && (active.alice ?? 0) < 1; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const cancelled = await call('POST', `/v1/suites/${id}/cancel`);
  assert.equal(cancelled.status, 200, cancelled.text);
  assert.equal(cancelled.json.status, 'cancelled');
  assert.deepEqual(statuses(cancelled.json), ['passed', 'notRun', 'notRun']);
  assert.equal(cancelled.json.variants[1].notRunReason, 'cancelled');
  assert.deepEqual([cancelled.json.verdict, cancelled.json.exitCode], ['infra-error', 2]);
  assert.equal(events.filter((e) => e === 'start:alice').length, 1, 'no further session was started after the cancel');
});

test('the suite list shows recent suites with their verdicts', async () => {
  const list = (await call('GET', '/v1/suites')).json.suites as Array<{ name: string; verdict?: string }>;
  assert.ok(list.length >= 8);
  assert.ok(list.some((s) => s.name === 'failfast' && s.verdict === 'red'));
});
