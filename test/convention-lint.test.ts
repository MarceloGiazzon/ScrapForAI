import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const ORIGIN = 'https://gx.example.com';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-lint-test-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts'); // .env may pin it
process.env.ALLOWED_TARGET_ORIGINS = ORIGIN;
process.env.ALLOWED_RESOURCE_ORIGINS = ORIGIN;

const { lintConventions } = await import('../src/library/conventionLint.js');
const { saveRoutine, lintRoutineContent } = await import('../src/library/routineService.js');
const { saveTarget } = await import('../src/targets/targetStore.js');
const { targetProfileSchema } = await import('../src/schemas/targetProfile.schema.js');

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

type Steps = Parameters<typeof lintConventions>[0]['steps'];
const gx = { platform: 'genexus' } as const;
const user = { id: 'user', action: 'fill', selector: '#u', valueFromCredential: 'loginUser' };
const pass = { id: 'pass', action: 'fill', selector: '#p', valueFromCredential: 'loginPassword' };
const submit = { id: 'submit', action: 'click', selector: '#go' };
const gate = { id: 'gate', action: 'waitForUrlContains', value: 'hwbwkw01', timeoutMs: 10000 };
const logout = [{ id: 'bye', action: 'click', selector: '#logout' }] as Steps;
const rules = (steps: unknown[], context: Parameters<typeof lintConventions>[1] = gx, extra: Record<string, unknown> = {}) =>
  lintConventions({ steps: steps as Steps, teardown: logout, ...extra }, context).findings.map((finding) => finding.rule);

test('GX001: a login submit with no gate is an error, with the gate (next steps or on the submit itself) it is not', () => {
  assert.deepEqual(rules([user, pass, submit]), ['GX001']);
  assert.deepEqual(rules([user, pass, submit, { id: 'shot', action: 'screenshot', name: 'x' }]), ['GX001']);
  assert.deepEqual(rules([user, pass, submit, gate]), []);
  assert.deepEqual(rules([user, pass, { ...submit, afterWaitFor: { urlContains: 'hwbwkw01' } }]), []);
  assert.deepEqual(rules([user, pass, submit, { action: 'assertUrlContains', value: 'hwbwkw01' }]), []);
  assert.deepEqual(rules([user, pass, submit, { action: 'reload' }, { action: 'reload' }, gate]), [], 'within the next three steps');
});

test('GX001 points at the submit step and never at an ordinary click', () => {
  const [finding] = lintConventions({ steps: [{ action: 'goto', url: '$targetUrl' }, user, pass, submit] as Steps, teardown: logout }, gx).findings;
  assert.deepEqual([finding!.path, finding!.stepId, finding!.severity], ['steps.3', 'submit', 'error']);
  assert.deepEqual(rules([{ action: 'click', selector: '#menu' }, { action: 'click', selector: '#other' }]), []);
});

test('GX001 only applies to genexus, and not to the profile\'s own login routine when the profile has a loginGate', () => {
  assert.deepEqual(rules([user, pass, submit], { platform: 'generic' }), []);
  assert.deepEqual(rules([user, pass, submit], { platform: 'genexus', isLoginRoutine: true, gateProvidedByProfile: true }), []);
  assert.deepEqual(rules([user, pass, submit], { platform: 'genexus', isLoginRoutine: true }), ['GX001']);
});

test('GX002: a routine that logs in (directly or by including the profile login) without a teardown warns; the login routine itself does not', () => {
  const noTeardown = (steps: unknown[], context: Parameters<typeof lintConventions>[1]) => lintConventions({ steps: steps as Steps }, context).findings.map((finding) => finding.rule);
  assert.deepEqual(noTeardown([user, pass, submit, gate], gx), ['GX002']);
  assert.deepEqual(noTeardown([{ id: 'auth', action: 'include', routineId: 'gx-login' }, { action: 'reload' }], { ...gx, loginRoutineId: 'gx-login' }), ['GX002']);
  assert.deepEqual(noTeardown([{ action: 'include', routineId: 'other' }], { ...gx, loginRoutineId: 'gx-login' }), []);
  assert.deepEqual(noTeardown([user, pass, submit, gate], { ...gx, isLoginRoutine: true }), []);
  assert.deepEqual(noTeardown([user, pass, submit, gate], { platform: 'generic' }), []);
});

test('WT001: a fixed wait warns on any platform, in the steps or the teardown', () => {
  assert.deepEqual(rules([{ action: 'waitForTimeout', timeoutMs: 2000 }], { platform: 'generic' }), ['WT001']);
  const result = lintConventions({ steps: [{ action: 'reload' }] as Steps, teardown: [{ id: 'w', action: 'waitForTimeout', timeoutMs: 500 }] as Steps }, { platform: 'generic' });
  assert.deepEqual(result.findings.map((finding) => [finding.rule, finding.path, finding.severity]), [['WT001', 'teardown.0', 'warning']]);
  assert.match(result.findings[0]!.suggestion ?? '', /waitForQuiet/);
});

