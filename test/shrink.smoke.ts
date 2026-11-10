import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// T5.6 end to end (real Chromium). A page computes a total and has a deliberate boundary bug: from quantity 1000 up it is one unit short.
// A routine with a random-ish quantity (edge values first) and an irrelevant text parameter fails on the first out-of-range sample; the
// shrinker must find the EXACT limit (fails with 1000, passes with 999), reset the irrelevant parameter, hand back a run that really failed
// with the minimal values, and that run must save into the vault as a SCENARIO with the values FIXED.

const site = await new Promise<{ server: http.Server; origin: string }>((resolve) => {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><meta charset="utf-8"><title>T</title>
<input id="price"><input id="qty"><input id="note"><div id="out"></div>
<script>
  document.getElementById('qty').oninput = function () {
    const p = Number(document.getElementById('price').value), q = Number(this.value);
    let total = Math.round(p * q * 1.1 * 100) / 100;
    if (q >= 1000) total -= 1; // the bug
    document.getElementById('out').textContent = String(total);
  };
</script>`);
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-shrink-smoke-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = site.origin;
process.env.ALLOWED_RESOURCE_ORIGINS = site.origin;
process.env.MAX_PARALLEL_JOBS = '3';

const { saveTarget } = await import('../src/targets/targetStore.js');
const { saveRoutine, runLibraryRoutine } = await import('../src/library/routineService.js');
const { startShrink, waitForShrink } = await import('../src/shrink/shrinkService.js');
const { shrinkRequestSchema } = await import('../src/schemas/shrink.schema.js');
const { addFromRun } = await import('../src/vault/regression/regressionFlows.js');
const { getRoutine } = await import('../src/library/routineLibrary.js');

after(async () => {
  await new Promise<void>((resolve) => site.server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const steps = [
  { id: 'open', action: 'goto', url: `${site.origin}/` },
  { id: 'price', action: 'fill', selector: '#price', valueFromParameter: 'price' },
  { id: 'note', action: 'fill', selector: '#note', valueFromParameter: 'note' },
  { id: 'qty', action: 'fill', selector: '#qty', valueFromParameter: 'qty' },
  { id: 'read', action: 'extractText', selector: '#out', name: 'total' },
  { id: 'check', action: 'assertEquals', actual: { extracted: 'total' }, expected: { expr: 'round(price * qty * 1.1, 2)' } },
];

async function shrinkAndWait(body: Record<string, unknown>) {
  const started = await startShrink(shrinkRequestSchema.parse(body), 'system');
  const state = await waitForShrink(started.shrinkId, 240_000);
  assert.equal(state?.status, 'completed', JSON.stringify(state));
  return state!;
}

test('the shrinker finds the exact limit of a boundary bug, ignores the irrelevant parameter, and its minimal run saves as a fixed SCENARIO', async () => {
  await saveTarget({
    id: 'shop', name: 'Shop', platform: 'generic', environment: 'dev', baseUrl: `${site.origin}/`, credentialSets: [],
    noiseFilters: [], surfaces: {}, screens: [], flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  });
  await saveRoutine('shop-total', {
    title: 'shop total', targetProfile: 'shop',
    parameters: [
      { name: 'price', cases: ['10.50'] },
      { name: 'note', generator: { type: 'string', minLength: 1, maxLength: 12, charset: 'alnum' } },
      { name: 'qty', generator: { type: 'int', min: 1, max: 5000 } },
    ] as never,
    steps: steps as never,
  });

  // Samples 0 and 1 (qty 1 and 0) pass; sample 2 is qty 5000, the first one over the limit.
  assert.equal((await runLibraryRoutine('shop-total', undefined, { seed: 'S', sample: 1 }, { initiator: 'system' })).status, 'passed');
  const failed = await runLibraryRoutine('shop-total', undefined, { seed: 'S', sample: 2 }, { initiator: 'system' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.parameters?.values.qty, '5000');

  // From the failed run's evidence.
  const state = await shrinkAndWait({ fromJobId: failed.jobId, maxShrinkRuns: 40 });
  assert.equal(state.outcome, 'minimal', JSON.stringify(state.result?.trail));
  assert.deepEqual(state.signature, { stepId: 'check', action: 'assertEquals', errorType: 'StepExecutionError' });
  assert.equal(state.result?.minimal.qty, '1000');
  assert.equal(state.result?.minimal.note, 'a', 'the irrelevant parameter was reset to its neutral value');
  assert.deepEqual(state.result?.essential, ['qty']);
  assert.deepEqual(state.result?.boundaries, [{ parameter: 'qty', fails: '1000', passes: '999', precision: 'adjacent' }]);
  assert.match(state.summary ?? '', /fails with qty="1000", passes with qty=999/);
  assert.ok(state.runs <= 40, `${state.runs} runs`);
  assert.deepEqual(state.replay, { routineId: 'shop-total', version: 1, parameterValues: state.result?.minimal });

  // The minimal run exists, failed, and was fed exactly the minimal values.
  const minimalJobId = state.result?.minimalJobId;
  assert.ok(minimalJobId);
  const replayed = await runLibraryRoutine('shop-total', 1, { parameterValues: state.result!.minimal }, { initiator: 'system' });
  assert.equal(replayed.status, 'failed');
  assert.deepEqual(replayed.parameters?.values, state.result!.minimal);
  assert.ok(Object.values(replayed.parameters!.sources).every((source) => source.source === 'fixed'));
  const justBelow = await runLibraryRoutine('shop-total', 1, { parameterValues: { ...state.result!.minimal, qty: '999' } }, { initiator: 'system' });
  assert.equal(justBelow.status, 'passed', 'the neighbour the shrinker reported really passes');

  // "Save to vault": a SCENARIO whose routine has the parameters FIXED at the minimal values.
  const added = await addFromRun({
    id: 'REG-501', fromJobId: minimalJobId, title: 'total is one short from quantity 1000', type: 'SCENARIO', severity: 'HIGH',
    surface: 'cart', tags: ['shrunk'], routineId: 'reg-501',
  });
  assert.equal(added.item.type, 'SCENARIO');
  const pinned = (await getRoutine('reg-501', added.routine.version))!;
  assert.deepEqual(pinned.parameters, [
    { name: 'price', cases: ['10.50'] },
    { name: 'note', cases: ['a'] },
    { name: 'qty', cases: ['1000'] },
  ]);
  const again = await runLibraryRoutine('reg-501', added.routine.version, { seed: 'anything', sample: 7 }, { initiator: 'system' });
  assert.equal(again.status, 'failed', 'the pinned scenario fails on every run, whatever the seed');
  assert.equal(again.parameters?.values.qty, '1000');
});

test('by routine + seed + sample, and a small budget stops early with the open bracket', async () => {
  const state = await shrinkAndWait({ routineId: 'shop-total', seed: 'S', sample: 2, maxShrinkRuns: 6 });
  assert.equal(state.outcome, 'budget');
  assert.equal(state.runs, 6);
  const bracket = state.result!.boundaries[0]!;
  assert.equal(bracket.precision, 'bracket');
  assert.ok(Number(bracket.fails) >= 1000 && Number(bracket.passes) < 1000);
  assert.match(state.summary ?? '', /stopped early: budget/);

  const passing = await shrinkAndWait({ routineId: 'shop-total', seed: 'S', sample: 1 });
  assert.equal(passing.outcome, 'not-failing');
  assert.equal(passing.runs, 1);
});

test('requests that cannot be shrunk are refused before anything runs', async () => {
  assert.equal(shrinkRequestSchema.safeParse({}).success, false);
  assert.equal(shrinkRequestSchema.safeParse({ fromJobId: 'job_x', routineId: 'a', seed: 's', sample: 1 }).success, false);
  assert.equal(shrinkRequestSchema.safeParse({ routineId: 'a', seed: 's' }).success, false);
  await assert.rejects(() => startShrink(shrinkRequestSchema.parse({ fromJobId: 'job_doesnotexist' }), 'system'), (e: Error) => e.name === 'EvidenceNotFound');
  await assert.rejects(() => startShrink(shrinkRequestSchema.parse({ routineId: 'ghost', seed: 's', sample: 0 }), 'system'), (e: Error) => e.name === 'RoutineNotFound');
});
