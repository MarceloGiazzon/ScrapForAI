import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// T4.4, the pure half: how screens are split into sessions, folder names, the atomic folder write, the idempotency lookup
// and the git commit (against a real temporary repository).

process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';
process.env.ALLOWED_RESOURCE_ORIGINS = 'https://dev.example.com';
const evolutionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-evo-'));
process.env.SYSTEM_EVOLUTION_DIR = evolutionDir;

const plan = await import('../src/evolution/snapshotPlan.js');
const store = await import('../src/evolution/snapshotStore.js');
const { snapshotBodySchema, snapshotManifestSchema } = await import('../src/schemas/evolution.schema.js');
const { explorationRequestSchema } = await import('../src/schemas/explorationRequest.schema.js');

const limits = { maxStepsPerJob: 40, jobTimeoutMs: 120_000, stepTimeoutMs: 15_000 };
const screen = (id: string, over: Record<string, unknown> = {}) => ({ id, name: id.toUpperCase(), reach: { url: `/${id}` }, ...over }) as never;
const profile = (over: Record<string, unknown> = {}) =>
  ({ id: 'app', baseUrl: 'https://dev.example.com', credentialSets: ['admin', 'viewer'], loginRoutine: 'login', screens: [], ...over }) as never;
const context = (over: Record<string, unknown> = {}) => ({ loginStepCount: 5, settleMs: 500, screenshots: true, limits, ...over });

test('sessions: one login per credential set, screens chunked, a routine-reached screen on its own', () => {
  const screens = [screen('a'), screen('b'), screen('c', { credentialSet: 'viewer' }), screen('d', { reach: { routineId: 'open-d' } })];
  const sessions = plan.planSnapshotSessions(profile({ screens }), screens, context());
  assert.deepEqual(sessions.map((s) => [s.credentialSet, s.screens.map((x) => x.id)]), [
    ['admin', ['a', 'b']],
    ['admin', ['d']],
    ['viewer', ['c']],
  ]);
  for (const session of sessions) {
    assert.equal(session.steps[0]!.action, 'include'); // the login first
    assert.ok(explorationRequestSchema.safeParse({ targetProfile: 'app', credentialSet: session.credentialSet, steps: session.steps }).success);
  }
  const first = sessions[0]!.steps.map((step) => step.action);
  assert.deepEqual(first, ['include', 'goto', 'waitForTimeout', 'captureInventory', 'screenshot', 'goto', 'waitForTimeout', 'captureInventory', 'screenshot']);
  const viaRoutine = sessions[1]!.steps.find((step) => step.action === 'include' && step.routineId === 'open-d');
  assert.ok(viaRoutine, 'the routine that reaches the screen runs after the login');
});

test('steps follow the options: no screenshots, no settle, absolute and relative URLs', () => {
  const screens = [screen('a'), screen('b', { reach: { url: 'https://dev.example.com/x' } })];
  const [session] = plan.planSnapshotSessions(profile({ screens }), screens, context({ screenshots: false, settleMs: 0 }));
  assert.deepEqual(session!.steps.map((step) => step.action), ['include', 'goto', 'captureInventory', 'goto', 'captureInventory']);
  const urls = session!.steps.filter((step) => step.action === 'goto').map((step) => (step as { url: string }).url);
  assert.deepEqual(urls, ['https://dev.example.com/a', 'https://dev.example.com/x']);
});

test('chunking respects MAX_STEPS_PER_JOB: no session exceeds it', () => {
  const screens = Array.from({ length: 30 }, (_, i) => screen(`s${i}`));
  const sessions = plan.planSnapshotSessions(profile({ screens }), screens, context());
  assert.ok(sessions.length > 1);
  for (const session of sessions) assert.ok(session.steps.length <= limits.maxStepsPerJob, `${session.steps.length} steps`);
  assert.equal(sessions.flatMap((s) => s.screens).length, 30);
});

test('anonymous profile: no login; credentials without a loginRoutine, an unknown set and an empty catalogue are refused', () => {
  const screens = [screen('a')];
  const [anonymous] = plan.planSnapshotSessions(profile({ credentialSets: [], loginRoutine: undefined, screens }), screens, context());
  assert.equal(anonymous!.credentialSet, undefined);
  assert.deepEqual(anonymous!.steps.map((step) => step.action), ['goto', 'waitForTimeout', 'captureInventory', 'screenshot']);

  assert.throws(() => plan.planSnapshotSessions(profile({ loginRoutine: undefined, screens }), screens, context()), plan.SnapshotPlanError);
  const stranger = [screen('a', { credentialSet: 'ghost' })];
  assert.throws(() => plan.planSnapshotSessions(profile({ screens: stranger }), stranger, context()), /ghost/);
  assert.throws(() => plan.screensToCapture({ id: 'app', screens: [] }), /no screens/);
  assert.throws(() => plan.screensToCapture({ id: 'app', screens: screens as never }, ['nope']), /nope/);
  assert.deepEqual(plan.screensToCapture({ id: 'app', screens: [screen('a'), screen('b')] as never }, ['b']).map((s) => s.id), ['b']);
});

test('inventory and screenshot names are neutral and stable; ids fit the step id limit', () => {
  assert.match(plan.inventoryName('change-password'), /^inv_[0-9a-f]{12}$/);
  assert.equal(plan.inventoryName('x'), plan.inventoryName('x'));
  assert.notEqual(plan.inventoryName('x'), plan.inventoryName('y'));
  const longId = 'a'.repeat(52);
  const steps = plan.screenSteps(screen(longId), { baseUrl: 'https://dev.example.com', settleMs: 500, screenshots: true });
  for (const step of steps) assert.ok(step.id!.length <= 80, step.id);
});

