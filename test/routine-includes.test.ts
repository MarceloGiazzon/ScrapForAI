import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const ORIGIN = 'https://dev.example.com';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-includes-test-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts'); // .env may pin it
process.env.ALLOWED_TARGET_ORIGINS = `${ORIGIN},https://other.example.com`;
process.env.ALLOWED_RESOURCE_ORIGINS = ORIGIN;
process.env.MAX_STEPS_PER_JOB = '50';

const { saveTarget } = await import('../src/targets/targetStore.js');
const { saveRoutine } = await import('../src/library/routineService.js');
const { expandIncludes } = await import('../src/library/includeExpander.js');
const { resolveExplorationRequest } = await import('../src/runner/resolveRequest.js');
const { explorationRequestSchema, mcpExplorationRequestSchema } = await import('../src/schemas/explorationRequest.schema.js');
const { mcpSaveRoutineSchema } = await import('../src/schemas/libraryRoutine.schema.js');

before(async () => {
  for (const [id, baseUrl] of [['app-dev', ORIGIN], ['other-app', 'https://other.example.com']] as const) {
    await saveTarget({
      id, name: id, platform: 'generic', environment: 'dev', baseUrl, credentialSets: [], noiseFilters: [], surfaces: {}, screens: [],
      flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
    });
  }
});

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

type Body = Parameters<typeof saveRoutine>[1];
const save = (id: string, body: Partial<Body> & { steps: Body['steps'] }) => saveRoutine(id, { title: id, targetProfile: 'app-dev', ...body } as Body);
const actions = (steps: Array<{ id?: string }>) => steps.map((s) => s.id);
const expectError = (name: string) => (error: unknown) => (error as Error).name === name;

const goto = { id: 'open', action: 'goto', url: '$targetUrl' } as const;

test('include expands in place and prefixes step ids with the include id', async () => {
  await save('login', { steps: [goto, { id: 'submit', action: 'click', selector: '#go' }, { action: 'waitForTimeout', timeoutMs: 100 }] });

  const out = await expandIncludes({
    steps: [{ id: 'before', action: 'reload' }, { id: 'auth', action: 'include', routineId: 'login' }, { id: 'after', action: 'reload' }],
  });

  assert.deepEqual(actions(out.steps), ['before', 'auth.open', 'auth.submit', undefined, 'after']);
  assert.deepEqual(out.includes.map((i) => [i.routineId, i.version]), [['login', 1]]);
  assert.match(out.includes[0]!.sha256, /^[0-9a-f]{64}$/);
});

test('without an include id the routine id is the prefix; waitForElapsed follows the rename', async () => {
  await save('timed', { steps: [{ id: 'start', action: 'reload' }, { id: 'hold', action: 'waitForElapsed', sinceStepId: 'start', minElapsedMs: 0 }] });

  const out = await expandIncludes({ steps: [{ action: 'include', routineId: 'timed' }] });
  assert.deepEqual(actions(out.steps), ['timed.start', 'timed.hold']);
  assert.equal((out.steps[1] as { sinceStepId: string }).sinceStepId, 'timed.start');
});

test('a pinned version is used even after a newer one exists', async () => {
  await save('versioned', { steps: [{ id: 'one', action: 'reload' }] });
  await save('versioned', { steps: [{ id: 'one', action: 'reload' }, { id: 'two', action: 'reload' }] });

  const pinned = await expandIncludes({ steps: [{ id: 'v', action: 'include', routineId: 'versioned', version: 1 }] });
  assert.deepEqual(actions(pinned.steps), ['v.one']);
  assert.equal(pinned.includes[0]!.version, 1);

  const current = await expandIncludes({ steps: [{ id: 'v', action: 'include', routineId: 'versioned' }] });
  assert.deepEqual(actions(current.steps), ['v.one', 'v.two']);
  assert.equal(current.includes[0]!.version, 2);

  await assert.rejects(() => expandIncludes({ steps: [{ action: 'include', routineId: 'versioned', version: 9 }] }), expectError('IncludedRoutineNotFound'));
});

