import assert from 'node:assert/strict';
import test from 'node:test';

// T5.3 part 1: the PRNG, edge values first, reproducible random values, the schema, parameter resolution and the secret lint.

process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';

const { createRng, intBetween } = await import('../src/generators/prng.js');
const { boundaryValues, randomValue, valueAt, edgeCount, formatDate, HOSTILE_FRAGMENTS } = await import('../src/generators/generators.js');
const { resolveParameters, ParameterError } = await import('../src/generators/resolveParameters.js');
const { generatorSchema, checkedGeneratorSchema, parametersSchema, parameterSchema } = await import('../src/schemas/parameters.schema.js');
const { explorationRequestSchema } = await import('../src/schemas/explorationRequest.schema.js');
const { routineContentSchema } = await import('../src/schemas/libraryRoutine.schema.js');
const { lintParameters } = await import('../src/library/routineLint.js');

const gen = (input: Record<string, unknown>) => checkedGeneratorSchema.parse(input);
const param = (input: Record<string, unknown>) => parameterSchema.parse(input);
const chars = (text: string) => [...text].length;

test('prng: the same seed gives the same stream, another seed another one, and ranges are respected', () => {
  const a = createRng('seed-1');
  const b = createRng('seed-1');
  const streamA = Array.from({ length: 20 }, () => a());
  assert.deepEqual(streamA, Array.from({ length: 20 }, () => b()));
  assert.notDeepEqual(streamA, Array.from({ length: 20 }, ((r) => () => r())(createRng('seed-2'))));
  assert.ok(streamA.every((n) => n >= 0 && n < 1));

  const rng = createRng('range');
  const seen = new Set<number>();
  for (let i = 0; i < 500; i += 1) {
    const n = intBetween(rng, -3, 3);
    assert.ok(n >= -3 && n <= 3);
    seen.add(n);
  }
  assert.equal(seen.size, 7, 'every value of the range, both ends included, shows up');
  assert.equal(intBetween(createRng('x'), 5, 5), 5);
});

test('int edges, in order and without repeats: min, min-1, max, max+1, zero, -1', () => {
  assert.deepEqual(boundaryValues(gen({ type: 'int', min: 5, max: 9 })), ['5', '4', '9', '10', '0', '-1']);
  assert.deepEqual(boundaryValues(gen({ type: 'int', min: 1, max: 10 })), ['1', '0', '10', '11', '-1'], 'min-1 and zero are the same value: once');
  assert.deepEqual(boundaryValues(gen({ type: 'int', min: -5, max: 5 })), ['-5', '-6', '5', '6', '0', '-1']);
  assert.deepEqual(boundaryValues(gen({ type: 'int', min: 0, max: 0 })), ['0', '-1', '1']);
});

test('decimal edges respect the scale and use exact steps (no floating point noise)', () => {
  assert.deepEqual(boundaryValues(gen({ type: 'decimal', min: 0.5, max: 9.99, scale: 2 })), ['0.50', '0.49', '9.99', '10.00', '0.00', '-0.01']);
  assert.deepEqual(boundaryValues(gen({ type: 'decimal', min: 0.1, max: 0.3, scale: 1 })), ['0.1', '0.0', '0.3', '0.4', '-0.1']);
  assert.deepEqual(boundaryValues(gen({ type: 'decimal', min: 1, max: 5, scale: 0 })), ['1', '0', '5', '6', '-1']);
});

test('date edges: from, the day before, to, the day after, and empty; output follows the format, leap days included', () => {
  assert.deepEqual(boundaryValues(gen({ type: 'date', from: '2026-01-01', to: '2026-12-31' })), ['01/01/2026', '31/12/2025', '31/12/2026', '01/01/2027', '']);
  assert.deepEqual(boundaryValues(gen({ type: 'date', from: '2024-03-01', to: '2024-03-02', format: 'yyyy-MM-dd' })), ['2024-03-01', '2024-02-29', '2024-03-02', '2024-03-03', '']);
  assert.equal(formatDate(Date.UTC(2026, 10, 3), 'dd.MM.yy'), '03.11.26');
  assert.equal(formatDate(Date.UTC(2026, 10, 3), 'MM/dd/yyyy'), '11/03/2026');
});

