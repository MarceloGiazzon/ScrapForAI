import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// T5.5 end to end (real Chromium): a page computes a total and prints it in the Brazilian format; the oracle recomputes it from the same
// parameters and compares. The fixture has a deliberate boundary bug (quantity >= 1000 loses one cent... one unit), so the oracle must
// pass on small samples and fail, saying by how much, on the large one. Also: a formula in an included routine follows the parameter rename.

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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-oracle-smoke-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = site.origin;
process.env.ALLOWED_RESOURCE_ORIGINS = site.origin;

const { saveTarget } = await import('../src/targets/targetStore.js');
const { saveRoutine, runLibraryRoutine } = await import('../src/library/routineService.js');

after(async () => {
  await new Promise<void>((resolve) => site.server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const calcSteps = (expr: string) => [
  { id: 'open', action: 'goto', url: `${site.origin}/` },
  { id: 'price', action: 'fill', selector: '#price', valueFromParameter: 'price' },
  { id: 'qty', action: 'fill', selector: '#qty', valueFromParameter: 'qty' },
  { id: 'read', action: 'extractText', selector: '#out', name: 'total' },
  { id: 'check', action: 'assertEquals', actual: { extracted: 'total' }, expected: { expr }, locale: 'pt' },
];
const PRICE = { name: 'price', cases: ['10.50'] };
const FORMULA = 'round(price * qty * 1.1, 2)';

test('the oracle passes on correct totals, in the page\'s own number format, and names the gap when the page is wrong', async () => {
  await saveTarget({
    id: 'shop', name: 'Shop', platform: 'generic', environment: 'dev', baseUrl: `${site.origin}/`, credentialSets: [],
    noiseFilters: [], surfaces: {}, screens: [], flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  });
  await saveRoutine('shop-total', {
    title: 'shop total', targetProfile: 'shop',
    parameters: [PRICE, { name: 'qty', cases: ['1', '3', '999', '1000', '2500'] }] as never,
    steps: calcSteps(FORMULA) as never,
  });

  for (const sample of [0, 1, 2]) {
    const ok = await runLibraryRoutine('shop-total', undefined, { seed: 's', sample });
    assert.equal(ok.status, 'passed', `sample ${sample}: ${JSON.stringify(ok.error)}`);
  }

  const first = await runLibraryRoutine('shop-total', undefined, { seed: 's', sample: 0 });
  assert.match(String(first.extracted.total), /^R\$ 11,55$/, 'the page prints the Brazilian format and the oracle still agrees');

  const bad = await runLibraryRoutine('shop-total', undefined, { seed: 's', sample: 3 });
  assert.equal(bad.status, 'failed');
  assert.equal(bad.parameters?.values.qty, '1000');
  assert.match(bad.error?.message ?? '', /assertEquals: total is 11549 but round\(price \* qty \* 1\.1, 2\) gives 11550 \(difference 1, tolerance 1e-9\); with price=10\.5, qty=1000/);

  const huge = await runLibraryRoutine('shop-total', undefined, { seed: 's', sample: 4 });
  assert.match(huge.error?.message ?? '', /total is 28874 but .* gives 28875/, 'the page printed "R$ 28.874,00": thousands separators are understood');
});

test('a tolerance absorbs a known difference; the same page then passes', async () => {
  await saveRoutine('shop-total-tolerant', {
    title: 'tolerant', targetProfile: 'shop',
    parameters: [PRICE, { name: 'qty', cases: ['1000'] }] as never,
    steps: calcSteps(FORMULA).map((step) => (step.action === 'assertEquals' ? { ...step, tolerance: { absolute: 1 } } : step)) as never,
  });
  const result = await runLibraryRoutine('shop-total-tolerant', undefined, {});
  assert.equal(result.status, 'passed', JSON.stringify(result.error));
});

test('an expression that cannot be read is refused when the routine is saved, not when it runs', async () => {
  await assert.rejects(
    saveRoutine('broken-formula', { title: 'broken', targetProfile: 'shop', parameters: [PRICE] as never, steps: calcSteps('price *') as never }),
    (error: Error & { status?: number }) => error.status === 400 || /expression/i.test(error.message),
  );
});

test('a formula in an included routine follows the rename of its parameters; two includes draw independently', async () => {
  await saveRoutine('shop-check', {
    title: 'shop check', targetProfile: 'shop',
    parameters: [PRICE, { name: 'qty', cases: ['2', '4'] }] as never,
    steps: calcSteps(FORMULA).slice(1) as never,
  });
  await saveRoutine('shop-twice', {
    title: 'shop twice', targetProfile: 'shop',
    steps: [
      { id: 'open', action: 'goto', url: `${site.origin}/` },
      { id: 'one', action: 'include', routineId: 'shop-check' },
      { id: 'two', action: 'include', routineId: 'shop-check' },
    ] as never,
  });

  const result = await runLibraryRoutine('shop-twice', undefined, { seed: 'x', sample: 1 });
  assert.equal(result.status, 'passed', JSON.stringify(result.error));
  assert.deepEqual(Object.keys(result.parameters?.values ?? {}).sort(), ['one_price', 'one_qty', 'two_price', 'two_qty']);
  assert.equal(result.steps.filter((step) => step.action === 'assertEquals' && step.status === 'passed').length, 2);
});
