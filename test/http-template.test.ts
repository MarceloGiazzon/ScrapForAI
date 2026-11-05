import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// T5.7 follow-up, the pure half: {{parameter}} placeholders in the url and body of an httpRequest (helper, schema, declared-name check,
// resolution of values, rename through an include, suite "parametric" detection and the runner's filling).

const ORIGIN = 'https://dev.example.com';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-http-template-test-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = ORIGIN;
process.env.MAX_STEPS_PER_JOB = '50';

const { placeholdersOf, placeholderNames, placeholderProblems, renamePlaceholders, fillPlaceholders, MissingPlaceholderValue } = await import('../src/schemas/httpTemplate.js');
const { explorationRequestSchema } = await import('../src/schemas/explorationRequest.schema.js');
const { resolveParameters, referencedParameters, ParameterError } = await import('../src/generators/resolveParameters.js');
const { saveTarget } = await import('../src/targets/targetStore.js');
const { saveRoutine } = await import('../src/library/routineService.js');
const { expandIncludes } = await import('../src/library/includeExpander.js');
const { executeHttpRequest, HttpStepError } = await import('../src/runner/httpRequest.js');

before(async () => {
  await saveTarget({
    id: 'app-dev', name: 'app-dev', platform: 'generic', environment: 'dev', baseUrl: ORIGIN, credentialSets: [], noiseFilters: [], surfaces: {}, screens: [],
    flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  });
});
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const call = (over: Record<string, unknown> = {}) => ({ id: 'calc', action: 'httpRequest', name: 'r', method: 'POST', url: '/api/total', body: '{"qty": {{qty}}}', ...over });
const qty = { name: 'qty', generator: { type: 'int', min: 1, max: 9 } };
const parse = (steps: unknown[], parameters: unknown[] = [qty]) => explorationRequestSchema.safeParse({ targetUrl: `${ORIGIN}/app`, steps, parameters });

// ---- the helper

test('placeholders: only {{name}}, {{name|json}} and {{name|url}} count; JSON braces are left alone', () => {
  assert.deepEqual(placeholdersOf('{"a": {{qty}}, "b": {{name|json}}, "c": {"d": 1}}'), [
    { name: 'qty', encoding: 'raw' },
    { name: 'name', encoding: 'json' },
  ]);
  assert.deepEqual(placeholdersOf('{{a b}} {{x|xml}} {x} {{ y }} {{}}'), [], 'anything else is literal text');
  assert.deepEqual(placeholdersOf('{"k":{{n}}}}'), [{ name: 'n', encoding: 'raw' }], 'a closing brace after the placeholder stays');
  assert.deepEqual(placeholderNames('{{a}}{{b}}{{a|json}}'), ['a', 'b']);
  assert.deepEqual(placeholdersOf(undefined), []);
});

test('placeholders: the url takes the bare form only', () => {
  assert.deepEqual(placeholderProblems('/api/{{id}}', 'url'), []);
  assert.equal(placeholderProblems('/api/{{id|json}}', 'url').length, 1);
  assert.deepEqual(placeholderProblems('{"a": {{id|json}}}', 'body'), []);
});

test('fill: raw in a body, json and url on request, always percent-encoded in a url', () => {
  const values = { qty: '12', name: 'a"b\\c', q: 'a b&c=d/../x' };
  assert.equal(fillPlaceholders('{"qty": {{qty}}, "name": {{name|json}}}', values, 'body'), '{"qty": 12, "name": "a\\"b\\\\c"}');
  assert.equal(fillPlaceholders('q={{q|url}}', values, 'body'), 'q=a%20b%26c%3Dd%2F..%2Fx');
  assert.equal(fillPlaceholders('/api/{{q}}?n={{qty}}', values, 'url'), '/api/a%20b%26c%3Dd%2F..%2Fx?n=12', 'a value cannot add a segment or a query parameter');
  assert.equal(fillPlaceholders('no placeholders {"a":{"b":1}}', values, 'body'), 'no placeholders {"a":{"b":1}}');
});

test('fill: a value that looks like a placeholder is not expanded again, and a missing value throws', () => {
  assert.equal(fillPlaceholders('{{a}}', { a: '{{b}}', b: 'x' }, 'body'), '{{b}}');
  assert.throws(() => fillPlaceholders('{{missing}}', {}, 'body'), (error: unknown) => error instanceof MissingPlaceholderValue && /missing/.test((error as Error).message));
  assert.throws(() => fillPlaceholders('{{toString}}', {}, 'body'), MissingPlaceholderValue, 'inherited properties are not values');
});

test('rename: follows the scope for every encoding and leaves other names alone', () => {
  const scope = new Map([['qty', 'inc_qty']]);
  assert.equal(renamePlaceholders('{"a": {{qty}}, "b": {{qty|json}}, "c": {{other}}}', scope), '{"a": {{inc_qty}}, "b": {{inc_qty|json}}, "c": {{other}}}');
  assert.equal(renamePlaceholders('{{qty}}', new Map()), '{{qty}}');
});

// ---- schema

test('schema: a declared parameter in the url and body is accepted; an undeclared one is refused', () => {
  assert.ok(parse([call()]).success);
  assert.ok(parse([call({ url: '/api/{{qty}}/total' })]).success);
  const refused = parse([call({ body: '{"n": {{nope}}}' })]);
  assert.ok(!refused.success);
  assert.match(JSON.stringify(refused.error?.issues), /parameter \\"nope\\" is not declared/);
  assert.ok(!parse([call({ url: '/api/{{nope}}' })]).success, 'also in the url');
  assert.ok(!parse([call({ url: '/api/{{qty}}' })], []).success, 'and with no parameters at all');
});

