import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const ORIGIN = 'https://dev.example.com';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-suite-plan-test-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts'); // .env may pin it
process.env.ALLOWED_TARGET_ORIGINS = ORIGIN;
process.env.ALLOWED_RESOURCE_ORIGINS = ORIGIN;

const { saveTarget } = await import('../src/targets/targetStore.js');
const { saveRoutine } = await import('../src/library/routineService.js');
const { planSuite, concludeSuite, startSuite, recoverSuites, getSuite, SUITE_ID_PATTERN } = await import('../src/orchestrator/suiteRunner.js');
const { suiteRequestSchema, suiteStateSchema } = await import('../src/schemas/suiteRequest.schema.js');
const { suitesDir } = await import('../src/config/paths.js');

before(async () => {
  await saveTarget({
    id: 'app-dev', name: 'App', platform: 'generic', environment: 'dev', baseUrl: ORIGIN, credentialSets: [],
    noiseFilters: [], surfaces: {}, screens: [], flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  });
  await saveTarget({
    id: 'app-shared', name: 'Shared', platform: 'generic', environment: 'dev', baseUrl: ORIGIN, credentialSets: [],
    noiseFilters: [], surfaces: {}, screens: [], flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 3 },
  });
  const steps = [{ id: 'open', action: 'goto', url: '$targetUrl' }] as never;
  await saveRoutine('crud', { title: 'crud', targetProfile: 'app-dev', steps });
  await saveRoutine('report', { title: 'report', targetProfile: 'app-dev', steps, credentialSet: 'own-cred' });
  await saveRoutine('flaky', { title: 'flaky', targetProfile: 'app-dev', steps, status: 'quarantined' });
});

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const parse = (body: unknown) => suiteRequestSchema.parse(body);
const keys = (planned: Awaited<ReturnType<typeof planSuite>>) => planned.map((entry) => entry.state.variantKey);
const expectError = (name: string) => (error: unknown) => (error as Error).name === name;

test('2 routines x 2 credential sets = 4 runs with distinct, readable variantKeys', async () => {
  const planned = await planSuite(parse({
    name: 'matrix',
    items: [{ routineId: 'crud' }, { routineId: 'report' }],
    variants: { credentialSets: ['gam-admin', 'gam-readonly'] },
  }));

  assert.deepEqual(keys(planned), ['crud/cred:gam-admin', 'crud/cred:gam-readonly', 'report/cred:gam-admin', 'report/cred:gam-readonly']);
  assert.equal(new Set(keys(planned)).size, 4);
  assert.ok(planned.every((entry) => entry.state.status === 'pending'));
});

test('credential sets x target profiles multiply too', async () => {
  const planned = await planSuite(parse({
    name: 'm', items: [{ routineId: 'crud' }],
    variants: { credentialSets: ['a', 'b'], targetProfiles: ['app-dev', 'app-shared'] },
  }));

  assert.deepEqual(keys(planned), ['crud/cred:a/target:app-dev', 'crud/cred:a/target:app-shared', 'crud/cred:b/target:app-dev', 'crud/cred:b/target:app-shared']);
  assert.deepEqual(planned.map((entry) => entry.state.targetProfile), ['app-dev', 'app-shared', 'app-dev', 'app-shared']);
});

test('the version is pinned when the suite starts, and a pinned item keeps its version in the key', async () => {
  await saveRoutine('crud', { title: 'crud', targetProfile: 'app-dev', steps: [{ id: 'open', action: 'goto', url: '$targetUrl' }, { id: 'again', action: 'reload' }] as never });

  const planned = await planSuite(parse({ name: 'v', items: [{ routineId: 'crud' }, { routineId: 'crud', version: 1 }] }));
  assert.deepEqual(planned.map((entry) => [entry.state.variantKey, entry.state.routineVersion]), [['crud', 2], ['crud@v1', 1]]);
});

test('the lock key is the credential set the run will really use, and sessions follow the profile', async () => {
  const [own, overridden, shared] = [
    (await planSuite(parse({ name: 'x', items: [{ routineId: 'report' }] })))[0]!,
    (await planSuite(parse({ name: 'x', items: [{ routineId: 'report' }], variants: { credentialSets: ['other'] } })))[0]!,
    (await planSuite(parse({ name: 'x', items: [{ routineId: 'report' }], variants: { targetProfiles: ['app-shared'] } })))[0]!,
  ];

  assert.equal(own.lockKey, 'own-cred', "the routine's own credential set is locked even when the suite names none");
  assert.equal(overridden.lockKey, 'other');
  assert.equal(shared.maxSessions, 3, 'maxSessionsPerCredential comes from the profile the run uses');
  assert.equal(own.maxSessions, 1);

  const none = (await planSuite(parse({ name: 'x', items: [{ routineId: 'crud' }] })))[0]!;
  assert.equal(none.lockKey, undefined, 'no credential, no lock');
});

test('the same item twice gets #2, so keys stay unique', async () => {
  const planned = await planSuite(parse({ name: 'dup', items: [{ routineId: 'crud' }, { routineId: 'crud' }] }));
  assert.deepEqual(keys(planned), ['crud', 'crud#2']);
});

test('non-active routines are listed as not run, with the reason, instead of disappearing', async () => {
  const skipped = (await planSuite(parse({ name: 'q', items: [{ routineId: 'flaky' }] })))[0]!.state;
  assert.equal(skipped.status, 'notRun');
  assert.match(skipped.notRunReason ?? '', /quarantined/);

  const included = (await planSuite(parse({ name: 'q', items: [{ routineId: 'flaky' }], statuses: ['active', 'quarantined'] })))[0]!.state;
  assert.equal(included.status, 'pending');
});

