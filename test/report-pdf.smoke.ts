import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Real Chromium: the PDF of a real run, in each language, and proof that the report page cannot load anything.

const API_KEY = 'test-api-key-1234567890';

test('PDF report of a real run: valid PDF in en/pt/es; the page under test cannot inject anything into it', async () => {
  const outbound: string[] = [];
  const site = await new Promise<{ server: http.Server; origin: string }>((resolve) => {
    const server = http.createServer((req, res) => {
      outbound.push(req.url ?? '');
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><title>Shop</title><h1 id="t">Total: 5</h1>');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-report-smoke-'));

  process.env.SCRAPFORAI_API_KEY = API_KEY;
  process.env.SCRAPFORAI_DATA_DIR = dataDir;
  process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
  process.env.ALLOWED_TARGET_ORIGINS = site.origin;
  process.env.ALLOWED_RESOURCE_ORIGINS = site.origin;

  const express = (await import('express')).default;
  const { apiAuth } = await import('../src/security/apiAuth.js');
  const { explorationRouter } = await import('../src/routes/exploration.routes.js');
  const { runsRouter } = await import('../src/routes/runs.routes.js');
  const { saveTarget } = await import('../src/targets/targetStore.js');

  await saveTarget({
    id: 'shop', name: 'Shop', platform: 'generic', environment: 'qa', baseUrl: `${site.origin}/`, credentialSets: [], noiseFilters: [], surfaces: {}, screens: [],
    flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  });

  const app = express();
  app.use(express.json());
  app.use(apiAuth);
  app.use('/v1/explorations', explorationRouter);
  app.use('/v1/runs', runsRouter);
  const api = app.listen(0);
  await new Promise<void>((resolve) => api.once('listening', resolve));
  const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` };

  try {
    const run = await fetch(`${apiUrl}/v1/explorations/run`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        targetProfile: 'shop', buildId: 'rev9', scenarioName: 'Cart <img src=http://evil.example/x.png>', options: { screenshots: 'always' },
        steps: [{ id: 'open', action: 'goto', url: '$targetUrl' }, { id: 'total', action: 'assertTextContains', selector: '#t', text: 'Total: 4', timeoutMs: 400 }],
      }),
    });
    const result = (await run.json()) as { jobId: string; status: string };
    assert.equal(result.status, 'failed');

    const pin = await fetch(`${apiUrl}/v1/runs/${result.jobId}/pin`, { method: 'POST', headers, body: JSON.stringify({ reason: 'report smoke' }) });
    assert.equal(pin.status, 200);

    const before = outbound.length;
    const sizes: Record<string, number> = {};
    for (const lang of ['en', 'pt', 'es']) {
      const response = await fetch(`${apiUrl}/v1/runs/${result.jobId}/report?format=pdf&lang=${lang}`, { headers });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.get('content-type'), 'application/pdf');
      const pdf = Buffer.from(await response.arrayBuffer());
      assert.equal(pdf.subarray(0, 5).toString(), '%PDF-', lang);
      assert.ok(pdf.subarray(-1024).toString('latin1').includes('%%EOF'), `${lang}: complete file`);
      assert.ok(pdf.length > 5_000, `${lang}: has real content (${pdf.length} bytes)`);
      sizes[lang] = pdf.length;
    }
    assert.equal(new Set(Object.values(sizes)).size, 3, 'each language renders different text');

    // Rendering the PDFs reached nobody: neither the site under test nor the host named in the hostile scenario name.
    assert.equal(outbound.length, before, 'building a report makes no request to the application');

    // The HTML form of the same report is what the PDF was printed from.
    const html = await (await fetch(`${apiUrl}/v1/runs/${result.jobId}/report?lang=en`, { headers })).text();
    assert.ok(html.includes('Signature valid') && html.includes('rev9') && !html.includes('<img src=http://evil'));
  } finally {
    await new Promise<void>((resolve) => api.close(() => resolve()));
    await new Promise<void>((resolve) => site.server.close(() => resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
