import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const ORIGIN = 'https://gx.example.com';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-platform-test-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts'); // .env may pin it
process.env.ALLOWED_TARGET_ORIGINS = ORIGIN;
process.env.ALLOWED_RESOURCE_ORIGINS = ORIGIN;
process.env.MAX_STEPS_PER_JOB = '50';

const { applyNoiseFilters, noiseRulesFor } = await import('../src/targets/platformRules.js');
const { saveTarget } = await import('../src/targets/targetStore.js');
const { saveRoutine } = await import('../src/library/routineService.js');
const { saveCredentialSet } = await import('../src/vault/credentials/credentialVault.js');
const { resolveExplorationRequest } = await import('../src/runner/resolveRequest.js');
const { explorationRequestSchema } = await import('../src/schemas/explorationRequest.schema.js');
const { targetProfileSchema } = await import('../src/schemas/targetProfile.schema.js');

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const failure = (failureText: string | undefined, status?: number) => ({ origin: ORIGIN, pathname: '/x', method: 'GET', failureText, status });

test('genexus: net::ERR_ABORTED is noise, counted with its reason; a real failure and a 500 stay', () => {
  const rules = noiseRulesFor(targetProfileSchema.parse({ id: 'p', name: 'gx', platform: 'genexus', environment: 'dev', baseUrl: ORIGIN }));
  const out = applyNoiseFilters(
    [failure('net::ERR_ABORTED'), failure('net::ERR_ABORTED'), failure('net::ERR_CONNECTION_RESET'), failure(undefined, 500)],
    rules,
  );
  assert.equal(out.kept.length, 2);
  assert.deepEqual(out.kept.map((item) => item.failureText ?? item.status), ['net::ERR_CONNECTION_RESET', 500]);
  assert.equal(out.filtered.length, 1);
  assert.equal(out.filtered[0]!.count, 2);
  assert.match(out.filtered[0]!.reason, /top\.location/);
});

test('generic profile filters nothing by itself; its own noiseFilters apply (to failures, never to HTTP statuses)', () => {
  const generic = targetProfileSchema.parse({ id: 'p', name: 'g', environment: 'dev', baseUrl: ORIGIN });
  assert.deepEqual(noiseRulesFor(generic), []);
  assert.deepEqual(noiseRulesFor(undefined), []);

  const custom = targetProfileSchema.parse({
    id: 'p',
    name: 'g',
    environment: 'dev',
    baseUrl: ORIGIN,
    noiseFilters: [{ networkFailureTextContains: 'ERR_BLOCKED_BY_CLIENT', reason: 'ad blocker in the lab' }],
  });
  const out = applyNoiseFilters([failure('net::ERR_BLOCKED_BY_CLIENT'), failure('net::ERR_ABORTED'), failure(undefined, 404)], noiseRulesFor(custom));
  assert.equal(out.kept.length, 2, 'ERR_ABORTED is only noise on a genexus profile');
  assert.deepEqual(out.filtered, [{ reason: 'ad blocker in the lab', count: 1 }]);
});

test('loginGate: timeout defaults to 15 s and must be a sane number', () => {
  const profile = targetProfileSchema.parse({ id: 'p', name: 'gx', platform: 'genexus', environment: 'dev', baseUrl: ORIGIN, loginGate: { urlContains: 'hwbwkw01' } });
  assert.equal(profile.loginGate?.timeoutMs, 15_000);
  assert.throws(() => targetProfileSchema.parse({ id: 'p', name: 'gx', environment: 'dev', baseUrl: ORIGIN, loginGate: { urlContains: 'x', timeoutMs: 5 } }));
});

// ---- automatic login ---------------------------------------------------------------------------------------------------------------------

type Body = Parameters<typeof saveRoutine>[1];
const save = (id: string, targetProfile: string, steps: Body['steps']) => saveRoutine(id, { title: id, targetProfile, steps } as Body);
const ids = (steps: Array<{ id?: string }>) => steps.map((step) => step.id);

