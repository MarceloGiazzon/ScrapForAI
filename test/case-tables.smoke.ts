import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// T5.5 tables of cases end to end (real Chromium): a page computes a total (Brazilian format) with a deliberate boundary bug at quantity >= 1000.
// A stored CSV table (semicolons, decimal commas, as a spreadsheet saves it) holds each case: the quantity and price to type AND the total the page
// must show. A routine reads both from the same row; a suite with one sample per row finds the failing row; a pinned version stays reproducible
// after the table changes; a routine that includes another one keeps the reference.

const site = await new Promise<{ server: http.Server; origin: string }>((resolve) => {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><meta charset="utf-8"><title>T</title>
<input id="price"><input id="qty"><div id="out"></div>
<script>
  function fmt(n) { const s = Math.abs(n).toFixed(2).replace('.', ','); return (n < 0 ? '-' : '') + 'R$ ' + s.replace(/\\B(?=(\\d{3})+(?!\\d))/g, '.'); }
  function calc() {
    const p = Number(document.getElementById('price').value), q = Number(document.getElementById('qty').value);
    let total = Math.round(p * q * 1.1 * 100) / 100;
    if (q >= 1000) total -= 1; // the bug
    document.getElementById('out').textContent = fmt(total);
  }
  document.getElementById('qty').oninput = calc;
</script>`);
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-tables-smoke-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = site.origin;
process.env.ALLOWED_RESOURCE_ORIGINS = site.origin;

const { saveTarget } = await import('../src/targets/targetStore.js');
const { saveRoutine, runLibraryRoutine } = await import('../src/library/routineService.js');
const { saveCaseTable } = await import('../src/tables/caseTableService.js');
const { startSuite, waitForSuite } = await import('../src/orchestrator/suiteRunner.js');
const { suiteRequestSchema } = await import('../src/schemas/suiteRequest.schema.js');

after(async () => {
  await new Promise<void>((resolve) => site.server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// 10.50 * qty * 1.1, rounded to cents, as the page prints it (the page is wrong from quantity 1000 on).
const CASES = 'qty;price;total\n1;10.50;11,55\n3;10.50;34,65\n999;10.50;11.538,45\n1000;10.50;11.550,00\n2500;10.50;28.875,00\n';

const ref = (column: string, version?: number) => ({ id: 'shop-cases', column, ...(version ? { version } : {}) });
const steps = (version?: number) => [
  { id: 'open', action: 'goto', url: `${site.origin}/` },
  { id: 'price', action: 'fill', selector: '#price', valueFromParameter: 'price' },
  { id: 'qty', action: 'fill', selector: '#qty', valueFromParameter: 'qty' },
  { id: 'read', action: 'extractText', selector: '#out', name: 'total' },
  { id: 'check', action: 'assertEquals', actual: { extracted: 'total' }, expected: { table: ref('total', version) }, locale: 'pt' },
];
const params = (version?: number) => [
  { name: 'qty', fromTable: ref('qty', version) },
  { name: 'price', fromTable: ref('price', version) },
];

async function runSuite(body: Record<string, unknown>) {
  const started = await startSuite(suiteRequestSchema.parse({ name: 'tables', ...body }), 'system');
  const state = await waitForSuite(started.suiteRunId, 90_000);
  assert.equal(state?.status, 'completed', JSON.stringify(state?.variants));
  return state!;
}

test('a routine reads its inputs and its expected total from the same row of a table', async () => {
  await saveTarget({
    id: 'shop', name: 'Shop', platform: 'generic', environment: 'dev', baseUrl: `${site.origin}/`, credentialSets: [],
    noiseFilters: [], surfaces: {}, screens: [], flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  });
  const saved = await saveCaseTable('shop-cases', { title: 'Shop totals', csv: CASES });
  assert.equal(saved.table.version, 1);
  await saveRoutine('shop-table', { title: 'shop table', targetProfile: 'shop', parameters: params() as never, steps: steps() as never });

  for (const sample of [0, 1, 2]) {
    const ok = await runLibraryRoutine('shop-table', undefined, { sample }, { initiator: 'system' });
    assert.equal(ok.status, 'passed', `row ${sample}: ${JSON.stringify(ok.error)}`);
  }
  const first = await runLibraryRoutine('shop-table', undefined, { sample: 0 }, { initiator: 'system' });
  assert.equal(first.parameters?.values.qty, '1');
  assert.equal(first.parameters?.sources.qty?.source, 'case');
  assert.match(String(first.extracted.total), /^R\$ 11,55$/);
  assert.deepEqual(first.tables, [{ id: 'shop-cases', version: 1, sha256: saved.table.sha256, rows: 5 }], 'the result says which table version it ran against');

  const bad = await runLibraryRoutine('shop-table', undefined, { sample: 3 }, { initiator: 'system' });
  assert.equal(bad.status, 'failed');
  assert.equal(bad.parameters?.values.qty, '1000');
  assert.match(bad.error?.message ?? '', /assertEquals: total is 11549 but 11\.550,00 gives 11550 \(difference 1/);
  assert.equal(bad.failedStepIndex, 4, 'the failing step is the check of that row');

  const wrapped = await runLibraryRoutine('shop-table', undefined, { sample: 5 }, { initiator: 'system' });
  assert.equal(wrapped.parameters?.values.qty, '1', 'sample 5 of 5 rows is row 0, as with any cases');
  assert.equal(wrapped.status, 'passed');
});

test('a suite with one sample per row reports the failing row, and what each row typed and showed', async () => {
  const state = await runSuite({ samples: 5, items: [{ routineId: 'shop-table' }] });
  assert.equal(state.verdict, 'red');
  assert.equal(state.total, 5);
  const rows = state.variants;
  assert.deepEqual(rows.map((row) => row.sample), [0, 1, 2, 3, 4]);
  assert.deepEqual(rows.map((row) => row.parameters?.qty), ['1', '3', '999', '1000', '2500']);
  assert.deepEqual(rows.map((row) => row.status), ['passed', 'passed', 'passed', 'failed', 'failed']);
  assert.equal(rows[2]!.extracted?.total, 'R$ 11.538,45');
});

test('a pinned version stays reproducible after the table changes; an unpinned routine follows the current one', async () => {
  await saveRoutine('shop-pinned', { title: 'pinned', targetProfile: 'shop', parameters: params(1) as never, steps: steps(1) as never });
  // Version 2 fixes the expectation of the buggy rows to what the page shows (a person decided the page is right).
  const second = await saveCaseTable('shop-cases', { csv: CASES.replace('11.550,00', '11.549,00').replace('28.875,00', '28.874,00') });
  assert.equal(second.table.version, 2);

  const pinned = await runLibraryRoutine('shop-pinned', undefined, { sample: 3 }, { initiator: 'system' });
  assert.equal(pinned.status, 'failed', 'version 1 still expects 11.550,00');
  assert.equal(pinned.tables?.[0]?.version, 1);

  const current = await runLibraryRoutine('shop-table', undefined, { sample: 3 }, { initiator: 'system' });
  assert.equal(current.status, 'passed', 'the current version expects what the page shows');
  assert.equal(current.tables?.[0]?.version, 2);
});

test('an included routine keeps its table reference through the rename of its parameters', async () => {
  await saveRoutine('shop-row', {
    title: 'shop row', targetProfile: 'shop', parameters: params(1) as never, steps: steps(1).slice(1) as never,
  });
  await saveRoutine('shop-includer', {
    title: 'includer', targetProfile: 'shop',
    steps: [{ id: 'open', action: 'goto', url: `${site.origin}/` }, { id: 'row', action: 'include', routineId: 'shop-row' }] as never,
  });
  const ok = await runLibraryRoutine('shop-includer', undefined, { sample: 1 }, { initiator: 'system' });
  assert.equal(ok.status, 'passed', JSON.stringify(ok.error));
  assert.deepEqual(Object.keys(ok.parameters?.values ?? {}).sort(), ['row_price', 'row_qty']);
  assert.equal(ok.parameters?.values.row_qty, '3');

  const bad = await runLibraryRoutine('shop-includer', undefined, { sample: 3 }, { initiator: 'system' });
  assert.equal(bad.status, 'failed');
  assert.match(bad.error?.message ?? '', /total is 11549 but 11\.550,00/);
});

test('saving a run as a routine keeps the references as written (never the cells), and parameterValues cannot be mixed with a table', async () => {
  const run = await runLibraryRoutine('shop-table', undefined, { sample: 1 }, { initiator: 'system' });
  assert.equal(run.status, 'passed');
  const copy = await saveRoutine('shop-from-run', { fromJobId: run.jobId, title: 'copy of a table run' } as never);
  const stored = copy.routine as unknown as { parameters: unknown; steps: Array<{ expected?: unknown }> };
  assert.deepEqual(stored.parameters, params(), 'the table references, not the cases of the table');
  assert.deepEqual(stored.steps.at(-1)?.expected, { table: ref('total') }, 'the expectation still points at the table, not at the cell of row 1');
  assert.ok(!JSON.stringify(stored).includes('34,65'), 'no cell was copied into the routine');

  await assert.rejects(
    runLibraryRoutine('shop-table', undefined, { parameterValues: { qty: '5' } }, { initiator: 'system' }),
    (error: Error & { status?: number }) => error.status === 400 && /table of cases/.test(error.message),
  );
});
