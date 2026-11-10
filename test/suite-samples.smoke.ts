import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// T5.4 end to end (real Chromium): a suite with `samples` runs a parametric routine once per sample (edge values first, then random),
// the table records what each run was fed and what it extracted, one seed replays the whole table, and a routine with no
// parameters still runs once.

const site = await new Promise<{ server: http.Server; origin: string }>((resolve) => {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(
      '<!doctype html><meta charset="utf-8"><title>T</title><h1 id="t">Form</h1>' +
        '<input id="qty" oninput="document.getElementById(\'out\').textContent=this.value">' +
        '<div id="out"></div>',
    );
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-suite-samples-smoke-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = site.origin;
process.env.ALLOWED_RESOURCE_ORIGINS = site.origin;

const { saveTarget } = await import('../src/targets/targetStore.js');
const { saveRoutine } = await import('../src/library/routineService.js');
const { startSuite, waitForSuite } = await import('../src/orchestrator/suiteRunner.js');
const { suiteRequestSchema } = await import('../src/schemas/suiteRequest.schema.js');

after(async () => {
  await new Promise<void>((resolve) => site.server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const open = { id: 'open', action: 'goto', url: `${site.origin}/` };

async function runSuite(body: Record<string, unknown>) {
  const started = await startSuite(suiteRequestSchema.parse({ name: 'samples', ...body }), 'system');
  const state = await waitForSuite(started.suiteRunId, 60_000);
  assert.equal(state?.status, 'completed', JSON.stringify(state?.variants));
  return state!;
}

test('samples expand a parametric routine into edge values then random ones; a plain routine runs once', async () => {
  await saveTarget({
    id: 'samples-app', name: 'App', platform: 'generic', environment: 'dev', baseUrl: site.origin, credentialSets: [],
    noiseFilters: [], surfaces: {}, screens: [], flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  });
  await saveRoutine('qty-check', {
    title: 'qty check', targetProfile: 'samples-app',
    parameters: [{ name: 'qty', generator: { type: 'int', min: 1, max: 1_000_000 } }] as never,
    steps: [open, { id: 'type', action: 'fill', selector: '#qty', valueFromParameter: 'qty' }, { id: 'read', action: 'extractText', selector: '#out', name: 'typed' }] as never,
  });
  await saveRoutine('plain', { title: 'plain', targetProfile: 'samples-app', steps: [open] as never });

  const first = await runSuite({ samples: 6, seed: 'table-seed', items: [{ routineId: 'qty-check' }, { routineId: 'plain' }] });
  assert.equal(first.verdict, 'green', first.verdictReason);
  assert.equal(first.seed, 'table-seed');
  assert.equal(first.total, 7, '6 samples of the parametric routine + 1 run of the plain one');

  const rows = first.variants.filter((variant) => variant.routineId === 'qty-check');
  assert.deepEqual(rows.map((row) => row.sample), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(rows.slice(0, 5).map((row) => row.parameters?.qty), ['1', '0', '1000000', '1000001', '-1'], 'edge values first');
  for (const row of rows) assert.equal(row.extracted?.typed, row.parameters?.qty, 'what the page received is what the table says');

  const plain = first.variants.find((variant) => variant.routineId === 'plain')!;
  assert.deepEqual([plain.sample, plain.parameters, plain.extracted], [undefined, undefined, undefined]);

  // The same seed replays every row; another seed changes the random one.
  const again = await runSuite({ samples: 6, seed: 'table-seed', items: [{ routineId: 'qty-check' }] });
  assert.deepEqual(again.variants.map((row) => row.parameters), rows.map((row) => row.parameters));
  const other = await runSuite({ samples: 6, seed: 'another-seed', items: [{ routineId: 'qty-check' }] });
  assert.notEqual(other.variants[5]!.parameters?.qty, rows[5]!.parameters?.qty);
  assert.deepEqual(other.variants.slice(0, 5).map((row) => row.parameters?.qty), ['1', '0', '1000000', '1000001', '-1'], 'edges do not depend on the seed');
});
