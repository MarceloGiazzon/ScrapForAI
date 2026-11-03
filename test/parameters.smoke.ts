import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// T5.3 part 1 end to end (real Chromium): generated values are really typed into the page, edge values come first, the seed in
// result.parameters replays a run exactly, a run saved as a routine keeps its generators and parameters, and a run without
// parameters has no `parameters` in its result at all.

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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-params-smoke-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = site.origin;
process.env.ALLOWED_RESOURCE_ORIGINS = site.origin;

const { resolveExplorationRequest } = await import('../src/runner/resolveRequest.js');
const { runExploration } = await import('../src/runner/runExploration.js');
const { explorationRequestSchema } = await import('../src/schemas/explorationRequest.schema.js');
const { saveTarget } = await import('../src/targets/targetStore.js');
const { saveRoutine, runLibraryRoutine } = await import('../src/library/routineService.js');
const { RequestResolutionError } = await import('../src/runner/resolutionError.js');

after(async () => {
  await new Promise<void>((resolve) => site.server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const open = [{ id: 'open', action: 'goto', url: `${site.origin}/` }];
const typeAndRead = (fillExtra: Record<string, unknown>) => [
  ...open,
  { id: 'type', action: 'fill', selector: '#qty', ...fillExtra },
  { id: 'read', action: 'extractText', selector: '#out', name: 'typed' },
];

async function run(body: Record<string, unknown>) {
  const request = explorationRequestSchema.parse({ targetUrl: `${site.origin}/`, ...body });
  return runExploration(await resolveExplorationRequest(request));
}

const QTY = { name: 'qty', generator: { type: 'int', min: 1, max: 10 } };

test('edge values come first and are what the page receives; the result says what was generated and from where', async () => {
  const expected = ['1', '0', '10', '11', '-1'];
  for (const sample of [0, 3]) {
    const result = await run({ parameters: [QTY], seed: 'S1', sample, steps: typeAndRead({ valueFromParameter: 'qty' }) });
    assert.equal(result.status, 'passed', JSON.stringify(result.error));
    assert.equal(result.extracted.typed, expected[sample]);
    assert.deepEqual(result.parameters, { seed: 'S1', sample, values: { qty: expected[sample] }, sources: { qty: { source: 'boundary', index: sample } } });
  }
  const random = await run({ parameters: [QTY], seed: 'S1', sample: 5, steps: typeAndRead({ valueFromParameter: 'qty' }) });
  assert.equal(random.parameters?.sources.qty?.source, 'random');
  assert.ok(Number(random.extracted.typed) >= 1 && Number(random.extracted.typed) <= 10);
  assert.equal(random.parameters?.values.qty, random.extracted.typed);
});

test('the seed replays a run: the same seed and sample type the same value; a run with no seed reports the one it used', async () => {
  const wide = { name: 'qty', generator: { type: 'int', min: 1, max: 1000000 } };
  const steps = typeAndRead({ valueFromParameter: 'qty' });
  const a = await run({ parameters: [wide], seed: 'replay-me', sample: 9, steps });
  const b = await run({ parameters: [wide], seed: 'replay-me', sample: 9, steps });
  assert.equal(a.extracted.typed, b.extracted.typed);
  assert.deepEqual(a.parameters, b.parameters);

  const other = await run({ parameters: [wide], seed: 'another', sample: 9, steps });
  assert.notEqual(other.extracted.typed, a.extracted.typed);

  const unseeded = await run({ parameters: [wide], sample: 9, steps });
  assert.match(unseeded.parameters!.seed, /^[0-9a-f]{12}$/);
  const replay = await run({ parameters: [wide], seed: unseeded.parameters!.seed, sample: 9, steps });
  assert.equal(replay.extracted.typed, unseeded.extracted.typed, 'the returned seed is enough to replay it');
});

test('an inline generator needs no declaration; a hostile maximum-length string reaches the page intact', async () => {
  const hostile = { type: 'string', minLength: 0, maxLength: 30, charset: 'hostile' };
  // edge order for min 0: '', max, max+1  -> sample 1 is the maximum length
  const result = await run({ seed: 'H', sample: 1, steps: typeAndRead({ valueFromGenerator: hostile }) });
  assert.equal(result.status, 'passed', JSON.stringify(result.error));
  const record = result.parameters!;
  const [name] = Object.keys(record.values);
  assert.equal(name, 'gen_type', 'named after its step');
  assert.equal([...record.values[name!]!].length, 30);
  assert.equal(result.extracted.typed, record.values[name!], 'what the page showed is what was generated, quotes, markup and all');

  const tooLong = await run({ seed: 'H', sample: 2, steps: typeAndRead({ valueFromGenerator: hostile }) });
  assert.equal([...tooLong.parameters!.values.gen_type!].length, 31, 'one past the limit, on purpose');
});

test('a run with no parameter and no generator has no `parameters` in its result', async () => {
  const result = await run({ steps: typeAndRead({ value: '42' }) });
  assert.equal(result.status, 'passed');
  assert.equal(result.parameters, undefined);
  assert.equal(result.extracted.typed, '42');
});

test('a parameter that nobody declared is a 400 from the server, with the names that were declared', async () => {
  const unvalidated = { targetUrl: `${site.origin}/`, steps: typeAndRead({ valueFromParameter: 'nope' }), parameters: [{ name: 'qty', cases: ['1'], }], options: explorationRequestSchema.shape.options.parse(undefined) };
  await assert.rejects(resolveExplorationRequest(unvalidated as never), (error: Error) => {
    assert.ok(error instanceof RequestResolutionError);
    assert.equal((error as InstanceType<typeof RequestResolutionError>).status, 400);
    // The post-expansion validation names it first; the resolver's own UnknownParameter is the second line of defence (unit-tested).
    assert.match(error.name, /^(ExpandedRoutineInvalid|UnknownParameter)$/);
    assert.match(error.message, /parameter "nope" is not declared|not declared: nope/);
    assert.match(error.message, /declared: qty/);
    return true;
  });
});

test('saved as a routine from a run, it keeps what the author wrote (generators, parameters), and a later run can pick the seed and sample', async () => {
  await saveTarget({
    id: 'fixture', name: 'Fixture', platform: 'generic', environment: 'dev', baseUrl: `${site.origin}/`, credentialSets: [],
    noiseFilters: [], surfaces: {}, screens: [], flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  });

  const first = await run({
    targetProfile: 'fixture',
    parameters: [QTY],
    seed: 'orig',
    sample: 0,
    steps: [
      ...open,
      { id: 'a', action: 'fill', selector: '#qty', valueFromParameter: 'qty' },
      { id: 'b', action: 'fill', selector: '#qty', valueFromGenerator: { type: 'oneOf', values: ['alpha', 'beta'] } },
      { id: 'read', action: 'extractText', selector: '#out', name: 'typed' },
    ],
  });
  assert.equal(first.status, 'passed', JSON.stringify(first.error));
  assert.equal(first.extracted.typed, 'alpha');

  const saved = await saveRoutine('param-routine', { fromJobId: first.jobId, title: 'param routine', targetProfile: 'fixture' });
  assert.deepEqual(saved.routine.parameters, [{ name: 'qty', generator: { type: 'int', min: 1, max: 10 }, includeBoundaries: true }]);
  assert.deepEqual(saved.routine.steps.map((step) => ('valueFromGenerator' in step ? 'generator' : 'valueFromParameter' in step ? 'parameter' : step.action)), ['goto', 'parameter', 'generator', 'extractText']);
  assert.ok(!JSON.stringify(saved.routine).includes('gen_b'), 'the implicit parameter is not written into the routine');
  assert.ok(!JSON.stringify(saved.routine).includes('"orig"'), 'the seed is per run, not part of the routine');

  const again = await runLibraryRoutine('param-routine', undefined, { seed: 'picked', sample: 2 });
  assert.equal(again.status, 'passed', JSON.stringify(again.error));
  assert.deepEqual([again.parameters?.seed, again.parameters?.sample, again.parameters?.values.qty], ['picked', 2, '10']);
  assert.equal(again.extracted.typed, again.parameters?.values.gen_b, 'the inline generator of the last fill is what stays in the page');
});

test('a secret typed into a parameter\'s cases is refused when the routine is saved', async () => {
  await assert.rejects(
    saveRoutine('leaky', {
      title: 'leaky',
      targetProfile: 'fixture',
      parameters: [{ name: 'p', cases: ['fine', 'sk-abcdefghijklmnopqrstuvwxyz012345'] }],
      steps: typeAndRead({ valueFromParameter: 'p' }) as never,
    }),
    (error: Error & { status?: number; details?: unknown }) => {
      assert.equal(error.status, 422);
      assert.ok(!JSON.stringify(error.details).includes('sk-abcdefghijklmnopqrstuvwxyz012345'));
      return true;
    },
  );
});

// ---- part 2 ----------------------------------------------------------------------------------------------------------------

test('a generated CPF is typed into the page, is valid, is flagged synthetic in the result and in the report', async () => {
  const { isValidDocument } = await import('../src/generators/generators.js');
  const { buildRunReport } = await import('../src/reports/buildReport.js');
  const cpf = { name: 'cpf', generator: { type: 'document', kind: 'cpf', formatted: true } };
  const result = await run({
    targetProfile: 'fixture',
    parameters: [cpf],
    seed: 'doc-seed',
    sample: 0,
    steps: typeAndRead({ valueFromParameter: 'cpf' }),
  });
  assert.equal(result.status, 'passed', JSON.stringify(result.error));
  assert.match(String(result.extracted.typed), /^\d{3}\.\d{3}\.\d{3}-\d{2}$/);
  assert.ok(isValidDocument('cpf', String(result.extracted.typed)));
  assert.deepEqual(result.parameters?.synthetic, ['cpf']);

  const html = await buildRunReport(result.jobId, 'pt');
  assert.ok(html.includes('Dados de teste') && html.includes('doc-seed'));
  assert.ok(html.includes(String(result.extracted.typed)));
  assert.ok(html.includes('sintético') && html.includes('Dados sintéticos'));

  const invalidParam = { ...cpf, generator: { ...cpf.generator, valid: false } };
  const empty = await run({ parameters: [invalidParam], seed: 'doc-seed', sample: 0, steps: typeAndRead({ valueFromParameter: 'cpf' }) });
  assert.equal(empty.extracted.typed, '', 'the first edge value of an invalid document is the empty one');
  const wrongCheck = await run({ parameters: [invalidParam], seed: 'doc-seed', sample: 4, steps: typeAndRead({ valueFromParameter: 'cpf' }) });
  assert.ok(!isValidDocument('cpf', String(wrongCheck.extracted.typed)));
  assert.equal(String(wrongCheck.extracted.typed).replace(/\D/g, '').length, 11);
});

test('an included routine declares its own parameters: renamed after the include, one set per include, steps rewritten', async () => {
  const wide = { name: 'qty', generator: { type: 'int', min: 1, max: 1000000 }, includeBoundaries: false };
  await saveRoutine('with-params', {
    title: 'a routine with its own parameter and an inline generator',
    targetProfile: 'fixture',
    parameters: [wide],
    steps: [
      { id: 'type', action: 'fill', selector: '#qty', valueFromParameter: 'qty' },
      { id: 'note', action: 'fill', selector: '#qty', valueFromGenerator: { type: 'oneOf', values: ['inline'] } },
    ] as never,
  });
  await saveRoutine('with-qty-only', {
    title: 'qty only',
    targetProfile: 'fixture',
    parameters: [wide],
    steps: [{ id: 'type', action: 'fill', selector: '#qty', valueFromParameter: 'qty' }] as never,
  });

  const steps = [
    ...open,
    { id: 'a', action: 'include', routineId: 'with-qty-only' },
    { id: 'b', action: 'include', routineId: 'with-qty-only' },
    { id: 'read', action: 'extractText', selector: '#out', name: 'typed' },
  ];
  const result = await run({ targetProfile: 'fixture', seed: 'inc', sample: 0, steps });
  assert.equal(result.status, 'passed', JSON.stringify(result.error));
  assert.deepEqual(Object.keys(result.parameters!.values).sort(), ['a_qty', 'b_qty']);
  assert.notEqual(result.parameters!.values.a_qty, result.parameters!.values.b_qty, 'each include draws its own value');
  assert.equal(result.extracted.typed, result.parameters!.values.b_qty, 'the last include typed last');

  const replay = await run({ targetProfile: 'fixture', seed: 'inc', sample: 0, steps });
  assert.deepEqual(replay.parameters!.values, result.parameters!.values);

  // inline generators inside an included routine: the dotted step id becomes a legal name
  const withInline = await run({
    targetProfile: 'fixture',
    seed: 'inc',
    sample: 0,
    steps: [...open, { id: 'x', action: 'include', routineId: 'with-params' }, { id: 'read', action: 'extractText', selector: '#out', name: 'typed' }],
  });
  assert.equal(withInline.status, 'passed', JSON.stringify(withInline.error));
  assert.deepEqual(Object.keys(withInline.parameters!.values).sort(), ['gen_x_note', 'x_qty']);
  assert.equal(withInline.extracted.typed, 'inline');

  // an includer that already uses a renamed name is told, not silently overwritten
  await assert.rejects(
    run({ targetProfile: 'fixture', parameters: [{ name: 'a_qty', cases: ['1'] }], steps }),
    (error: Error & { status?: number }) => error.status === 400 && /a_qty/.test(error.message),
  );

  // an including routine can be saved: the check at save sees the renamed parameters of what it includes
  const saved = await saveRoutine('includer', { title: 'includer', targetProfile: 'fixture', steps: steps as never });
  assert.equal(saved.routine.version, 1);
  const viaLibrary = await runLibraryRoutine('includer', undefined, { seed: 'lib', sample: 0 });
  assert.equal(viaLibrary.status, 'passed', JSON.stringify(viaLibrary.error));
  assert.deepEqual(Object.keys(viaLibrary.parameters!.values).sort(), ['a_qty', 'b_qty']);
});
