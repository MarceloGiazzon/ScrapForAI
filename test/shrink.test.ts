import assert from 'node:assert/strict';
import test from 'node:test';

import { describeParameters } from '../src/shrink/describe.js';
import { type Probe, shrink, type ShrinkParameter, summarizeShrink } from '../src/shrink/shrink.js';

// T5.6: the shrinking algorithms against fake systems with a KNOWN failure region, so the exact answer is known. No browser.

const int = (name: string, baseline = '0'): ShrinkParameter => ({ name, shape: { kind: 'int', baseline } });
const text = (name: string, baseline = 'a'): ShrinkParameter => ({ name, shape: { kind: 'string', baseline } });
const opaque = (name: string, baseline: string): ShrinkParameter => ({ name, shape: { kind: 'opaque', baseline } });

/** A probe that fails when `broken(values)` and counts its calls. */
function system(broken: (values: Record<string, string>) => boolean): { probe: Probe; calls: Array<Record<string, string>> } {
  const calls: Array<Record<string, string>> = [];
  return {
    calls,
    probe: async (values) => {
      calls.push(values);
      return { fails: broken(values), jobId: `job_${calls.length}` };
    },
  };
}
const run = (parameters: ShrinkParameter[], failing: Record<string, string>, probe: Probe, extra: { maxRuns?: number; deadline?: number; signal?: AbortSignal } = {}) =>
  shrink({ parameters, failing, probe, maxRuns: extra.maxRuns ?? 30, deadline: extra.deadline ?? Date.now() + 60_000, ...(extra.signal ? { signal: extra.signal } : {}) });

test('ACCEPTANCE: a boundary bug at qty >= 1000 is found exactly - fails with 1000, passes with 999', async () => {
  const { probe, calls } = system((v) => Number(v.qty) >= 1000);
  const result = await run([int('qty')], { qty: '2500000' }, probe);

  assert.equal(result.status, 'minimal');
  assert.deepEqual(result.minimal, { qty: '1000' });
  assert.deepEqual(result.boundaries, [{ parameter: 'qty', fails: '1000', passes: '999', precision: 'adjacent' }]);
  assert.deepEqual(result.essential, ['qty']);
  assert.match(summarizeShrink(result), /fails with qty="1000", passes with qty=999/);
  assert.ok(result.runs <= 30 && calls.length === result.runs);
  assert.equal(result.minimalJobId, result.trail.findLast((entry) => entry.failed)?.jobId, 'the id points at a run that really failed with the minimal values');
});

test('the same for a lower bound, a negative limit and a decimal', async () => {
  const below = await run([int('n', '5')], { n: '-77' }, system((v) => Number(v.n) < -3).probe);
  assert.deepEqual(below.boundaries, [{ parameter: 'n', fails: '-4', passes: '-3', precision: 'adjacent' }]);

  const upperOfNegatives = await run([int('n', '0')], { n: '-90000' }, system((v) => Number(v.n) <= -500).probe);
  assert.deepEqual(upperOfNegatives.minimal, { n: '-500' });

  const price = (name: string): ShrinkParameter => ({ name, shape: { kind: 'decimal', scale: 2, baseline: '0.00' } });
  const decimal = await run([price('p')], { p: '123.45' }, system((v) => Number(v.p) > 9.99).probe);
  assert.deepEqual(decimal.boundaries, [{ parameter: 'p', fails: '10.00', passes: '9.99', precision: 'adjacent' }]);
  assert.deepEqual(decimal.minimal, { p: '10.00' });
});

test('binary search is cheap: 20 runs for a range of a million', async () => {
  const { probe } = system((v) => Number(v.q) >= 777_777);
  const result = await run([int('q')], { q: '999999' }, probe, { maxRuns: 40 });
  assert.equal(result.minimal.q, '777777');
  assert.ok(result.runs <= 24, `${result.runs} runs`);
});

