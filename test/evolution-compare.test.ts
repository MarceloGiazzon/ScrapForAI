import assert from 'node:assert/strict';
import test from 'node:test';

// T4.5 / T4.7, the pure half: two snapshots -> per-screen diff -> classified against declared changes -> CHANGES.md text.

process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';

const { diffSnapshots, renderChangesMarkdown, renderChangesFile } = await import('../src/evolution/compare.js');
const { expectedChangesSchema } = await import('../src/schemas/expectedChanges.schema.js');
const { screenInventorySchema } = await import('../src/schemas/screenInventory.schema.js');

type View = Parameters<typeof diffSnapshots>[0];

const inventory = (screenId: string, over: Record<string, unknown> = {}) =>
  screenInventorySchema.parse({
    screenId,
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true, enabled: true, visible: true, maxLength: 80 },
      { key: 'zip', label: 'Zip', type: 'text', required: false, enabled: true, visible: true },
      { key: 'state', label: 'State', type: 'select', required: false, enabled: true, visible: true, options: ['SP', 'RJ'] },
    ],
    actions: [{ key: 'save', label: 'Save', enabled: true }, { key: 'export', label: 'Export', enabled: true }],
    grids: [{ key: 'orders', columns: ['Id', 'Date'] }],
    ...over,
  });

const view = (buildId: string, inventories: Record<string, unknown>, extra: Partial<View> = {}): View => ({
  buildId,
  createdAt: `2026-11-0${buildId.endsWith('1') ? 1 : 2}T08:00:00.000Z`,
  complete: true,
  inventories: new Map(Object.entries(inventories) as never),
  notCaptured: new Map(),
  names: new Map([['customers', 'Customers'], ['orders', 'Orders'], ['admin', 'Admin']]),
  ...extra,
});

const revised = () =>
  inventory('customers', {
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true, enabled: true, visible: true, maxLength: 80 },
      { key: 'zip', label: 'Zip', type: 'text', required: true, enabled: true, visible: true },
      { key: 'phone', label: 'Phone', type: 'text', required: false, enabled: true, visible: true },
      { key: 'state', label: 'State', type: 'select', required: false, enabled: true, visible: true, options: ['SP', 'RJ', 'MG'] },
    ],
    actions: [{ key: 'save', label: 'Save', enabled: true }],
    grids: [{ key: 'orders', columns: ['Id', 'Date', 'Total'] }],
  });

test('a screen diff in plain words: added field, removed action, now required, new option, new column', () => {
  const diff = diffSnapshots(view('rev1', { customers: inventory('customers') }), view('rev2', { customers: revised() }));
  const [screen] = diff.screens;
  assert.equal(screen!.status, 'changed');
  const texts = screen!.changes.map((c) => c.text);
  assert.ok(texts.includes('+ field Phone (phone) (text, optional)'));
  assert.ok(texts.includes('- action Export (export)'));
  assert.ok(texts.includes('~ field Zip (zip) is now required'));
  assert.ok(texts.includes('+ option "MG" in field State (state)'));
  assert.ok(texts.includes('+ column "Total" in grid orders'));
  assert.equal(diff.classified, false);
  assert.equal(diff.counts.changes, 5);
  assert.ok(screen!.changes.every((c) => c.classification === undefined), 'nothing declared, nothing classified');
});

test('an unchanged screen is unchanged; reordering is not a change', () => {
  const reordered = inventory('customers', { fields: [...inventory('customers').fields].reverse(), actions: [...inventory('customers').actions].reverse() });
  const diff = diffSnapshots(view('rev1', { customers: inventory('customers') }), view('rev2', { customers: reordered }));
  assert.equal(diff.screens[0]!.status, 'unchanged');
  assert.equal(diff.counts.changes, 0);
  assert.match(renderChangesMarkdown(diff, 'app'), /No structural change between these two snapshots\./);
});

test('screens that appear or disappear; one that failed to capture is unknown, never "removed"', () => {
  const before = view('rev1', { customers: inventory('customers'), admin: inventory('admin') });
  const after = view('rev2', { customers: inventory('customers'), orders: inventory('orders') }, { notCaptured: new Map([['admin', 'LoginFailed: nope']]), complete: false });
  const diff = diffSnapshots(before, after);
  const byId = Object.fromEntries(diff.screens.map((s) => [s.id, s]));
  assert.equal(byId.orders!.status, 'added');
  assert.equal(byId.admin!.status, 'unknown');
  assert.match(byId.admin!.reason!, /not captured in build rev2: LoginFailed: nope/);
  assert.equal(byId.customers!.status, 'unchanged');
  assert.deepEqual([diff.counts.screensAdded, diff.counts.screensRemoved, diff.counts.screensUnknown], [1, 0, 1]);

  const gone = diffSnapshots(view('rev1', { admin: inventory('admin') }), view('rev2', {}));
  assert.equal(gone.screens[0]!.status, 'removed');
  const bothMissing = diffSnapshots(view('rev1', {}, { notCaptured: new Map([['admin', 'x']]) }), view('rev2', {}, { notCaptured: new Map([['admin', 'y']]) }));
  assert.equal(bothMissing.screens[0]!.status, 'unknown');
});

