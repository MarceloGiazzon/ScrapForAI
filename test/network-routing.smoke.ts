import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// T5.1 end to end (real Chromium). A page on the allowed origin pulls an image, a stylesheet and a fetch from ANOTHER origin that
// is not on any allowlist. With BLOCK_UNEXPECTED_RESOURCES=true the other origin must never be reached, the blocked requests are
// reported with handledBy, and they are NOT counted as the application's network failures. Without the guard the behaviour is
// what it has always been: reported, not blocked.

const hits: string[] = [];
const other = await new Promise<{ server: http.Server; origin: string }>((resolve) => {
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('content-type', req.url?.endsWith('.css') ? 'text/css' : 'image/gif');
    res.end(req.url?.endsWith('.css') ? 'h1{color:red}' : Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
});

const site = await new Promise<{ server: http.Server; origin: string }>((resolve) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/own.png') {
      res.setHeader('content-type', 'image/gif');
      return res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
    }
    res.setHeader('content-type', 'text/html');
    res.end(
      `<!doctype html><title>T</title><link rel="stylesheet" href="${other.origin}/style.css"><h1 id="t">Hello</h1>` +
        `<img id="own" src="/own.png"><img id="ext" src="${other.origin}/pixel.gif">` +
        `<script>fetch('${other.origin}/beacon.gif').catch(function(){});</script>`,
    );
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-routing-smoke-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = site.origin;
process.env.ALLOWED_RESOURCE_ORIGINS = site.origin;
process.env.BLOCK_UNEXPECTED_RESOURCES = 'true';

const { resolveExplorationRequest } = await import('../src/runner/resolveRequest.js');
const { runExploration } = await import('../src/runner/runExploration.js');
const { explorationRequestSchema } = await import('../src/schemas/explorationRequest.schema.js');
const { createPlaywrightContext } = await import('../src/runner/playwrightContext.js');

after(async () => {
  await new Promise<void>((resolve) => site.server.close(() => resolve()));
  await new Promise<void>((resolve) => other.server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('guard on: the other origin is never reached, the blocks are reported with handledBy and are not network failures', async () => {
  hits.length = 0;
  const request = explorationRequestSchema.parse({
    targetUrl: `${site.origin}/`,
    steps: [{ id: 'open', action: 'goto', url: `${site.origin}/` }, { id: 'settle', action: 'waitForTimeout', timeoutMs: 500 }, { id: 'h', action: 'assertVisible', selector: '#t' }],
  });
  const result = await runExploration(await resolveExplorationRequest(request));

  assert.equal(result.status, 'passed', JSON.stringify(result.error));
  assert.deepEqual(hits, [], 'not one request reached the origin outside the allowlist');

  const routing = result.evidence.routing ?? [];
  assert.deepEqual(routing.map((entry) => [entry.pathname, entry.resourceType, entry.handledBy, entry.action]).sort(), [
    ['/beacon.gif', 'fetch', 'allowlist-guard', 'abort'],
    ['/pixel.gif', 'image', 'allowlist-guard', 'abort'],
    ['/style.css', 'stylesheet', 'allowlist-guard', 'abort'],
  ]);
  assert.ok(routing.every((entry) => entry.origin === other.origin));

  // reported (the evidence the guard exists to give) ...
  assert.deepEqual(result.evidence.unexpectedExternalRequests.map((entry) => entry.pathname).sort(), ['/beacon.gif', '/pixel.gif', '/style.css']);
  // ... but a deliberate block is not the application failing
  assert.deepEqual(result.evidence.networkFailures, []);
  assert.ok(!result.evidence.network.some((entry) => entry.failureText), 'no requestfailed entry for a request we aborted');
});

test('guard on: the allowed origin is untouched (its image loads, nothing of it is in routing)', async () => {
  const request = explorationRequestSchema.parse({
    targetUrl: `${site.origin}/`,
    steps: [{ id: 'open', action: 'goto', url: `${site.origin}/` }, { id: 'settle', action: 'waitForTimeout', timeoutMs: 300 }, { id: 'own', action: 'extractAttribute', selector: '#own', attribute: 'src', name: 'src' }],
  });
  const result = await runExploration(await resolveExplorationRequest(request));
  assert.equal(result.status, 'passed', JSON.stringify(result.error));
  assert.equal(result.extracted.src, '/own.png');
  assert.ok(!(result.evidence.routing ?? []).some((entry) => entry.pathname === '/own.png'));
});

test('guard off (per-context override): the same page reaches the other origin; nothing is installed, so nothing is recorded', async () => {
  hits.length = 0;
  const playwright = await createPlaywrightContext(true, undefined, { blockUnexpected: false });
  try {
    assert.equal(playwright.routing.active, false);
    await playwright.page.goto(`${site.origin}/`, { waitUntil: 'load' });
    await playwright.page.waitForTimeout(500);
    assert.ok(hits.length >= 2, `the other origin was reached: ${hits.join(', ')}`);
    assert.deepEqual(playwright.routing.entries, []);
  } finally {
    await playwright.close();
  }
});

test('guard on (per-context): a page cannot be loaded from, but may navigate to, an allowed origin; main-frame navigation is not the guard\'s job', async () => {
  hits.length = 0;
  const playwright = await createPlaywrightContext(true, undefined, { blockUnexpected: true });
  try {
    await playwright.page.goto(`${site.origin}/`, { waitUntil: 'load' });
    assert.equal(await playwright.page.locator('#t').innerText(), 'Hello');
    assert.deepEqual(hits, []);
    assert.equal(playwright.routing.entries.length, 3);
  } finally {
    await playwright.close();
  }
});