test('cycles are refused, at save time, whether direct or through other routines', async () => {
  await assert.rejects(() => save('selfish', { steps: [{ id: 'me', action: 'include', routineId: 'selfish' }] }), expectError('IncludeCycle'));

  await save('cycle-b', { steps: [{ id: 'b', action: 'reload' }] });
  await save('cycle-a', { steps: [{ id: 'b', action: 'include', routineId: 'cycle-b' }] });
  // cycle-b -> cycle-a -> cycle-b
  await assert.rejects(() => save('cycle-b', { steps: [{ id: 'a', action: 'include', routineId: 'cycle-a' }] }), expectError('IncludeCycle'));

  // The message shows the chain.
  await assert.rejects(
    () => save('cycle-b', { steps: [{ id: 'a', action: 'include', routineId: 'cycle-a' }] }),
    (error: Error) => error.message.includes('cycle-b -> cycle-a -> cycle-b'),
  );

  // And a cycle that was never saved (library edited by hand) is still caught at run time.
  const dir = path.join(dataDir, 'library');
  assert.ok(fs.existsSync(path.join(dir, 'cycle-a')));
});

test('nesting deeper than 3 levels is refused', async () => {
  await save('d1', { steps: [{ id: 's', action: 'reload' }] });
  await save('d2', { steps: [{ id: 'x', action: 'include', routineId: 'd1' }] });
  await save('d3', { steps: [{ id: 'x', action: 'include', routineId: 'd2' }] });
  await save('d4', { steps: [{ id: 'x', action: 'include', routineId: 'd3' }] }); // d4 -> d3 -> d2 -> d1: exactly 3 levels

  const ok = await expandIncludes({ steps: [{ id: 'x', action: 'include', routineId: 'd3' }] });
  assert.deepEqual(actions(ok.steps), ['x.x.x.s'].slice(0, 0).concat(['x.x.x.s']));

  await assert.rejects(() => expandIncludes({ steps: [{ id: 'x', action: 'include', routineId: 'd4' }] }), expectError('IncludeDepthExceeded'));
  await assert.rejects(() => save('d5', { steps: [{ id: 'x', action: 'include', routineId: 'd4' }] }), expectError('IncludeDepthExceeded'));
});

test('missing, retired and other-application routines cannot be included', async () => {
  await assert.rejects(() => save('needs-ghost', { steps: [{ id: 'g', action: 'include', routineId: 'ghost' }] }), expectError('IncludedRoutineNotFound'));

  await save('old-login', { steps: [{ id: 's', action: 'reload' }], status: 'retired' });
  await assert.rejects(() => expandIncludes({ steps: [{ action: 'include', routineId: 'old-login' }] }), expectError('IncludedRoutineRetired'));

  await save('foreign', { targetProfile: 'other-app', steps: [{ id: 's', action: 'reload' }] });
  await assert.rejects(
    () => save('uses-foreign', { steps: [{ id: 'f', action: 'include', routineId: 'foreign' }] }),
    expectError('IncludeTargetProfileMismatch'),
  );
});

test('including the same routine twice needs distinct include ids', async () => {
  await assert.rejects(
    () => expandIncludes({ steps: [{ action: 'include', routineId: 'login' }, { action: 'include', routineId: 'login' }] }),
    expectError('ExpandedRoutineInvalid'),
  );

  const ok = await expandIncludes({ steps: [{ id: 'first', action: 'include', routineId: 'login' }, { id: 'second', action: 'include', routineId: 'login' }] });
  assert.deepEqual(actions(ok.steps).filter(Boolean), ['first.open', 'first.submit', 'second.open', 'second.submit']);
});

