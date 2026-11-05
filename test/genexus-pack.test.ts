import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// T10.2, the pure half: the target profile templates, the answers file, the plan (order, completeness, validity), the zip, and that the guides in
// Spanish and Portuguese keep up with the templates.
process.env.SCRAPFORAI_API_KEY ??= 'test-api-key-1234567890';
process.env.ALLOWED_TARGET_ORIGINS ??= 'https://dev.example.com';
process.env.MAX_STEPS_PER_JOB = '50';

const { loadTemplates, parseAnswers, planPack, fillJson, placeholdersIn, collectPackFiles, buildPackZip } = await import('../src/pack/genexusPack.js');
const { targetProfileSchema } = await import('../src/schemas/targetProfile.schema.js');
const { mcpSaveRoutineSchema } = await import('../src/schemas/libraryRoutine.schema.js');
const { readZip } = await import('../src/evidence/zip.js');

const root = path.resolve(import.meta.dirname, '..');
const templatesDir = path.join(root, 'templates');
const templates = await loadTemplates(templatesDir);
const example = JSON.parse(readFileSync(path.join(templatesDir, 'genexus-pack.answers.example.json'), 'utf8')) as Record<string, any>;

const validate = (item: { kind: string; id: string; body: Record<string, unknown> }): string[] => {
  const result = item.kind === 'target' ? targetProfileSchema.safeParse({ ...item.body, id: item.id }) : mcpSaveRoutineSchema.safeParse({ id: item.id, ...item.body });
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
};

// ---- the templates

test('the pack has two GeneXus target profiles and five installable screen routines', () => {
  assert.deepEqual(templates.filter((t) => t.kind === 'target').map((t) => t.name), ['genexus-dev', 'genexus-staging']);
  assert.deepEqual(
    templates.filter((t) => t.kind === 'routine').map((t) => t.name),
    ['login', 'prompt-select', 'smoke-page', 'transaction-insert', 'work-with-search'],
    'chaos- and concurrency- templates are adapted by hand, not installed by id',
  );
});

test('target profile templates: GeneXus rules on, a login gate and a build probe, no secret, placeholders documented, valid once filled', () => {
  const readme = readFileSync(path.join(templatesDir, 'targets', 'README.md'), 'utf8');
  for (const template of templates.filter((t) => t.kind === 'target')) {
    const body = template.body as Record<string, any>;
    assert.equal(body.platform, 'genexus');
    assert.equal(body.loginRoutine, 'login', 'the profile names the routine the pack saves as `login`');
    assert.ok(body.loginGate?.urlContains, 'the login gate is what turns a failed login into a clear failure');
    assert.ok(body.buildInfo, 'a report says which build it proves');
    assert.equal(body.flags.allowFaults, false);
    assert.equal(body.flags.maxSessionsPerCredential, 1, 'GeneXus: one session per user');
    assert.equal(body.id, undefined, 'the id is the one in the URL');
    for (const name of placeholdersIn(template.body)) assert.ok(readme.includes(name), `${name} is not explained in templates/targets/README.md`);
    const filled = fillJson(template.body, Object.fromEntries(placeholdersIn(template.body).map((name) => [name, name === 'REPLACE_BASE_URL' || name.endsWith('_URL') ? 'https://dev.example.com/app' : 'x'])), new Set());
    assert.deepEqual(validate({ kind: 'target', id: 'app-dev', body: filled as never }), [], template.file);
  }
  const staging = templates.find((t) => t.name === 'genexus-staging')!.body as Record<string, any>;
  assert.equal(staging.environment, 'staging');
  assert.equal((templates.find((t) => t.name === 'genexus-dev')!.body as Record<string, any>).environment, 'dev');
});

// ---- filling

test('fillJson: fills inside strings only, so a quote or a backslash in a value cannot break the document; reports what is missing', () => {
  const missing = new Set<string>();
  const filled = fillJson({ a: 'x REPLACE_A y', list: ['REPLACE_B', 1, null, { deep: 'REPLACE_A' }], REPLACE_KEY: 'k' }, { REPLACE_A: 'say "hi" \\ done', REPLACE_B: 'b' }, missing);
  assert.deepEqual(filled, { a: 'x say "hi" \\ done y', list: ['b', 1, null, { deep: 'say "hi" \\ done' }], REPLACE_KEY: 'k' }, 'keys are not placeholders');
  assert.equal(missing.size, 0);
  fillJson({ a: 'REPLACE_NOPE', b: 'REPLACE_BLANK' }, { REPLACE_BLANK: '   ' }, missing);
  assert.deepEqual([...missing].sort(), ['REPLACE_BLANK', 'REPLACE_NOPE'], 'a blank answer is a missing answer');
  assert.deepEqual(placeholdersIn({ a: 'REPLACE_B REPLACE_A', b: ['REPLACE_A'] }), ['REPLACE_A', 'REPLACE_B']);
});

test('parseAnswers: says what is wrong with the file and accepts the example', () => {
  assert.deepEqual(parseAnswers(example).problems, []);
  assert.ok(parseAnswers(null).problems.length > 0);
  const bad = parseAnswers({ values: { not_a_placeholder: 'x', REPLACE_OK: 3 }, target: { template: 'genexus-dev', id: 'bad id!' }, routines: 'login' });
  assert.equal(bad.answers, undefined);
  assert.ok(bad.problems.some((p) => /not_a_placeholder/.test(p)));
  assert.ok(bad.problems.some((p) => /REPLACE_OK/.test(p)));
  assert.ok(bad.problems.some((p) => /target/.test(p)));
  assert.ok(bad.problems.some((p) => /routines/.test(p)));
  assert.ok(parseAnswers({ ...example, routineValues: { login: 'x' } }).problems.some((p) => /routineValues\.login/.test(p)));
});