test('string edges: empty, min, min-1, max, max+1 (lengths in characters), hostile ones too, never a cut surrogate pair', () => {
  const values = boundaryValues(gen({ type: 'string', minLength: 2, maxLength: 5 }));
  assert.deepEqual(values.map(chars), [0, 2, 1, 5, 6]);
  assert.deepEqual(boundaryValues(gen({ type: 'string', minLength: 0, maxLength: 3 })).map(chars), [0, 3, 4], 'minLength 0: no min-1, empty is not repeated');
  assert.deepEqual(boundaryValues(gen({ type: 'string', minLength: 2, maxLength: 5 })), values, 'deterministic');

  for (const length of [1, 2, 3, 7, 11, 40]) {
    const hostile = boundaryValues(gen({ type: 'string', minLength: length, maxLength: length, charset: 'hostile' }));
    for (const text of hostile) {
      assert.doesNotThrow(() => encodeURIComponent(text), `a lone surrogate at length ${length}`);
    }
    assert.ok(hostile.some((text) => chars(text) === length));
  }
});

test('oneOf: its values in order, without repeats', () => {
  assert.deepEqual(boundaryValues(gen({ type: 'oneOf', values: ['b', 'a', 'b', 'c'] })), ['b', 'a', 'c']);
});

test('random values stay inside the valid range, for every generator', () => {
  const rng = createRng('ranges');
  const int = gen({ type: 'int', min: -4, max: 4 });
  const decimal = gen({ type: 'decimal', min: 1.25, max: 3.75, scale: 2 });
  const date = gen({ type: 'date', from: '2026-02-27', to: '2026-03-02', format: 'yyyy-MM-dd' });
  const alpha = gen({ type: 'string', minLength: 3, maxLength: 6, charset: 'alpha' });
  const hostile = gen({ type: 'string', minLength: 4, maxLength: 30, charset: 'hostile' });
  const unicode = gen({ type: 'string', minLength: 1, maxLength: 8, charset: 'unicode' });

  for (let i = 0; i < 300; i += 1) {
    const n = Number(randomValue(int, rng));
    assert.ok(Number.isInteger(n) && n >= -4 && n <= 4);
    const d = randomValue(decimal, rng);
    assert.match(d, /^\d\.\d\d$/);
    assert.ok(Number(d) >= 1.25 && Number(d) <= 3.75, d);
    assert.ok(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02'].includes(randomValue(date, rng)));
    const a = randomValue(alpha, rng);
    assert.match(a, /^[A-Za-z]{3,6}$/);
    const h = randomValue(hostile, rng);
    assert.ok(chars(h) >= 4 && chars(h) <= 30);
    assert.doesNotThrow(() => encodeURIComponent(h));
    assert.ok(chars(randomValue(unicode, rng)) >= 1);
  }
  const everyDay = new Set(Array.from({ length: 200 }, () => randomValue(date, rng)));
  assert.equal(everyDay.size, 4, 'both ends of a date range are reachable');
});

test('hostile strings are made of the documented nasty fragments (quotes, markup, injection, emoji, right-to-left)', () => {
  const all = HOSTILE_FRAGMENTS.join('');
  for (const needle of [`'`, `"`, '<script>', 'DROP TABLE', '%s', '😀', '‮']) assert.ok(all.includes(needle), needle);
  const long = boundaryValues(gen({ type: 'string', minLength: 0, maxLength: 200, charset: 'hostile' })).find((text) => chars(text) === 200)!;
  assert.ok(long.includes('<script>') && long.includes(`'`));
});

test('valueAt: edge values first, then random; a random value depends only on (seed, name, position)', () => {
  const p = param({ name: 'qty', generator: { type: 'int', min: 1, max: 1000000 } });
  const edges = boundaryValues(p.generator as never);
  assert.equal(edgeCount(p), edges.length);
  edges.forEach((value, index) => assert.deepEqual(valueAt(p, index, 's'), { value, source: 'boundary', index }));

  const first = valueAt(p, edges.length, 'seed-a');
  assert.deepEqual([first.source, first.index], ['random', 0]);
  assert.deepEqual(valueAt(p, edges.length, 'seed-a'), first, 'same seed, same value');
  assert.notEqual(valueAt(p, edges.length, 'seed-b').value, first.value, 'another seed, another value');
  // replaying sample 40 alone gives what a run that went through 0..39 would have had
  const alone = valueAt(p, 40, 'seed-a');
  for (let i = 0; i < 40; i += 1) valueAt(p, i, 'seed-a');
  assert.deepEqual(valueAt(p, 40, 'seed-a'), alone);
  assert.notEqual(valueAt(p, 40, 'seed-a').value, valueAt(p, 41, 'seed-a').value);
  // two parameters with the same generator do not mirror each other
  const q = param({ name: 'other', generator: { type: 'int', min: 1, max: 1000000 } });
  assert.notEqual(valueAt(q, edges.length, 'seed-a').value, first.value);
});

test('includeBoundaries false: only random values; cases cycle in order', () => {
  const noEdges = param({ name: 'n', generator: { type: 'int', min: 1, max: 100 }, includeBoundaries: false });
  assert.equal(edgeCount(noEdges), 0);
  assert.equal(valueAt(noEdges, 0, 's').source, 'random');

  const cases = param({ name: 'c', cases: ['x', 'y', 'z'] });
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => valueAt(cases, i, 's').value), ['x', 'y', 'z', 'x', 'y']);
  assert.deepEqual(valueAt(cases, 4, 's'), { value: 'y', source: 'case', index: 1 });
});

