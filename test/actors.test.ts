import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// T6.4 actors, without a browser: the helpers, the schema rules, the all-or-nothing credential lock, the merge of evidence, include-as-actor and the
// per-actor vault values at resolution. The browser side is test/actors.smoke.ts.

const ORIGIN = 'https://dev.example.com';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-actors-test-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts'); // .env may pin it
process.env.SCRAPFORAI_VAULT_KEY = crypto.randomBytes(32).toString('base64');
process.env.ALLOWED_TARGET_ORIGINS = ORIGIN;
process.env.ALLOWED_RESOURCE_ORIGINS = ORIGIN;
process.env.MAX_STEPS_PER_JOB = '50';
process.env.MAX_ACTORS_PER_JOB = '5';

const { actorsInUse, isMultiActor, sessionCredentialSets } = await import('../src/runner/actors.js');
const { JobQueue, LockUnsatisfiableError } = await import('../src/orchestrator/jobQueue.js');
const { mergeEvidence, mergePiiReports } = await import('../src/runner/mergeEvidence.js');
const { explorationRequestSchema } = await import('../src/schemas/explorationRequest.schema.js');
const { routineContentSchema } = await import('../src/schemas/libraryRoutine.schema.js');
const { saveTarget } = await import('../src/targets/targetStore.js');
const { saveRoutine } = await import('../src/library/routineService.js');
const { expandIncludes } = await import('../src/library/includeExpander.js');
const { resolveExplorationRequest } = await import('../src/runner/resolveRequest.js');
const { saveCredentialSet } = await import('../src/vault/credentials/credentialVault.js');

before(async () => {
  for (const [id, maxSessionsPerCredential] of [['app-dev', 1], ['app-multi', 2]] as const) {
    await saveTarget({
      id, name: id, platform: 'generic', environment: 'dev', baseUrl: ORIGIN, credentialSets: ['main-set', 'bob-set', 'ghost-set'], noiseFilters: [], surfaces: {}, screens: [],
      flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential },
    });
  }
  await saveCredentialSet('main-set', { boundOrigins: [ORIGIN], values: { user: 'mm', pass: 'main-secret-aaaa' }, tags: [] }, 'create');
  await saveCredentialSet('bob-set', { boundOrigins: [ORIGIN], values: { user: 'bb', pass: 'bob-secret-bbbb' }, tags: [] }, 'create');
});

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function manual() {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { done, finish };
}
const queue = (max = 10) => new JobQueue(() => ({ max, reservedForInteractive: 0 }));

// ---------------------------------------------------------------------------------------------------------------- helpers

test('actorsInUse lists the actors that run a step, in the order of their first step, teardown included', () => {
  assert.deepEqual(actorsInUse({ steps: [{}, {}] }), ['main'], 'no actors: just main, as always');
  assert.deepEqual(actorsInUse({ steps: [{ actor: 'bob' }, {}, { actor: 'alice' }, { actor: 'bob' }] }), ['bob', 'main', 'alice']);
  assert.deepEqual(actorsInUse({ steps: [{ actor: 'bob' }], teardown: [{ actor: 'alice' }, { actor: 'bob' }] }), ['bob', 'alice']);
  assert.deepEqual(actorsInUse({ steps: [{ actor: 'main' }, {}] }), ['main'], 'naming main is the same as saying nothing');
});

test('a run is multi-actor only when some step names an actor other than main', () => {
  assert.equal(isMultiActor(['main']), false);
  assert.equal(isMultiActor(['main', 'bob']), true);
  assert.equal(isMultiActor(['bob']), true);
});

test('sessionCredentialSets counts one session per credential set, a repeated set twice', () => {
  assert.deepEqual(sessionCredentialSets({}), []);
  assert.deepEqual(sessionCredentialSets({ credentialSet: 'a' }), ['a']);
  assert.deepEqual(sessionCredentialSets({ credentialSet: 'a', actors: { x: { credentialSet: 'b' }, y: {}, z: { credentialSet: 'a' } } }), ['a', 'b', 'a']);
  assert.deepEqual(sessionCredentialSets({ actors: { x: { credentialSet: 'b' } } }), ['b'], 'an actor-only count, as the suite planner asks for it');
});

