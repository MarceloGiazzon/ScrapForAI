import assert from 'node:assert/strict';
import test from 'node:test';

// T3.1, the pure half: turning what the app reports into a valid build id, and reading a JSON path.

process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';
process.env.ALLOWED_RESOURCE_ORIGINS = 'https://dev.example.com';

const { sanitizeBuildId, readJsonPath } = await import('../src/runner/buildProbe.js');
const { buildIdSchema } = await import('../src/schemas/explorationRequest.schema.js');

test('sanitizeBuildId: always something buildIdSchema accepts, or undefined', () => {
  assert.equal(sanitizeBuildId('  rev 4519 (rc1)  '), 'rev_4519_rc1');
  assert.equal(sanitizeBuildId('2026.11/rc1+sha.ab12'), '2026.11/rc1+sha.ab12');
  assert.equal(sanitizeBuildId(4519), '4519');
  assert.equal(sanitizeBuildId('   '), undefined);
  assert.equal(sanitizeBuildId('()<>'), undefined);
  assert.equal(sanitizeBuildId({ a: 1 }), undefined);
  assert.equal(sanitizeBuildId(undefined), undefined);
  const long = sanitizeBuildId('x'.repeat(500))!;
  assert.equal(long.length, 100);
  for (const raw of ['v 1.2', 'ü?§ build', '<script>alert(1)</script>', 'a\nb']) {
    const value = sanitizeBuildId(raw);
    if (value !== undefined) assert.ok(buildIdSchema.safeParse(value).success, `${JSON.stringify(raw)} -> ${value}`);
  }
});

test('readJsonPath: dotted paths, array indexes and a leading $; anything else is undefined (including prototype keys)', () => {
  const doc = { version: '1.2.3', app: { releases: [{ id: 'a' }, { id: 'b' }] }, n: 0 };
  assert.equal(readJsonPath(doc, 'version'), '1.2.3');
  assert.equal(readJsonPath(doc, '$.app.releases[1].id'), 'b');
  assert.equal(readJsonPath(doc, 'app.releases.0.id'), 'a');
  assert.equal(readJsonPath(doc, 'n'), 0);
  assert.equal(readJsonPath(doc, 'app.nothing'), undefined);
  assert.equal(readJsonPath(doc, 'app.releases[9].id'), undefined);
  assert.equal(readJsonPath(doc, 'version.length'), undefined, 'a string is not walked into');
  assert.equal(readJsonPath(doc, 'app.releases.length'), undefined, 'array properties are not reachable');
  assert.equal(readJsonPath(doc, '__proto__.x'), undefined);
  assert.equal(readJsonPath(doc, 'constructor.name'), undefined);
  assert.equal(readJsonPath(null, 'a'), undefined);
  assert.equal(readJsonPath({ 'npdev.builtAt': 'T1', 'npdev.version': '0.2.0' }, 'npdev.builtAt'), 'T1', 'a key with a dot in its name (actuator/info)');
  assert.equal(readJsonPath({ a: { 'b.c': 5 } }, 'a.b.c'), 5);
  assert.equal(readJsonPath({ a: { b: { c: 1 } }, 'a.b': { c: 2 } }, 'a.b.c'), 1, 'the nested reading wins over a dotted key');
});