// ---- the plan

test('planPack: the example is complete and valid; the profile comes first, then the login, then the screens', () => {
  const parsed = parseAnswers(example);
  const plan = planPack(parsed.answers!, templates, validate as never);
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.items.map((item) => item.path), ['/v1/targets/app-dev', '/v1/routines/login', '/v1/routines/smoke-page', '/v1/routines/work-with-search']);
  // The routines point at the profile the answers named, without the user having to repeat it.
  for (const item of plan.items.filter((i) => i.kind === 'routine')) assert.equal((item.body as Record<string, unknown>).targetProfile, 'app-dev');
  assert.ok(plan.items.every((item) => placeholdersIn(item.body).length === 0), 'nothing is left to replace');
  assert.ok(plan.items.filter((i) => i.kind === 'routine').every((i) => (i.body as Record<string, unknown>).status === 'draft'), 'installed routines are drafts');
});

test('planPack: login is always installed; an unknown template, a missing answer and an invalid result each stop everything', () => {
  const base = parseAnswers(example).answers!;
  const withoutLogin = planPack({ ...base, routines: ['smoke-page'] }, templates);
  assert.ok(withoutLogin.items.some((item) => item.id === 'login'), 'every screen includes it');

  const unknown = planPack({ ...base, routines: ['login', 'nope'] }, templates);
  assert.ok(unknown.problems.some((p) => /unknown routine template "nope"/.test(p)));
  assert.ok(planPack({ ...base, target: { template: 'nope', id: 'x' } }, templates).problems.some((p) => /unknown target template/.test(p)));

  const { REPLACE_BASE_URL: _gone, ...fewer } = base.values;
  const missing = planPack({ ...base, values: fewer }, templates);
  assert.ok(missing.problems.some((p) => /genexus-dev\.target\.json: no value for .*REPLACE_BASE_URL/.test(p)));

  const invalid = planPack({ ...base, values: { ...base.values, REPLACE_BASE_URL: 'not a url' } }, templates, validate as never);
  assert.ok(invalid.problems.some((p) => /genexus-dev\.target\.json: baseUrl/.test(p)), invalid.problems.join('\n'));

  const stray = planPack({ ...base, routineValues: { 'transaction-insert': { REPLACE_PAGE_URL: 'https://dev.example.com/x' } } }, templates);
  assert.ok(stray.problems.some((p) => /"transaction-insert", which is not among the routines to install/.test(p)));
});

test('planPack: routineValues override the shared values for that routine only', () => {
  const base = parseAnswers(example).answers!;
  const plan = planPack({ ...base, routineValues: { 'smoke-page': { REPLACE_PAGE_URL: 'https://dev.example.com/MyApp/hother' } } }, templates);
  const smoke = plan.items.find((item) => item.id === 'smoke-page')!;
  assert.match(JSON.stringify(smoke.body), /MyApp\/hother/);
  assert.doesNotMatch(JSON.stringify(plan.items.find((item) => item.id === 'work-with-search')!.body), /hother/);
});

// ---- the zip and the guides

test('the zip holds the templates, the guides, the skill and a manifest that matches', async () => {
  const files = await collectPackFiles(root);
  const zip = buildPackZip(files, '9.9.9', new Date('2026-11-05T12:00:00Z'));
  const entries = new Map(readZip(zip).map((entry) => [entry.name, entry.data]));
  for (const name of [
    'PACK-INFO.txt', 'MANIFEST.sha256', 'answers.example.json', 'templates/targets/genexus-dev.target.json', 'templates/routines/gx-login.routine.json',
    'templates/routines/gx-prompt-select.routine.json', 'docs/genexus-pack/README.es.md', 'docs/genexus-pack/README.pt.md', 'docs/genexus-routine-conventions.md',
    'skill/scrapforai/SKILL.md',
  ]) assert.ok(entries.has(name), `${name} is in the pack`);
  const manifest = entries.get('MANIFEST.sha256')!.toString('utf8');
  assert.match(manifest, /^[0-9a-f]{64} {2}templates\/routines\/gx-login\.routine\.json$/m);
  assert.match(entries.get('PACK-INFO.txt')!.toString('utf8'), /pack 9\.9\.9/);
  // Nothing from the machine goes in: no .env, no data directory.
  assert.ok([...entries.keys()].every((name) => !/(^|\/)\.env|node_modules|credentials/.test(name)));
});

for (const lang of ['es', 'pt']) {
  test(`the ${lang} guide keeps up: every GeneXus template, every lint rule and the install commands are in it`, () => {
    const guide = readFileSync(path.join(root, 'docs', 'genexus-pack', `README.${lang}.md`), 'utf8');
    for (const file of readdirSync(path.join(templatesDir, 'routines')).filter((f) => f.startsWith('gx-') && f.endsWith('.routine.json'))) {
      assert.ok(guide.includes(file.replace('.routine.json', '')), `${lang}: ${file} is not mentioned`);
    }
    for (const file of readdirSync(path.join(templatesDir, 'targets')).filter((f) => f.endsWith('.target.json'))) assert.ok(guide.includes(file.replace('.target.json', '')), `${lang}: ${file}`);
    for (const needle of ['GX001', 'GX002', 'WT001', 'SEL001', 'waitForQuiet', 'pack apply', '--dry-run', 'ALLOWED_TARGET_ORIGINS', 'lintSuppress', 'docs/TEAM-SERVER.md']) {
      assert.ok(guide.includes(needle), `${lang}: ${needle} is not mentioned`);
    }
    assert.ok(guide.includes('test/genexus-pack.smoke.ts') && /aplicaci[oó]n simulada|aplica[cç][aã]o simulada/.test(guide), 'the guide says WHAT the templates were run against (a simulated application), and where');
  });
}