// ---------------------------------------------------------------------------------------------------------------- schema

const issues = (input: unknown): string[] => {
  const parsed = explorationRequestSchema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
};
const base = { targetProfile: 'app-dev', steps: [{ action: 'reload' }] };

test('a step may name a declared actor, and only a declared one (steps, teardown and include)', () => {
  assert.deepEqual(issues({ ...base, actors: { bob: {} }, steps: [{ actor: 'bob', action: 'reload' }] }), []);
  assert.deepEqual(issues({ ...base, steps: [{ actor: 'main', action: 'reload' }] }), [], 'main needs no declaration');

  assert.match(issues({ ...base, steps: [{ actor: 'ghost', action: 'reload' }] })[0] ?? '', /steps\.0\.actor: actor "ghost" is not declared/);
  assert.match(issues({ ...base, actors: { bob: {} }, teardown: [{ actor: 'ghost', action: 'reload' }] })[0] ?? '', /teardown\.0\.actor/);
  assert.match(issues({ ...base, steps: [{ action: 'include', routineId: 'login', actor: 'ghost' }] })[0] ?? '', /steps\.0\.actor/);
});

test('main cannot be declared, an actor takes only credentialSet and viewport, and the number of actors is capped', () => {
  assert.match(issues({ ...base, actors: { main: {} } })[0] ?? '', /implicit actor/);
  assert.notEqual(issues({ ...base, actors: { bob: { password: 'x' } } }).length, 0, 'no stray keys on an actor');
  assert.notEqual(issues({ ...base, actors: { bob: { viewport: { width: 10, height: 10 } } } }).length, 0, 'the viewport rules of the run apply');
  const six = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`a${index}`, {}]));
  assert.match(issues({ ...base, actors: six })[0] ?? '', /at most 5 actors/);
});

test('a routine without actors keeps its shape: the field is optional and has no default', () => {
  const parsed = routineContentSchema.parse({ title: 't', targetProfile: 'app-dev', steps: [{ action: 'reload' }] });
  assert.equal('actors' in parsed, false);
  assert.deepEqual(routineContentSchema.parse({ title: 't', targetProfile: 'app-dev', actors: { bob: { credentialSet: 'bob-set' } }, steps: [{ actor: 'bob', action: 'reload' }] }).actors, {
    bob: { credentialSet: 'bob-set' },
  });
});

// ---------------------------------------------------------------------------------------------------------------- the lock

test('a task with several credential keys starts only when ALL are free, and does not block the ones behind it', async () => {
  const q = queue();
  const order: string[] = [];
  const holdA = manual();
  const holdB = manual();

  const y = q.run(async () => void (order.push('y'), await holdA.done), { priority: 'suite', lockKey: 'a' });
  await tick();
  const x = q.run(async () => void (order.push('x'), await holdB.done), { priority: 'suite', lockKeys: ['a', 'b'] });
  const z = q.run(async () => void order.push('z'), { priority: 'suite', lockKey: 'b' });
  await tick();
  assert.deepEqual(order, ['y', 'z'], 'x waits for a; z, behind it, only needs b and goes first');

  holdA.finish();
  await y;
  await tick();
  assert.deepEqual(order, ['y', 'z', 'x'], 'x starts once a is free (z already let go of b)');
  holdB.finish();
  await Promise.all([x, z]);
  assert.deepEqual(q.stats().locks, {}, 'every key was released');
});

