import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// T6.1 without a browser: schema rules, what a matrix may reference, how it is split into sessions, how a run
// result becomes cells, expectations, the diff against the previous run and the verdict.

const ORIGIN = 'https://dev.example.com';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-perm-test-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts'); // .env may pin it
process.env.ALLOWED_TARGET_ORIGINS = ORIGIN;
process.env.ALLOWED_RESOURCE_ORIGINS = ORIGIN;

const { saveTarget } = await import('../src/targets/targetStore.js');
const { saveRoutine } = await import('../src/library/routineService.js');
const { permissionMatrixSchema } = await import('../src/schemas/permissionMatrix.schema.js');
const { explorationRequestSchema } = await import('../src/schemas/explorationRequest.schema.js');
const { saveMatrix, resolveMatrixContext } = await import('../src/permissions/matrixStore.js');
const { startMatrixRun } = await import('../src/permissions/matrixRunner.js');
const logic = await import('../src/permissions/matrixLogic.js');

type Matrix = ReturnType<typeof permissionMatrixSchema.parse>;
type Result = Parameters<typeof logic.classifySession>[1];

const profile = (id: string, credentialSets: string[]) => ({
  id, name: id, platform: 'generic' as const, environment: 'dev' as const, baseUrl: ORIGIN, credentialSets,
  noiseFilters: [], surfaces: {}, screens: [], flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
});

before(async () => {
  await saveTarget(profile('app-dev', ['admin', 'seller']));
  await saveTarget(profile('other', ['admin']));
  const login = [
    { id: 'open', action: 'goto', url: '$targetUrl' },
    { id: 'user', action: 'fill', selector: '#u', valueFromCredential: 'user' },
    { id: 'submit', action: 'click', selector: '#go' },
  ] as never;
  await saveRoutine('login', { title: 'login', targetProfile: 'app-dev', steps: login });
  await saveRoutine('other-login', { title: 'login elsewhere', targetProfile: 'other', steps: login });
  await saveRoutine('delete-order', { title: 'delete', targetProfile: 'app-dev', steps: [{ id: 'x', action: 'click', selector: '#del' }] as never });
});

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const base = (extra: Record<string, unknown> = {}): Matrix =>
  permissionMatrixSchema.parse({
    targetProfile: 'app-dev',
    loginRoutine: 'login',
    roles: ['admin', 'seller'],
    deniedWhen: [{ urlContains: 'login' }, { textVisible: 'Not authorized' }, { status: 403 }],
    probes: [
      { kind: 'url', id: 'settings', url: '/settings' },
      { kind: 'control', id: 'delete-btn', url: '/orders', selector: '#del' },
      { kind: 'action', id: 'delete', routineId: 'delete-order' },
    ],
    ...extra,
  });

const LIMITS = { maxStepsPerJob: 50, jobTimeoutMs: 60_000, stepTimeoutMs: 10_000 };
const issues = (body: unknown) => (permissionMatrixSchema.safeParse(body).error?.issues ?? []).map((issue) => issue.message).join(' | ');

test('schema: duplicate roles/probe ids, unknown roles/probes in expectations and impossible expectations are refused', () => {
  const ok = base();
  assert.equal(ok.settleMs, 1500);
  assert.equal(ok.isolation, 'perRole');

  assert.match(issues({ ...ok, roles: ['admin', 'admin'] }), /listed twice/);
  assert.match(issues({ ...ok, probes: [...ok.probes, { kind: 'url', id: 'settings', url: '/x' }] }), /used twice/);
  assert.match(issues({ ...ok, expected: { ghost: { settings: 'allowed' } } }), /not one of the roles/);
  assert.match(issues({ ...ok, expected: { admin: { nope: 'allowed' } } }), /not one of the probes/);
  assert.match(issues({ ...ok, expected: { admin: { settings: 'visible' } } }), /can only be expected "allowed" or "denied"/);
  assert.equal(issues({ ...ok, expected: { admin: { 'delete-btn': 'enabled' }, seller: { 'delete-btn': 'hidden', settings: 'denied' } } }), '');
  assert.match(issues({ ...ok, probes: [{ kind: 'url', id: 'rel', url: 'settings' }] }), /absolute/);
  assert.match(issues({ ...ok, deniedWhen: [] }), /at least 1|>=1|too_small|Array must contain/i);

  const manyProbes = Array.from({ length: 200 }, (_, i) => ({ kind: 'url', id: `p${i}`, url: `/p${i}` }));
  assert.match(issues({ ...ok, roles: ['a', 'b', 'c'], probes: manyProbes }), /500 cells/);
});