test('an unknown routine or version fails the whole suite before anything runs', async () => {
  await assert.rejects(() => startSuite(parse({ name: 'x', items: [{ routineId: 'crud' }, { routineId: 'ghost' }] })), expectError('SuiteItemNotFound'));
  await assert.rejects(() => startSuite(parse({ name: 'x', items: [{ routineId: 'crud', version: 99 }] })), expectError('SuiteItemNotFound'));
  assert.deepEqual(fs.existsSync(suitesDir()) ? fs.readdirSync(suitesDir()) : [], [], 'nothing was recorded');
});

test('a suite that expands past 500 runs is refused', async () => {
  const creds = Array.from({ length: 20 }, (_, i) => `c${i}`);
  const profiles = Array.from({ length: 20 }, (_, i) => `p${i}`);
  await assert.rejects(
    () => planSuite(parse({ name: 'big', items: Array.from({ length: 2 }, () => ({ routineId: 'crud' })), variants: { credentialSets: creds, targetProfiles: profiles } })),
    expectError('SuiteTooLarge'),
  );
});

test('request validation: strict, bounded, sensible defaults', () => {
  const ok = parse({ name: 'x', items: [{ routineId: 'crud' }] });
  assert.deepEqual([ok.mode, ok.failFast, ok.statuses], ['sequential', false, ['active']]);

  assert.equal(suiteRequestSchema.safeParse({ name: 'x', items: [] }).success, false);
  assert.equal(suiteRequestSchema.safeParse({ name: 'x', items: [{ routineId: 'a/b' }] }).success, false);
  assert.equal(suiteRequestSchema.safeParse({ name: 'x', items: [{ routineId: 'crud' }], surprise: 1 }).success, false);
  assert.equal(suiteRequestSchema.safeParse({ name: 'x', items: [{ routineId: 'crud' }], variants: { credentialSets: [] } }).success, false);
  assert.equal(SUITE_ID_PATTERN.test('suite_abc123'), true);
  assert.equal(SUITE_ID_PATTERN.test('../x'), false);
});

function stateWith(variants: Array<'passed' | 'failed' | 'error' | 'notRun'>, teardownFailed = false) {
  const state = suiteStateSchema.parse({
    suiteRunId: 'suite_x', name: 'x', status: 'running', createdAt: new Date().toISOString(),
    request: parse({ name: 'x', items: [{ routineId: 'crud' }] }), total: variants.length,
    counts: { pending: 0, running: 0, passed: 0, failed: 0, error: 0, notRun: 0 },
    variants: variants.map((status, i) => ({ variantKey: `v${i}`, routineId: 'crud', routineVersion: 1, status, ...(teardownFailed && status === 'passed' ? { teardownStatus: 'failed' } : {}) })),
  });
  for (const v of state.variants) state.counts[v.status] += 1;
  return state;
}

test('one verdict, one exit code: 0 green, 1 red, 2 infrastructure', () => {
  const cases: Array<[Parameters<typeof stateWith>[0], boolean, string, number]> = [
    [['passed', 'passed'], false, 'green', 0],
    [['passed', 'failed'], false, 'red', 1],
    [['failed', 'notRun'], false, 'red', 1],
    [['passed', 'error'], false, 'infra-error', 2],
    [['failed', 'error'], false, 'infra-error', 2], // an incomplete suite cannot be trusted as plain "red"
    [['notRun', 'notRun'], false, 'infra-error', 2], // nothing was verified: never green
    [['passed'], true, 'infra-error', 2],            // cancelled
  ];

  for (const [variants, cancelled, verdict, exitCode] of cases) {
    const state = stateWith(variants);
    concludeSuite(state, cancelled);
    assert.deepEqual([state.verdict, state.exitCode], [verdict, exitCode], `${variants.join(',')} cancelled=${cancelled}`);
    assert.ok(state.verdictReason);
    assert.equal(state.status, cancelled ? 'cancelled' : 'completed');
  }
});

test('a failed teardown does not turn a green suite red, but is counted', () => {
  const state = stateWith(['passed', 'passed'], true);
  concludeSuite(state, false);
  assert.equal(state.verdict, 'green');
  assert.equal(state.teardownFailures, 2);
});

test('a state file left "running" by a dead process is closed as interrupted (exit 2)', async () => {
  fs.mkdirSync(suitesDir(), { recursive: true });
  const orphan = stateWith(['passed', 'notRun', 'notRun']);
  orphan.suiteRunId = 'suite_orphan1';
  orphan.variants[1]!.status = 'running';
  orphan.variants[2]!.status = 'pending';
  fs.writeFileSync(path.join(suitesDir(), 'suite_orphan1.json'), JSON.stringify(orphan));

  const result = await recoverSuites();
  assert.equal(result.interrupted, 1);

  const recovered = (await getSuite('suite_orphan1'))!;
  assert.equal(recovered.status, 'interrupted');
  assert.deepEqual([recovered.verdict, recovered.exitCode], ['infra-error', 2]);
  assert.deepEqual(recovered.variants.map((v) => v.status), ['passed', 'error', 'notRun']);
  assert.equal(recovered.variants[1]!.errorType, 'ServerRestarted');
});