test('teardown order: own first, then included teardowns, last-included first', async () => {
  await save('with-logout', { steps: [goto], teardown: [{ id: 'logout', action: 'reload' }] });
  await save('with-dialog', { steps: [{ id: 'dlg', action: 'reload' }], teardown: [{ id: 'close', action: 'reload' }] });

  const out = await expandIncludes({
    steps: [{ id: 'auth', action: 'include', routineId: 'with-logout' }, { id: 'nav', action: 'include', routineId: 'with-dialog' }],
    teardown: [{ id: 'delete-record', action: 'reload' }],
  });

  // delete-record needs the session, so it runs before logout; the dialog opened last is closed first.
  assert.deepEqual(actions(out.teardown), ['delete-record', 'nav.close', 'auth.logout']);
});

test('an included routine\'s teardown reaches the run even when the includer has none', async () => {
  const out = await expandIncludes({ steps: [{ id: 'auth', action: 'include', routineId: 'with-logout' }] });
  assert.deepEqual(actions(out.teardown), ['auth.logout']);
});

test('steps + teardown are limited after expansion', async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, action: 'reload' as const }));
  await save('thirty', { steps: many });

  await assert.rejects(
    () => expandIncludes({ steps: [{ id: 'a', action: 'include', routineId: 'thirty' }, { id: 'b', action: 'include', routineId: 'thirty' }] }),
    expectError('ExpandedRoutineTooLong'),
  );
});

test('resolveExplorationRequest hands the runner include-free steps and keeps the original for saving', async () => {
  const request = explorationRequestSchema.parse({
    targetProfile: 'app-dev',
    steps: [{ id: 'auth', action: 'include', routineId: 'with-logout' }, { id: 'check', action: 'reload' }],
    teardown: [{ id: 'bye', action: 'reload' }],
  });
  const resolved = await resolveExplorationRequest(request);

  assert.ok(resolved.steps.every((step) => step.action !== 'include'));
  assert.deepEqual(actions(resolved.steps), ['auth.open', 'check']);
  assert.deepEqual(actions(resolved.teardown ?? []), ['bye', 'auth.logout']);
  assert.equal(resolved.includes?.[0]?.routineId, 'with-logout');
  assert.equal(resolved.unexpanded?.steps[0]?.action, 'include');

  const plain = await resolveExplorationRequest(explorationRequestSchema.parse({ targetProfile: 'app-dev', steps: [{ action: 'reload' }] }));
  assert.equal(plain.includes, undefined, 'a run without includes carries no extra metadata');
  assert.equal(plain.teardown, undefined);
});

test('teardown is validated like steps: duplicate ids, forward waitForElapsed, shared step budget', () => {
  const base = { targetUrl: `${ORIGIN}/`, steps: [{ action: 'reload' }] };

  assert.equal(explorationRequestSchema.safeParse({ ...base, teardown: [{ id: 'x', action: 'reload' }, { id: 'x', action: 'reload' }] }).success, false);
  assert.equal(explorationRequestSchema.safeParse({ ...base, teardown: [{ action: 'waitForElapsed', sinceStepId: 'nope', minElapsedMs: 0 }] }).success, false);
  assert.equal(explorationRequestSchema.safeParse({ ...base, teardown: [{ id: 'ok', action: 'reload' }] }).success, true);
  assert.equal(explorationRequestSchema.safeParse({ ...base, teardown: [] }).success, false, 'an empty teardown is just no teardown');

  const fifty = Array.from({ length: 50 }, () => ({ action: 'reload' }));
  assert.equal(explorationRequestSchema.safeParse({ ...base, steps: fifty, teardown: [{ action: 'reload' }] }).success, false);
});

test('MCP schemas carry include and teardown', () => {
  const request = { targetProfile: 'app-dev', steps: [{ action: 'include', routineId: 'login' }], teardown: [{ action: 'reload' }] };
  assert.equal(mcpExplorationRequestSchema.safeParse(request).success, true);
  assert.equal(mcpSaveRoutineSchema.safeParse({ id: 'x', title: 'x', targetProfile: 'app-dev', steps: request.steps, teardown: request.teardown }).success, true);
  assert.equal(explorationRequestSchema.safeParse({ ...request, steps: [{ action: 'include', routineId: 'login', selector: '#x' }] }).success, false, 'include is strict');
});
