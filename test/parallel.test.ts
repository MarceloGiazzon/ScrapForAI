import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// T6.5 `parallel`, without a browser: the shape helpers, the validation rules that keep a race a race, every walker that must see INSIDE a branch (a
// secret, a fault, a login, an actor), include expansion and parameters inside a branch. The browser side is test/parallel.smoke.ts.

const ORIGIN = 'https://dev.example.com';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-parallel-test-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts'); // .env may pin it
process.env.SCRAPFORAI_VAULT_KEY = crypto.randomBytes(32).toString('base64');
process.env.ALLOWED_TARGET_ORIGINS = ORIGIN;
process.env.ALLOWED_RESOURCE_ORIGINS = ORIGIN;
process.env.MAX_STEPS_PER_JOB = '20';
process.env.MAX_ACTORS_PER_JOB = '5';
process.env.ALLOW_EVALUATE = 'false';

const { branchesOf, countSteps, extractedNameOf, isParallelStep, leafSteps, mapLeaves, someStep, walkSteps, walkWithPath } = await import('../src/schemas/stepTree.js');
const { explorationRequestSchema, explorationStepSchema, leafStepSchema } = await import('../src/schemas/explorationRequest.schema.js');
const { routineContentSchema } = await import('../src/schemas/libraryRoutine.schema.js');
const { buildRoutineRequestJsonSchema } = await import('../src/schemas/jsonSchema.js');
const { actorsInUse } = await import('../src/runner/actors.js');
const { usesFaults } = await import('../src/runner/faults.js');
const { usesQuiet } = await import('../src/runner/networkQuiet.js');
const { usesPiiScan } = await import('../src/runner/piiScanner.js');
const { lintRoutineSteps } = await import('../src/library/routineLint.js');
const { lintConventions } = await import('../src/library/conventionLint.js');
const { declareParameters, referencedParameters, resolveParameters } = await import('../src/generators/resolveParameters.js');
const { saveTarget } = await import('../src/targets/targetStore.js');
const { saveRoutine } = await import('../src/library/routineService.js');
const { expandIncludes } = await import('../src/library/includeExpander.js');
const { resolveExplorationRequest } = await import('../src/runner/resolveRequest.js');

before(async () => {
  await saveTarget({
    id: 'app-dev', name: 'app-dev', platform: 'generic', environment: 'dev', baseUrl: ORIGIN, credentialSets: [], noiseFilters: [], surfaces: {}, screens: [],
    flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 2 },
  });
});

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const open = (actor?: string) => ({ ...(actor ? { actor } : {}), action: 'goto', url: '$targetUrl' }) as const;
const click = (selector: string, actor?: string, id?: string) => ({ ...(id ? { id } : {}), ...(actor ? { actor } : {}), action: 'click', selector }) as const;
const race = (...branches: object[][]) => ({ id: 'race', action: 'parallel', branches });
const request = (steps: object[], extra: object = {}) => ({ targetUrl: `${ORIGIN}/`, actors: { alice: {}, bob: {} }, steps, ...extra });
const issues = (input: object) => {
  const parsed = explorationRequestSchema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
};

// ---------------------------------------------------------------------------------------------------------------- shape helpers

const sample = [
  { id: 'a', action: 'reload' },
  { id: 'p', action: 'parallel', branches: [[{ id: 'b0', action: 'click' }, { id: 'b1', action: 'click' }], [{ id: 'c0', action: 'screenshot', name: 'x' }]] },
  { id: 'z', action: 'reload' },
];

