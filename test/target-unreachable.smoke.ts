import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// First-use review, item 5: a target that is not running used to come back as `type: "Error"` with Playwright's call log, which reads like a ScrapForAI defect.
// Real Chromium against (a) a port nothing listens on, (b) a server that accepts the connection and never answers, (c) a healthy page as the control.

/** A port nothing listens on: bind, note the number, close. */
const deadPort = await new Promise<number>((resolve) => {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address() as AddressInfo;
    probe.close(() => resolve(port));
  });
});

const live = await new Promise<{ server: http.Server; origin: string }>((resolve) => {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/hang')) return; // accepts the request, never answers
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>Alive</title><h1>hello</h1>');
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
});
const deadOrigin = `http://127.0.0.1:${deadPort}`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-unreachable-smoke-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = `${live.origin},${deadOrigin}`;
process.env.ALLOWED_RESOURCE_ORIGINS = `${live.origin},${deadOrigin}`;

const { inspectDom } = await import('../src/runner/inspectDom.js');
const { resolveExplorationRequest } = await import('../src/runner/resolveRequest.js');
const { runExploration } = await import('../src/runner/runExploration.js');
const { domInspectionRequestSchema } = await import('../src/schemas/domInspectionRequest.schema.js');
const { explorationRequestSchema } = await import('../src/schemas/explorationRequest.schema.js');

after(async () => {
  live.server.closeAllConnections();
  await new Promise<void>((resolve) => live.server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function run(targetUrl: string, steps: unknown[]) {
  const request = explorationRequestSchema.parse({ targetUrl, steps });
  return runExploration(await resolveExplorationRequest(request));
}

function assertPlainSentence(message: string): void {
  for (const raw of ['Call log', 'page.goto', 'net::', 'at Object.', 'node_modules']) {
    assert.ok(!message.includes(raw), `the message leaks Playwright internals ("${raw}"): ${message}`);
  }
}

test('inspect-dom on a port nothing listens on: TargetUnreachable, with the origin and what to check', async () => {
  const result = await inspectDom(domInspectionRequestSchema.parse({ targetUrl: `${deadOrigin}/some/page?token=abc123` }));
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.type, 'TargetUnreachable');
  assert.ok(result.error?.message.includes(deadOrigin), `names the origin: ${result.error?.message}`);
  assert.match(result.error?.message ?? '', /connection refused/);
  assert.match(result.error?.message ?? '', /application under test is running/);
  assertPlainSentence(result.error?.message ?? '');
  assert.ok(!(result.error?.message ?? '').includes('abc123'), 'the query never reaches the message');
  assert.ok(!(result.error?.message ?? '').includes('/some/page'), 'neither does the path');
});

test('a run whose goto hits a dead port: the step and the run both say TargetUnreachable', async () => {
  const result = await run(`${deadOrigin}/`, [{ id: 'open', action: 'goto', url: '$targetUrl' }]);
  assert.equal(result.status, 'failed');
  assert.equal(result.steps[0]?.status, 'failed');
  assert.equal(result.steps[0]?.error?.type, 'TargetUnreachable');
  assert.equal(result.error?.type, 'TargetUnreachable');
  assert.ok(result.error?.message.includes(deadOrigin));
  assertPlainSentence(result.error?.message ?? '');
  assert.equal(result.failedStepIndex, 0);
});

test('a server that accepts and never answers: TargetNavigationTimeout, with the limit', async () => {
  const result = await run(`${live.origin}/`, [{ id: 'open', action: 'goto', url: `${live.origin}/hang`, timeoutMs: 1000 }]);
  assert.equal(result.status, 'failed');
  assert.equal(result.steps[0]?.error?.type, 'TargetNavigationTimeout');
  assert.match(result.steps[0]?.error?.message ?? '', /within 1000 ms/);
  assertPlainSentence(result.steps[0]?.error?.message ?? '');
});

test('control: a target that answers is untouched, and a timeout on a click is NOT blamed on the target', async () => {
  const passed = await run(`${live.origin}/`, [{ id: 'open', action: 'goto', url: '$targetUrl' }, { id: 'see', action: 'assertTextContains', selector: 'h1', text: 'hello' }]);
  assert.equal(passed.status, 'passed');
  assert.equal(passed.error, undefined);

  const missing = await run(`${live.origin}/`, [{ id: 'open', action: 'goto', url: '$targetUrl' }, { id: 'press', action: 'click', selector: '#nope', timeoutMs: 500 }]);
  assert.equal(missing.status, 'failed');
  assert.ok(!/^Target/.test(missing.steps[1]?.error?.type ?? ''), `a missing element is not a target problem: ${missing.steps[1]?.error?.type}`);
});

test('inspect-dom on a healthy page still passes', async () => {
  const result = await inspectDom(domInspectionRequestSchema.parse({ targetUrl: `${live.origin}/` }));
  assert.equal(result.status, 'passed');
  assert.equal(result.title, 'Alive');
});