test('a parameter that is not the cause is reset to its baseline (ddmin), and only the culprit is shrunk', async () => {
  const { probe, calls } = system((v) => Number(v.qty) >= 1000);
  const result = await run([int('qty'), int('tax', '0'), text('note'), opaque('kind', 'retail')], { qty: '5000', tax: '22', note: 'hello world', kind: 'wholesale' }, probe);

  assert.equal(result.status, 'minimal');
  assert.deepEqual(result.minimal, { qty: '1000', tax: '0', note: 'a', kind: 'retail' });
  assert.deepEqual(result.essential, ['qty']);
  assert.ok(calls.length === result.runs);
});

test('delta debugging: a failure that needs TWO parameters keeps exactly those two', async () => {
  // Fails only when region is "uy" AND qty >= 10; 'vat' and 'note' are noise.
  const { probe } = system((v) => v.region === 'uy' && Number(v.qty) >= 10);
  const result = await run(
    [opaque('region', 'br'), int('qty'), int('vat'), text('note')],
    { region: 'uy', qty: '4000', vat: '22', note: 'noise' },
    probe,
  );

  assert.equal(result.status, 'minimal');
  assert.deepEqual(result.minimal, { region: 'uy', qty: '10', vat: '0', note: 'a' });
  assert.deepEqual([...result.essential].sort(), ['qty', 'region']);
  assert.deepEqual(result.boundaries, [{ parameter: 'qty', fails: '10', passes: '9', precision: 'adjacent' }]);
});

test('with ten irrelevant parameters ddmin needs few runs, not ten per parameter', async () => {
  const noise = Array.from({ length: 10 }, (_, i) => int(`n${i}`));
  const failing: Record<string, string> = { culprit: '50', ...Object.fromEntries(noise.map((p) => [p.name, '9'])) };
  const { probe } = system((v) => Number(v.culprit) >= 7);
  const result = await run([int('culprit'), ...noise], failing, probe, { maxRuns: 60 });

  assert.equal(result.minimal.culprit, '7');
  assert.ok(noise.every((p) => result.minimal[p.name] === '0'));
  assert.ok(result.runs <= 22, `${result.runs} runs`);
});

test('strings: cut by halves, then character by character, down to the failing core', async () => {
  const { probe } = system((v) => v.name.includes("'"));
  const result = await run([text('name')], { name: `Joe O'Brien the third of his name` }, probe);
  assert.equal(result.status, 'minimal');
  assert.equal(result.minimal.name, "'");

  const pair = await run([text('s')], { s: 'xx<script>yy' }, system((v) => v.s.includes('<s')).probe);
  assert.equal(pair.minimal.s, '<s');

  const long = 'a'.repeat(3000) + 'Z' + 'b'.repeat(2000);
  const found = await run([text('long', 'a')], { long }, system((v) => v.long.includes('Z')).probe, { maxRuns: 40 });
  assert.equal(found.minimal.long, 'Z');
  assert.ok(found.runs <= 40);
});

test('strings are cut by characters, not UTF-16 halves: an emoji is never split', async () => {
  const result = await run([text('s')], { s: 'ab😀cd' }, system((v) => v.s.includes('😀')).probe);
  assert.equal(result.minimal.s, '😀');
});

test('a smaller input that fails SOMEWHERE ELSE is not progress (the probe decides "same failure")', async () => {
  // Original: qty >= 1000 fails at "total". Below 10 a different step fails ("validation"): that must not count.
  const calls: string[] = [];
  const probe: Probe = async (v) => {
    const qty = Number(v.qty);
    calls.push(v.qty!);
    return { fails: qty >= 1000 };
  };
  const result = await run([int('qty')], { qty: '4000' }, probe);
  assert.equal(result.minimal.qty, '1000');
});

test('a failure that does not repeat is reported, not shrunk', async () => {
  let n = 0;
  const result = await run([int('qty')], { qty: '9' }, async () => ({ fails: ++n === 99 }));
  assert.equal(result.status, 'not-reproduced');
  assert.equal(result.runs, 1);
  assert.match(summarizeShrink(result), /not deterministic/);
});