test('walkSteps visits the block and then its branches, branch 0 first; leafSteps skips the containers', () => {
  assert.deepEqual([...walkSteps(sample)].map((s) => s.id), ['a', 'p', 'b0', 'b1', 'c0', 'z']);
  assert.deepEqual([...leafSteps(sample)].map((s) => s.id), ['a', 'b0', 'b1', 'c0', 'z']);
  assert.equal(countSteps(sample), 6, 'a block counts as one step plus the steps of its branches');
  assert.equal(countSteps([{ action: 'reload' }]), 1, 'without a block, the length');
  assert.equal(someStep(sample, (s) => s.id === 'c0'), true);
  assert.equal(someStep(sample, (s) => s.id === 'p'), false, 'the container is not a leaf');
});

test('walkWithPath gives the path to each step, for messages that point at the exact step', () => {
  const paths = [...walkWithPath(sample, ['steps'])].map(({ step, path: where }) => [step.id, where.join('.')]);
  assert.deepEqual(paths, [
    ['a', 'steps.0'],
    ['p', 'steps.1'],
    ['b0', 'steps.1.branches.0.0'],
    ['b1', 'steps.1.branches.0.1'],
    ['c0', 'steps.1.branches.1.0'],
    ['z', 'steps.2'],
  ]);
});

test('mapLeaves rewrites leaves, keeps the block, and names the slot of a step ("s1b1_0" = first step of the second branch of the second step)', () => {
  const slots: string[] = [];
  const out = mapLeaves(sample, (step, slot) => {
    slots.push(slot);
    return { ...step, seen: true };
  });
  assert.deepEqual(slots, ['s0', 's1b0_0', 's1b0_1', 's1b1_0', 's2']);
  assert.equal(out[1]!.action, 'parallel');
  assert.deepEqual(branchesOf(out[1]!).map((b) => b.length), [2, 1]);
  assert.ok([...leafSteps(out)].every((s) => (s as { seen?: boolean }).seen));
  assert.equal(isParallelStep(out[1]!), true);
});

test('extractedNameOf: any named step except a screenshot (a file, not an extracted value)', () => {
  assert.equal(extractedNameOf({ action: 'extractText', name: 'total' }), 'total');
  assert.equal(extractedNameOf({ action: 'probePage', name: 'p' }), 'p');
  assert.equal(extractedNameOf({ action: 'screenshot', name: 'home' }), undefined);
  assert.equal(extractedNameOf({ action: 'click' }), undefined);
});

// ---------------------------------------------------------------------------------------------------------------- schema

test('a block of two branches, one actor each, is a valid request', () => {
  assert.deepEqual(issues(request([open('alice'), open('bob'), race([click('#save', 'alice')], [click('#save', 'bob')])])), []);
});

test('a block needs two branches, and no branch may be empty', () => {
  assert.notEqual(issues(request([race([click('#save', 'alice')])])).length, 0);
  assert.notEqual(issues(request([race([click('#save', 'alice')], [])])).length, 0);
});

test('a block cannot nest, and cannot sit in a teardown: a message that says why, not "Invalid input"', () => {
  const nested = issues(request([race([{ action: 'parallel', branches: [[click('#a', 'alice')], [click('#b', 'bob')]] }], [click('#save', 'bob')])]));
  assert.ok(nested.some((line) => /cannot hold another one/.test(line)), nested.join('\n'));

  const inTeardown = issues(request([open('alice')], { teardown: [race([click('#a', 'alice')], [click('#b', 'bob')])] }));
  assert.ok(inTeardown.some((line) => /not allowed in a teardown/.test(line)), inTeardown.join('\n'));
  assert.equal(leafStepSchema.safeParse({ action: 'parallel', branches: [] }).success, false);
  assert.equal(explorationStepSchema.safeParse({ action: 'parallel', branches: [[click('#a', 'alice')], [click('#b', 'bob')]] }).success, true);
});