const loginSteps = [
  { id: 'open', action: 'goto', url: '$targetUrl' },
  { id: 'user', action: 'fill', selector: '#user', valueFromCredential: 'loginUser' },
  { id: 'pass', action: 'fill', selector: '#pass', valueFromCredential: 'loginPassword' },
  { id: 'submit', action: 'click', selector: '#go' },
] as Body['steps'];

const profile = (id: string, extra: Record<string, unknown>) =>
  saveTarget(
    targetProfileSchema.parse({ id, name: id, environment: 'dev', baseUrl: ORIGIN, credentialSets: ['gx-admin'], ...extra }),
  );

before(async () => {
  await profile('gx-app', { platform: 'genexus', loginRoutine: 'gx-login', loginGate: { urlContains: 'hwbwkw01', timeoutMs: 8000 } });
  await profile('gx-nogate', { platform: 'genexus', loginRoutine: 'gx-login-b' });
  await profile('plain-app', { platform: 'generic', loginRoutine: 'gx-login' });
  await save('gx-login', 'gx-app', loginSteps);
  // This profile has no loginGate, so its login routine carries its own (GX001).
  await save('gx-login-b', 'gx-nogate', [...loginSteps, { id: 'gate', action: 'waitForUrlContains', value: 'home', timeoutMs: 5000 }] as Body['steps']);
  await saveCredentialSet('gx-admin', { boundOrigins: [ORIGIN], values: { loginUser: 'admin', loginPassword: 'placeholder-password-1' }, tags: [] }, 'create');
});

const request = (extra: Record<string, unknown>) =>
  explorationRequestSchema.parse({ targetProfile: 'gx-app', credentialSet: 'gx-admin', steps: [{ id: 'home', action: 'goto', url: '$targetUrl' }, { id: 'check', action: 'assertVisible', selector: '#menu' }], ...extra });

test('genexus + credential set: the login routine and the gate are included before the steps', async () => {
  const resolved = await resolveExplorationRequest(request({}));
  assert.deepEqual(ids(resolved.steps), ['autologin.open', 'autologin.user', 'autologin.pass', 'autologin.submit', 'autologin-gate', 'home', 'check']);
  const gate = resolved.steps[4] as { action: string; value: string; timeoutMs: number };
  assert.deepEqual([gate.action, gate.value, gate.timeoutMs], ['waitForUrlContains', 'hwbwkw01', 8000]);
  assert.deepEqual(resolved.autoLogin, { routineId: 'gx-login', version: 1, gate: true });
  // Saving the run as a routine keeps the steps as written: the login belongs to the profile, not to the routine.
  assert.deepEqual(ids(resolved.unexpanded!.steps), ['home', 'check']);
});

test('no gate configured: the login is included without one', async () => {
  const resolved = await resolveExplorationRequest(request({ targetProfile: 'gx-nogate' }));
  assert.equal(resolved.steps.some((step) => step.id === 'autologin-gate'), false);
  assert.equal(resolved.autoLogin?.gate, false);
});

test('options.autoLogin=false, no credential set, or a non-genexus profile: nothing is added', async () => {
  const off = await resolveExplorationRequest(request({ options: { autoLogin: false } }));
  assert.deepEqual(ids(off.steps), ['home', 'check']);
  assert.equal(off.autoLogin, undefined);

  const noSet = await resolveExplorationRequest(request({ credentialSet: undefined }));
  assert.deepEqual(ids(noSet.steps), ['home', 'check']);

  const generic = await resolveExplorationRequest(request({ targetProfile: 'plain-app' }));
  assert.deepEqual(ids(generic.steps), ['home', 'check']);
});

test('a run that already types a credential (explicit include, or the login routine itself) is not logged in twice', async () => {
  const explicit = await resolveExplorationRequest(request({ steps: [{ id: 'auth', action: 'include', routineId: 'gx-login' }, { id: 'check', action: 'assertVisible', selector: '#menu' }] }));
  assert.deepEqual(ids(explicit.steps), ['auth.open', 'auth.user', 'auth.pass', 'auth.submit', 'check']);
  assert.equal(explicit.autoLogin, undefined);

  const own = await resolveExplorationRequest(request({ steps: loginSteps }));
  assert.equal(own.steps.length, loginSteps.length);
  assert.equal(own.autoLogin, undefined);
});