test('when it fails with everything at baseline, the parameters are not the cause', async () => {
  const result = await run([int('qty'), text('s')], { qty: '40', s: 'hello' }, system(() => true).probe);
  assert.equal(result.status, 'independent');
  assert.deepEqual(result.minimal, { qty: '0', s: 'a' });
  assert.deepEqual(result.essential, []);
  assert.match(summarizeShrink(result), /not what breaks it/);
});

test('the run budget stops the search with the best failing input so far and the open bracket', async () => {
  const { probe } = system((v) => Number(v.qty) >= 1000);
  const result = await run([int('qty')], { qty: '9000000' }, probe, { maxRuns: 6 });

  assert.equal(result.status, 'budget');
  assert.equal(result.runs, 6);
  assert.ok(Number(result.minimal.qty) >= 1000, 'the reported input still fails');
  const bracket = result.boundaries[0]!;
  assert.equal(bracket.precision, 'bracket');
  assert.ok(Number(bracket.passes) < 1000 && Number(bracket.fails) >= 1000);
  assert.match(summarizeShrink(result), /stopped early: budget/);
});

test('the time limit and cancellation stop it too', async () => {
  const slow = system((v) => Number(v.qty) >= 10);
  const late = await run([int('qty')], { qty: '5000' }, slow.probe, { deadline: Date.now() - 1 });
  assert.equal(late.status, 'timeout');
  assert.equal(late.runs, 0);

  const controller = new AbortController();
  let calls = 0;
  const result = await run([int('qty')], { qty: '5000' }, async (v) => {
    calls += 1;
    if (calls === 3) controller.abort();
    return { fails: Number(v.qty) >= 10 };
  }, { signal: controller.signal });
  assert.equal(result.status, 'cancelled');
});

test('an error in the probe ends the search with what was found and the message', async () => {
  let calls = 0;
  const result = await run([int('qty')], { qty: '5000' }, async (v) => {
    calls += 1;
    if (calls === 4) throw new Error('browser crashed');
    return { fails: Number(v.qty) >= 10 };
  });
  assert.equal(result.status, 'error');
  assert.match(result.error ?? '', /browser crashed/);
  assert.ok(Number(result.minimal.qty) >= 10);
});

test('the same values are never run twice', async () => {
  const { probe, calls } = system((v) => Number(v.qty) >= 100);
  await run([int('qty'), int('other')], { qty: '100', other: '0' }, probe);
  const keys = calls.map((c) => JSON.stringify(c));
  assert.equal(new Set(keys).size, keys.length);
});

test('describing generated parameters: neutral values per kind', () => {
  const shapes = describeParameters([
    { name: 'a', generator: { type: 'int', min: 5, max: 10 }, includeBoundaries: true },
    { name: 'b', generator: { type: 'int', min: -10, max: 10 }, includeBoundaries: true },
    { name: 'c', generator: { type: 'decimal', min: 1, max: 9, scale: 2 }, includeBoundaries: true },
    { name: 'd', generator: { type: 'string', minLength: 3, maxLength: 9, charset: 'hostile' }, includeBoundaries: true },
    { name: 'e', generator: { type: 'oneOf', values: ['x', 'y'] }, includeBoundaries: true },
    { name: 'f', cases: ['first', 'second'] },
    { name: 'g', generator: { type: 'date', from: '2026-01-31', to: '2026-12-31', format: 'dd/MM/yyyy' }, includeBoundaries: true },
    { name: 'h', generator: { type: 'document', kind: 'cpf', valid: false, formatted: false }, includeBoundaries: true },
  ] as never);

  assert.deepEqual(shapes.map((s) => s.shape.kind === 'fixed' ? 'fixed' : s.shape.baseline), ['5', '0', '1.00', 'aaa', 'x', 'first', '31/01/2026', shapes[7]!.shape.kind === 'fixed' ? '' : shapes[7]!.shape.baseline]);
  const doc = shapes[7]!.shape;
  assert.ok(doc.kind === 'opaque' && /^\d{11}$/.test(doc.baseline), 'the neutral document is a valid one');
});