test('a branch is ONE actor and an actor is in ONE branch', () => {
  const mixed = issues(request([race([click('#a', 'alice'), click('#b', 'bob')], [click('#c', 'bob')])]));
  assert.ok(mixed.some((line) => /runs as ONE actor/.test(line)), mixed.join('\n'));

  const twice = issues(request([race([click('#a', 'alice')], [click('#b', 'alice')])]));
  assert.ok(twice.some((line) => /both run as actor "alice"/.test(line)), twice.join('\n'));

  // main is an actor too: a branch with no actor named is main's.
  const mainTwice = issues(request([race([click('#a')], [click('#b', 'main')])]));
  assert.ok(mainTwice.some((line) => /both run as actor "main"/.test(line)), mainTwice.join('\n'));
  assert.deepEqual(issues(request([race([click('#a')], [click('#b', 'bob')])])), [], 'main against bob is fine');
});

test('an undeclared actor inside a branch is refused with the path to it', () => {
  const found = issues(request([race([click('#a', 'alice')], [click('#b', 'ghost')])]));
  assert.ok(found.some((line) => line.startsWith('steps.0.branches.1.0.actor:') && /"ghost" is not declared/.test(line)), found.join('\n'));
});

test('an include with no actor is judged after expansion, not before (its steps may name actors of their own)', () => {
  assert.deepEqual(issues(request([race([{ action: 'include', routineId: 'x' }], [{ action: 'include', routineId: 'y' }])])), []);
  assert.ok(issues(request([race([{ action: 'include', routineId: 'x', actor: 'alice' }], [{ action: 'include', routineId: 'y', actor: 'alice' }])])).some((line) => /both run as actor/.test(line)));
});

test('step ids are unique across the whole list, branches included', () => {
  const found = issues(request([race([click('#a', 'alice', 'save')], [click('#b', 'bob', 'save')])]));
  assert.ok(found.some((line) => /duplicate step id "save"/.test(line)), found.join('\n'));
});

test('waitForElapsed may look at what finished before the block or earlier in its own branch, never at a sibling branch', () => {
  const wait = (since: string, actor: string) => ({ actor, action: 'waitForElapsed', sinceStepId: since, minElapsedMs: 0 });
  const before_ = { id: 'prep', action: 'reload' };
  assert.deepEqual(issues(request([before_, race([click('#a', 'alice', 'a1'), wait('a1', 'alice'), wait('prep', 'alice')], [click('#b', 'bob')])])), []);
  const sibling = issues(request([race([click('#a', 'alice', 'a1')], [wait('a1', 'bob')])]));
  assert.ok(sibling.some((line) => /earlier step/.test(line)), sibling.join('\n'));
  // After the block every branch's steps are earlier.
  assert.deepEqual(issues(request([race([click('#a', 'alice', 'a1')], [click('#b', 'bob', 'b1')]), { action: 'waitForElapsed', sinceStepId: 'b1', minElapsedMs: 0 }])), []);
});

test('a fault may end at a later step of its branch, or of a later block, but not at a sibling branch', () => {
  const fault = (until: string, actor: string) => ({ actor, action: 'injectFault', match: { urlContains: '/api' }, fault: { status: 500 }, untilStep: until });
  assert.deepEqual(issues(request([race([fault('a2', 'alice'), click('#x', 'alice', 'a2')], [click('#b', 'bob')])])), []);
  assert.ok(issues(request([race([fault('b1', 'alice')], [click('#b', 'bob', 'b1')])])).some((line) => /LATER step of the same list/.test(line)));
  assert.deepEqual(issues(request([fault('b1', 'alice'), race([click('#a', 'alice')], [click('#b', 'bob', 'b1')])])), [], 'a later step inside a later block counts');
});

test('two branches may not extract under the same name (the value would depend on who finished last)', () => {
  const extract = (name: string, actor: string) => ({ actor, action: 'extractText', name, selector: '#total' });
  const found = issues(request([race([extract('total', 'alice')], [extract('total', 'bob')])]));
  assert.ok(found.some((line) => /both extract "total"/.test(line)), found.join('\n'));
  assert.deepEqual(issues(request([race([extract('alice-total', 'alice')], [extract('bob-total', 'bob')])])), []);
  // Two screenshots of the same name are not a conflict: each actor keeps its own file.
  assert.deepEqual(issues(request([race([{ actor: 'alice', action: 'screenshot', name: 'end' }], [{ actor: 'bob', action: 'screenshot', name: 'end' }])])), []);
});

