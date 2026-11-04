import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// T6.6, without a browser: the concurrency templates (templates/routines/concurrency-*.routine.json) are filled with dummy values, saved through the
// REAL routine service next to a login routine, and expanded the way a run expands them. What is checked is what a template promises: that it still
// saves clean, stays inside MAX_STEPS_PER_JOB once the logins are included, never opens `main`, races only the last action, and that the formulas
// and counts that decide its verdict mean what the description says (fed with the numbers a lost update, a missing save and a good run would give).
// routine-templates.test.ts covers what every template shares (placeholders documented, draft, no literal secret).

const ORIGIN = 'https://dev.example.com';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-concurrency-templates-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts'); // .env may pin it
process.env.SCRAPFORAI_VAULT_KEY = crypto.randomBytes(32).toString('base64');
process.env.ALLOWED_TARGET_ORIGINS = ORIGIN;
process.env.ALLOWED_RESOURCE_ORIGINS = ORIGIN;
process.env.MAX_STEPS_PER_JOB = '50'; // the default: a template has to fit in what a fresh install allows
process.env.MAX_ACTORS_PER_JOB = '5';
process.env.ALLOW_EVALUATE = 'false';

const { actorsInUse } = await import('../src/runner/actors.js');
const { checkAssertEquals } = await import('../src/oracle/assertEquals.js');
const { resolveParameters } = await import('../src/generators/resolveParameters.js');
const { saveRoutine } = await import('../src/library/routineService.js');
const { expandIncludes } = await import('../src/library/includeExpander.js');
const { countSteps, leafSteps, walkSteps } = await import('../src/schemas/stepTree.js');
const { saveTarget } = await import('../src/targets/targetStore.js');

const dir = path.resolve(import.meta.dirname, '..', 'templates', 'routines');
const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');

const EDIT = 'concurrency-simultaneous-edit.routine.json';
const DOUBLE = 'concurrency-double-submit.routine.json';
const SESSION = 'concurrency-single-session.routine.json';
const APPROVAL = 'concurrency-approval-flow.routine.json';
const ALL = [EDIT, DOUBLE, SESSION, APPROVAL];

type Step = Record<string, any>;
interface Template {
  actors: Record<string, { credentialSet?: string }>;
  parameters?: Array<{ name: string; includeBoundaries?: boolean }>;
  credentialSet?: string;
  status: string;
  steps: Step[];
  teardown?: Step[];
}

/** Every REPLACE_* gets a value that is legal for what it stands for (a selector, a URL, a name). */
function fill(raw: string): string {
  return raw.replace(/REPLACE_([A-Z0-9_]+)/g, (_match, key: string) => {
    if (key === 'TARGET_PROFILE') return 'app-dev';
    if (key === 'CREDENTIAL_SET') return 'gam-admin';
    if (key === 'CREDENTIAL_SET_B') return 'gam-user';
    if (key === 'SURFACE') return 'concurrency';
    if (key === 'APPROVED_TEXT') return 'Approved';
    if (key === 'POST_LOGIN_URL_TOKEN') return 'hwbwkw01';
    if (key.endsWith('_URL_TOKEN')) return key.toLowerCase();
    if (key.endsWith('_URL')) return `${ORIGIN}/app/${key.toLowerCase()}`;
    if (key.endsWith('_SELECTOR')) return `#${key.toLowerCase()}`;
    throw new Error(`placeholder ${key} has no dummy in this test`);
  });
}

const read = (file: string): Template => JSON.parse(fill(fs.readFileSync(path.join(dir, file), 'utf8'))) as Template;
const idOf = (file: string): string => file.replace('.routine.json', '');
const steps = (template: Template): Step[] => [...walkSteps(template.steps)] as Step[];
const leaves = (template: Template): Step[] => [...leafSteps(template.steps)] as Step[];
const byId = (template: Template, id: string): Step => {
  const found = steps(template).find((step) => step.id === id);
  assert.ok(found, `the template has a step "${id}"`);
  return found;
};
const indexOfId = (template: Template, id: string): number => steps(template).findIndex((step) => step.id === id);
const blockOf = (template: Template): Step => {
  const blocks = template.steps.filter((step) => step.action === 'parallel');
  assert.equal(blocks.length, 1, 'exactly one parallel block');
  return blocks[0]!;
};

/** A step of an assertEquals as the oracle sees it, fed with the extracted numbers a run would have. */
const verdict = (step: Step, extracted: Record<string, string>) =>
  checkAssertEquals({ actual: step.actual, expected: step.expected, tolerance: step.tolerance, locale: step.locale ?? 'en', parameters: {}, extracted });

