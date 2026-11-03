import assert from 'node:assert/strict';
import test from 'node:test';

// T4.1: structural diff by identity, with normalizers. Pure: no server, no browser.

const { structuralDiff, isEmptyChangeSet, countChanges } = await import('../src/diff/structuralDiff.js');
const { normalizeKey, compileDiffConfig, globToRegExp } = await import('../src/diff/normalizers.js');
const { diffConfigSchema } = await import('../src/schemas/diffConfig.schema.js');
const { targetProfileSchema } = await import('../src/schemas/targetProfile.schema.js');

const field = (key: string, extra: Record<string, unknown> = {}) => ({ key, label: key.toUpperCase(), type: 'text', required: false, ...extra });

test('reordering an array of identified objects is not a change', () => {
  const before = { fields: [field('name'), field('email'), field('phone')] };
  const after = { fields: [field('phone'), field('name'), field('email')] };
  assert.ok(isEmptyChangeSet(structuralDiff(before, after)));
});

test('added, removed and changed are told apart, with a readable text each', () => {
  const before = { title: 'Customer', fields: [field('name'), field('zip'), field('fax')] };
  const after = { title: 'Customer', fields: [field('name'), field('zip', { required: true }), field('phone', { label: 'Phone' })] };
  const changes = structuralDiff(before, after);

  assert.deepEqual(changes.added.map((c) => c.path), ['fields[key=phone]']);
  assert.deepEqual(changes.removed.map((c) => c.path), ['fields[key=fax]']);
  assert.deepEqual(changes.changed.map((c) => [c.path, c.before, c.after]), [['fields[key=zip].required', false, true]]);
  assert.equal(changes.added[0]!.summary, '+ fields[key=phone]: "Phone"');
  assert.equal(changes.removed[0]!.summary, '- fields[key=fax]: "FAX"');
  assert.equal(changes.changed[0]!.summary, '~ fields[key=zip].required: false -> true');
  assert.equal(countChanges(changes), 3);
  assert.equal(changes.truncated, false);
});

test('a declared identity key wins over the key/id/name fallbacks', () => {
  const before = { rows: [{ id: 1, code: 'A', v: 1 }, { id: 2, code: 'B', v: 1 }] };
  const after = { rows: [{ id: 1, code: 'B', v: 1 }, { id: 2, code: 'A', v: 1 }] };
  // By fallback (`id`) the codes changed places; by `code` nothing changed except the ids.
  assert.equal(structuralDiff(before, after).changed.length, 2);
  const byCode = structuralDiff(before, after, { config: { identityKeys: { rows: 'code' } } });
  assert.deepEqual(byCode.changed.map((c) => c.path), ['rows[code=A].id', 'rows[code=B].id']);
});

test('scalar arrays are a multiset: order is ignored, duplicates are not', () => {
  assert.ok(isEmptyChangeSet(structuralDiff({ options: ['SP', 'RJ', 'MG'] }, { options: ['MG', 'SP', 'RJ'] })));
  const changes = structuralDiff({ options: ['a', 'a', 'b'] }, { options: ['a', 'b', 'c'] });
  assert.deepEqual(changes.added.map((c) => c.path), ['options[="c"]']);
  assert.deepEqual(changes.removed.map((c) => c.path), ['options[="a"]']);
});

test('an array declared ordered, or with no identity, is compared by position', () => {
  const steps = structuralDiff({ steps: [{ t: 'a' }, { t: 'b' }] }, { steps: [{ t: 'b' }, { t: 'a' }] });
  assert.deepEqual(steps.changed.map((c) => c.path), ['steps[0].t', 'steps[1].t']);

  const ordered = structuralDiff({ wizard: ['one', 'two'] }, { wizard: ['two', 'one'] }, { config: { ordered: ['wizard'] } });
  assert.deepEqual(ordered.changed.map((c) => c.path), ['wizard[0]', 'wizard[1]']);
});