test('MAX_STEPS_PER_JOB counts a block as one step plus the steps of its branches', () => {
  const branch = (actor: string, n: number) => Array.from({ length: n }, () => click('#x', actor));
  assert.deepEqual(issues(request([race(branch('alice', 9), branch('bob', 9))])), [], '1 + 18 = 19 <= 20');
  const found = issues(request([race(branch('alice', 10), branch('bob', 10))]));
  assert.ok(found.some((line) => /exceed MAX_STEPS_PER_JOB/.test(line)), found.join('\n'));
});

test('evaluate is still gated inside a branch, and a parameter still has to be declared', () => {
  const evaluate = issues(request([race([{ actor: 'alice', action: 'evaluate', name: 'x', script: 'return 1' }], [click('#b', 'bob')])]));
  assert.ok(evaluate.some((line) => /evaluate\/watch are disabled/.test(line)), evaluate.join('\n'));
  const undeclared = issues(request([race([{ actor: 'alice', action: 'fill', selector: '#q', valueFromParameter: 'qty' }], [click('#b', 'bob')])]));
  assert.ok(undeclared.some((line) => line.startsWith('steps.0.branches.0.0.valueFromParameter:')), undeclared.join('\n'));
});

test('a routine can hold a block (and still no block in its teardown)', () => {
  const content = { title: 't', targetProfile: 'app-dev', actors: { alice: {}, bob: {} }, steps: [race([click('#a', 'alice')], [click('#b', 'bob')])] };
  assert.equal(routineContentSchema.safeParse(content).success, true);
  assert.equal(routineContentSchema.safeParse({ ...content, teardown: [race([click('#a', 'alice')], [click('#b', 'bob')])] }).success, false);
});

test('the JSON Schema of a request has the block, with the leaf steps for its branches and no recursion', () => {
  const text = JSON.stringify(buildRoutineRequestJsonSchema());
  assert.match(text, /"parallel"/);
  assert.match(text, /"branches"/);
  assert.ok(!text.includes('"$ref":"#"'), 'no self reference');
});

// ---------------------------------------------------------------------------------------------------------------- walkers

test('actors, faults, quiet and the PII hunt see inside a branch', () => {
  const faulty = [race([{ actor: 'alice', action: 'injectFault', match: { urlContains: '/x' }, fault: { status: 500 } }], [{ actor: 'bob', action: 'waitForQuiet' }])];
  assert.equal(usesFaults({ steps: faulty as never }), true);
  assert.equal(usesQuiet({ steps: faulty }), true);
  assert.equal(usesPiiScan({ options: {}, steps: [race([{ actor: 'alice', action: 'scanForPii', name: 'p' }], [click('#b', 'bob')])] as never }), true);
  assert.deepEqual(actorsInUse({ steps: [race([click('#a', 'alice')], [click('#b', 'bob')]), open()] }), ['alice', 'bob', 'main']);
  assert.equal(usesFaults({ steps: [race([click('#a', 'alice')], [click('#b', 'bob')])] as never }), false);
});

test('a secret typed as a literal inside a branch is refused by the routine lint, with the path to it', () => {
  const steps = [race([{ actor: 'alice', action: 'fill', selector: '#p', value: 'hunter2-the-real-one' }], [click('#b', 'bob')])];
  const found = lintRoutineSteps(steps as never, ['hunter2-the-real-one']);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.path, 'steps.0.branches.0.0.value');
  assert.ok(!JSON.stringify(found).includes('hunter2'), 'the message never echoes the secret');
  assert.equal(lintRoutineSteps([race([{ actor: 'alice', action: 'fill', selector: '#p', value: 'sk-abcdefghijklmnopqrstuvwxyz0123' }], [click('#b', 'bob')])] as never, []).length, 1, 'a known key shape too');
});

