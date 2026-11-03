import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// examples/wmsoffice/ are verified-against-a-real-app routines and vault items. This keeps them loadable:
// valid against today's schemas, internally consistent, and free of secrets.
process.env.SCRAPFORAI_API_KEY ??= 'test-api-key-1234567890';
process.env.ALLOWED_TARGET_ORIGINS ??= 'https://dev.example.com';
process.env.MAX_STEPS_PER_JOB = '50';

const { mcpSaveRoutineSchema } = await import('../src/schemas/libraryRoutine.schema.js');
const { regressionItemWriteSchema } = await import('../src/schemas/regressionItem.schema.js');
const { targetProfileSchema } = await import('../src/schemas/targetProfile.schema.js');
const { lintRoutineSteps } = await import('../src/library/routineLint.js');

const dir = path.resolve(import.meta.dirname, '..', 'examples', 'wmsoffice');
const read = (file: string): Record<string, any> => JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
const ROUTINES = ['wms-login', 'reg-216', 'reg-218'];
const ITEMS = ['REG-216', 'REG-218'];

test('the target profile is valid and the credential set it names is the one the routines use', () => {
  const target = read('target.json');
  const parsed = targetProfileSchema.safeParse({ id: 'wmsoffice-dev', ...target });
  assert.ok(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues));
  for (const id of ROUTINES) {
    const routine = read(`routines/${id}.json`);
    assert.equal(routine.targetProfile, 'wmsoffice-dev');
    assert.ok(target.credentialSets.includes(routine.credentialSet), `${id} uses a credential set the profile does not list`);
  }
});

for (const id of ROUTINES) {
  test(`routines/${id}.json is a valid saveable routine with no literal secret`, () => {
    const routine = read(`routines/${id}.json`);
    const parsed = mcpSaveRoutineSchema.safeParse({ id, ...routine });
    assert.ok(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues));
    assert.deepEqual(lintRoutineSteps([...(parsed.data.steps ?? []), ...(parsed.data.teardown ?? [])], []), []);
    // Login fields come from the vault, never from a literal.
    for (const step of routine.steps.filter((s: any) => s.action === 'fill' && /user|pass/i.test(String(s.selector)))) {
      assert.ok(step.valueFromCredential && step.value === undefined, `${id}: ${step.id} must use valueFromCredential`);
    }
  });
}

test('the login gate does not match the login URL (it already contains next=...npdev-business-ui)', () => {
  const login = read('routines/wms-login.json');
  const gate = login.steps.find((s: any) => s.id === 'gate');
  assert.ok(gate, 'the login routine needs a gate step');
  assert.notEqual(gate.action, 'waitForUrlContains', 'a URL gate passes on login.html?next=...npdev-business-ui');
});

test('every regression routine includes the login at a pinned version that exists', () => {
  for (const id of ['reg-216', 'reg-218']) {
    const include = read(`routines/${id}.json`).steps.find((s: any) => s.action === 'include');
    assert.ok(include, `${id} must include the login`);
    assert.equal(include.routineId, 'wms-login');
    assert.equal(include.version, 1, 'pin the version: without it the proof is not reproducible');
  }
});

for (const id of ITEMS) {
  test(`items/${id}.json is a valid vault item that points at an existing routine`, () => {
    const item = read(`items/${id}.json`);
    const parsed = regressionItemWriteSchema.safeParse(item);
    assert.ok(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues));
    assert.ok(ROUTINES.includes(item.routine.id), `${id} points at an unknown routine`);
    assert.equal(item.routine.version, 1);
    assert.ok(item.redNotCapturedReason, 'a bug fixed before the vault existed has no RED: say why');
    assert.equal(item.provenRed, undefined, 'evidence cannot be typed in');
    assert.equal(item.firstGreen, undefined, 'evidence cannot be typed in');
  });
}