test('GeneXus grid rows: vNAME_0001 and vNAME_0002 are the same control, extra rows are told apart by order', () => {
  assert.equal(normalizeKey('vQTY_0001', compileDiffConfig()), 'vQTY');
  assert.equal(normalizeKey('vQTY_0012', compileDiffConfig()), 'vQTY');
  assert.equal(normalizeKey('vQTY_1', compileDiffConfig()), 'vQTY_1'); // not a four-digit row suffix

  const before = { fields: [{ key: 'vQTY_0001', type: 'number' }, { key: 'vQTY_0002', type: 'number' }] };
  const after = { fields: [{ key: 'vQTY_0001', type: 'number' }, { key: 'vQTY_0002', type: 'number' }, { key: 'vQTY_0003', type: 'number' }] };
  const changes = structuralDiff(before, after);
  assert.deepEqual(changes.added.map((c) => c.path), ['fields[key=vQTY#3]']);
  assert.equal(changes.removed.length + changes.changed.length, 0);

  // Same rows, different numbering (a new page of the grid): nothing changed.
  const renumbered = { fields: [{ key: 'vQTY_0011', type: 'number' }, { key: 'vQTY_0012', type: 'number' }] };
  assert.ok(isEmptyChangeSet(structuralDiff({ fields: before.fields.slice(0, 2) }, renumbered)));

  // Switched off in the profile: rows differ again.
  const off = structuralDiff({ fields: before.fields.slice(0, 2) }, renumbered, { config: { gridRowSuffix: false } });
  assert.equal(off.added.length, 2);
  assert.equal(off.removed.length, 2);
});

test('GeneXus web component prefix: W0012vNAME is vNAME, and the prefix alone or a lookalike is left as it is', () => {
  const normalizers = compileDiffConfig();
  assert.equal(normalizeKey('W0012vCUSTOMER', normalizers), 'vCUSTOMER');
  assert.equal(normalizeKey('W0012W0003vCUSTOMER', normalizers), 'vCUSTOMER');
  assert.equal(normalizeKey('#W0012vCUSTOMER', normalizers), '#vCUSTOMER');
  assert.equal(normalizeKey('W0012', normalizers), 'W0012');
  assert.equal(normalizeKey('Window', normalizers), 'Window');
  assert.equal(normalizeKey('W12vX', normalizers), 'W12vX');

  const before = { fields: [{ key: 'W0012vCUSTOMER', label: 'Customer' }] };
  const after = { fields: [{ key: 'W0034vCUSTOMER', label: 'Customer' }] };
  assert.ok(isEmptyChangeSet(structuralDiff(before, after)));
  assert.equal(structuralDiff(before, after, { config: { webComponentPrefix: false } }).added.length, 1);
});

test('key-like properties are normalized as controls; ordinary text only by the masks', () => {
  const before = { control: { selector: '#W0001vNAME_0001', label: 'W0001 stays' } };
  const after = { control: { selector: '#W0002vNAME_0007', label: 'W0002 stays' } };
  const changes = structuralDiff(before, after);
  assert.deepEqual(changes.changed.map((c) => c.path), ['control.label']);
});

test('mask patterns turn dynamic text into a constant', () => {
  const config = { maskPatterns: [{ pattern: '\\d{4}-\\d{2}-\\d{2}' }, { pattern: 'session [0-9a-f]{8}', flags: 'i', replacement: 'session' }] };
  const before = { title: 'Report 2026-11-01 (session AB12CD34)', fields: [{ key: 'f', label: 'Due 2026-11-01' }] };
  const after = { title: 'Report 2026-11-03 (session 00FF00FF)', fields: [{ key: 'f', label: 'Due 2027-01-15' }] };
  assert.ok(isEmptyChangeSet(structuralDiff(before, after, { config })));
  assert.equal(structuralDiff(before, { ...after, title: 'Other' }, { config }).changed.length, 1);
});

test('numeric tolerance: absolute and relative', () => {
  assert.equal(structuralDiff({ ms: 100 }, { ms: 104 }).changed.length, 1);
  assert.ok(isEmptyChangeSet(structuralDiff({ ms: 100 }, { ms: 104 }, { config: { numericTolerance: { absolute: 5 } } })));
  assert.equal(structuralDiff({ ms: 100 }, { ms: 106 }, { config: { numericTolerance: { absolute: 5 } } }).changed.length, 1);
  assert.ok(isEmptyChangeSet(structuralDiff({ ms: 1000 }, { ms: 1040 }, { config: { numericTolerance: { relative: 0.05 } } })));
  assert.equal(structuralDiff({ ms: 1000 }, { ms: 1100 }, { config: { numericTolerance: { relative: 0.05 } } }).changed.length, 1);
});

test('ignorePaths: generic and full paths, * within a segment, ** anywhere', () => {
  const before = { fields: [{ key: 'a', id: 'x1', maxLength: 10 }], meta: { renderedAt: '1', build: { n: 1 } } };
  const after = { fields: [{ key: 'a', id: 'x2', maxLength: 20 }], meta: { renderedAt: '2', build: { n: 2 } } };
  assert.equal(structuralDiff(before, after).changed.length, 4);
  const config = { ignorePaths: ['fields[].id', 'fields[key=a].maxLength', 'meta.**'] };
  assert.ok(isEmptyChangeSet(structuralDiff(before, after, { config })));
  assert.ok(globToRegExp('meta.*').test('meta.renderedAt'));
  assert.ok(!globToRegExp('meta.*').test('meta.build.n'));
  assert.ok(globToRegExp('meta.**').test('meta.build.n'));
  // regex metacharacters in a glob are literal
  assert.ok(!globToRegExp('fields[].id').test('fieldsX.id'));
});

