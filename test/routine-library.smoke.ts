import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// End-to-end (real Chromium): pinning a routine version runs THAT version, runs are tagged in the
// history, and a run's saved request never carries the credential values.

const API_KEY = 'test-api-key-1234567890';
const SENTINEL = 'S3NT1NEL-library-e2e-4d2b';

test('run a pinned version, see it in the history, and save a run without leaking its secret', async () => {
  const site = await new Promise<{ server: http.Server; origin: string }>((resolve) => {
    const server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><title>T</title><h1 id="t">Hello</h1><input id="p" type="password">');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-library-smoke-'));

  process.env.SCRAPFORAI_API_KEY = API_KEY;
  process.env.SCRAPFORAI_DATA_DIR = dataDir;
// .env may pin ARTIFACT_DIR; dotenv never overrides an existing variable, so this keeps evidence in the temp dir.
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
  process.env.SCRAPFORAI_VAULT_KEY = crypto.randomBytes(32).toString('base64');
  process.env.ALLOWED_TARGET_ORIGINS = site.origin;
  process.env.ALLOWED_RESOURCE_ORIGINS = site.origin;

  const express = (await import('express')).default;
  const { apiAuth } = await import('../src/security/apiAuth.js');
  const { routinesRouter } = await import('../src/routes/routines.routes.js');
  const { explorationRouter } = await import('../src/routes/exploration.routes.js');
  const { saveTarget } = await import('../src/targets/targetStore.js');
  const { saveCredentialSet } = await import('../src/vault/credentials/credentialVault.js');
  const { listRuns } = await import('../src/history/runHistoryStore.js');
  const { runsRouter } = await import('../src/routes/runs.routes.js');

  await saveTarget({
    id: 'fixture',
    name: 'Fixture',
    platform: 'generic',
    environment: 'dev',
    baseUrl: `${site.origin}/`,
    credentialSets: ['pw'],
    noiseFilters: [],
    surfaces: {},
    screens: [],
    flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  });
  await saveCredentialSet('pw', { boundOrigins: [site.origin], values: { loginPassword: SENTINEL }, tags: [] }, 'create');

  const app = express();
  app.use(express.json());
  app.use(apiAuth);
  app.use('/v1/routines', routinesRouter);
  app.use('/v1/explorations', explorationRouter);
  app.use('/v1/runs', runsRouter);
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

  try {
    const open = { id: 'open', action: 'goto', url: '$targetUrl' };
    await call('PUT', '/v1/routines/hello', { title: 'Hello', targetProfile: 'fixture', steps: [open, { id: 'x', action: 'extractText', selector: '#t', name: 'fromV1' }] });
    await call('PUT', '/v1/routines/hello', { title: 'Hello', targetProfile: 'fixture', steps: [open, { id: 'x', action: 'extractText', selector: '#t', name: 'fromV2' }] });

    // Pinned to v1 although v2 exists.
    const pinned = await call('POST', '/v1/routines/hello/run?version=1', {});
    assert.equal(pinned.status, 200, pinned.text);
    assert.deepEqual(Object.keys(pinned.json.extracted), ['fromV1']);
    assert.equal(pinned.json.routine.version, 1);

    // Default: the current version.
    const current = await call('POST', '/v1/routines/hello/run', {});
    assert.deepEqual(Object.keys(current.json.extracted), ['fromV2']);
    assert.equal(current.json.routine.version, 2);

    // The history records which routine and version ran.
    const { items: runs } = await listRuns({ limit: 10, offset: 0 });
    const byJob = new Map(runs.map((run) => [run.jobId, run]));
    assert.equal(byJob.get(pinned.json.jobId)?.routineId, 'hello');
    assert.equal(byJob.get(pinned.json.jobId)?.routineVersion, 1);
    assert.equal(byJob.get(current.json.jobId)?.routineVersion, 2);

    // Every real run writes a manifest that verifies; retention classes are honoured end to end (T1.5).
    const manifest = await call('GET', `/v1/runs/${current.json.jobId}/manifest`);
    assert.equal(manifest.status, 200, manifest.text);
    assert.equal(manifest.json.verification.ok, true);
    assert.equal(manifest.json.manifest.retention, 'ephemeral');
    assert.ok(manifest.json.manifest.files.some((file: { path: string }) => file.path === 'request.json'));

    const kept = await call('POST', '/v1/explorations/run', {
      targetProfile: 'fixture',
      options: { retention: 'standard' },
      steps: [open],
    });
    assert.equal(kept.status, 200, kept.text);
    assert.equal((await call('GET', `/v1/runs/${kept.json.jobId}/manifest`)).json.manifest.retention, 'standard');
    assert.equal((await listRuns({ limit: 20, offset: 0 })).items.find((run) => run.jobId === kept.json.jobId)?.retention, 'standard');

    // Pin a real run: it moves out of the artifact root, stays verifiable and is flagged in the history.
    const pin = await call('POST', `/v1/runs/${pinned.json.jobId}/pin`, { reason: 'smoke proof', ref: 'test:SMOKE-1' });
    assert.equal(pin.status, 200, pin.text);
    assert.ok(!fs.existsSync(path.join(dataDir, 'artifacts', pinned.json.jobId)));
    assert.equal((await call('GET', `/v1/runs/${pinned.json.jobId}/manifest`)).json.verification.ok, true);
    const detail = await call('GET', `/v1/runs/${pinned.json.jobId}`);
    assert.equal(detail.json.summary.pinned, true);
    assert.equal(detail.json.summary.retention, 'pinned');
    assert.equal(detail.json.evidenceAvailable, true, 'pinned evidence is served by the normal run endpoint');

    assert.equal((await call('POST', '/v1/routines/hello/run?version=7', {})).status, 404);
    assert.equal((await call('POST', '/v1/routines/missing/run', {})).status, 404);

    // A run that used a vault secret can be saved from its job id, and the stored request has no secret.
    const withSecret = await call('POST', '/v1/explorations/run', {
      targetProfile: 'fixture',
      credentialSet: 'pw',
      scenarioName: 'Type the password',
      steps: [open, { id: 'pw', action: 'fill', selector: '#p', valueFromCredential: 'loginPassword' }],
    });
    assert.equal(withSecret.status, 200, withSecret.text);

    const requestFile = path.join(dataDir, 'artifacts', withSecret.json.jobId, 'request.json');
    assert.ok(fs.existsSync(requestFile));
    assert.ok(!fs.readFileSync(requestFile, 'utf8').includes(SENTINEL));
    assert.ok(fs.readFileSync(requestFile, 'utf8').includes('"credentialSet": "pw"'), 'only the NAME of the set is kept');

    const saved = await call('PUT', '/v1/routines/typed', { fromJobId: withSecret.json.jobId });
    assert.equal(saved.status, 201, saved.text);

    const rerun = await call('POST', '/v1/routines/typed/run', {});
    assert.equal(rerun.status, 200, rerun.text);
    assert.equal(rerun.json.routine.id, 'typed');
    assert.ok(!rerun.text.includes(SENTINEL));

    const libraryOnDisk = fs.readdirSync(path.join(dataDir, 'library', 'typed')).map((name) => fs.readFileSync(path.join(dataDir, 'library', 'typed', name), 'utf8'));
    assert.ok(libraryOnDisk.every((content) => !content.includes(SENTINEL)));
  } finally {
    await new Promise<void>((resolve) => api.close(() => resolve()));
    await new Promise<void>((resolve) => site.server.close(() => resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
