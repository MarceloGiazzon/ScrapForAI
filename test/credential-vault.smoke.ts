import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// End-to-end (real Chromium): a vaulted secret is typed into the bound origin, is refused on a
// different allowlisted origin, and never shows up in the response, result.json or history.

const API_KEY = 'test-api-key-1234567890';
const SENTINEL = 'S3NT1NEL-e2e-vault-value-77c1';

function listen(handler: http.RequestListener): Promise<{ server: http.Server; origin: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

const page = (req: http.IncomingMessage, res: http.ServerResponse) => {
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><title>Login</title><input id="u" name="u"><input id="p" name="p" type="password"><button id="go">Go</button>');
};

function scan(dir: string, needle: string, skip: Set<string>): string[] {
  const hits: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      hits.push(...scan(full, needle, skip));
    } else if (!skip.has(entry.name) && fs.readFileSync(full).includes(needle)) {
      hits.push(full);
    }
  }
  return hits;
}

test('vault secret: bound origin works, other origin is refused, and the value never leaks', async () => {
  const bound = await listen(page);
  const other = await listen(page);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-vault-smoke-'));

  process.env.SCRAPFORAI_API_KEY = API_KEY;
  process.env.SCRAPFORAI_DATA_DIR = dataDir;
// .env may pin ARTIFACT_DIR; dotenv never overrides an existing variable, so this keeps evidence in the temp dir.
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
  process.env.ALLOW_EVALUATE = 'true'; // only to read the typed value back out of the page
  process.env.SCRAPFORAI_VAULT_KEY = crypto.randomBytes(32).toString('base64');
  process.env.ALLOWED_TARGET_ORIGINS = `${bound.origin},${other.origin}`;
  process.env.ALLOWED_RESOURCE_ORIGINS = `${bound.origin},${other.origin}`;

  const express = (await import('express')).default;
  const { apiAuth } = await import('../src/security/apiAuth.js');
  const { explorationRouter } = await import('../src/routes/exploration.routes.js');
  const { saveCredentialSet } = await import('../src/vault/credentials/credentialVault.js');

  await saveCredentialSet('e2e', { boundOrigins: [bound.origin], values: { loginUser: 'alice', loginPassword: SENTINEL }, tags: [] }, 'create');

  const app = express();
  app.use(express.json());
  app.use(apiAuth);
  app.use('/v1/explorations', explorationRouter);
  const api = app.listen(0);
  await new Promise<void>((resolve) => api.once('listening', resolve));
  const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  const run = async (routine: object) => {
    const response = await fetch(`${apiUrl}/v1/explorations/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(routine),
    });
    const text = await response.text();
    return { status: response.status, text, json: JSON.parse(text) as Record<string, any> };
  };

  try {
    // 1. Bound origin: the fill works. extractAttribute reads the value straight back out of the
    //    page (evaluate) to prove redaction catches it on the way out.
    const ok = await run({
      targetUrl: `${bound.origin}/`,
      credentialSet: 'e2e',
      steps: [
        { id: 'open', action: 'goto', url: '$targetUrl' },
        { id: 'user', action: 'fill', selector: '#u', valueFromCredential: 'loginUser' },
        { id: 'pass', action: 'fill', selector: '#p', valueFromCredential: 'loginPassword' },
        { id: 'read', action: 'evaluate', name: 'typed', script: "return document.querySelector('#p').value" },
      ],
    });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.status, 'passed');
    assert.equal(ok.json.extracted.typed, '[REDACTED]', 'the typed secret is redacted in the output');
    assert.ok(!ok.text.includes(SENTINEL));

    // 2. A different allowlisted origin: refused before anything is typed.
    const mismatch = await run({
      targetUrl: `${other.origin}/`,
      credentialSet: 'e2e',
      steps: [
        { id: 'open', action: 'goto', url: '$targetUrl' },
        { id: 'pass', action: 'fill', selector: '#p', valueFromCredential: 'loginPassword' },
      ],
    });
    assert.equal(mismatch.json.status, 'failed');
    assert.equal(mismatch.json.error.type, 'CredentialOriginMismatch');
    assert.ok(!mismatch.text.includes(SENTINEL));

    // 3. Navigating from the bound origin to the other one mid-routine is refused as well.
    const hop = await run({
      targetUrl: `${bound.origin}/`,
      credentialSet: 'e2e',
      steps: [
        { id: 'open', action: 'goto', url: '$targetUrl' },
        { id: 'go', action: 'goto', url: `${other.origin}/` },
        { id: 'pass', action: 'fill', selector: '#p', valueFromCredential: 'loginPassword' },
      ],
    });
    assert.equal(hop.json.error.type, 'CredentialOriginMismatch');

    // 4. An unknown set keeps its error contract.
    const unknown = await run({ targetUrl: `${bound.origin}/`, credentialSet: 'nope', steps: [{ action: 'reload' }] });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.error.type, 'CredentialSetNotFound');

    // 5. The sentinel is nowhere on disk except inside the encrypted vault file.
    await new Promise((resolve) => setTimeout(resolve, 200)); // let lastUsedAt writes settle
    assert.deepEqual(scan(dataDir, SENTINEL, new Set(['credentials.enc.json'])), [], 'no artifact, result.json or history file may contain the secret');
    assert.ok(fs.readdirSync(path.join(dataDir, 'history')).length > 0, 'history was written (so the scan above covered it)');
  } finally {
    await new Promise<void>((resolve) => api.close(() => resolve()));
    await new Promise<void>((resolve) => bound.server.close(() => resolve()));
    await new Promise<void>((resolve) => other.server.close(() => resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
