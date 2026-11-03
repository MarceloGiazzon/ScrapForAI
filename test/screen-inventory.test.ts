import assert from 'node:assert/strict';
import test from 'node:test';

// T4.3, the pure half: key derivation, radio groups, grid rows, determinism and the diff of two inventories.

const { deriveScreenInventory } = await import('../src/inventory/deriveInventory.js');
const { diffInventories } = await import('../src/inventory/diffInventory.js');
const { isEmptyChangeSet } = await import('../src/diff/structuralDiff.js');
const { screenInventorySchema } = await import('../src/schemas/screenInventory.schema.js');

const field = (extra: Record<string, unknown>) => ({ type: 'text', required: false, enabled: true, visible: true, ...extra });
const structure = (over: Record<string, unknown> = {}) => ({
  fields: [
    field({ id: 'cust-name', name: 'name', label: 'Name', required: true, maxLength: 80 }),
    field({ id: 'cust-zip', label: 'Zip' }),
    field({ type: 'select', name: 'state', label: 'State', options: ['SP', 'RJ'] }),
    field({ label: 'Free text only' }),
  ],
  actions: [
    { id: 'save', label: 'Save', enabled: true, visible: true },
    { label: 'Help', enabled: true, visible: true },
  ],
  tables: [{ id: 'orders', columns: ['Id', 'Date', ''] }],
  ...over,
});

test('keys: name, else id, else a label slug; sorted, validated, columns without empty headers', () => {
  const inventory = deriveScreenInventory(structure(), { screenId: 'customer', title: 'Customer' });
  assert.ok(screenInventorySchema.safeParse(inventory).success);
  assert.deepEqual(inventory.fields.map((f) => f.key), ['cust-zip', 'field:free-text-only', 'name', 'state']);
  assert.deepEqual(inventory.actions.map((a) => a.key), ['action:help', 'save']);
  assert.deepEqual(inventory.grids, [{ key: 'orders', columns: ['Id', 'Date'] }]);
  assert.equal(inventory.fields.find((f) => f.key === 'name')!.maxLength, 80);
  assert.deepEqual(inventory.fields.find((f) => f.key === 'state')!.options, ['SP', 'RJ']);
  assert.equal(inventory.unkeyed, 0);
});

test('controls with nothing to build a key from are counted, not listed', () => {
  const inventory = deriveScreenInventory(
    structure({ fields: [field({}), field({ id: 'a' })], actions: [{ enabled: true, visible: true }], tables: [{ columns: ['x'] }] }),
    { screenId: 's' },
  );
  assert.equal(inventory.fields.length, 1);
  assert.equal(inventory.unkeyed, 3);
});

test('GeneXus names: web component prefix and grid row suffix are normalized; repeated rows keep document order', () => {
  const inventory = deriveScreenInventory(
    structure({
      fields: [
        field({ name: 'W0012vCUSTOMER' }),
        field({ name: 'vQTY_0001', type: 'number' }),
        field({ name: 'vQTY_0002', type: 'number' }),
      ],
      actions: [],
      tables: [],
    }),
    { screenId: 's' },
  );
  assert.deepEqual(inventory.fields.map((f) => f.key), ['vCUSTOMER', 'vQTY', 'vQTY#2']);
});

test('a radio group is one field, required/enabled/visible if any member is', () => {
  const inventory = deriveScreenInventory(
    structure({
      fields: [
        field({ type: 'radio', name: 'kind', label: 'Kind', enabled: false, visible: false }),
        field({ type: 'radio', name: 'kind', required: true }),
        field({ type: 'text', name: 'kind' }), // a different control that reuses the name is NOT merged
      ],
      actions: [],
      tables: [],
    }),
    { screenId: 's' },
  );
  assert.deepEqual(inventory.fields.map((f) => [f.key, f.type, f.required, f.enabled, f.visible]), [
    ['kind', 'radio', true, true, true],
    ['kind#2', 'text', false, true, true],
  ]);
});

test('visibleOnly drops what the user cannot see', () => {
  const hidden = structure({ fields: [field({ name: 'a' }), field({ name: 'b', visible: false })], actions: [], tables: [] });
  assert.equal(deriveScreenInventory(hidden, { screenId: 's' }).fields.length, 2);
  assert.equal(deriveScreenInventory(hidden, { screenId: 's', visibleOnly: true }).fields.length, 1);
});

test('same structure in another order gives the same inventory; a different screenId is refused', () => {
  const a = structure();
  const b = structure({ fields: [...a.fields].reverse(), actions: [...a.actions].reverse() });
  assert.deepEqual(deriveScreenInventory(a, { screenId: 's' }), deriveScreenInventory(b, { screenId: 's' }));
  assert.throws(() => deriveScreenInventory(a, { screenId: 'bad id!' }));
});

test('diffInventories: moved is not a change; required, new action and new column are', () => {
  const before = deriveScreenInventory(structure(), { screenId: 'customer' });
  const reordered = deriveScreenInventory(structure({ fields: [...structure().fields].reverse() }), { screenId: 'customer' });
  assert.ok(isEmptyChangeSet(diffInventories(before, reordered)));

  const after = deriveScreenInventory(
    structure({
      fields: structure().fields.map((f) => (f.id === 'cust-zip' ? { ...f, required: true } : f)),
      actions: [...structure().actions, { id: 'export', label: 'Export', enabled: true, visible: true }],
      tables: [{ id: 'orders', columns: ['Id', 'Date', 'Total'] }],
    }),
    { screenId: 'customer' },
  );
  const changes = diffInventories(before, after);
  assert.deepEqual(changes.changed.map((c) => c.path), ['fields[key=cust-zip].required']);
  assert.deepEqual(changes.added.map((c) => c.path), ['actions[key=export]', 'grids[key=orders].columns[="Total"]']);
  assert.equal(changes.removed.length, 0);
});

test('the profile diff config applies on top of the inventory identities', () => {
  const before = deriveScreenInventory(structure(), { screenId: 'customer' });
  const after = deriveScreenInventory(
    structure({ fields: structure().fields.map((f) => (f.name === 'name' ? { ...f, maxLength: 200 } : f)) }),
    { screenId: 'customer' },
  );
  assert.equal(diffInventories(before, after).changed.length, 1);
  assert.ok(isEmptyChangeSet(diffInventories(before, after, { config: { ignorePaths: ['fields[].maxLength'] } })));
});