test('two tasks can never each hold half of what the other needs', async () => {
  const q = queue();
  const gate = manual();
  const started: string[] = [];
  const first = q.run(async () => void (started.push('first'), await gate.done), { priority: 'suite', lockKeys: ['a', 'b'] });
  const second = q.run(async () => void started.push('second'), { priority: 'suite', lockKeys: ['b', 'a'] });
  await tick();
  assert.deepEqual(started, ['first'], 'the second needs both and neither is free');
  gate.finish();
  await Promise.all([first, second]);
  assert.deepEqual(started, ['first', 'second']);
});

test('a key listed twice is two sessions: it fits maxPerLock 2, and is refused (not queued for ever) with maxPerLock 1', async () => {
  const q = queue();
  const gate = manual();
  const ran: string[] = [];
  const both = q.run(async () => void (ran.push('both'), await gate.done), { priority: 'suite', lockKeys: ['a', 'a'], maxPerLock: 2 });
  const other = q.run(async () => void ran.push('other'), { priority: 'suite', lockKey: 'a', maxPerLock: 2 });
  await tick();
  assert.deepEqual(ran, ['both'], 'both sessions are in use, so a third task waits');
  assert.equal(q.stats().locks['a'], 2);
  gate.finish();
  await Promise.all([both, other]);

  await assert.rejects(q.run(async () => undefined, { priority: 'suite', lockKeys: ['a', 'a'], maxPerLock: 1 }), (error) => {
    assert.ok(error instanceof LockUnsatisfiableError);
    assert.equal(error.wanted, 2);
    return true;
  });
});

test('tryAcquire takes lockKey and lockKeys together and gives all of them back on release', () => {
  const q = queue();
  const held = q.tryAcquire({ priority: 'interactive', lockKey: 'a', lockKeys: ['b'] });
  assert.ok(held.ok);
  assert.deepEqual(q.stats().locks, { a: 1, b: 1 });
  assert.deepEqual(q.tryAcquire({ lockKeys: ['b'] }), { ok: false, reason: 'lock' });
  if (held.ok) held.release();
  assert.deepEqual(q.stats().locks, {});
  assert.ok(q.tryAcquire({ lockKeys: ['b'] }).ok);
});

// ---------------------------------------------------------------------------------------------------------------- merged evidence

const block = (over: Record<string, unknown> = {}) => ({
  screenshots: [], console: [], consoleErrors: [], pageErrors: [], network: [], networkFailures: [], unexpectedExternalRequests: [], ...over,
});

test('mergeEvidence tags every item with its actor and keeps the totals of the run', () => {
  const merged = mergeEvidence([
    {
      actor: 'main',
      evidence: block({
        screenshots: [{ name: 'home', path: 'a/home.png' }],
        consoleErrors: [{ type: 'error', text: 'boom' }],
        pageErrors: ['TypeError: x'],
        networkFailures: [{ origin: 'o', pathname: '/x', method: 'GET', status: 500 }],
        noiseFiltered: [{ reason: 'aborted', count: 2 }],
        traffic: [{ origin: 'o', pathname: '/api', method: 'GET', resourceType: 'xhr', status: 200, count: 3 }],
        tracePath: 'a/trace.zip',
        domTextSnapshot: 'ignored here',
        finalUrl: 'ignored here',
      }),
    },
    {
      actor: 'bob',
      evidence: block({
        screenshots: [{ name: 'home', path: 'a/bob--home.png' }],
        routing: [{ origin: 'o', pathname: '/z', method: 'GET', handledBy: 'fault', action: 'fulfill' }],
        noiseFiltered: [{ reason: 'aborted', count: 1 }],
        traffic: [{ origin: 'o', pathname: '/api', method: 'GET', resourceType: 'xhr', status: 200, count: 4 }, { origin: 'o', pathname: '/b', method: 'POST', status: 201, count: 1 }],
        tracePath: 'a/trace.bob.zip',
        trafficTruncated: true,
      }),
    },
  ]);

  assert.deepEqual(merged.screenshots.map((s) => [s.actor, s.path]), [['main', 'a/home.png'], ['bob', 'a/bob--home.png']]);
  assert.deepEqual(merged.consoleErrors, [{ type: 'error', text: 'boom', actor: 'main' }]);
  assert.deepEqual(merged.pageErrors, ['[main] TypeError: x']);
  assert.equal(merged.networkFailures[0]!.actor, 'main');
  assert.deepEqual(merged.routing, [{ origin: 'o', pathname: '/z', method: 'GET', handledBy: 'fault', action: 'fulfill', actor: 'bob' }]);
  assert.deepEqual(merged.noiseFiltered, [{ reason: 'aborted', count: 3 }], 'noise adds up');
  assert.deepEqual(merged.traffic?.map((t) => [t.pathname, t.count]), [['/api', 7], ['/b', 1]], 'the same request seen by two actors is one entry with both counts');
  assert.equal(merged.trafficTruncated, true);
  assert.equal(merged.tracePath, 'a/trace.zip', "the run's trace is the first actor's");
  assert.equal('domTextSnapshot' in merged, false, 'which snapshot stands for the run is the caller\'s call');
  assert.equal('finalUrl' in merged, false);
});