test('folder names: date + build, unsafe characters replaced, the build is recoverable from the name', () => {
  assert.equal(plan.snapshotFolderName('2026-11-03T10:00:00.000Z', 'rev4519'), '2026-11-03_rev4519');
  assert.equal(plan.snapshotFolderName('2026-11-03T10:00:00.000Z', '2026.11/rc1+sha.ab'), '2026-11-03_2026.11_rc1_sha.ab');
  assert.ok(!plan.folderSafe('../../etc').includes('/'));
  assert.ok(!plan.folderSafe('..').startsWith('.'));
  assert.equal(plan.buildOfFolder('2026-11-03_rev4519'), 'rev4519');
  assert.equal(plan.buildOfFolder('2026-11-03_a_b'), 'a_b');
  assert.equal(plan.buildOfFolder('.tmp-1'), undefined);
  assert.equal(plan.buildOfFolder('notes'), undefined);
});

test('body: defaults and strictness', () => {
  const body = snapshotBodySchema.parse({ targetProfile: 'app' });
  assert.deepEqual([body.screenshots, body.force, body.allowPartial, body.settleMs], [true, false, false, 500]);
  assert.equal(snapshotBodySchema.safeParse({ targetProfile: 'app', surprise: 1 }).success, false);
  assert.equal(snapshotBodySchema.safeParse({ targetProfile: '../x' }).success, false);
  assert.equal(snapshotBodySchema.safeParse({ targetProfile: 'app', screens: [] }).success, false);
});

const manifest = (buildId: string, createdAt: string) =>
  snapshotManifestSchema.parse({
    schemaVersion: 1, targetProfile: 'app', environment: 'dev', buildId, buildIdSource: 'provided', createdAt, screenshots: false,
    complete: true, screens: [], notCaptured: [],
  });

test('writing a snapshot: files land in the folder, listing is oldest first, the build lookup is exact, force replaces', async () => {
  const write = (name: string, buildId: string, createdAt: string, extra: string, replace: string[] = []) =>
    store.writeSnapshotFolder('app', name, [
      { relative: store.MANIFEST_FILE, data: JSON.stringify(manifest(buildId, createdAt)) },
      { relative: 'screens/home.json', data: extra },
    ], replace);

  await write('2026-11-02_rev1', 'rev1', '2026-11-02T08:00:00.000Z', 'one');
  await write('2026-11-03_rev2', 'rev2', '2026-11-03T08:00:00.000Z', 'two');
  assert.deepEqual((await store.listSnapshots('app')).map((s) => s.buildId), ['rev1', 'rev2']);
  assert.equal((await store.findSnapshotOfBuild('app', 'rev2'))?.folder, 'app/2026-11-03_rev2');
  assert.equal(await store.findSnapshotOfBuild('app', 'rev'), undefined, 'exact build, not a prefix');
  assert.equal(await store.findSnapshotOfBuild('other', 'rev1'), undefined);

  // force on rev1 the next day: the old folder is replaced, not duplicated
  await write('2026-11-04_rev1', 'rev1', '2026-11-04T08:00:00.000Z', 'uno', ['2026-11-02_rev1']);
  assert.deepEqual((await store.listSnapshots('app')).map((s) => s.name), ['2026-11-03_rev2', '2026-11-04_rev1']);
  assert.equal(fs.readFileSync(path.join(evolutionDir, 'app', '2026-11-04_rev1', 'screens', 'home.json'), 'utf8'), 'uno');
  assert.deepEqual(fs.readdirSync(path.join(evolutionDir, 'app')).filter((n) => n.startsWith('.tmp')), [], 'no temp folder is left behind');
});

test('a file that would escape the snapshot folder is refused and nothing is left behind', async () => {
  await assert.rejects(store.writeSnapshotFolder('app', '2026-11-05_evil', [{ relative: '../../escaped.txt', data: 'x' }]), /escapes/);
  assert.ok(!fs.existsSync(path.join(evolutionDir, 'escaped.txt')));
  assert.ok(!fs.existsSync(path.join(evolutionDir, 'app', '2026-11-05_evil')));
  assert.deepEqual(fs.readdirSync(path.join(evolutionDir, 'app')).filter((n) => n.startsWith('.tmp')), []);
  assert.throws(() => store.targetFolder('../x'));
});

test('git: not a repository -> nothing committed; a repository -> one commit with the build in the message, only the target folder', async () => {
  assert.deepEqual(await store.commitSnapshot('app', 'evolution(app): rev1'), { repository: false, committed: false });

  const git = (...args: string[]) => execFileSync('git', ['-C', evolutionDir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(evolutionDir, 'unrelated.txt'), 'not part of the snapshot');
  git('add', 'unrelated.txt'); // staged by someone else: must NOT be swept into the snapshot commit

  const outcome = await store.commitSnapshot('app', 'evolution(app): rev1');
  assert.equal(outcome.repository, true);
  assert.equal(outcome.committed, true, JSON.stringify(outcome));
  assert.match(git('log', '-1', '--format=%s'), /^evolution\(app\): rev1$/);
  assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n').every((file) => file.startsWith('app/')), true);
  assert.match(git('status', '--short'), /^A\s+unrelated\.txt$/m, 'the other staged file is still staged, not committed');

  // Nothing changed: no empty commit.
  assert.deepEqual(await store.commitSnapshot('app', 'evolution(app): rev1'), { repository: true, committed: false, note: 'nothing to commit' });

  // A replaced folder (force) shows up as a deletion plus an addition in one commit.
  fs.rmSync(path.join(evolutionDir, 'app', '2026-11-03_rev2'), { recursive: true });
  assert.equal((await store.commitSnapshot('app', 'evolution(app): cleanup')).committed, true);
  assert.match(git('show', '--name-status', '--format=', 'HEAD'), /^D\s+app\/2026-11-03_rev2/m);
});
