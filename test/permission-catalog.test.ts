import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// T6.2 without a browser: the screen catalogue of a target profile becomes direct-URL probes for every role, and a role
// whose MENU does not offer a screen is expected to be denied when it opens the URL (reaching it is the alert).

const ORIGIN = 'https://dev.example.com';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-perm-catalog-test-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts'); // .env may pin it
process.env.ALLOWED_TARGET_ORIGINS = ORIGIN;
process.env.ALLOWED_RESOURCE_ORIGINS = ORIGIN;

const { saveTarget } = await import('../src/targets/targetStore.js');
const { saveRoutine } = await import('../src/library/routineService.js');
const { permissionMatrixSchema } = await import('../src/schemas/permissionMatrix.schema.js');
const { targetProfileSchema } = await import('../src/schemas/targetProfile.schema.js');
const { resolveMatrixContext } = await import('../src/permissions/matrixStore.js');
const logic = await import('../src/permissions/matrixLogic.js');

type Matrix = ReturnType<typeof permissionMatrixSchema.parse>;

const LIMITS = { maxStepsPerJob: 50, jobTimeoutMs: 60_000, stepTimeoutMs: 10_000 };
const issues = (body: unknown) => (permissionMatrixSchema.safeParse(body).error?.issues ?? []).map((issue) => issue.message).join(' | ');

const screenList = [
  { id: 'dashboard', name: 'Dashboard', reach: { url: '/dashboard' }, offeredTo: ['admin', 'seller'] },
  { id: 'settings', name: 'Settings', reach: { url: '/settings' }, offeredTo: ['admin'] },
  { id: 'reports', name: 'Reports (no menu claim)', reach: { url: '/reports' } },
  { id: 'wizard', name: 'Only by routine', reach: { routineId: 'login' } },
];

const profile = (screens: unknown[]) =>
  ({
    id: 'catalog-dev', name: 'catalog-dev', platform: 'generic', environment: 'dev', baseUrl: ORIGIN, credentialSets: ['admin', 'seller'],
    noiseFilters: [], surfaces: {}, screens, flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  }) as never;

const catalogMatrix = (extra: Record<string, unknown> = {}): Matrix =>
  permissionMatrixSchema.parse({
    targetProfile: 'catalog-dev',
    loginRoutine: 'login',
    roles: ['admin', 'seller'],
    deniedWhen: [{ urlContains: 'login' }],
    probes: [],
    screensFromCatalog: true,
    ...extra,
  });

before(async () => {
  await saveTarget(profile(screenList));
  await saveRoutine('login', { title: 'login', targetProfile: 'catalog-dev', steps: [{ id: 'open', action: 'goto', url: '$targetUrl' }] as never });
});

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('schema: screensFromCatalog allows a matrix with no hand-written probes; otherwise one is required; offeredTo must name roles', () => {
  assert.equal(issues(catalogMatrix()), '');
  const { screensFromCatalog: _omit, ...without } = catalogMatrix();
  assert.match(issues(without), /at least one probe, or screensFromCatalog/);

  const handwritten = (offeredTo: string[]) => ({ ...without, probes: [{ kind: 'url', id: 'a', url: '/a', offeredTo }] });
  assert.match(issues(handwritten(['ghost'])), /not one of the roles/);
  assert.equal(issues(handwritten(['admin'])), '');

  assert.equal(issues({ ...catalogMatrix(), expected: { seller: { 'screen-settings': 'denied' } } }), '', 'a catalogue probe may get an expectation before it exists');
  assert.match(issues({ ...handwritten(['admin']), expected: { seller: { 'screen-settings': 'denied' } } }), /not one of the probes/, 'without the catalogue it is still a typo');
});

test('target profile: a screen is validated (id, reach, unknown fields)', () => {
  const parse = (screens: unknown[]) => targetProfileSchema.safeParse(profile(screens));
  assert.ok(parse(screenList).success);
  assert.ok(!parse([{ id: 'x', name: 'x', reach: {} }]).success, 'reach needs a url or a routineId');
  assert.ok(!parse([{ id: 'bad id', name: 'x', reach: { url: '/x' } }]).success);
  assert.ok(!parse([{ id: 'x', name: 'x', reach: { url: 'x' } }]).success, 'a relative path must start with /');
  assert.ok(!parse([{ id: 'x', name: 'x', reach: { url: '/x' }, extra: 1 }]).success);
});