test('mergeEvidence leaves out what no actor recorded', () => {
  const merged = mergeEvidence([{ actor: 'main', evidence: block() }]);
  for (const key of ['traffic', 'trafficTruncated', 'noiseFiltered', 'routing', 'tracePath']) assert.equal(key in merged, false, key);
});

test('mergePiiReports prefixes locations with the actor, recomputes the counts and adds what was scanned', () => {
  const finding = (location: string, severity: 'high' | 'low', detector: 'cpf' | 'email' = 'cpf') => ({
    detector, surface: 'url' as const, location, maskedSample: '***', fingerprint: 'a'.repeat(64), severity, count: 1,
  });
  const scanned = (urls: number) => ({ urls, console: 1, responseBodies: 0, responseBodiesSkipped: 0, storageEntries: 0, jarEntries: 0, hiddenInputs: 0 });
  const report = (findings: ReturnType<typeof finding>[], urls: number, notes: string[] = []) => ({
    kind: 'pii-scan' as const,
    findings,
    counts: { total: 0, bySeverity: { high: 0, medium: 0, low: 0, info: 0 }, byDetector: [], bySurface: [] },
    scanned: scanned(urls),
    truncated: false,
    notes,
  });

  assert.equal(mergePiiReports([]), undefined);
  const merged = mergePiiReports([
    { actor: 'main', report: report([finding('GET /a', 'high')], 4) },
    { actor: 'bob', report: { ...report([finding('GET /a', 'low', 'email')], 6, ['cookies could not be read']), truncated: true } },
  ])!;
  assert.deepEqual(merged.findings.map((f) => f.location), ['[main] GET /a', '[bob] GET /a'], 'one value on two actors is two findings');
  assert.equal(merged.counts.total, 2);
  assert.equal(merged.counts.bySeverity.high, 1);
  assert.equal(merged.scanned.urls, 10);
  assert.equal(merged.scanned.console, 2);
  assert.equal(merged.truncated, true);
  assert.deepEqual(merged.notes, ['[bob] cookies could not be read']);
});

// ---------------------------------------------------------------------------------------------------------------- include as an actor

type Body = Parameters<typeof saveRoutine>[1];
const save = (id: string, body: Partial<Body> & { steps: Body['steps'] }) => saveRoutine(id, { title: id, targetProfile: 'app-dev', ...body } as Body);
const actorsOf = (steps: Array<{ id?: string; actor?: string }>) => steps.map((step) => [step.id, step.actor]);