test('schema: a url placeholder with an encoding is refused', () => {
  const result = parse([call({ url: '/api/{{qty|json}}' })]);
  assert.ok(!result.success);
  assert.match(JSON.stringify(result.error?.issues), /percent-encoded/);
});

// ---- resolution

test('resolve: a placeholder counts as a use of the parameter, so it is drawn and recorded', () => {
  const steps = [call()] as never[];
  assert.deepEqual(referencedParameters(steps), ['qty']);
  const out = resolveParameters({ steps, parameters: [{ name: 'qty', generator: { type: 'int', min: 5, max: 5 }, includeBoundaries: false }] as never, seed: 's', sample: 0 });
  assert.equal(out.record!.values.qty, '5');
  assert.equal(out.steps[0]!.action, 'httpRequest');
});

test('resolve: an undeclared placeholder is an UnknownParameter before any browser starts', () => {
  assert.throws(() => resolveParameters({ steps: [call({ body: '{{ghost}}' })] as never }), (error: unknown) => error instanceof ParameterError && error.type === 'UnknownParameter');
});

test('resolve: with no parameter anywhere a body full of braces is untouched', () => {
  const steps = [call({ body: '{"a":{"b":1}}' })] as never[];
  const out = resolveParameters({ steps });
  assert.equal(out.steps, steps);
  assert.equal(out.record, undefined);
});

// ---- includes

test('include: the placeholders of an included routine follow the rename of its parameters', async () => {
  await saveRoutine('calc-total', {
    title: 'calc',
    targetProfile: 'app-dev',
    parameters: [qty],
    steps: [call({ url: '/api/total/{{qty}}' })],
  } as never);

  const out = await expandIncludes({ steps: [{ id: 'a', action: 'include', routineId: 'calc-total' }] }, { targetProfile: 'app-dev' });
  const step = out.steps[0] as unknown as { url: string; body: string };
  assert.equal(step.url, '/api/total/{{a_qty}}');
  assert.equal(step.body, '{"qty": {{a_qty}}}');
  assert.deepEqual(out.parameters.map((p) => p.name), ['a_qty']);
  // Two includes draw independently.
  const two = await expandIncludes({ steps: [{ id: 'a', action: 'include', routineId: 'calc-total' }, { id: 'b', action: 'include', routineId: 'calc-total' }] }, { targetProfile: 'app-dev' });
  assert.deepEqual([(two.steps[0] as { body: string }).body, (two.steps[1] as { body: string }).body], ['{"qty": {{a_qty}}}', '{"qty": {{b_qty}}}']);
});

// ---- the runner

const recorder = () => {
  const seen: Array<{ url: string; options: Record<string, unknown> }> = [];
  const client = {
    fetch: async (url: string, options: Record<string, unknown>) => {
      seen.push({ url, options });
      return { status: () => 200, headers: () => ({ 'content-type': 'application/json' }), body: async () => Buffer.from('{"total": 1}') };
    },
  };
  return { seen, client: client as never };
};

test('runner: the url is filled before the allowlist check and the body is sent as filled', async () => {
  const { seen, client } = recorder();
  await executeHttpRequest({
    client,
    step: { method: 'POST', url: '/api/{{who}}/total', body: '{"qty": {{qty}}, "who": {{who|json}}}' },
    baseUrl: `${ORIGIN}/app`,
    parameters: { qty: '1000', who: 'a b/../c' },
    timeoutMs: 1000,
    allowedMethods: ['POST'],
  });
  assert.equal(seen[0]!.url, `${ORIGIN}/api/a%20b%2F..%2Fc/total`);
  assert.equal(seen[0]!.options.data, '{"qty": 1000, "who": "a b/../c"}');
});

test('runner: a parameter without a value is a step error, and a body that grows past the limit is refused', async () => {
  const { seen, client } = recorder();
  const base = { client, baseUrl: `${ORIGIN}/app`, timeoutMs: 1000, allowedMethods: ['POST'] };
  await assert.rejects(
    executeHttpRequest({ ...base, step: { method: 'POST', url: '/api/x', body: '{{nope}}' }, parameters: {} }),
    (error: unknown) => error instanceof HttpStepError && /nope/.test((error as Error).message),
  );
  await assert.rejects(
    executeHttpRequest({ ...base, step: { method: 'POST', url: '/api/x', body: `${'{{big}}'.repeat(5)}` }, parameters: { big: 'x'.repeat(5000) } }),
    (error: unknown) => error instanceof HttpStepError && /limit/.test((error as Error).message),
  );
  assert.equal(seen.length, 0, 'nothing was sent');
});

test('runner: a value that points the url off the allowlist cannot, because it is encoded', async () => {
  const { seen, client } = recorder();
  await executeHttpRequest({
    client,
    step: { method: 'GET', url: '/api/{{p}}' },
    baseUrl: `${ORIGIN}/app`,
    parameters: { p: 'https://evil.example.com/x' },
    timeoutMs: 1000,
  });
  assert.equal(new URL(seen[0]!.url).origin, ORIGIN);
});