test('SEL001: positional selectors warn, ids and attributes do not', () => {
  for (const selector of ['ul > li:nth-child(3)', 'tr:nth-of-type(2) td', '.row >> nth=1', 'button:first', 'a:last', 'li:first-child']) {
    assert.deepEqual(rules([{ action: 'click', selector }], { platform: 'generic' }), ['SEL001'], selector);
  }
  for (const selector of ['#save', '[name="cep"]', 'button:has-text("Save")', 'input[name=first]', '[data-npdev-key="client.name"]']) {
    assert.deepEqual(rules([{ action: 'click', selector }], { platform: 'generic' }), [], selector);
  }
  assert.deepEqual(rules([{ action: 'keyboardWalk', name: 'w', startSelector: 'div:nth-child(2)' }], { platform: 'generic' }), ['SEL001']);
});

test('a suppression with a reason moves the finding to `suppressed`; one for another step or rule does not', () => {
  const steps = [user, pass, submit] as unknown as Steps;
  const accepted = lintConventions({ steps, teardown: logout, lintSuppress: [{ rule: 'GX001', reason: 'login lands on the same URL in this app' }] }, gx);
  assert.deepEqual(accepted.findings, []);
  assert.deepEqual(accepted.suppressed.map((item) => [item.rule, item.reason]), [['GX001', 'login lands on the same URL in this app']]);

  const wrongStep = lintConventions({ steps, teardown: logout, lintSuppress: [{ rule: 'GX001', stepId: 'other', reason: 'a reason long enough' }] }, gx);
  assert.deepEqual(wrongStep.findings.map((item) => item.rule), ['GX001']);
  const rightStep = lintConventions({ steps, teardown: logout, lintSuppress: [{ rule: 'GX001', stepId: 'submit', reason: 'a reason long enough' }] }, gx);
  assert.deepEqual(rightStep.findings, []);
  const wrongRule = lintConventions({ steps, teardown: logout, lintSuppress: [{ rule: 'WT001', reason: 'a reason long enough' }] }, gx);
  assert.deepEqual(wrongRule.findings.map((item) => item.rule), ['GX001']);
});

// ---- at save -------------------------------------------------------------------------------------------------------------------------------

type Body = Parameters<typeof saveRoutine>[1];
const save = (id: string, targetProfile: string, steps: unknown[], extra: Record<string, unknown> = {}) =>
  saveRoutine(id, { title: id, targetProfile, steps, ...extra } as Body);

before(async () => {
  await saveTarget(targetProfileSchema.parse({ id: 'gx-app', name: 'gx', platform: 'genexus', environment: 'dev', baseUrl: ORIGIN, loginRoutine: 'gx-login', loginGate: { urlContains: 'hwbwkw01' } }));
  await saveTarget(targetProfileSchema.parse({ id: 'plain', name: 'plain', platform: 'generic', environment: 'dev', baseUrl: ORIGIN }));
});

test('save: a GX001 error stops the save with 422 and stores nothing; the same steps on a generic profile save fine', async () => {
  await assert.rejects(
    () => save('bad-login', 'gx-app', [user, pass, submit]),
    (error: unknown) => {
      const e = error as { status: number; name: string; message: string; details?: Array<{ path: string; message: string }> };
      assert.equal(e.status, 422);
      assert.match(e.message, /GX001/);
      assert.match(e.details![0]!.message, /^GX001:/);
      return true;
    },
  );
  assert.ok((await save('plain-login', 'plain', [user, pass, submit])).created);
});

test('save: the profile\'s own login routine needs no gate of its own when the profile has a loginGate; warnings come back with the routine', async () => {
  const saved = await save('gx-login', 'gx-app', [user, pass, submit]);
  assert.equal(saved.created, true);
  assert.deepEqual(saved.lint.findings, []);

  const warned = await save('with-wait', 'plain', [{ action: 'reload' }, { action: 'waitForTimeout', timeoutMs: 1000 }]);
  assert.deepEqual(warned.lint.findings.map((item) => item.rule), ['WT001']);
});

test('save: lintSuppress is stored with the routine, accepts the finding and keeps it listed', async () => {
  const saved = await save('accepted', 'gx-app', [user, pass, submit], { lintSuppress: [{ rule: 'GX001', reason: 'the post-login URL equals the login URL here' }] });
  assert.deepEqual(saved.lint.findings.filter((item) => item.rule === 'GX001'), []);
  assert.deepEqual(saved.lint.suppressed.map((item) => item.rule), ['GX001']);
  assert.equal(saved.routine.lintSuppress?.[0]?.rule, 'GX001');
  await assert.rejects(() => save('short-reason', 'gx-app', [user, pass, submit], { lintSuppress: [{ rule: 'GX001', reason: 'no' }] }));
});

test('lintRoutineContent lints without saving, and knows the routine id is the login routine', async () => {
  const asLogin = await lintRoutineContent({ targetProfile: 'gx-app', steps: [user, pass, submit] as never, routineId: 'gx-login' });
  assert.deepEqual(asLogin.findings, []);
  const asOther = await lintRoutineContent({ targetProfile: 'gx-app', steps: [user, pass, submit] as never });
  assert.deepEqual(asOther.findings.map((item) => item.rule).sort(), ['GX001', 'GX002']);
  await assert.rejects(() => lintRoutineContent({ targetProfile: 'nope', steps: [submit] as never }), /does not exist/);
});