test('an include with an actor makes the included steps run as it, unless a step names its own', async () => {
  await save('login', {
    actors: { admin: {} },
    steps: [{ id: 'open', action: 'goto', url: '$targetUrl' }, { id: 'sudo', actor: 'admin', action: 'reload' }, { id: 'submit', action: 'click', selector: '#go' }],
  });

  const out = await expandIncludes({
    actors: { bob: {}, admin: {} },
    steps: [{ id: 'mine', action: 'reload' }, { id: 'as-bob', action: 'include', routineId: 'login', actor: 'bob' }, { id: 'plain', action: 'include', routineId: 'login' }],
  });
  assert.deepEqual(actorsOf(out.steps), [
    ['mine', undefined],
    ['as-bob.open', 'bob'],
    ['as-bob.sudo', 'admin'],
    ['as-bob.submit', 'bob'],
    ['plain.open', undefined],
    ['plain.sudo', 'admin'],
    ['plain.submit', undefined],
  ]);
});

test('the nearest include that names an actor wins, however deep', async () => {
  await save('inner', { steps: [{ id: 'step', action: 'reload' }] });
  await save('outer', { actors: { carol: {} }, steps: [{ id: 'own', action: 'reload' }, { id: 'in', action: 'include', routineId: 'inner', actor: 'carol' }, { id: 'inherits', action: 'include', routineId: 'inner' }] });

  const out = await expandIncludes({ actors: { bob: {}, carol: {} }, steps: [{ id: 'o', action: 'include', routineId: 'outer', actor: 'bob' }] });
  assert.deepEqual(actorsOf(out.steps), [['o.own', 'bob'], ['o.in.step', 'carol'], ['o.inherits.step', 'bob']]);
});

test('an included routine uses actor names its includer has to declare too', async () => {
  await save('uses-ghost', { actors: { ghost: {} }, steps: [{ id: 'boo', actor: 'ghost', action: 'reload' }] });

  await assert.rejects(
    expandIncludes({ actors: { bob: {} }, steps: [{ action: 'include', routineId: 'uses-ghost' }] }),
    (error: Error) => error.name === 'ExpandedRoutineInvalid' && /actor "ghost" is not declared/.test(error.message),
  );
  const ok = await expandIncludes({ actors: { ghost: {} }, steps: [{ action: 'include', routineId: 'uses-ghost' }] });
  assert.deepEqual(actorsOf(ok.steps), [['uses-ghost.boo', 'ghost']]);
});

test('a routine cannot be saved with a step for an actor it does not declare', async () => {
  await assert.rejects(save('no-decl', { steps: [{ actor: 'ghost', action: 'reload' }] }), (error: { status?: number; details?: unknown[] }) => error.status === 400);
  const saved = await save('with-decl', { actors: { bob: { credentialSet: 'bob-set' } }, steps: [{ actor: 'bob', action: 'reload' }] });
  assert.deepEqual(saved.routine.actors, { bob: { credentialSet: 'bob-set' } });
});

// ---------------------------------------------------------------------------------------------------------------- convention lint

test("GX001 follows each actor: one actor's submit is not another's, and one actor's gate does not vouch for another's login", async () => {
  const { lintConventions } = await import('../src/library/conventionLint.js');
  type Steps = Parameters<typeof lintConventions>[0]['steps'];
  const rules = (steps: unknown[]) => lintConventions({ steps: steps as Steps, teardown: [{ action: 'reload' }] as Steps }, { platform: 'genexus' }).findings.map((f) => `${f.rule}@${f.path}`);
  const fill = (actor: string, id: string) => ({ id, actor, action: 'fill', selector: '#u', valueFromCredential: 'user' });
  const click = (actor: string, id: string, extra: object = {}) => ({ id, actor, action: 'click', selector: '#go', ...extra });
  const gate = (actor: string) => ({ id: `gate-${actor}`, actor, action: 'waitForUrlContains', value: '/home', timeoutMs: 10000 });

  // Both log in, interleaved, each with its own gate: clean. (One shared "typed" flag used to skip bob's submit altogether.)
  assert.deepEqual(rules([fill('a', 'a1'), fill('b', 'b1'), click('a', 'a2'), click('b', 'b2'), gate('a'), gate('b')]), []);
  // Bob never gates his login; alice's gate must not count for him.
  assert.deepEqual(rules([fill('a', 'a1'), fill('b', 'b1'), click('a', 'a2'), click('b', 'b2'), gate('a')]), ['GX001@steps.3']);
  // A click of bob's that has nothing to do with a login is not alice's submit.
  assert.deepEqual(rules([fill('a', 'a1'), click('b', 'b-other'), click('a', 'a2', { afterWaitFor: { urlContains: '/home' } })]), []);
  // The gate window counts that actor's own next three steps, not the interleaved ones.
  assert.deepEqual(rules([fill('a', 'a1'), click('a', 'a2'), { actor: 'b', action: 'reload' }, { actor: 'b', action: 'reload' }, { actor: 'b', action: 'reload' }, gate('a')]), []);
});

