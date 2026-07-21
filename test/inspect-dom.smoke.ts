import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Serve a tiny fixture on 127.0.0.1 and allowlist its EXACT origin BEFORE importing
// inspectDom: src/config/env.ts parses process.env once at import time, and an
// explicitly-allowlisted origin bypasses the private-IP block in validateTargetUrl.
test('inspect-dom returns a DOM snapshot (regression: esbuild __name ReferenceError)', async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(
      '<!doctype html><html><head><title>Fixture</title></head>' +
        '<body><form id="f"><input name="email" type="email"></form>' +
        '<button id="go">Go</button></body></html>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  process.env.SCRAPFORAI_API_KEY = process.env.SCRAPFORAI_API_KEY ?? 'test-key-1234567890';
  process.env.ALLOWED_TARGET_ORIGINS = origin;
  process.env.ALLOWED_RESOURCE_ORIGINS = origin;

  const { inspectDom } = await import('../src/runner/inspectDom.js');
  try {
    const result = await inspectDom({
      targetUrl: `${origin}/`,
      waitUntil: 'load',
      timeoutMs: 10000,
      includeRenderedHtml: false,
      includeHiddenControls: true,
      includeConsole: true,
      includeNetwork: false,
      redactSensitiveValues: true,
    });
    assert.equal(result.status, 'passed', `inspect-dom failed: ${JSON.stringify(result.error)}`);
    assert.equal(result.title, 'Fixture');
    assert.ok(result.allControls.some((c) => c.name === 'email'), 'expected the email input in the snapshot');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