test('the convention lint reads the steps of a branch: positional selectors and fixed waits, with the real path', () => {
  const steps = [race([{ id: 'wait', actor: 'alice', action: 'waitForTimeout', timeoutMs: 500 }, click('li:nth-child(2) a', 'alice')], [click('#b', 'bob')])];
  const { findings } = lintConventions({ steps: steps as never }, { platform: 'generic' });
  assert.deepEqual(findings.map((f) => [f.rule, f.path]).sort(), [['SEL001', 'steps.0.branches.0.1'], ['WT001', 'steps.0.branches.0.0']]);
});

test('GX001 follows each actor through a block: each branch logs in and gates for itself', () => {
  const login = (actor: string, gated: boolean) => [
    { actor, action: 'fill', selector: '#u', valueFromCredential: 'user' },
    { actor, action: 'fill', selector: '#p', valueFromCredential: 'pass' },
    { actor, action: 'click', selector: '#go' },
    ...(gated ? [{ actor, action: 'waitForUrlContains', value: '/home' }] : []),
  ];
  const ok = lintConventions({ steps: [race(login('alice', true), login('bob', true))] as never, teardown: [] }, { platform: 'genexus' });
  assert.deepEqual(ok.findings.filter((f) => f.rule === 'GX001'), []);
  const missing = lintConventions({ steps: [race(login('alice', true), login('bob', false))] as never }, { platform: 'genexus' });
  const gx001 = missing.findings.filter((f) => f.rule === 'GX001');
  assert.equal(gx001.length, 1, "alice's gate does not vouch for bob's login");
  assert.equal(gx001[0]!.path, 'steps.0.branches.1.2');
});

test('an inline generator inside a branch becomes a parameter named after its step, or after its slot when it has no id', () => {
  const steps = [
    { id: 'plain', action: 'reload' },
    race(
      [{ id: 'qty-a', actor: 'alice', action: 'fill', selector: '#q', valueFromGenerator: { type: 'int', min: 1, max: 5 } }],
      [{ actor: 'bob', action: 'fill', selector: '#q', valueFromGenerator: { type: 'int', min: 1, max: 5 } }],
    ),
  ];
  const declared = declareParameters({ steps });
  assert.deepEqual(declared.parameters.map((p) => p.name), ['gen_qty-a', 'gen_s1b1_0']);
  assert.deepEqual(referencedParameters([...leafSteps(declared.steps)]), ['gen_qty-a', 'gen_s1b1_0']);

  const resolved = resolveParameters({ steps, seed: 'fixed-seed', sample: 0 });
  assert.equal(Object.keys(resolved.record!.values).length, 2, 'both draw a value');
  assert.ok([...leafSteps(resolved.steps)].every((s) => (s as { valueFromGenerator?: unknown }).valueFromGenerator === undefined));
});

// ---------------------------------------------------------------------------------------------------------------- includes

test('an include inside a branch expands inside that branch, under its actor, with prefixed ids and its own teardown deferred', async () => {
  await saveRoutine('login', {
    title: 'login', targetProfile: 'app-dev',
    steps: [{ id: 'open', action: 'goto', url: '$targetUrl' }, { id: 'go', action: 'click', selector: '#go' }],
    teardown: [{ id: 'out', action: 'goto', url: `${ORIGIN}/logout` }],
  } as never);

  const out = await expandIncludes({
    steps: [race([{ id: 'in-a', action: 'include', routineId: 'login', actor: 'alice' }, click('#save', 'alice', 'save-a')], [{ id: 'in-b', action: 'include', routineId: 'login', actor: 'bob' }]) as never],
    actors: { alice: {}, bob: {} },
  });

  assert.deepEqual([...walkSteps(out.steps)].map((s) => (s as { id?: string }).id), ['race', 'in-a.open', 'in-a.go', 'save-a', 'in-b.open', 'in-b.go']);
  assert.ok([...leafSteps(out.steps)].every((s) => (s as { action: string }).action !== 'include'), 'the runner never sees an include');
  const actors = [...leafSteps(out.steps)].map((s) => (s as { actor?: string }).actor);
  assert.deepEqual(actors, ['alice', 'alice', 'alice', 'bob', 'bob'], 'the included steps run as the include\'s actor');
  assert.deepEqual(out.includes.map((i) => i.routineId), ['login', 'login']);
  assert.equal(out.teardown.length, 2, 'both includes brought their teardown, run after the steps');
});