before(async () => {
  await saveTarget({
    id: 'app-dev', name: 'app-dev', platform: 'genexus', environment: 'dev', baseUrl: ORIGIN,
    credentialSets: ['gam-admin', 'gam-user'], loginRoutine: 'login', loginGate: { urlContains: 'hwbwkw01', timeoutMs: 15000 },
    noiseFilters: [], surfaces: {}, screens: [],
    flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 2 },
  });
  // The templates `include` the login at version 1: it is the login template, filled and saved first, like the README says.
  await saveRoutine('login', read('gx-login.routine.json') as never);
});

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('the four scenarios of T6.6 exist and are documented', () => {
  const files = fs.readdirSync(dir).filter((file) => file.startsWith('concurrency-'));
  assert.deepEqual(files.sort(), [...ALL].sort());
  for (const file of ALL) assert.ok(readme.includes(file), `${file} is listed in the README`);
});

for (const file of ALL) {
  test(`${file}: saves with no convention finding, fits the step budget once the logins are included, and never opens main`, async () => {
    const template = read(file);
    assert.equal(template.status, 'draft');
    assert.equal(template.credentialSet, undefined, 'main holds no credential set: it would take a session lock for a user nobody logs in as');
    assert.ok(Object.keys(template.actors).length >= 2, 'a concurrency scenario has at least two actors');
    for (const [name, actor] of Object.entries(template.actors)) assert.ok(actor.credentialSet, `actor ${name} names its credential set`);

    // The real save: schema, target profile, parallel/actor rules, secret lint and the convention lint.
    const saved = await saveRoutine(idOf(file), template as never);
    assert.deepEqual(saved.lint.findings, [], 'no warning left to the author (GX002 is suppressed, with its reason)');
    assert.deepEqual(saved.lint.suppressed.map((item) => item.rule), ['GX002']);

    // Every step names an actor, so main never gets a browser context.
    const expanded = await expandIncludes({ steps: template.steps as never, teardown: template.teardown as never, parameters: template.parameters, actors: template.actors }, { targetProfile: 'app-dev' });
    assert.deepEqual([...actorsInUse(expanded)].sort(), Object.keys(template.actors).sort());

    const total = countSteps(expanded.steps) + countSteps(expanded.teardown);
    assert.ok(total <= 50, `${total} steps once expanded; MAX_STEPS_PER_JOB is 50 by default`);

    // One logout (the login's teardown) per login include, each run by the actor that logged in.
    const logins = steps(template).filter((step) => step.action === 'include');
    assert.ok(logins.every((step) => step.routineId === 'login' && step.version === 1 && typeof step.actor === 'string'), 'the login is pinned and run as an actor');
    assert.deepEqual(
      (expanded.teardown as Step[]).map((step) => step.actor).sort(),
      logins.map((step) => step.actor).sort(),
    );
    // Typed data is generated, never the boundaries of validation (this is not a validation test).
    assert.ok((template.parameters ?? []).every((parameter) => parameter.includeBoundaries === false));
  });
}

for (const file of [EDIT, DOUBLE]) {
  test(`${file}: two different actors race one block, and only the last action is inside it`, () => {
    const template = read(file);
    const block = blockOf(template);
    const branches = block.branches as Step[][];
    assert.equal(branches.length, 2);
    const actorsOfBranch = branches.map((branch) => new Set(branch.map((step) => step.actor)));
    assert.ok(actorsOfBranch.every((set) => set.size === 1), 'one branch = one actor');
    assert.notEqual([...actorsOfBranch[0]!][0], [...actorsOfBranch[1]!][0]);
    assert.ok(branches.every((branch) => branch[0]!.action === 'click' && branch[0]!.selector === '#trigger_selector'), 'each branch starts by pressing the same control');
    for (const step of branches.flat()) {
      assert.ok(!['goto', 'fill', 'include', 'press'].includes(step.action), `step ${String(step.id)} is setup and belongs before the block, not inside the race`);
    }
    // Each branch keeps what its user was told, and fails on a raw error; the verdict comes AFTER the block.
    assert.ok(branches.every((branch) => branch.some((step) => step.action === 'extractText')));
    assert.ok(branches.every((branch) => branch.some((step) => step.action === 'assertNoTextMatches')));
    const blockAt = indexOfId(template, block.id);
    const decisive = steps(template).filter((step) => step.action === 'assertEquals' || step.action === 'assertCount');
    assert.ok(decisive.length > 0 && decisive.every((step) => indexOfId(template, step.id) > blockAt || step.id === 'same-start'));
  });
}