test('a matrix can only reference what its target profile allows', async () => {
  await assert.rejects(resolveMatrixContext(base({ roles: ['admin', 'stranger'] })), (error: Error) => error.name === 'CredentialSetNotAllowed' && /stranger/.test(error.message));
  await assert.rejects(
    resolveMatrixContext(base({ probes: [{ kind: 'url', id: 'evil', url: 'https://evil.example.org/x' }] })),
    (error: Error) => error.name === 'TargetUrlNotAllowed' && /evil/.test(error.message),
  );
  await assert.rejects(
    resolveMatrixContext(base({ probes: [{ kind: 'url', id: 'meta', url: 'http://169.254.169.254/latest' }] })),
    (error: Error) => error.name === 'TargetUrlNotAllowed',
  );
  await assert.rejects(resolveMatrixContext(base({ loginRoutine: undefined })), (error: Error) => error.name === 'LoginRoutineRequired');
  await assert.rejects(resolveMatrixContext(base({ loginRoutine: 'other-login' })), /other/);
  await assert.rejects(resolveMatrixContext(base({ probes: [{ kind: 'action', id: 'a', routineId: 'missing' }] })), /missing/);

  const context = await resolveMatrixContext(base());
  assert.equal(context.loginStepCount, 3);
});

test('saving is idempotent: the same content is not a change', async () => {
  const first = await saveMatrix('orders', base());
  const again = await saveMatrix('orders', base());
  assert.equal(first.changed, true);
  assert.equal(again.changed, false);
  assert.equal(again.stored.sha256, first.stored.sha256);
  const edited = await saveMatrix('orders', base({ settleMs: 0 }));
  assert.equal(edited.changed, true);
  assert.notEqual(edited.stored.sha256, first.stored.sha256);
});

test('sessions: one login per role for its pages (chunked to the job limits), one session per action, role-major', () => {
  const matrix = base();
  const sessions = logic.planSessions(matrix, { baseUrl: ORIGIN, loginRoutine: 'login', loginStepCount: 3, limits: LIMITS });
  assert.deepEqual(sessions.map((s) => `${s.role}:${s.kind}:${s.probes.map((p) => p.id).join(',')}`), [
    'admin:pages:settings,delete-btn',
    'admin:action:delete',
    'seller:pages:settings,delete-btn',
    'seller:action:delete',
  ]);

  const pages = sessions[0]!;
  assert.deepEqual(pages.steps.map((step) => step.id), [
    'login', 'probe-settings-open', 'probe-settings-settle', 'probe-settings-read', 'probe-delete-btn-open', 'probe-delete-btn-settle', 'probe-delete-btn-read',
  ]);
  assert.equal((pages.steps[1] as { url: string }).url, `${ORIGIN}/settings`, 'paths resolve against the profile baseUrl');
  assert.deepEqual((pages.steps[3] as { textMarkers?: string[] }).textMarkers, ['Not authorized']);
  assert.equal((pages.steps[6] as { selector?: string }).selector, '#del');

  for (const session of sessions) {
    assert.ok(explorationRequestSchema.safeParse({ targetProfile: 'app-dev', credentialSet: session.role, steps: session.steps }).success, 'every session is a valid request');
  }

  const many = base({ probes: Array.from({ length: 30 }, (_, i) => ({ kind: 'url', id: `p${i}`, url: `/p${i}` })) });
  const perSession = logic.probesPerSession(many, 3, LIMITS);
  assert.ok(perSession >= 1 && perSession * 3 + 3 <= LIMITS.maxStepsPerJob, `chunk ${perSession} fits MAX_STEPS_PER_JOB`);
  const chunked = logic.planSessions(many, { baseUrl: ORIGIN, loginRoutine: 'login', loginStepCount: 3, limits: LIMITS });
  assert.equal(chunked.reduce((n, s) => n + s.probes.length, 0), 60, 'every cell is planned exactly once');
  assert.ok(chunked.every((s) => s.steps.length <= LIMITS.maxStepsPerJob));

  const isolated = logic.planSessions(base({ isolation: 'perProbe' }), { baseUrl: ORIGIN, loginRoutine: 'login', loginStepCount: 3, limits: LIMITS });
  assert.equal(isolated.filter((s) => s.kind === 'pages').length, 4, 'perProbe: one login per role x page probe');
});

function fakeResult(overrides: Partial<Result>): Result {
  return {
    jobId: 'job_test', status: 'passed', startedAt: '', finishedAt: '', durationMs: 1, targetUrl: ORIGIN, caller: null,
    steps: [], extracted: {},
    evidence: { screenshots: [], console: [], consoleErrors: [], pageErrors: [], network: [], networkFailures: [], unexpectedExternalRequests: [] },
    ...overrides,
  } as Result;
}

