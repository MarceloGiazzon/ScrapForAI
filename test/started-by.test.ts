import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// Who a run was started for is RECORDED: in result.json, in the history index, in the run report and as a filter of GET /v1/runs.
// It comes from the initiator the server was given (never from the request), and a run from before the field existed simply has none.
// No browser here: the real run is in test/team.smoke.ts.

const MASTER = 'test-api-key-1234567890';
const ORIGIN = 'https://dev.example.com';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-startedby-test-'));
process.env.SCRAPFORAI_API_KEY = MASTER;
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.SCRAPFORAI_VAULT_KEY = crypto.randomBytes(32).toString('base64');
process.env.ALLOWED_TARGET_ORIGINS = ORIGIN;
process.env.ALLOWED_RESOURCE_ORIGINS = ORIGIN;

const express = (await import('express')).default;
const users = await import('../src/team/userStore.js');
const { apiAuth } = await import('../src/security/apiAuth.js');
const { runsRouter } = await import('../src/routes/runs.routes.js');
const { startedByOf, initiatorOf, SYSTEM_INITIATOR } = await import('../src/team/initiator.js');
const { resolveExplorationRequest } = await import('../src/runner/resolveRequest.js');
const { explorationRequestSchema } = await import('../src/schemas/explorationRequest.schema.js');
const { explorationResultSchema } = await import('../src/schemas/explorationResult.schema.js');
const { summarizeResult } = await import('../src/history/summarizeResult.js');
const { runSummarySchema } = await import('../src/history/runSummary.js');
const { appendRun, listRuns, resetRunHistoryForTests } = await import('../src/history/runHistoryStore.js');
const { executorOf } = await import('../src/reports/buildReport.js');
const { renderRunReport } = await import('../src/reports/render.js');

let server: http.Server;
let base: string;
let aliceKey = '';

