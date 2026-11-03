import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// T3.1 end to end (real Chromium): the build the app reports is read after the run, by each kind of probe, never fails the
// run, never beats a build id the caller gave, and reaches the result and the history summary.

const site = await new Promise<{ server: http.Server; origin: string }>((resolve) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('x-app-build', 'rev 4519 (rc1)');
    if (url.pathname === '/api/version') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ app: { releases: [{ id: '2026.11/rc2' }] } }));
    }
    if (url.pathname === '/moved') {
      res.writeHead(302, { location: '/api/version' });
      return res.end();
    }
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>T</title><h1 id="t">Hello</h1><footer><span id="ver">v 7.3.1</span></footer>');
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-build-smoke-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts'); // .env may pin it
process.env.ALLOWED_TARGET_ORIGINS = site.origin;
process.env.ALLOWED_RESOURCE_ORIGINS = site.origin;

const { saveTarget } = await import('../src/targets/targetStore.js');
const { resolveExplorationRequest } = await import('../src/runner/resolveRequest.js');
const { runExploration } = await import('../src/runner/runExploration.js');
const { explorationRequestSchema } = await import('../src/schemas/explorationRequest.schema.js');
const { summarizeResult } = await import('../src/history/summarizeResult.js');

after(async () => {
  await new Promise<void>((resolve) => site.server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function runAgainst(buildInfo: unknown, extra: Record<string, unknown> = {}) {
  await saveTarget({
    id: 'fixture', name: 'Fixture', platform: 'generic', environment: 'dev', baseUrl: `${site.origin}/`, credentialSets: [],
    ...(buildInfo ? { buildInfo } : {}),
    noiseFilters: [], surfaces: {}, screens: [], flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  } as never);
  const request = explorationRequestSchema.parse({
    targetProfile: 'fixture',
    steps: [{ id: 'open', action: 'goto', url: '$targetUrl' }, { id: 'h', action: 'assertVisible', selector: '#t' }],
    ...extra,
  });
  return runExploration(await resolveExplorationRequest(request));
}

test('httpHeader: the header of the base URL is the build (made safe for a build id)', async () => {
  const result = await runAgainst({ kind: 'httpHeader', header: 'X-App-Build' });
  assert.equal(result.status, 'passed');
  assert.deepEqual([result.buildId, result.buildIdSource], ['rev_4519_rc1', 'probe']);
  const summary = summarizeResult(result);
  assert.deepEqual([summary.buildId, summary.buildIdSource], ['rev_4519_rc1', 'probe']);
});

test('jsonEndpoint: a path into the JSON answer; a redirecting endpoint is not followed', async () => {
  const found = await runAgainst({ kind: 'jsonEndpoint', url: '/api/version', jsonPath: 'app.releases[0].id' });
  assert.deepEqual([found.buildId, found.buildIdSource], ['2026.11/rc2', 'probe']);

  const redirected = await runAgainst({ kind: 'jsonEndpoint', url: '/moved', jsonPath: 'app.releases[0].id' });
  assert.deepEqual([redirected.status, redirected.buildId, redirected.buildIdSource], ['passed', 'unknown', 'unknown']);
});

test('selectorText: the text of an element on a page', async () => {
  const result = await runAgainst({ kind: 'selectorText', url: '/', selector: '#ver' });
  assert.deepEqual([result.buildId, result.buildIdSource], ['v_7.3.1', 'probe']);
  assert.ok(result.evidence.screenshots.length === 0 && result.evidence.network.every((entry) => !entry.url.includes('/api/version')), 'the probe adds nothing to the run evidence');
});

test('a probe that cannot answer is "unknown" and never fails the run (missing header, missing element, a URL outside the allowlist)', async () => {
  for (const info of [
    { kind: 'httpHeader', header: 'x-nope' },
    { kind: 'selectorText', url: '/', selector: '#nope' },
    { kind: 'jsonEndpoint', url: 'http://169.254.169.254/latest/meta-data', jsonPath: 'a' },
    { kind: 'jsonEndpoint', url: '/api/version', jsonPath: 'app.nothing' },
  ]) {
    const result = await runAgainst(info);
    assert.equal(result.status, 'passed', JSON.stringify(info));
    assert.deepEqual([result.buildId, result.buildIdSource], ['unknown', 'unknown'], JSON.stringify(info));
  }
});

test('a build id the caller gave wins and is not probed; "provided" and no buildInfo leave the result without one', async () => {
  const given = await runAgainst({ kind: 'httpHeader', header: 'x-app-build' }, { buildId: 'ci-123' });
  assert.deepEqual([given.buildId, given.buildIdSource], ['ci-123', 'provided']);

  const provided = await runAgainst({ kind: 'provided' });
  assert.equal(provided.buildId, undefined);
  assert.equal(provided.buildIdSource, undefined);

  const none = await runAgainst(undefined);
  assert.equal(none.buildId, undefined);
});
