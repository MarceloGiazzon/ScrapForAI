import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// T9.2: the first client of the living manual is ScrapForAI's own web console (templates/manual/scrapforai-console/). Unlike templates/routines/ these
// are NOT placeholders: they are saved as they are against a console (target.json says which one). This test keeps them valid, trilingual, free of
// secrets, and honest about the rule that matters most for a login page: the API key is typed from the vault and never in front of a camera.

process.env.SCRAPFORAI_API_KEY ??= 'test-api-key-1234567890';
process.env.ALLOWED_TARGET_ORIGINS ??= 'http://127.0.0.1:3000';
process.env.MAX_STEPS_PER_JOB = '50';

const { mcpSaveRoutineSchema } = await import('../src/schemas/libraryRoutine.schema.js');
const { targetProfileSchema } = await import('../src/schemas/targetProfile.schema.js');
const { explorationRequestSchema } = await import('../src/schemas/explorationRequest.schema.js');
const { lintRoutineDoc, lintRoutineSteps } = await import('../src/library/routineLint.js');
const { lintConventions } = await import('../src/library/conventionLint.js');
const { leafSteps } = await import('../src/schemas/stepTree.js');
const { DOC_LANGS, DOC_TAG } = await import('../src/schemas/docStep.schema.js');

const dir = path.resolve(import.meta.dirname, '..', 'templates', 'manual', 'scrapforai-console');
const read = (file: string) => JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as Record<string, any>;
const routineFiles = readdirSync(dir).filter((file) => file.endsWith('.routine.json'));

test('the target profile is valid and names the credential set the routines use', () => {
  const target = read('target.json');
  assert.ok(targetProfileSchema.safeParse(target).success);
  assert.equal(target.environment, 'dev', 'a manual is built against a development console, never a production one');
  for (const file of routineFiles) {
    const routine = read(file);
    assert.equal(routine.targetProfile, target.id);
    assert.ok(target.credentialSets.includes(routine.credentialSet));
  }
  assert.deepEqual(routineFiles, ['01-sign-in.routine.json', '02-screens.routine.json'], 'the chapter order is the id order');
});

for (const file of routineFiles) {
  test(`${file}: a valid, active, tagged routine with a caption in every language and no secret`, () => {
    const body = read(file);
    const parsed = mcpSaveRoutineSchema.safeParse({ id: file.replace('.routine.json', ''), ...body });
    assert.ok(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3)));
    assert.ok(body.tags.includes(DOC_TAG));
    assert.equal(body.status, 'active', 'only active routines are built into a manual');

    for (const lang of DOC_LANGS) {
      assert.ok(body.doc.title[lang] && body.doc.intro[lang], `the chapter heading and introduction exist in ${lang}`);
    }
    const documented = [...leafSteps(body.steps)].filter((step) => (step as { doc?: unknown }).doc !== undefined) as Array<Record<string, any>>;
    assert.ok(documented.length >= 4, 'a chapter with figures');
    for (const step of documented) {
      assert.ok(step.id, 'every documented step has an id');
      for (const lang of DOC_LANGS) assert.ok(step.doc.caption[lang], `step ${step.id} has a ${lang} caption`);
    }

    assert.deepEqual(lintRoutineSteps(body.steps, []), []);
    assert.deepEqual(lintRoutineDoc(body.doc, []), []);
    const lint = lintConventions({ steps: body.steps, teardown: body.teardown, tags: body.tags }, { platform: 'generic' });
    assert.deepEqual(lint.findings.map((finding) => `${finding.rule}@${finding.path}`), [], 'no convention warning (no fixed wait, no positional selector, tagged doc)');
  });

  test(`${file}: the API key comes from the vault, and the figure of that step is taken before it is typed`, () => {
    const body = read(file);
    for (const step of leafSteps([...body.steps, ...(body.teardown ?? [])]) as Iterable<Record<string, any>>) {
      if (step.action !== 'fill') continue;
      assert.equal(step.valueFromCredential, 'apiKey', `fill ${step.id} must come from the vault`);
      assert.equal(step.value, undefined);
      assert.notEqual(step.doc?.when, 'after', `the figure of ${step.id} must not be taken after the key is typed`);
    }
    // And the whole thing is runnable as a documentation run.
    const request = explorationRequestSchema.safeParse({ targetProfile: body.targetProfile, credentialSet: body.credentialSet, options: { docFigures: true }, steps: body.steps, teardown: body.teardown });
    assert.ok(request.success, request.success ? '' : JSON.stringify(request.error.issues.slice(0, 3)));
  });
}

test('the README says how to set the first client up and what its figures depend on', () => {
  const readme = readFileSync(path.join(dir, '..', 'README.md'), 'utf8');
  for (const needle of ['scrapforai-console', 'manual build', 'MANUAL_OUTPUT_DIR', 'POST /v1/credentials', 'setClock']) {
    assert.ok(readme.includes(needle), `the README mentions ${needle}`);
  }
});