test('expected vs unexpected: entries cover by screen, kind and path; the rest is unexpected', () => {
  const expected = expectedChangesSchema.parse({
    buildId: 'rev2',
    expected: [
      { screen: 'customers', kind: 'added', path: 'fields[key=phone]', ref: 'REG-301' },
      { screen: 'customers', kind: 'changed', path: 'fields[key=zip].*', note: 'zip is mandatory now' },
      { screen: '*', path: 'grids[key=orders].columns**', ref: 'REG-302' },
    ],
  });
  const diff = diffSnapshots(view('rev1', { customers: inventory('customers') }), view('rev2', { customers: revised() }), { expected });
  assert.equal(diff.classified, true);
  const status = Object.fromEntries(diff.screens[0]!.changes.map((c) => [c.path, [c.classification, c.coveredBy]]));
  assert.deepEqual(status['fields[key=phone]'], ['expected', 'REG-301']);
  assert.deepEqual(status['fields[key=zip].required'], ['expected', 'zip is mandatory now']);
  assert.deepEqual(status['grids[key=orders].columns[="Total"]'], ['expected', 'REG-302']);
  assert.deepEqual(status['actions[key=export]'], ['unexpected', undefined], 'the removed Export button was not declared');
  assert.deepEqual(status['fields[key=state].options[="MG"]'], ['unexpected', undefined]);
  assert.deepEqual([diff.counts.expected, diff.counts.unexpected], [3, 2]);
});

test('kind semantics: "changed" with no path covers everything inside the screen, "added" only additions; whole-screen entries need no path', () => {
  const view1 = view('rev1', { customers: inventory('customers') });
  const view2 = view('rev2', { customers: revised() });
  const all = diffSnapshots(view1, view2, { expected: expectedChangesSchema.parse({ buildId: 'rev2', expected: [{ screen: 'customers', kind: 'changed' }] }) });
  assert.equal(all.counts.unexpected, 0);
  const onlyAdds = diffSnapshots(view1, view2, { expected: expectedChangesSchema.parse({ buildId: 'rev2', expected: [{ screen: 'customers', kind: 'added' }] }) });
  assert.deepEqual(onlyAdds.screens[0]!.changes.filter((c) => c.classification === 'unexpected').map((c) => c.kind).sort(), ['changed', 'removed']);
  const wrongScreen = diffSnapshots(view1, view2, { expected: expectedChangesSchema.parse({ buildId: 'rev2', expected: [{ screen: 'orders' }] }) });
  assert.equal(wrongScreen.counts.expected, 0);

  const appeared = diffSnapshots(view('rev1', {}), view('rev2', { orders: inventory('orders') }), { expected: expectedChangesSchema.parse({ buildId: 'rev2', expected: [{ screen: 'orders', kind: 'added', ref: 'REG-9' }] }) });
  assert.deepEqual([appeared.screens[0]!.classification, appeared.screens[0]!.coveredBy], ['expected', 'REG-9']);
  const unplanned = diffSnapshots(view('rev1', { admin: inventory('admin') }), view('rev2', {}), { expected: expectedChangesSchema.parse({ buildId: 'rev2', expected: [] }) });
  assert.equal(unplanned.screens[0]!.classification, 'unexpected');
  assert.equal(unplanned.counts.unexpected, 1);
});

test('CHANGES.md: deterministic, says what changed and what was not expected; the narrative is labelled and never mixed in', () => {
  const expected = expectedChangesSchema.parse({ buildId: 'rev2', expected: [{ screen: 'customers', kind: 'added', path: 'fields[key=phone]', ref: 'REG-301' }] });
  const diff = diffSnapshots(view('rev1', { customers: inventory('customers') }), view('rev2', { customers: revised() }), { expected });
  const text = renderChangesMarkdown(diff, 'app');
  assert.match(text, /^# Changes in app: rev1 -> rev2$/m);
  assert.match(text, /Summary: 1 screen\(s\) changed, 0 added, 0 removed, 5 change\(s\), 1 expected, 4 unexpected\./);
  assert.match(text, /^## Screen Customers$/m);
  assert.match(text, /^- \+ field Phone \(phone\) \(text, optional\)  \(expected: REG-301\)$/m);
  assert.match(text, /^- - action Export \(export\)  \*\*UNEXPECTED\*\*$/m);
  assert.equal(renderChangesMarkdown(diff, 'app'), text, 'same input, same text');
  assert.ok(!/AI-generated/.test(renderChangesFile(diff, 'app')));
  assert.ok(!/AI-generated/.test(renderChangesFile(diff, 'app', '   ')));

  const withNarrative = renderChangesFile(diff, 'app', 'Customers got a phone field.');
  assert.ok(withNarrative.startsWith(text.trimEnd()), 'the deterministic part comes first and is untouched');
  assert.match(withNarrative, /## Narrative \(AI-generated summary, not verified\)\n\nCustomers got a phone field\.\n$/);
});

test('expected-changes schema: strict, bounded, kind defaults to any', () => {
  assert.equal(expectedChangesSchema.parse({ buildId: 'rev2', expected: [{ screen: 'x' }] }).expected[0]!.kind, '*');
  assert.equal(expectedChangesSchema.safeParse({ buildId: 'rev2', expected: [{ screen: 'x', surprise: 1 }] }).success, false);
  assert.equal(expectedChangesSchema.safeParse({ buildId: 'rev2', expected: [{ screen: 'x', kind: 'moved' }] }).success, false);
  assert.equal(expectedChangesSchema.safeParse({ buildId: 'bad id!', expected: [] }).success, false);
});