test('schema: defaults, and what a generator may not be', () => {
  const date = gen({ type: 'date', from: '2026-01-01', to: '2026-01-02' }) as { format: string };
  assert.equal(date.format, 'dd/MM/yyyy');
  assert.equal((gen({ type: 'string', minLength: 0, maxLength: 3 }) as { charset: string }).charset, 'alnum');
  assert.equal(param({ name: 'a', generator: { type: 'int', min: 1, max: 2 } }).includeBoundaries, true);

  for (const bad of [
    { type: 'int', min: 5, max: 1 },
    { type: 'int', min: 1.5, max: 3 },
    { type: 'decimal', min: 1, max: 2, scale: 9 },
    { type: 'date', from: '2026-02-30', to: '2026-03-01' },
    { type: 'date', from: '2026-03-02', to: '2026-03-01' },
    { type: 'date', from: '01/01/2026', to: '02/01/2026' },
    { type: 'date', from: '2026-01-01', to: '2026-01-02', format: 'dd/MMM/yyyy' },
    { type: 'string', minLength: 5, maxLength: 2 },
    { type: 'string', minLength: 0, maxLength: 5001 },
    { type: 'string', minLength: 0, maxLength: 5, charset: 'emoji' },
    { type: 'oneOf', values: [] },
    { type: 'document', kind: 'passport' },
    { type: 'int', min: 1, max: 2, extra: true },
  ]) {
    assert.equal(checkedGeneratorSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
  assert.equal(generatorSchema.safeParse({ type: 'int', min: 5, max: 1 }).success, true, 'the cross-field rule belongs to the checked schema');
});

test('parameters: names are unique, bounded and safe', () => {
  const ok = parametersSchema.safeParse([{ name: 'a', cases: ['1'] }, { name: 'b', generator: { type: 'int', min: 1, max: 2 } }]);
  assert.ok(ok.success);
  assert.equal(parametersSchema.safeParse([{ name: 'a', cases: ['1'] }, { name: 'a', cases: ['2'] }]).success, false);
  assert.equal(parametersSchema.safeParse([{ name: 'bad name!', cases: ['1'] }]).success, false);
  assert.equal(parametersSchema.safeParse([{ name: 'a', cases: [] }]).success, false);
  assert.equal(parametersSchema.safeParse([{ name: 'a', cases: ['1'], generator: { type: 'int', min: 1, max: 2 } }]).success, false, 'cases or generator, not both');
});

type Step = { id?: string; action: string; selector?: string; valueFromParameter?: string; valueFromGenerator?: unknown; value?: string };
const fill = (id: string, extra: Record<string, unknown>): Step => ({ id, action: 'fill', selector: '#x', ...extra });

test('resolve: a run with no parameter and no generator is returned untouched, with no record', () => {
  const steps = [fill('a', { value: 'x' })];
  const out = resolveParameters<Step>({ steps });
  assert.equal(out.steps, steps);
  assert.equal(out.record, undefined);
});

test('resolve: declared parameters take their sample-th value; the record says which value, from where, with which seed', () => {
  const parameters = [param({ name: 'qty', generator: { type: 'int', min: 1, max: 10 } }), param({ name: 'kind', cases: ['a', 'b'] })];
  const steps = [fill('q', { valueFromParameter: 'qty' }), fill('k', { valueFromParameter: 'kind' })];

  const first = resolveParameters<Step>({ steps, parameters, seed: 'S', sample: 0 });
  assert.deepEqual(first.record, { seed: 'S', sample: 0, values: { qty: '1', kind: 'a' }, sources: { qty: { source: 'boundary', index: 0 }, kind: { source: 'case', index: 0 } } });
  const third = resolveParameters<Step>({ steps, parameters, seed: 'S', sample: 3 });
  assert.deepEqual(third.record!.values, { qty: '11', kind: 'b' });
  const random = resolveParameters<Step>({ steps, parameters, seed: 'S', sample: 5 });
  assert.equal(random.record!.sources.qty!.source, 'random');
  assert.deepEqual(resolveParameters<Step>({ steps, parameters, seed: 'S', sample: 5 }).record, random.record, 'replay');
});

test('resolve: no seed means a fresh one, returned; with it the same run can be replayed exactly', () => {
  const parameters = [param({ name: 'p', generator: { type: 'int', min: 1, max: 1000000 }, includeBoundaries: false })];
  const steps = [fill('a', { valueFromParameter: 'p' })];
  const one = resolveParameters<Step>({ steps, parameters });
  const two = resolveParameters<Step>({ steps, parameters });
  assert.match(one.record!.seed, /^[0-9a-f]{12}$/);
  assert.notEqual(one.record!.seed, two.record!.seed);
  assert.deepEqual(resolveParameters<Step>({ steps, parameters, seed: one.record!.seed }).record!.values, one.record!.values);
});

test('resolve: an inline generator becomes a parameter named after its step; the step now says valueFromParameter', () => {
  const out = resolveParameters<Step>({
    steps: [fill('qty-field', { valueFromGenerator: { type: 'int', min: 1, max: 9 } })],
    teardown: [fill('clean', { valueFromGenerator: { type: 'oneOf', values: ['z'] } })],
    seed: 'S',
    sample: 1,
  });
  assert.deepEqual(out.steps[0], { id: 'qty-field', action: 'fill', selector: '#x', valueFromParameter: 'gen_qty-field' });
  assert.deepEqual(out.teardown![0], { id: 'clean', action: 'fill', selector: '#x', valueFromParameter: 'gen_clean' });
  assert.deepEqual(out.record!.values, { 'gen_qty-field': '0', gen_clean: 'z' });
});

test('resolve: errors are named and say what to do', () => {
  const p = [param({ name: 'a', cases: ['1'] })];
  assert.throws(() => resolveParameters<Step>({ steps: [fill('s', { valueFromParameter: 'missing' })], parameters: p }), (e: Error) => e instanceof ParameterError && e.type === 'UnknownParameter' && /missing/.test(e.message) && /declared: a/.test(e.message));
  assert.throws(() => resolveParameters<Step>({ steps: [fill('s', { valueFromGenerator: { type: 'int', min: 9, max: 1 } })] }), (e: Error) => e instanceof ParameterError && e.type === 'InvalidGenerator' && /min is greater than max/.test(e.message));
  assert.throws(() => resolveParameters<Step>({ steps: [fill('gen_x', { valueFromGenerator: { type: 'oneOf', values: ['v'] } }), fill('x', { valueFromGenerator: { type: 'oneOf', values: ['v'] } })], parameters: [param({ name: 'gen_x', cases: ['1'] })] }), (e: Error) => e instanceof ParameterError && e.type === 'DuplicateParameter');
  // ids that only differ by characters a name cannot hold collapse to one name: that is a duplicate, said plainly
  assert.throws(() => resolveParameters<Step>({ steps: [fill('a.b', { valueFromGenerator: { type: 'oneOf', values: ['v'] } }), fill('a_b', { valueFromGenerator: { type: 'oneOf', values: ['v'] } })] }), (e: Error) => e instanceof ParameterError && e.type === 'DuplicateParameter' && /different id/.test(e.message));
});

const baseRequest = (steps: unknown[], extra: Record<string, unknown> = {}) => ({ targetUrl: 'https://dev.example.com/', steps, ...extra });

test('request schema: exactly one value source, undeclared parameters are refused unless an include may declare them', () => {
  const one = (step: Record<string, unknown>, extra: Record<string, unknown> = {}) => explorationRequestSchema.safeParse(baseRequest([{ id: 'f', action: 'fill', selector: '#x', ...step }], extra));

  assert.ok(one({ valueFromParameter: 'q' }, { parameters: [{ name: 'q', cases: ['1'] }] }).success);
  assert.ok(one({ valueFromGenerator: { type: 'int', min: 1, max: 3 } }).success);
  assert.equal(one({ value: 'x', valueFromParameter: 'q' }, { parameters: [{ name: 'q', cases: ['1'] }] }).success, false, 'two sources');
  assert.equal(one({ valueFromGenerator: { type: 'int', min: 3, max: 1 } }).success, false, 'a bad inline generator is refused at validation');

  const undeclared = one({ valueFromParameter: 'q' });
  assert.equal(undeclared.success, false);
  assert.match(undeclared.error?.issues[0]?.message ?? '', /parameter "q" is not declared/);

  const withInclude = explorationRequestSchema.safeParse(baseRequest([{ id: 'login', action: 'include', routineId: 'login' }, { id: 'f', action: 'fill', selector: '#x', valueFromParameter: 'q' }]));
  assert.ok(withInclude.success, 'an include may bring the declaration: the server checks after expanding');

  assert.equal(explorationRequestSchema.safeParse(baseRequest([{ id: 'g', action: 'goto', url: 'https://dev.example.com/' }], { seed: '' })).success, false);
  assert.equal(explorationRequestSchema.safeParse(baseRequest([{ id: 'g', action: 'goto', url: 'https://dev.example.com/' }], { sample: -1 })).success, false);
});

test('routine content: parameters are optional with no default, so a routine saved before them keeps its digest', () => {
  const without = routineContentSchema.parse({ title: 't', targetProfile: 'p', steps: [{ id: 'g', action: 'goto', url: 'https://dev.example.com/' }] });
  assert.equal('parameters' in without, false);
  const withParams = routineContentSchema.parse({ title: 't', targetProfile: 'p', parameters: [{ name: 'q', cases: ['1'] }], steps: [{ id: 'g', action: 'goto', url: 'https://dev.example.com/' }] });
  assert.equal(withParams.parameters?.length, 1);
});

test('lint: a secret in a parameter\'s cases or oneOf values is refused and never echoed', () => {
  const secret = 'S3cr3t-Value-ABC123';
  const issues = lintParameters(
    [
      { name: 'a', cases: ['fine', secret] },
      { name: 'b', generator: { type: 'oneOf', values: ['x', `prefix ${secret} suffix`] } },
      { name: 'c', generator: { type: 'int' } },
      { name: 'd', cases: ['sk-abcdefghijklmnopqrstuvwxyz0123'] },
    ],
    [secret],
  );
  assert.deepEqual(issues.map((issue) => issue.path), ['parameters.0.cases.1', 'parameters.1.generator.values.1', 'parameters.3.cases.0']);
  assert.ok(!JSON.stringify(issues).includes(secret));
  assert.deepEqual(lintParameters([{ name: 'ok', cases: ['1', '2'] }], [secret]), []);
});