test('classification: denial by url, text or status; control states; login failure; a broken probe; a probe never reached', () => {
  const matrix = base();
  const [pages, action] = logic.planSessions(matrix, { baseUrl: ORIGIN, loginRoutine: 'login', loginStepCount: 3, limits: LIMITS });
  const reading = (url: string, extra: Record<string, unknown> = {}) => ({ url, documentStatus: 200, markersFound: [], ...extra });

  const deniedByUrl = logic.classifySession(pages!, fakeResult({
    extracted: {
      probe_settings: reading(`${ORIGIN}/login?next=/settings`),
      'probe_delete-btn': reading(`${ORIGIN}/orders`, { selector: { count: 1, visible: true, enabled: false } }),
    },
  }), matrix, 3);
  assert.equal(deniedByUrl[0]!.outcome, 'denied');
  assert.equal(deniedByUrl[0]!.deniedBy, 'urlContains "login"');
  assert.deepEqual([deniedByUrl[1]!.outcome, deniedByUrl[1]!.state], ['allowed', 'disabled']);

  const byTextAndStatus = logic.classifySession(pages!, fakeResult({
    extracted: {
      probe_settings: reading(`${ORIGIN}/settings`, { markersFound: ['Not authorized'] }),
      'probe_delete-btn': reading(`${ORIGIN}/orders`, { documentStatus: 403, selector: { count: 1, visible: true, enabled: true } }),
    },
  }), matrix, 3);
  assert.equal(byTextAndStatus[0]!.deniedBy, 'textVisible "Not authorized"');
  assert.deepEqual([byTextAndStatus[1]!.outcome, byTextAndStatus[1]!.deniedBy], ['denied', 'status 403'], 'a denied page wins over a visible control');

  const states = (selector: unknown) =>
    logic.classifySession(pages!, fakeResult({ extracted: { probe_settings: reading(`${ORIGIN}/settings`), 'probe_delete-btn': reading(`${ORIGIN}/orders`, { selector }) } }), matrix, 3);
  assert.equal(states({ count: 0, visible: false, enabled: false })[1]!.state, 'hidden');
  assert.equal(states({ count: 2, visible: false, enabled: true })[1]!.state, 'hidden', 'present but invisible is hidden');
  assert.equal(states({ count: 1, visible: true, enabled: true })[1]!.state, 'enabled');
  assert.equal(states({ count: 1, visible: true, enabled: true })[0]!.outcome, 'allowed');

  const loginFailed = logic.classifySession(pages!, fakeResult({ status: 'failed', failedStepIndex: 2, error: { type: 'TimeoutError', message: 'no #go' } }), matrix, 3);
  assert.ok(loginFailed.every((cell) => cell.outcome === 'error' && cell.errorType === 'LoginFailed'));

  const broken = logic.classifySession(pages!, fakeResult({
    status: 'failed', failedStepIndex: 4, error: { type: 'TargetUrlNotAllowed', message: 'redirected outside' },
    steps: [{ index: 4, id: 'probe-settings-open', action: 'goto', status: 'failed', startedAt: '', finishedAt: '', durationMs: 1, error: { type: 'TargetUrlNotAllowed', message: 'redirected outside' } }],
  }), matrix, 3);
  assert.deepEqual(broken.map((cell) => cell.errorType), ['TargetUrlNotAllowed', 'NotReached']);

  assert.equal(logic.classifySession(action!, fakeResult({}), matrix, 3)[0]!.outcome, 'allowed');
  const actionDenied = logic.classifySession(action!, fakeResult({
    status: 'failed', failedStepIndex: 3, finalUrl: `${ORIGIN}/orders`, error: { type: 'TimeoutError', message: '#del' },
    evidence: { screenshots: [], console: [], consoleErrors: [], pageErrors: [], network: [], networkFailures: [], unexpectedExternalRequests: [], domTextSnapshot: 'Orders\nNot authorized' },
  }), matrix, 3);
  assert.deepEqual([actionDenied[0]!.outcome, actionDenied[0]!.deniedBy], ['denied', 'textVisible "Not authorized"']);
  const actionBroken = logic.classifySession(action!, fakeResult({ status: 'failed', failedStepIndex: 3, finalUrl: `${ORIGIN}/orders`, error: { type: 'TimeoutError', message: '#del' } }), matrix, 3);
  assert.equal(actionBroken[0]!.errorType, 'ActionFailedWithoutDenial', 'a routine that fails for no denial reason is not an answer');
});