before(async () => {
  aliceKey = (await users.createUser({ id: 'alice', name: 'Alice', role: 'runner' }, 'root')).key;
  const app = express();
  app.use(express.json());
  app.use(apiAuth);
  app.use('/v1/runs', runsRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const baseRequest = { targetUrl: `${ORIGIN}/`, steps: [{ action: 'goto', url: '$targetUrl' }] };

const minimalResult = (over: Record<string, unknown> = {}) =>
  explorationResultSchema.parse({
    jobId: 'job_sb_1', status: 'passed', startedAt: '2026-11-10T10:00:00.000Z', finishedAt: '2026-11-10T10:00:01.000Z', durationMs: 1000, targetUrl: `${ORIGIN}/`,
    caller: null, steps: [], extracted: {},
    evidence: { screenshots: [], console: [], consoleErrors: [], pageErrors: [], network: [], networkFailures: [], unexpectedExternalRequests: [] },
    ...over,
  });

test('startedByOf: a person keeps id and role; the server acting on its own has no role', () => {
  assert.deepEqual(startedByOf({ userId: 'alice', role: 'runner' }), { userId: 'alice', role: 'runner' });
  assert.deepEqual(startedByOf(SYSTEM_INITIATOR), { userId: 'system' });
  assert.deepEqual(startedByOf(initiatorOf(undefined)), { userId: 'anonymous', role: 'viewer' });
});

test('the resolver stamps the run with who it is for, and a request cannot claim to be someone else', async () => {
  const resolved = await resolveExplorationRequest(explorationRequestSchema.parse(baseRequest), { initiator: { userId: 'alice', role: 'runner' } });
  assert.deepEqual(resolved.startedBy, { userId: 'alice', role: 'runner' });

  const system = await resolveExplorationRequest(explorationRequestSchema.parse(baseRequest), { initiator: SYSTEM_INITIATOR });
  assert.deepEqual(system.startedBy, { userId: 'system' });

  // Either the schema refuses the extra key or it drops it: in both cases the stamp is the initiator's.
  const forged = explorationRequestSchema.safeParse({ ...baseRequest, startedBy: { userId: 'carol', role: 'admin' } });
  if (forged.success) {
    const stamped = await resolveExplorationRequest(forged.data, { initiator: { userId: 'alice', role: 'runner' } });
    assert.deepEqual(stamped.startedBy, { userId: 'alice', role: 'runner' });
  }
});

test('the result schema holds it; a result written before the field existed still parses and has none', () => {
  assert.deepEqual(minimalResult({ startedBy: { userId: 'alice', role: 'runner' } }).startedBy, { userId: 'alice', role: 'runner' });
  assert.equal(minimalResult().startedBy, undefined);
  assert.equal(explorationResultSchema.safeParse({ ...minimalResult(), startedBy: { userId: 'alice', role: 'superuser' } }).success, false, 'a made-up role is refused');
  assert.equal(explorationResultSchema.safeParse({ ...minimalResult(), startedBy: { userId: '' } }).success, false);
});

test('the history summary keeps the user id only, and an old line without it still loads', () => {
  const summary = summarizeResult(minimalResult({ startedBy: { userId: 'alice', role: 'runner' } }));
  assert.equal(summary.startedBy, 'alice');
  assert.equal(summarizeResult(minimalResult()).startedBy, undefined);

  const { startedBy: _drop, ...oldLine } = summary;
  assert.equal(runSummarySchema.safeParse(oldLine).success, true);
});

test('the run history filters by who started it, and the text search finds a person too', async () => {
  resetRunHistoryForTests();
  const add = (jobId: string, startedBy?: string) =>
    appendRun(summarizeResult(minimalResult({ jobId, ...(startedBy ? { startedBy: { userId: startedBy } } : {}) })));
  await add('job_sb_a', 'alice');
  await add('job_sb_b', 'bob');
  await add('job_sb_c', 'alice');
  await add('job_sb_old');

  assert.deepEqual((await listRuns({ startedBy: 'alice' })).items.map((run) => run.jobId).sort(), ['job_sb_a', 'job_sb_c']);
  assert.deepEqual((await listRuns({ startedBy: 'nobody' })).items, []);
  assert.deepEqual((await listRuns({ q: 'bob' })).items.map((run) => run.jobId), ['job_sb_b']);
  assert.equal((await listRuns({})).total, 4, 'a run with no recorded person is still listed without a filter');
  assert.ok(!(await listRuns({ startedBy: 'alice' })).items.some((run) => run.jobId === 'job_sb_old'), 'and never matches a person');
});

test('http: GET /v1/runs?startedBy= filters, for a person\'s own key too', async () => {
  const response = await fetch(`${base}/v1/runs?startedBy=alice`, { headers: { authorization: `Bearer ${aliceKey}` } });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { total: number; items: Array<{ startedBy?: string }> };
  assert.equal(body.total, 2);
  assert.ok(body.items.every((run) => run.startedBy === 'alice'));
});

test('the report says who executed it: the person with the tool in brackets; the scheduler reads as before', () => {
  assert.equal(executorOf({ caller: { source: 'claude-code' }, startedBy: { userId: 'alice', role: 'runner' } }), 'alice (claude-code)');
  assert.equal(executorOf({ caller: null, startedBy: { userId: 'root', role: 'admin' } }), 'root (ScrapForAI)');
  assert.equal(executorOf({ caller: { source: 'nightly-ci' }, startedBy: { userId: 'system' } }), 'nightly-ci');
  assert.equal(executorOf({ caller: null }), 'ScrapForAI', 'an old run has no person: unchanged');
});

test('the report escapes the executor like everything else from a run', () => {
  const html = renderRunReport(
    {
      jobId: 'job_sb_x', status: 'passed', targetUrl: `${ORIGIN}/`, startedAt: 'a', finishedAt: 'b', durationMs: 1,
      executor: executorOf({ caller: null, startedBy: { userId: '<img src=x onerror=alert(1)>' } }),
      steps: [], screenshots: [], consoleCount: 0, consoleErrors: [], networkCount: 0, networkFailures: [], integrity: { state: 'none' }, generatedAt: 'now',
    },
    'en',
  );
  assert.ok(!html.includes('<img src=x'), 'the markup is not live');
  assert.ok(html.includes('&lt;img src=x'));
});
