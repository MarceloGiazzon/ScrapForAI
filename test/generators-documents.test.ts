import assert from 'node:assert/strict';
import test from 'node:test';

// T5.3 part 2, the pure half: document generators (cpf, cnpj, ci-uy, rut-uy), the `synthetic` mark, safe implicit names, and how a
// report shows generated data.

process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';

const { createRng } = await import('../src/generators/prng.js');
const { boundaryValues, randomValue, edgeCount, isValidDocument } = await import('../src/generators/generators.js');
const { resolveParameters } = await import('../src/generators/resolveParameters.js');
const { checkedGeneratorSchema, parameterSchema, sanitizeParameterName } = await import('../src/schemas/parameters.schema.js');
const { renderRunReport, printable } = await import('../src/reports/render.js');

type Kind = 'cpf' | 'cnpj' | 'ci-uy' | 'rut-uy';
const KINDS: Kind[] = ['cpf', 'cnpj', 'ci-uy', 'rut-uy'];
const LENGTH: Record<Kind, number> = { cpf: 11, cnpj: 14, 'ci-uy': 8, 'rut-uy': 12 };
const doc = (kind: Kind, over: Record<string, unknown> = {}) => checkedGeneratorSchema.parse({ type: 'document', kind, ...over });
const digitsOnly = (text: string) => text.replace(/\D/g, '');

test('the validator agrees with documents known to be correct (and refuses the classic fakes)', () => {
  for (const good of ['529.982.247-25', '52998224725', '123.456.789-09']) assert.ok(isValidDocument('cpf', good), good);
  for (const bad of ['111.111.111-11', '00000000000', '529.982.247-24', '5299822472', '529.982.247-250']) assert.ok(!isValidDocument('cpf', bad), bad);

  for (const good of ['11.222.333/0001-81', '11222333000181', '00.000.000/0001-91']) assert.ok(isValidDocument('cnpj', good), good);
  for (const bad of ['11.111.111/1111-11', '11.222.333/0001-80', '1122233300018']) assert.ok(!isValidDocument('cnpj', bad), bad);

  for (const good of ['1.234.567-2', '12345672']) assert.ok(isValidDocument('ci-uy', good), good);
  for (const bad of ['1.234.567-3', '1234567', '123456722']) assert.ok(!isValidDocument('ci-uy', bad), bad);

  assert.ok(isValidDocument('rut-uy', '215521750017'));
  for (const bad of ['215521750018', '21552175001', '2155217500170']) assert.ok(!isValidDocument('rut-uy', bad), bad);

  assert.ok(!isValidDocument('cpf', 'ABCDEFGHIJK'), 'letters are never a document');
  assert.ok(!isValidDocument('cpf', ''));
});

test('valid: every generated document passes the check, whatever the seed, formatted or not', () => {
  for (const kind of KINDS) {
    const rng = createRng(`valid:${kind}`);
    const plain = doc(kind);
    const pretty = doc(kind, { formatted: true });
    const seen = new Set<string>();
    for (let i = 0; i < 300; i += 1) {
      const a = randomValue(plain, rng);
      assert.match(a, new RegExp(`^\\d{${LENGTH[kind]}}$`), `${kind} ${a}`);
      assert.ok(isValidDocument(kind, a), `${kind} ${a}`);
      seen.add(a);
      const b = randomValue(pretty, rng);
      assert.ok(isValidDocument(kind, b), `${kind} ${b}`);
      assert.equal(digitsOnly(b).length, LENGTH[kind]);
    }
    assert.ok(seen.size > 250, `${kind}: documents are varied (${seen.size} distinct of 300)`);
  }
});

test('shapes: separators where the documents have them, none where they do not', () => {
  const rng = createRng('shape');
  assert.match(randomValue(doc('cpf', { formatted: true }), rng), /^\d{3}\.\d{3}\.\d{3}-\d{2}$/);
  assert.match(randomValue(doc('cnpj', { formatted: true }), rng), /^\d{2}\.\d{3}\.\d{3}\/0001-\d{2}$/);
  assert.match(randomValue(doc('ci-uy', { formatted: true }), rng), /^[1-6]\.\d{3}\.\d{3}-\d$/);
  assert.match(randomValue(doc('rut-uy', { formatted: true }), rng), /^\d{12}$/, 'a RUT has no separators');
  const rut = randomValue(doc('rut-uy'), rng);
  assert.ok(Number(rut.slice(0, 2)) >= 1 && Number(rut.slice(0, 2)) <= 22, 'department 01-22');
  assert.equal(rut.slice(8, 11), '001');
});

test('invalid: every generated document is the right length and fails the check, only its last digit being wrong', () => {
  for (const kind of KINDS) {
    const rng = createRng(`invalid:${kind}`);
    const bad = doc(kind, { valid: false });
    for (let i = 0; i < 300; i += 1) {
      const value = randomValue(bad, rng);
      assert.equal(value.length, LENGTH[kind], `${kind} ${value}`);
      assert.ok(!isValidDocument(kind, value), `${kind} ${value} should be invalid`);
    }
  }
  // the same seed gives the same document, valid or not
  const a = randomValue(doc('cpf', { valid: false }), createRng('s'));
  assert.equal(a, randomValue(doc('cpf', { valid: false }), createRng('s')));
});