test('expectations: a control on a denied page counts as hidden; errors are never judged', () => {
  const matrix = base({ expected: { seller: { 'delete-btn': 'hidden', settings: 'denied' }, admin: { 'delete-btn': 'enabled' } } });
  const cell = (role: string, probeId: string, extra: Record<string, unknown>) => logic.applyExpectation({ role, probeId, kind: probeId === 'settings' ? 'url' : 'control', outcome: 'allowed', ...extra } as never, matrix);

  assert.equal(cell('seller', 'delete-btn', { outcome: 'denied' }).matches, true);
  assert.equal(cell('seller', 'delete-btn', { state: 'hidden' }).matches, true);
  assert.equal(cell('seller', 'delete-btn', { state: 'disabled' }).matches, false);
  assert.equal(cell('admin', 'delete-btn', { state: 'enabled' }).matches, true);
  assert.equal(cell('seller', 'settings', { outcome: 'allowed' }).matches, false);
  const errored = cell('seller', 'settings', { outcome: 'error' });
  assert.equal(errored.matches, undefined);
  assert.equal(errored.expected, 'denied');
  assert.equal(cell('admin', 'settings', {}).expected, undefined);
});

test('diff against the previous run: a new access with no expectation is an alert; a lost one is listed; a changed probe is not compared', () => {
  const matrix = base({ expected: { admin: { settings: 'allowed' } } });
  const previous = {
    matrix,
    cells: [
      { role: 'seller', probeId: 'settings', kind: 'url', outcome: 'denied' },
      { role: 'seller', probeId: 'delete-btn', kind: 'control', outcome: 'allowed', state: 'disabled' },
      { role: 'admin', probeId: 'settings', kind: 'url', outcome: 'denied' },
      { role: 'admin', probeId: 'delete', kind: 'action', outcome: 'allowed' },
      { role: 'seller', probeId: 'delete', kind: 'action', outcome: 'error' },
    ],
  } as never;
  const now = [
    { role: 'seller', probeId: 'settings', kind: 'url', outcome: 'allowed' },
    { role: 'seller', probeId: 'delete-btn', kind: 'control', outcome: 'allowed', state: 'enabled' },
    { role: 'admin', probeId: 'settings', kind: 'url', outcome: 'allowed', expected: 'allowed', matches: true },
    { role: 'admin', probeId: 'delete', kind: 'action', outcome: 'denied' },
    { role: 'seller', probeId: 'delete', kind: 'action', outcome: 'allowed' },
  ] as never;

  const changes = logic.diffAgainst(previous, now, matrix);
  assert.deepEqual(changes.map((c) => `${c.role}/${c.probeId}:${c.from}->${c.to}:${c.change}:${c.alert}`), [
    'seller/settings:denied->allowed:gainedAccess:true',
    'seller/delete-btn:disabled->enabled:gainedAccess:true',
    'admin/settings:denied->allowed:gainedAccess:false',
    'admin/delete:allowed->denied:lostAccess:false',
  ], 'an expected gain is not an alert; an error on either side is not compared');

  const moved = base({ probes: [{ kind: 'url', id: 'settings', url: '/settings-v2' }] });
  assert.deepEqual(logic.diffAgainst(previous, now, moved), [], 'a probe aimed elsewhere is a new question');
});

test('verdict: red (an unmet expectation or an unexpected gain) wins over infra-error; green needs every cell answered', () => {
  const state = (cells: unknown[], changes: unknown[] = []) => ({ matrix: base(), cells, changes, counts: {} }) as never as Parameters<typeof logic.concludeMatrix>[0];
  const allowed = { role: 'a', probeId: 'p', kind: 'url', outcome: 'allowed' };

  const green = state([allowed]);
  logic.concludeMatrix(green, false);
  assert.deepEqual([green.verdict, green.exitCode, green.status], ['green', 0, 'completed']);

  const infra = state([allowed, { ...allowed, probeId: 'q', outcome: 'error' }]);
  logic.concludeMatrix(infra, false);
  assert.deepEqual([infra.verdict, infra.exitCode], ['infra-error', 2]);

  const redWithError = state([{ ...allowed, expected: 'denied', matches: false }, { ...allowed, probeId: 'q', outcome: 'error' }]);
  logic.concludeMatrix(redWithError, false);
  assert.deepEqual([redWithError.verdict, redWithError.exitCode], ['red', 1]);
  assert.match(redWithError.verdictReason!, /differ from the expectation.*could not be answered/);

  const alert = state([allowed], [{ role: 'a', probeId: 'p', from: 'denied', to: 'allowed', change: 'gainedAccess', alert: true }]);
  logic.concludeMatrix(alert, false);
  assert.deepEqual([alert.verdict, alert.counts.alerts], ['red', 1]);

  const cancelled = state([allowed, { ...allowed, probeId: 'q', outcome: 'pending' }]);
  logic.concludeMatrix(cancelled, true);
  assert.deepEqual([cancelled.verdict, cancelled.status], ['infra-error', 'cancelled']);
});

test('running a matrix that does not exist is a 404 and starts nothing', async () => {
  await assert.rejects(startMatrixRun('ghost', {}), (error: Error & { status?: number }) => error.name === 'PermissionMatrixNotFound' && error.status === 404);
});