// ---------------------------------------------------------------------------------------------------------------- resolution

test('each actor gets the values of ITS credential set; main keeps its own; nothing is shared', async () => {
  const resolved = await resolveExplorationRequest(
    explorationRequestSchema.parse({
      targetProfile: 'app-dev',
      credentialSet: 'main-set',
      actors: { bob: { credentialSet: 'bob-set' }, guest: {} },
      steps: [{ action: 'reload' }, { actor: 'bob', action: 'reload' }, { actor: 'guest', action: 'reload' }],
    }),
  );
  assert.deepEqual(resolved.credentials, { user: 'mm', pass: 'main-secret-aaaa' });
  assert.deepEqual(resolved.actorCredentials?.['bob']?.credentials, { user: 'bb', pass: 'bob-secret-bbbb' });
  assert.deepEqual(resolved.actorCredentials?.['bob']?.credentialBinding.boundOrigins, [ORIGIN]);
  assert.equal(resolved.actorCredentials?.['guest'], undefined, 'an actor with no set has no values (it never borrows main\'s)');
});

test('an actor\'s credential set must exist and be allowed for the profile, like the run\'s own', async () => {
  const run = (actors: object, targetProfile = 'app-dev') =>
    resolveExplorationRequest(explorationRequestSchema.parse({ targetProfile, actors, steps: [{ actor: 'x', action: 'reload' }] }));

  await assert.rejects(run({ x: { credentialSet: 'ghost-set' } }), (error: { status?: number; message: string }) => error.status === 404 && /actor "x"/.test(error.message));
  await saveCredentialSet('stranger', { boundOrigins: [ORIGIN], values: { pass: 'stranger-secret-cccc' }, tags: [] }, 'create');
  await assert.rejects(run({ x: { credentialSet: 'stranger' } }), (error: { status?: number; message: string }) => error.status === 403 && /actor "x"/.test(error.message));
});

test('more actors on one account than the profile allows is refused, and so is more actors than MAX_ACTORS_PER_JOB', async () => {
  const twice = {
    targetProfile: 'app-dev',
    actors: { a: { credentialSet: 'bob-set' }, b: { credentialSet: 'bob-set' } },
    steps: [{ actor: 'a', action: 'reload' }, { actor: 'b', action: 'reload' }],
  };
  await assert.rejects(resolveExplorationRequest(explorationRequestSchema.parse(twice)), (error: { status?: number; name: string }) => error.status === 400 && error.name === 'TooManySessionsForCredential');
  const allowed = await resolveExplorationRequest(explorationRequestSchema.parse({ ...twice, targetProfile: 'app-multi' }));
  assert.deepEqual(Object.keys(allowed.actorCredentials ?? {}), ['a', 'b'], 'a profile that allows two sessions per credential takes both');

  // five declared actors + main in use = six contexts, one over the cap
  const five = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`n${index}`, {}]));
  await assert.rejects(
    resolveExplorationRequest(explorationRequestSchema.parse({ targetProfile: 'app-dev', actors: five, steps: [{ action: 'reload' }, ...Object.keys(five).map((actor) => ({ actor, action: 'reload' }))] })),
    (error: { status?: number; message: string }) => error.status === 400 && /MAX_ACTORS_PER_JOB/.test(error.message),
  );
});