test('simultaneous edit: the counter must go up by exactly one (a lost update, or no save at all, fails)', () => {
  const template = read(EDIT);
  const exactlyOne = byId(template, 'exactly-one-saved');
  assert.equal(verdict(exactlyOne, { counter_first: '41', counter_after: '42' }).passed, true, 'one accepted save');
  const lost = verdict(exactlyOne, { counter_first: '41', counter_after: '43' });
  assert.equal(lost.passed, false, 'both saves accepted: the lock let a lost update through');
  assert.match(lost.message, /difference 1/);
  assert.equal(verdict(exactlyOne, { counter_first: '41', counter_after: '41' }).passed, false, 'neither save was accepted');

  // The race only means something if both users started from the same state.
  const sameStart = byId(template, 'same-start');
  assert.equal(verdict(sameStart, { counter_first: '41', counter_second: '41' }).passed, true);
  assert.equal(verdict(sameStart, { counter_first: '41', counter_second: '42' }).passed, false);

  // The two counters are read BEFORE anyone types, and the formula's variables are the names those steps extract.
  const typedAt = Math.min(indexOfId(template, 'first-types'), indexOfId(template, 'second-types'));
  assert.ok(indexOfId(template, 'first-counter') < typedAt && indexOfId(template, 'second-counter') < typedAt);
  assert.equal(byId(template, 'first-counter').name, 'counter_first');
  assert.equal(byId(template, 'after-counter').name, 'counter_after');
  // The two users type different values, drawn by two parameters.
  assert.notEqual(byId(template, 'first-types').valueFromParameter, byId(template, 'second-types').valueFromParameter);
});

test('double submit: both users submit the SAME value and the grid is asked for exactly one row', () => {
  const template = read(DOUBLE);
  const typed = ['first-types', 'second-types', 'search-code'].map((id) => byId(template, id).valueFromParameter);
  assert.deepEqual(typed, ['code', 'code', 'code'], 'one unique value, typed by both users and searched for');

  const count = byId(template, 'exactly-one-record');
  assert.equal(count.action, 'assertCount');
  assert.equal(count.operator, '=');
  assert.equal(count.count, 1);
  assert.ok(indexOfId(template, 'search-code') < indexOfId(template, 'search-settled') && indexOfId(template, 'search-settled') < indexOfId(template, 'exactly-one-record'), 'the grid is allowed to refresh before it is counted');

  // The generated value is the same for both (one parameter) and is never empty or a boundary, so the grid search is meaningful.
  const resolved = resolveParameters({ steps: template.steps as never, parameters: template.parameters as never, seed: 'seed-1', sample: 0 });
  assert.equal(resolved.record!.values.code!.length, 10);
  assert.equal(resolved.record!.sources.code!.source, 'random');
});

test('single session: the same user twice, the older session ends and the newest one is untouched', () => {
  const template = read(SESSION);
  assert.equal(template.actors.first!.credentialSet, template.actors.second!.credentialSet, 'the SAME user logs in twice');
  assert.equal(template.steps.some((step) => step.action === 'parallel'), false, 'not a race: the second login happens after the first is established');

  const order = ['login-first', 'first-visible', 'login-second', 'second-visible', 'first-asks-again', 'first-ended', 'second-asks-again', 'second-still-visible'];
  const positions = order.map((id) => indexOfId(template, id));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, `steps happen in this order: ${order.join(' > ')}`);
  assert.equal(byId(template, 'first-ended').action, 'waitForUrlContains');
  assert.equal(byId(template, 'first-ended').value, 'login_url_token');
  assert.equal(byId(template, 'first-ended').actor, 'first');
  assert.equal(byId(template, 'second-still-in').actor, 'second');

  // Two sessions of one credential only run when the profile allows it, and the README says how to get there.
  assert.match(readme, /maxSessionsPerCredential/);
  assert.match(readme, /TooManySessionsForCredential/);
});

test('approval flow: requester, then approver, then requester again, over one generated subject', () => {
  const template = read(APPROVAL);
  assert.equal(template.steps.some((step) => step.action === 'parallel'), false, 'a hand-over between two users in order, not a race');
  assert.deepEqual(Object.keys(template.actors).sort(), ['approver', 'requester']);

  // The actors alternate: login x2, then requester, approver, requester. The shot is the requester's, after the decision.
  const turns: string[] = [];
  for (const step of leaves(template).filter((item) => item.action !== 'include')) if (turns.at(-1) !== step.actor) turns.push(step.actor);
  assert.deepEqual(turns, ['requester', 'approver', 'requester']);

  // One subject, typed by the requester and searched for by both, so the approver finds THIS request and the requester sees ITS state.
  const subject = leaves(template).filter((step) => step.valueFromParameter === 'subject');
  assert.deepEqual(subject.map((step) => step.actor), ['requester', 'approver', 'requester']);

  // The two halves of the hand-over are both asserted: the item REACHES the approver, and the decision comes BACK.
  assert.ok(indexOfId(template, 'inbox-arrived') < indexOfId(template, 'approve'));
  const back = byId(template, 'status-approved');
  assert.equal(back.actor, 'requester');
  assert.equal(back.action, 'assertTextContains');
  assert.equal(back.text, 'Approved');
  assert.ok(indexOfId(template, 'approved') < indexOfId(template, 'status-open'), 'the requester looks after the approver is done');
});