test('type changes, null vs missing and added/removed properties', () => {
  const changes = structuralDiff({ a: 1, b: null, c: 'x', gone: true }, { a: '1', b: null, c: 'x', fresh: [] });
  assert.deepEqual(changes.changed.map((c) => c.path), ['a']);
  assert.deepEqual(changes.removed.map((c) => c.path), ['gone']);
  assert.deepEqual(changes.added.map((c) => c.path), ['fresh']);
  assert.ok(isEmptyChangeSet(structuralDiff({ x: null }, { x: null })));
  assert.equal(structuralDiff({ x: null }, {}).removed.length, 1);
});

test('nested arrays: grid columns inside a grid identified by key', () => {
  const before = { grids: [{ key: 'orders', columns: ['id', 'date', 'total'] }] };
  const after = { grids: [{ key: 'orders', columns: ['total', 'id', 'status'] }] };
  const changes = structuralDiff(before, after);
  assert.deepEqual(changes.added.map((c) => c.path), ['grids[key=orders].columns[="status"]']);
  assert.deepEqual(changes.removed.map((c) => c.path), ['grids[key=orders].columns[="date"]']);
});

test('deterministic: same input, same output, regardless of key or item order', () => {
  const a = { fields: [field('a'), field('b', { required: true })], z: 1, y: 2 };
  const b = { y: 3, z: 1, fields: [field('b'), field('a')] };
  const first = structuralDiff(a, b);
  const second = structuralDiff(structuredClone(a), structuredClone(b));
  assert.deepEqual(first, second);
  assert.deepEqual(first.changed.map((c) => c.path), ['fields[key=b].required', 'y']);
});

test('maxChanges truncates and says so; maxDepth compares deeper values as one opaque value', () => {
  const big = (n: number) => ({ fields: Array.from({ length: 50 }, (_, i) => ({ key: `f${i}`, v: n })) });
  const capped = structuralDiff(big(1), big(2), { maxChanges: 10 });
  assert.equal(countChanges(capped), 10);
  assert.equal(capped.truncated, true);

  const deep = structuralDiff({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } }, { maxDepth: 1 });
  assert.deepEqual(deep.changed.map((c) => c.path), ['a']);
});

test('prototype-ish keys are plain data', () => {
  const before = JSON.parse('{"__proto__":{"x":1},"constructor":1}');
  const after = JSON.parse('{"__proto__":{"x":2},"constructor":1}');
  const changes = structuralDiff(before, after);
  assert.deepEqual(changes.changed.map((c) => c.path), ['__proto__.x']);
  assert.equal(({} as Record<string, unknown>).x, undefined);
});

test('config validation: a bad regex, unknown keys and a bad flag are refused; a target profile accepts `diff`', () => {
  assert.equal(diffConfigSchema.safeParse({ maskPatterns: [{ pattern: '(' }] }).success, false);
  assert.equal(diffConfigSchema.safeParse({ maskPatterns: [{ pattern: 'a', flags: 'g' }] }).success, false);
  assert.equal(diffConfigSchema.safeParse({ surprise: true }).success, false);
  assert.equal(diffConfigSchema.safeParse({ numericTolerance: { relative: 2 } }).success, false);
  const parsed = diffConfigSchema.parse({});
  assert.equal(parsed.gridRowSuffix, true);
  assert.equal(parsed.webComponentPrefix, true);

  const profile = targetProfileSchema.safeParse({
    id: 'app-dev', name: 'App', environment: 'dev', baseUrl: 'https://dev.example.com',
    diff: { maskPatterns: [{ pattern: 'session \\d+' }], identityKeys: { fields: 'key' } },
  });
  assert.ok(profile.success, JSON.stringify(profile.error?.issues));
});

test('a huge string skips the user patterns (bounded cost) but is never truncated: a late difference is still seen', () => {
  const config = { maskPatterns: [{ pattern: '(a+)+$' }] }; // catastrophic on the wrong input
  const base = `${'a'.repeat(30)}!${'a'.repeat(100000)}`;
  const started = Date.now();
  const changes = structuralDiff({ t: base }, { t: `${base}b` }, { config });
  assert.equal(changes.changed.length, 1);
  assert.ok(Date.now() - started < 5000);
});
