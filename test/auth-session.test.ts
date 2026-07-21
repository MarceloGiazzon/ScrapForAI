import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const TEST_API_KEY = 'test-api-key-1234567890';

// Isolate all writes (runs.jsonl, artifacts) from the developer's real data directory.
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-test-'));

process.env.SCRAPFORAI_API_KEY ??= TEST_API_KEY;
process.env.SCRAPFORAI_DATA_DIR = testDataDir;
process.env.ALLOWED_TARGET_ORIGINS ??= 'https://dev.example.com';
process.env.ALLOWED_RESOURCE_ORIGINS ??= 'https://dev.example.com';
process.env.CORS_ALLOWED_ORIGINS ??= 'http://localhost:3000';

const express = (await import('express')).default;
const { env } = await import('../src/config/env.js');
const { isPathInside, resolveArtifactPath } = await import('../src/artifacts/artifactStore.js');
const { apiAuth } = await import('../src/security/apiAuth.js');
const { authRouter } = await import('../src/routes/auth.routes.js');
const { configRouter } = await import('../src/routes/config.routes.js');
const { runsRouter } = await import('../src/routes/runs.routes.js');

/**
 * Mirrors the middleware order in src/server.ts. The real server module cannot be imported
 * here because it opens a listener at import time.
 */
function createTestApp(): import('express').Express {
  const app = express();
  app.use(express.json());
  app.use(apiAuth);
  app.use('/v1/auth', authRouter);
  app.use('/v1/runs', runsRouter);
  app.use('/v1/config', configRouter);
  return app;
}

let server: http.Server;
let baseUrl: string;

before(async () => {
  server = createTestApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));

  const address = server.address();
  assert.ok(address && typeof address === 'object', 'server must bind a TCP port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

/** Issues a request with a RAW path, bypassing the URL normalization fetch() performs. */
function rawRequest(rawPath: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const { port } = server.address() as { port: number };
    const request = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET', headers }, (response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

const bearer = { Authorization: `Bearer ${env.SCRAPFORAI_API_KEY}` };

test('unauthenticated requests to the run history are rejected', async () => {
  const response = await fetch(`${baseUrl}/v1/runs`);
  assert.equal(response.status, 401);
});

test('a valid bearer token grants access to the run history', async () => {
  const response = await fetch(`${baseUrl}/v1/runs`, { headers: bearer });
  assert.equal(response.status, 200);

  const payload = (await response.json()) as { items: unknown[] };
  assert.ok(Array.isArray(payload.items));
});

test('login with a wrong key fails and sets no cookie', async () => {
  const response = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: 'definitely-not-the-key' }),
  });

  assert.equal(response.status, 401);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('login with the correct key issues an HttpOnly SameSite=Strict cookie', async () => {
  const response = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: env.SCRAPFORAI_API_KEY }),
  });

  assert.equal(response.status, 200);

  const setCookie = response.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /sfa_session=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
});

/** Logs in and returns the raw Cookie header value for reuse. */
async function loginCookie(): Promise<string> {
  const response = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: env.SCRAPFORAI_API_KEY }),
  });

  const setCookie = response.headers.get('set-cookie') ?? '';
  return setCookie.split(';')[0] ?? '';
}

test('a session cookie grants access to the run history', async () => {
  const cookie = await loginCookie();

  const response = await fetch(`${baseUrl}/v1/runs`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
});

test('a cookie-authenticated write without the UI header is refused as CSRF', async () => {
  const cookie = await loginCookie();

  const response = await fetch(`${baseUrl}/v1/config`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ updates: { LOG_LEVEL: 'info' } }),
  });

  assert.equal(response.status, 403);

  const payload = (await response.json()) as { error: { type: string } };
  assert.equal(payload.error.type, 'CsrfProtection');
});

test('a cookie session cannot change a locked field even with the UI header', async () => {
  const cookie = await loginCookie();

  const response = await fetch(`${baseUrl}/v1/config`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-ScrapForAI-UI': '1' },
    body: JSON.stringify({ updates: { ALLOW_EVALUATE: 'true' } }),
  });

  assert.equal(response.status, 400);

  const payload = (await response.json()) as { error: { details: Array<{ path: string }> } };
  assert.equal(payload.error.details[0]?.path, 'ALLOW_EVALUATE');
});

test('artifact paths cannot escape the artifact root', async () => {
  // The primitive itself: a sibling directory sharing a prefix must NOT be considered inside.
  assert.equal(isPathInside('/app/artifacts', '/app/artifacts'), true);
  assert.equal(isPathInside('/app/artifacts', '/app/artifacts/job1/shot.png'), true);
  assert.equal(isPathInside('/app/artifacts', '/app/artifacts-evil/secret'), false);
  assert.equal(isPathInside('/app/artifacts', '/app'), false);

  assert.equal(resolveArtifactPath('../../../.env'), undefined);
  assert.equal(resolveArtifactPath('job1/../../../../etc/passwd'), undefined);
  assert.ok(resolveArtifactPath('job1/screenshots/a.png'));
});

test('traversal through the artifact route never returns file contents', async () => {
  const attempts = [
    '/v1/runs/abc/artifacts/../../../.env',
    '/v1/runs/abc/artifacts/..%2f..%2f..%2f.env',
    '/v1/runs/abc/artifacts/..%2f..%2f..%2fpackage.json',
    '/v1/runs/abc/artifacts/%2e%2e%2f%2e%2e%2fpackage.json',
  ];

  for (const attempt of attempts) {
    const { status, body } = await rawRequest(attempt, bearer);

    assert.ok([400, 404].includes(status), `${attempt} returned ${status}, expected 400 or 404`);
    assert.doesNotMatch(body, /SCRAPFORAI_API_KEY/, `${attempt} leaked .env contents`);
    assert.doesNotMatch(body, /"dependencies"/, `${attempt} leaked package.json contents`);
  }
});