test('after expansion the branches are checked again: two includes that land on one actor are refused', async () => {
  await assert.rejects(
    expandIncludes({
      steps: [race([{ id: 'in-a', action: 'include', routineId: 'login', actor: 'alice' }], [{ id: 'in-b', action: 'include', routineId: 'login', actor: 'alice' }]) as never],
      actors: { alice: {} },
    }),
    (error: Error) => error.name === 'ExpandedRoutineInvalid' && /both run as actor "alice"/.test(error.message),
  );
});

// ---------------------------------------------------------------------------------------------------------------- barrier

const barrier = (name: string, actor?: string, extra: object = {}) => ({ ...(actor ? { actor } : {}), action: 'barrier', name, ...extra }) as const;

test('a barrier is a meeting point, not an extraction: the same name in every branch is what it is for', () => {
  assert.equal(extractedNameOf({ action: 'barrier', name: 'go' }), undefined);
  assert.deepEqual(issues(request([race([click('#a', 'alice'), barrier('go', 'alice'), click('#save', 'alice')], [barrier('go', 'bob'), click('#save', 'bob')])])), []);
  // Two barriers, in the same order in both branches, and a timeout on one of them.
  assert.deepEqual(
    issues(request([race([barrier('ready', 'alice', { timeoutMs: 5000 }), click('#a', 'alice'), barrier('done', 'alice')], [barrier('ready', 'bob'), click('#b', 'bob'), barrier('done', 'bob')])])),
    [],
  );
  assert.ok(JSON.stringify(buildRoutineRequestJsonSchema()).includes('"barrier"'), 'the JSON Schema offers the step');
});

test('a barrier outside a parallel branch is refused: it would wait for nobody', () => {
  const top = issues(request([barrier('go', 'alice')]));
  assert.ok(top.some((line) => line.startsWith('steps.0.action:') && /only works inside a parallel branch/.test(line)), top.join('\n'));
  const inTeardown = issues(request([open('alice')], { teardown: [barrier('go', 'alice')] }));
  assert.ok(inTeardown.some((line) => line.startsWith('teardown.0.action:') && /only works inside a parallel branch/.test(line)), inTeardown.join('\n'));
  assert.equal(leafStepSchema.safeParse({ action: 'barrier', name: 'go' }).success, true, 'as a step it is valid; where it stands is what is checked');
  assert.equal(leafStepSchema.safeParse({ action: 'barrier' }).success, false, 'a name is required');
  assert.equal(leafStepSchema.safeParse({ action: 'barrier', name: 'go', frame: { name: 'x' }, selector: '#a' }).success, false, 'strict: no selector');
});