test('materialize: one url probe per screen with a url, offeredTo limited to the matrix roles; routine-only screens are not probed', () => {
  const target = { id: 'catalog-dev', screens: screenList } as never;
  const effective = logic.materializeMatrix(catalogMatrix({ roles: ['seller'] }), target);
  assert.deepEqual(effective.probes.map((probe) => probe.id), ['screen-dashboard', 'screen-settings', 'screen-reports']);
  const byId = Object.fromEntries(effective.probes.map((probe) => [probe.id, probe as { offeredTo?: string[]; url: string }]));
  assert.deepEqual(byId['screen-dashboard']!.offeredTo, ['seller'], 'roles outside this matrix are dropped');
  assert.deepEqual(byId['screen-settings']!.offeredTo, [], 'offered to nobody in this matrix');
  assert.equal(byId['screen-reports']!.offeredTo, undefined, 'no claim about the menu');
  assert.equal(byId['screen-reports']!.url, '/reports');

  const handwritten = catalogMatrix({ probes: [{ kind: 'url', id: 'extra', url: '/extra' }] });
  assert.deepEqual(logic.materializeMatrix(handwritten, target).probes.map((probe) => probe.id), ['extra', 'screen-dashboard', 'screen-settings', 'screen-reports']);

  const { screensFromCatalog: _omit, ...plain } = handwritten;
  assert.equal(logic.materializeMatrix(plain as Matrix, target), plain, 'without the flag the matrix is untouched');

  assert.throws(() => logic.materializeMatrix(catalogMatrix(), { id: 'p', screens: [] } as never), /no screen with reach.url/);
  assert.throws(
    () => logic.materializeMatrix(catalogMatrix({ probes: [{ kind: 'url', id: 'screen-settings', url: '/s' }] }), target),
    /already used/,
  );
  assert.throws(
    () => logic.materializeMatrix(catalogMatrix({ expected: { admin: { 'screen-nope': 'allowed' } } }), target),
    /neither a probe of the matrix nor a screen/,
  );
  const wide = Array.from({ length: 300 }, (_, i) => ({ id: `s${i}`, name: 's', reach: { url: `/s${i}` } }));
  assert.throws(() => logic.materializeMatrix(catalogMatrix(), { id: 'p', screens: wide } as never), /exceed 500 cells/);
});

test('expectations: a role whose menu does not offer the screen is expected denied; reaching it is the alert, and the verdict says so', () => {
  const effective = logic.materializeMatrix(catalogMatrix(), { id: 'catalog-dev', screens: screenList } as never);
  const cell = (role: string, probeId: string, outcome: string) => logic.applyExpectation({ role, probeId, kind: 'url', outcome } as never, effective);

  const sellerSettings = cell('seller', 'screen-settings', 'allowed');
  assert.deepEqual([sellerSettings.expected, sellerSettings.expectedBy, sellerSettings.matches], ['denied', 'menu', false]);
  assert.equal(cell('seller', 'screen-settings', 'denied').matches, true);
  assert.equal(cell('admin', 'screen-settings', 'allowed').expected, undefined, 'offered: no claim about access');
  assert.equal(cell('seller', 'screen-reports', 'allowed').expected, undefined, 'no offeredTo: no claim');
  assert.equal(cell('seller', 'screen-settings', 'error').matches, undefined, 'an error is never judged');

  // a written expectation wins over the menu
  const overridden = logic.materializeMatrix(catalogMatrix({ expected: { seller: { 'screen-settings': 'allowed' } } }), { id: 'p', screens: screenList } as never);
  const written = logic.applyExpectation({ role: 'seller', probeId: 'screen-settings', kind: 'url', outcome: 'allowed' } as never, overridden);
  assert.deepEqual([written.expected, written.expectedBy, written.matches], ['allowed', undefined, true]);

  type State = Parameters<typeof logic.concludeMatrix>[0];
  const red = { matrix: effective, cells: [sellerSettings, cell('admin', 'screen-settings', 'allowed')], changes: [], counts: {} } as never as State;
  logic.concludeMatrix(red, false);
  assert.deepEqual([red.verdict, red.exitCode, red.counts.unofferedAccess, red.counts.mismatches], ['red', 1, 1, 1]);
  assert.match(red.verdictReason!, /1 role\/screen pair\(s\) opened a page the role's menu does not offer/);
  assert.doesNotMatch(red.verdictReason!, /differ from the expectation/, 'a menu violation is not reported twice');

  const clean = { matrix: effective, cells: [cell('seller', 'screen-settings', 'denied'), cell('admin', 'screen-settings', 'allowed')], changes: [], counts: {} } as never as State;
  logic.concludeMatrix(clean, false);
  assert.deepEqual([clean.verdict, clean.counts.unofferedAccess], ['green', 0]);
  assert.match(clean.verdictReason!, /every expectation met/);
});

test('context: the effective matrix is what is planned (a session per role probes every catalogue screen); catalogue URLs go through the allowlist', async () => {
  const context = await resolveMatrixContext(catalogMatrix());
  assert.deepEqual(context.matrix.probes.map((probe) => probe.id), ['screen-dashboard', 'screen-settings', 'screen-reports']);

  const sessions = logic.planSessions(context.matrix, { baseUrl: ORIGIN, loginRoutine: context.loginRoutine, loginStepCount: context.loginStepCount, limits: LIMITS });
  assert.deepEqual(sessions.map((session) => session.role), ['admin', 'seller']);
  assert.equal(sessions[0]!.probes.length, 3);

  await saveTarget(profile([{ id: 'ext', name: 'elsewhere', reach: { url: 'https://evil.example.org/x' } }]));
  await assert.rejects(resolveMatrixContext(catalogMatrix()), (error: Error) => error.name === 'TargetUrlNotAllowed');

  await saveTarget(profile([]));
  await assert.rejects(resolveMatrixContext(catalogMatrix()), (error: Error & { status?: number }) => error.name === 'ScreenCatalogError' && error.status === 400);
});
