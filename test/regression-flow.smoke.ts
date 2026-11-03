import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// End-to-end (real Chromium) for T2.2/T2.3: RED pinned -> still red (item untouched) -> fix -> GREEN pinned,
// then the vault runs as a suite, ordered by impact.

const API_KEY = 'test-api-key-1234567890';

test('RED -> GREEN flow with pinned, verifiable evidence; impact-ordered vault suite', async () => {
  let bugPresent = true;
  const site = await new Promise<{ server: http.Server; origin: string }>((resolve) => {
    const server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><title>Shop</title><p id="total">Total: ${bugPresent ? 5 : 4}</p>`);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-regression-smoke-'));

  process.env.SCRAPFORAI_API_KEY = API_KEY;
  process.env.SCRAPFORAI_DATA_DIR = dataDir;
  process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
  process.env.ALLOWED_TARGET_ORIGINS = site.origin;
  process.env.ALLOWED_RESOURCE_ORIGINS = site.origin;
  process.env.MAX_PARALLEL_JOBS = '3';

  const express = (await import('express')).default;
  const { apiAuth } = await import('../src/security/apiAuth.js');
  const { vaultRouter } = await import('../src/routes/vault.routes.js');
  const { explorationRouter } = await import('../src/routes/exploration.routes.js');
  const { runsRouter } = await import('../src/routes/runs.routes.js');
  const { suitesRouter } = await import('../src/routes/suites.routes.js');
  const { saveTarget } = await import('../src/targets/targetStore.js');
  const { saveRoutine } = await import('../src/library/routineService.js');
  const { sha256File } = await import('../src/evidence/manifest.js');

  await saveTarget({
    id: 'shop', name: 'Shop', platform: 'generic', environment: 'dev', baseUrl: `${site.origin}/`, credentialSets: [], noiseFilters: [],
    surfaces: { cart: ['src/cart/**'], search: ['src/search/**'] }, screens: [],
    flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  });

  const app = express();
  app.use(express.json());
  app.use(apiAuth);
  app.use('/v1/vault', vaultRouter);
  app.use('/v1/explorations', explorationRouter);
  app.use('/v1/runs', runsRouter);
  app.use('/v1/suites', suitesRouter);
  const api = app.listen(0);
  await new Promise<void>((resolve) => api.once('listening', resolve));
  const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  const call = async (method: string, urlPath: string, body?: unknown, auth = true) => {
    const response = await fetch(`${apiUrl}${urlPath}`, {
      method,
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${API_KEY}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, json: JSON.parse(text) as Record<string, any> };
  };

  try {
    const steps = [
      { id: 'open', action: 'goto', url: '$targetUrl' },
      { id: 'total', action: 'assertTextContains', selector: '#total', text: 'Total: 4', timeoutMs: 500 },
    ];

    // 1. The agent reproduces the bug: the run FAILS because the app shows 5.
    const red = await call('POST', '/v1/explorations/run', { targetProfile: 'shop', buildId: 'rev1', scenarioName: 'cart total', steps });
    assert.equal(red.status, 500, red.text);
    assert.equal(red.json.status, 'failed');
    assert.equal(red.json.buildId, 'rev1');

    // A passing run is not a RED proof.
    const green0 = await call('POST', '/v1/explorations/run', { targetProfile: 'shop', steps: [steps[0]] });
    const notRed = await call('POST', '/v1/vault/add-from-run', { id: 'SHOP-1', fromJobId: green0.json.jobId, title: 't', surface: 'cart' });
    assert.equal(notRed.status, 409);
    assert.equal(notRed.json.error.type, 'JobNotRed');

    // 2. Capture it: routine saved, failing run pinned as provenRed.
    const added = await call('POST', '/v1/vault/add-from-run', {
      id: 'SHOP-1', fromJobId: red.json.jobId, title: 'Cart total adds 1', severity: 'P1', surface: 'cart', ledgerRef: 'npdev:REG-209', tags: ['cart'],
    });
    assert.equal(added.status, 201, added.text);
    const item = added.json.item;
    assert.deepEqual([item.status, item.firstGreen, item.provenRed.jobId, item.provenRed.buildId], ['ACTIVE', null, red.json.jobId, 'rev1']);
    assert.deepEqual(item.routine, { id: 'shop-1', version: 1 });
    assert.equal(item.lastRun.status, 'failed');

    // The RED evidence is pinned, outside the artifact root, and its manifest hash is the one the item quotes.
    assert.ok(!fs.existsSync(path.join(dataDir, 'artifacts', red.json.jobId)), 'moved to the pinned store');
    const pinnedManifest = path.join(dataDir, 'evidence', 'pinned', red.json.jobId, 'manifest.json');
    assert.equal(await sha256File(pinnedManifest), item.provenRed.manifestSha256);
    const verified = await call('GET', `/v1/runs/${red.json.jobId}/manifest`);
    assert.equal(verified.json.location, 'pinned');
    assert.equal(verified.json.verification.ok, true);

    assert.equal((await call('POST', '/v1/vault/add-from-run', { id: 'SHOP-1', fromJobId: red.json.jobId, title: 'x', surface: 'cart' })).status, 409, 'id already taken');
    assert.equal((await call('POST', '/v1/vault/SHOP-1/confirm-green', {}, false)).status, 401, 'confirm-green needs the bearer token');

    // 3. confirm-green while the bug is still there: 409, nothing changes.
    const stillRed = await call('POST', '/v1/vault/SHOP-1/confirm-green', { buildId: 'rev2' });
    assert.equal(stillRed.status, 409, stillRed.text);
    assert.equal(stillRed.json.error.type, 'StillRed');
    const unchanged = (await call('GET', '/v1/vault/SHOP-1')).json;
    assert.equal(unchanged.firstGreen, null);
    assert.equal(unchanged.lastRun.jobId, red.json.jobId, 'the failed attempt did not rewrite the item');

    // 4. The fix lands; confirm-green runs the SAME routine version and pins the passing run.
    bugPresent = false;
    const confirmed = await call('POST', '/v1/vault/SHOP-1/confirm-green', { buildId: 'rev2' });
    assert.equal(confirmed.status, 200, confirmed.text);
    const done = confirmed.json.item;
    assert.equal(done.firstGreen.buildId, 'rev2');
    assert.notEqual(done.firstGreen.jobId, done.provenRed.jobId);
    assert.equal(done.provenRed.buildId, 'rev1', 'the RED still says which build was broken');
    assert.equal(await sha256File(path.join(dataDir, 'evidence', 'pinned', done.firstGreen.jobId, 'manifest.json')), done.firstGreen.manifestSha256);
    assert.equal(done.lastRun.status, 'passed');

    assert.equal((await call('POST', '/v1/vault/SHOP-1/confirm-green', {})).json.error.type, 'AlreadyConfirmed', 'firstGreen is the FIRST pass and is never overwritten');

    // 5. Run the item on its own: records lastRun, exit-code style status.
    const ran = await call('POST', '/v1/vault/SHOP-1/run', { buildId: 'rev3' });
    assert.equal(ran.status, 200);
    assert.equal((await call('GET', '/v1/vault/SHOP-1')).json.lastRun.buildId, 'rev3');

    // 6. A suite of the whole vault, ordered by impact: the cart change puts SHOP-1 first, with the reason.
    await saveRoutine('search-ok', { title: 'search', targetProfile: 'shop', steps: [steps[0]] } as never);
    assert.equal((await call('PUT', '/v1/vault/SHOP-2', { title: 'Search ok', type: 'SCENARIO', severity: 'P0', status: 'ACTIVE', surface: 'search', routine: { id: 'search-ok', version: 1 }, redNotCapturedReason: 'never red: a scenario' })).status, 201);

    const planned = await call('POST', '/v1/vault/plan', { changedFiles: ['src/cart/total.ts'] });
    assert.deepEqual(planned.json.order.map((entry: { id: string }) => entry.id), ['SHOP-1', 'SHOP-2'], 'P0 SHOP-2 would win on severity alone; the touched surface beats it');
    assert.match(planned.json.order[0].reasons[0].detail, /src\/cart\/total\.ts matches src\/cart\/\*\*/);

    const started = await call('POST', '/v1/suites', { name: 'vault', items: [{ vault: {} }], order: 'impact', impact: { changedFiles: ['src/cart/total.ts'] }, buildId: 'rev4' });
    assert.equal(started.status, 202, started.text);
    let state: Record<string, any>;
    do {
      state = (await call('GET', `/v1/suites/${started.json.suiteRunId}?wait=20`)).json;
    } while (state.status === 'running');

    assert.deepEqual(state.variants.map((v: { variantKey: string }) => v.variantKey), ['SHOP-1', 'SHOP-2']);
    assert.deepEqual(state.variants.map((v: { vaultItemId: string }) => v.vaultItemId), ['SHOP-1', 'SHOP-2']);
    assert.equal(state.variants[0].order.position, 1);
    assert.match(state.variants[0].order.reasons[0], /matches src\/cart/);
    assert.deepEqual([state.verdict, state.exitCode], ['green', 0]);
    assert.equal((await call('GET', '/v1/vault/SHOP-2')).json.lastRun.buildId, 'rev4', 'suite runs update each item\'s lastRun');

    // 7. The vault stops being green when the bug comes back.
    bugPresent = true;
    const regress = await call('POST', '/v1/suites', { name: 'regress', items: [{ vault: { status: ['ACTIVE'] } }], failFast: true, order: 'impact', impact: { changedFiles: ['src/cart/x.ts'] } });
    do {
      state = (await call('GET', `/v1/suites/${regress.json.suiteRunId}?wait=20`)).json;
    } while (state.status === 'running');
    assert.deepEqual([state.verdict, state.exitCode], ['red', 1]);
    assert.deepEqual(state.variants.map((v: { status: string }) => v.status), ['failed', 'notRun'], 'failFast stops at the regression');
  } finally {
    await new Promise<void>((resolve) => api.close(() => resolve()));
    await new Promise<void>((resolve) => site.server.close(() => resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
