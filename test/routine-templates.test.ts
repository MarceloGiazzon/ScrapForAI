import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// Routine templates (templates/routines/) are starting points that people edit and then save. They must
// stay valid once the placeholders are filled, never carry a literal secret, and never be saveable as
// "ready" by accident (placeholders present, status draft).
process.env.SCRAPFORAI_API_KEY ??= 'test-api-key-1234567890';
process.env.ALLOWED_TARGET_ORIGINS ??= 'https://dev.example.com';
process.env.MAX_STEPS_PER_JOB = '50';

const { mcpSaveRoutineSchema } = await import('../src/schemas/libraryRoutine.schema.js');
const { lintRoutineSteps } = await import('../src/library/routineLint.js');

const dir = path.resolve(import.meta.dirname, '..', 'templates', 'routines');
const readme = readFileSync(path.join(dir, 'README.md'), 'utf8');
const PLACEHOLDER = /REPLACE_[A-Z0-9_]+/g;

const DUMMIES: Record<string, string> = {
  REPLACE_TARGET_PROFILE: 'app-dev',
  REPLACE_CREDENTIAL_SET: 'gam-admin',
  REPLACE_POST_LOGIN_URL_TOKEN: 'hwbwkw01',
  REPLACE_LOGOUT_URL: 'https://dev.example.com/app/logout',
  REPLACE_SURFACE: 'checkout',
  REPLACE_PAGE_URL: 'https://dev.example.com/app/hcheckout',
  REPLACE_PAGE_URL_TOKEN: 'hcheckout',
  REPLACE_MAIN_SELECTOR: '#main',
};

const files = readdirSync(dir).filter((f) => f.endsWith('.routine.json'));

test('there is at least a login and a smoke template', () => {
  assert.ok(files.includes('gx-login.routine.json'));
  assert.ok(files.includes('gx-smoke-page.routine.json'));
});

for (const file of files) {
  const raw = readFileSync(path.join(dir, file), 'utf8');

  test(`${file}: placeholders are known, documented, and the template is a draft`, () => {
    const found = new Set(raw.match(PLACEHOLDER) ?? []);
    assert.ok(found.size > 0, 'a template without placeholders is a routine, not a template');
    for (const name of found) {
      assert.ok(name in DUMMIES, `unknown placeholder ${name}: add it to this test and to the README table`);
      assert.ok(readme.includes(name), `placeholder ${name} is not explained in templates/routines/README.md`);
    }
    assert.equal(JSON.parse(raw).status, 'draft');
  });

  test(`${file}: valid as a saved routine once the placeholders are filled`, () => {
    const filled = raw.replace(PLACEHOLDER, (name) => DUMMIES[name] ?? name);
    const body = JSON.parse(filled) as Record<string, unknown>;
    const parsed = mcpSaveRoutineSchema.safeParse({ id: 'template-check', ...body });
    assert.ok(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues));
    const steps = [...(parsed.data.steps ?? []), ...(parsed.data.teardown ?? [])];
    assert.deepEqual(lintRoutineSteps(steps, []), [], 'a template must not carry anything that looks like a secret');
  });

  test(`${file}: credentials only by name (valueFromCredential), no literal value`, () => {
    const body = JSON.parse(raw) as { steps: Array<Record<string, unknown>> };
    for (const step of body.steps.filter((s) => s.action === 'fill')) {
      assert.ok(typeof step.valueFromCredential === 'string' && step.value === undefined, `fill step ${String(step.id)} must use valueFromCredential`);
    }
  });
}

test('the login template gates the login and releases the session', () => {
  const login = JSON.parse(readFileSync(path.join(dir, 'gx-login.routine.json'), 'utf8')) as {
    steps: Array<{ action: string }>;
    teardown?: unknown[];
  };
  assert.ok(login.steps.some((s) => s.action === 'waitForUrlContains'), 'GeneXus convention: gate the login');
  assert.ok((login.teardown ?? []).length > 0, 'GeneXus convention: one session per user, so log out in teardown');
});