test('edges: a valid document has none to put first; an invalid one starts with empty, too short, too long, letters, wrong check digit', () => {
  for (const kind of KINDS) {
    assert.equal(edgeCount(parameterSchema.parse({ name: 'd', generator: { type: 'document', kind } })), 0);
    const edges = boundaryValues(doc(kind, { valid: false }));
    assert.equal(edges.length, 5, kind);
    assert.equal(edges[0], '');
    assert.equal(edges[1]!.length, LENGTH[kind] - 1);
    assert.equal(edges[2]!.length, LENGTH[kind] + 1);
    assert.equal(edges[3], 'A'.repeat(LENGTH[kind]));
    assert.equal(edges[4]!.length, LENGTH[kind]);
    for (const edge of edges) assert.ok(!isValidDocument(kind, edge), `${kind} edge "${edge}"`);
    assert.deepEqual(boundaryValues(doc(kind, { valid: false })), edges, 'deterministic');
  }
});

test('schema: kind is one of the four, valid and formatted default as documented, nothing else is accepted', () => {
  const parsed = doc('cpf') as { valid: boolean; formatted: boolean };
  assert.deepEqual([parsed.valid, parsed.formatted], [true, false]);
  assert.equal(checkedGeneratorSchema.safeParse({ type: 'document', kind: 'dni-ar' }).success, false);
  assert.equal(checkedGeneratorSchema.safeParse({ type: 'document' }).success, false);
  assert.equal(checkedGeneratorSchema.safeParse({ type: 'document', kind: 'cpf', surprise: 1 }).success, false);
});

type Step = { id?: string; action: string; selector?: string; valueFromParameter?: string; valueFromGenerator?: unknown };
const fill = (id: string, extra: Record<string, unknown>): Step => ({ id, action: 'fill', selector: '#x', ...extra });

test('synthetic: the record lists the parameters whose values are generated documents, and only those', () => {
  const out = resolveParameters<Step>({
    steps: [fill('cpf', { valueFromGenerator: { type: 'document', kind: 'cpf' } }), fill('qty', { valueFromGenerator: { type: 'int', min: 1, max: 3 } })],
    parameters: [parameterSchema.parse({ name: 'rut', generator: { type: 'document', kind: 'rut-uy', valid: false } }), parameterSchema.parse({ name: 'kind', cases: ['a'] })],
    seed: 'S',
    sample: 5,
  });
  assert.deepEqual([...out.record!.synthetic!].sort(), ['gen_cpf', 'rut']);
  assert.ok(isValidDocument('cpf', out.record!.values.gen_cpf!), 'sample 5 of a valid cpf is a valid random one');

  const none = resolveParameters<Step>({ steps: [fill('q', { valueFromGenerator: { type: 'int', min: 1, max: 3 } })], seed: 'S' });
  assert.equal('synthetic' in none.record!, false, 'no mark when nothing is synthetic');
});

test('implicit names: a step id with dots (from an include) becomes a legal parameter name', () => {
  assert.equal(sanitizeParameterName('gen_login.user'), 'gen_login_user');
  assert.equal(sanitizeParameterName('a b/c'), 'a_b_c');
  assert.equal(sanitizeParameterName('x'.repeat(200)).length, 80);
  const out = resolveParameters<Step>({ steps: [fill('login.user', { valueFromGenerator: { type: 'oneOf', values: ['ana'] } })], seed: 'S' });
  assert.deepEqual(out.record!.values, { gen_login_user: 'ana' });
  assert.equal(out.steps[0]!.valueFromParameter, 'gen_login_user');
});

const reportData = (parameters: unknown) => ({
  jobId: 'job_p', status: 'passed' as const, targetUrl: 'https://x/', startedAt: 'a', finishedAt: 'b', durationMs: 1, executor: 'ScrapForAI', steps: [], screenshots: [],
  consoleCount: 0, consoleErrors: [], networkCount: 0, networkFailures: [], integrity: { state: 'none' as const }, generatedAt: 'now', ...(parameters ? { parameters } : {}),
});

test('report: seed, sample and values are shown escaped and made safe; documents carry the synthetic tag and warning, in every language', () => {
  const params = {
    seed: 'SEED-1',
    sample: 3,
    rows: [
      { name: 'cpf', value: '529.982.247-25', source: 'random', synthetic: true },
      { name: 'note', value: `<script>alert(1)</script>‮evil\u0000'"`, source: 'boundary', synthetic: false },
      { name: 'empty', value: '', source: 'boundary', synthetic: false },
      { name: 'long', value: 'x'.repeat(5000), source: 'boundary', synthetic: false },
    ],
  };
  const html = renderRunReport(reportData(params), 'en');
  assert.ok(html.includes('Test data') && html.includes('SEED-1'));
  assert.ok(html.includes('529.982.247-25') && html.includes('>synthetic<'));
  assert.ok(html.includes('Synthetic data: the generated identity documents are made up'));
  assert.ok(!html.includes('<script>alert(1)'), 'markup in a value is escaped');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('‮') && html.includes('\\u202e') && html.includes('\\u0000'), 'bidi and control characters are shown, not obeyed');
  assert.ok(html.includes('(none)'), 'an empty value says so');
  assert.ok(!html.includes('x'.repeat(300)), 'a long value is clipped');

  assert.ok(renderRunReport(reportData(params), 'pt').includes('Dados sintéticos'));
  assert.ok(renderRunReport(reportData(params), 'es').includes('Datos sintéticos'));
  assert.ok(renderRunReport(reportData(params), 'es').includes('Semilla'));

  const plain = renderRunReport(reportData({ seed: 'S', sample: 0, rows: [{ name: 'q', value: '1', source: 'boundary', synthetic: false }] }), 'en');
  assert.ok(plain.includes('Test data') && !plain.includes('Synthetic data'), 'no warning when nothing is synthetic');
  assert.ok(!renderRunReport(reportData(undefined), 'en').includes('Test data'), 'a run without parameters has no such section');
  assert.equal(printable('a\tb⁧c'), 'a\\u0009b\\u2067c');
});