test('every branch must hold the same barriers in the same order, once each: otherwise somebody waits for a branch that never comes', () => {
  const onlyOne = issues(request([race([barrier('go', 'alice'), click('#a', 'alice')], [click('#b', 'bob')])]));
  assert.ok(onlyOne.some((line) => line.startsWith('steps.0.branches.1:') && /branch 1 holds the barriers none but branch 0 holds "go"/.test(line)), onlyOne.join('\n'));

  const swapped = issues(request([race([barrier('a', 'alice'), barrier('b', 'alice')], [barrier('b', 'bob'), barrier('a', 'bob')])]));
  assert.ok(swapped.some((line) => /branch 1 holds the barriers "b", "a" but branch 0 holds "a", "b"/.test(line)), swapped.join('\n'));

  const other = issues(request([race([barrier('a', 'alice')], [barrier('z', 'bob')])]));
  assert.ok(other.some((line) => /every branch must reach the same barriers in the same order/.test(line)), other.join('\n'));

  const twice = issues(request([race([barrier('go', 'alice'), click('#a', 'alice'), barrier('go', 'alice')], [barrier('go', 'bob'), click('#b', 'bob'), barrier('go', 'bob')])]));
  assert.ok(twice.some((line) => /barrier "go" appears twice in branch 0/.test(line)), twice.join('\n'));
});

test('a barrier carries the branch\'s actor like any other step: one with none is main\'s, and a branch is ONE actor', () => {
  const found = issues(request([race([click('#a', 'alice'), barrier('go')], [click('#b', 'bob'), barrier('go', 'bob')])]));
  assert.ok(found.some((line) => /runs as ONE actor but this one uses alice, main/.test(line)), found.join('\n'));
  assert.deepEqual(actorsInUse({ steps: [race([click('#a', 'alice'), barrier('go', 'alice')], [barrier('go', 'bob')]) as never] }), ['alice', 'bob'], 'a barrier opens no actor of its own');
});

test('a branch with an include is judged after expansion: the barriers are compared then, with what the included routine brought', async () => {
  // Before expansion nothing is known about the include, so there is nothing to compare.
  assert.deepEqual(issues(request([race([{ action: 'include', routineId: 'login', actor: 'alice' }, barrier('go', 'alice')], [barrier('go', 'bob')])])), []);
  // After it: login has no barrier, alice's branch has one and bob's has one too -> same -> fine; but an include that adds a branch without one is not.
  const expanded = await expandIncludes({
    steps: [race([{ id: 'in-a', action: 'include', routineId: 'login', actor: 'alice' }, barrier('go', 'alice')], [{ id: 'in-b', action: 'include', routineId: 'login', actor: 'bob' }]) as never],
    actors: { alice: {}, bob: {} },
  }).then(() => 'expanded', (error: Error) => `${error.name}: ${error.message}`);
  assert.match(expanded, /^ExpandedRoutineInvalid: .*branch 1 holds the barriers none but branch 0 holds "go"/);
});

test('a barrier counts as a step against MAX_STEPS_PER_JOB (20 in this file)', () => {
  const branch = (actor: string, clicks: number) => [barrier('go', actor), ...Array.from({ length: clicks }, () => click('#x', actor))];
  assert.deepEqual(issues(request([race(branch('alice', 8), branch('bob', 8))])), [], '1 + 9 + 9 = 19 steps: fits');
  const tooMany = issues(request([race(branch('alice', 9), branch('bob', 9))]));
  assert.ok(tooMany.some((line) => /exceed MAX_STEPS_PER_JOB/.test(line)), '1 + 10 + 10 = 21 steps: the barriers are in the count');
});

test('resolving a request with a block keeps its structure and hands a teardown of leaf steps to the runner', async () => {
  const resolved = await resolveExplorationRequest(
    explorationRequestSchema.parse({
      targetProfile: 'app-dev',
      actors: { alice: {}, bob: {} },
      steps: [race([{ id: 'in-a', action: 'include', routineId: 'login', actor: 'alice' }], [click('#save', 'bob', 'save-b')])],
    }),
  );
  assert.equal(resolved.steps[0]!.action, 'parallel');
  assert.deepEqual(actorsInUse(resolved), ['alice', 'bob']);
  assert.equal(resolved.teardown?.length, 1, "alice's login teardown");
  assert.equal(resolved.unexpanded?.steps[0]!.action, 'parallel', 'saved as written: the include is still an include');
});
