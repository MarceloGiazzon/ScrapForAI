import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// End-to-end (real Chromium) for T1.4: include + teardown. The fixture server records which URLs the
// browser hit, so "the teardown ran" is observed server-side, not inferred from our own result.

const API_KEY = 'test-api-key-1234567890';

test('include expands; teardown runs after success and after a failure at step 3, without masking it', async () => {
  const hits: string[] = [];
  const site = await new Promise<{ server: http.Server; origin: string }>((resolve) => {
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      res.setHeader('content-type', 'text/html');
      res.end(
        '<!doctype html><title>Fixture</title><button id="go" onclick="document.body.insertAdjacentHTML(\'beforeend\',\'<p id=welcome>Hi</p>\')">Login</button>',
      );
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-composition-smoke-'));

  process.env.SCRAPFORAI_API_KEY = API_KEY;
  process.env.SCRAPFORAI_DATA_DIR = dataDir;
  process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
  process.env.ALLOWED_TARGET_ORIGINS = site.origin;
  process.env.ALLOWED_RESOURCE_ORIGINS = site.origin;

  const express = (await import('express')).default;
  const { apiAuth } = await import('../src/security/apiAuth.js');
  const { routinesRouter } = await import('../src/routes/routines.routes.js');
  const { explorationRouter } = await import('../src/routes/exploration.routes.js');
  const { saveTarget } = await import('../src/targets/targetStore.js');

  await saveTarget({
    id: 'fixture', name: 'Fixture', platform: 'generic', environment: 'dev', baseUrl: `${site.origin}/`, credentialSets: [],
    noiseFilters: [], surfaces: {}, screens: [], flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  });

  const app = express();
  app.use(express.json());
  app.use(apiAuth);
  app.use('/v1/routines', routinesRouter);
  app.use('/v1/explorations', explorationRouter);
  const api = app.listen(0);
  await new Promise<void>((resolve) => api.once('listening', resolve));
  const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  const call = async (method: string, urlPath: string, body?: unknown) => {
    const response = await fetch(`${apiUrl}${urlPath}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, json: JSON.parse(text) as Record<string, any> };
  };
  const put = async (id: string, body: object) => {
    const response = await call('PUT', `/v1/routines/${id}`, { title: id, targetProfile: 'fixture', ...body });
    assert.ok(response.status === 200 || response.status === 201, `${id}: ${response.text}`);
  };
  const run = (id: string) => call('POST', `/v1/routines/${id}/run`, {});
  const hitsAfter = (marker: number) => hits.slice(marker).filter((url) => url.startsWith('/logout') || url.startsWith('/cleanup'));

  try {
    const open = { id: 'open', action: 'goto', url: '$targetUrl' };
    const click = { id: 'click', action: 'click', selector: '#go', timeoutMs: 2000 };

    await put('login', { steps: [open, click], teardown: [{ id: 'logout', action: 'goto', url: `${site.origin}/logout` }] });

    // --- 1. include + teardown on a passing run -------------------------------------------------
    await put('main', {
      steps: [{ id: 'auth', action: 'include', routineId: 'login' }, { id: 'check', action: 'assertVisible', selector: '#welcome', timeoutMs: 2000 }],
      teardown: [{ id: 'cleanup', action: 'goto', url: `${site.origin}/cleanup` }],
    });

    let marker = hits.length;
    const passed = await run('main');
    assert.equal(passed.status, 200, passed.text);
    assert.equal(passed.json.status, 'passed');
    assert.deepEqual(passed.json.steps.map((s: { id: string }) => s.id), ['auth.open', 'auth.click', 'check']);
    assert.deepEqual(passed.json.includes.map((i: { routineId: string; version: number }) => [i.routineId, i.version]), [['login', 1]]);
    assert.equal(passed.json.teardownStatus, 'passed');
    assert.deepEqual(passed.json.teardown.map((s: { id: string }) => s.id), ['cleanup', 'auth.logout']);
    assert.deepEqual(hitsAfter(marker), ['/cleanup', '/logout'], 'own teardown first, then the included routine\'s logout');

    // --- 2. failure at step 3: teardown still runs, failure is kept ------------------------------
    await put('fails-at-3', {
      steps: [open, click, { id: 'boom', action: 'assertVisible', selector: '#does-not-exist', timeoutMs: 500 }],
      teardown: [{ id: 'cleanup', action: 'goto', url: `${site.origin}/cleanup` }],
    });

    marker = hits.length;
    const failed = await run('fails-at-3');
    assert.equal(failed.status, 500);
    assert.equal(failed.json.status, 'failed');
    assert.equal(failed.json.failedStepIndex, 2);
    assert.equal(failed.json.steps.length, 3);
    assert.equal(failed.json.error.type, 'StepExecutionError');
    assert.deepEqual(hitsAfter(marker), ['/cleanup'], 'the teardown ran although step 3 failed');
    assert.equal(failed.json.teardownStatus, 'passed');
    assert.ok(failed.json.evidence.screenshots.some((s: { name: string }) => s.name === 'failure'), 'failure evidence captured before teardown');

    // --- 3. a failing teardown step never masks the real failure, and the rest still run ----------
    await put('teardown-breaks', {
      steps: [open, { id: 'boom', action: 'assertVisible', selector: '#does-not-exist', timeoutMs: 500 }],
      teardown: [{ id: 'broken', action: 'click', selector: '#also-missing', timeoutMs: 300 }, { id: 'cleanup', action: 'goto', url: `${site.origin}/cleanup` }],
    });

    marker = hits.length;
    const both = await run('teardown-breaks');
    assert.equal(both.json.failedStepIndex, 1);
    assert.equal(both.json.error.message, failed.json.error.message, 'the error reported is the step\'s, not the teardown\'s');
    assert.deepEqual(both.json.teardown.map((s: { status: string }) => s.status), ['failed', 'passed']);
    assert.equal(both.json.teardownStatus, 'failed');
    assert.deepEqual(hitsAfter(marker), ['/cleanup'], 'the step after the failed teardown step still ran');

    // --- 4. passing steps + failing teardown: verdict unchanged, but visible --------------------------
    await put('dirty-cleanup', { steps: [open, click], teardown: [{ id: 'broken', action: 'click', selector: '#also-missing', timeoutMs: 300 }] });
    const dirty = await run('dirty-cleanup');
    assert.equal(dirty.json.status, 'passed', 'the verdict is the steps\' verdict');
    assert.equal(dirty.json.teardownStatus, 'failed', 'but a failed cleanup is reported');

    // --- 5. a run saved from its job id keeps the include (not the expanded copy) ----------------------
    const saved = await call('PUT', '/v1/routines/main-copy', { fromJobId: passed.json.jobId });
    assert.equal(saved.status, 201, saved.text);
    assert.equal(saved.json.routine.steps[0].action, 'include');
    assert.equal(saved.json.routine.teardown[0].id, 'cleanup');

    // --- 6. an ad-hoc request can include too, and a missing routine is a clean 404 ----------------------
    const adHoc = await call('POST', '/v1/explorations/run', { targetProfile: 'fixture', steps: [{ id: 'auth', action: 'include', routineId: 'login' }] });
    assert.equal(adHoc.status, 200, adHoc.text);
    assert.deepEqual(adHoc.json.teardown.map((s: { id: string }) => s.id), ['auth.logout']);

    const missing = await call('POST', '/v1/explorations/run', { targetProfile: 'fixture', steps: [{ action: 'include', routineId: 'nope' }] });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.type, 'IncludedRoutineNotFound');
  } finally {
    await new Promise<void>((resolve) => api.close(() => resolve()));
    await new Promise<void>((resolve) => site.server.close(() => resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
