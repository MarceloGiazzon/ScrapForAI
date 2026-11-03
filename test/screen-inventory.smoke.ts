import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

// T4.3 end to end with a real Chromium: inspect_dom with includeStructure -> inventory. The page is full of
// values (typed, preselected, in cells, inside labels) and NONE of them may reach the inventory.

const SECRETS = ['123-45-6789', 'Ada Lovelace', 'typed-in-textarea', 'cell-secret-4242', 'Selected Customer Name', 'wrapped-value-77'];

const page = `<!doctype html><html><head><title>Customer</title></head><body>
<form id="f">
  <label for="cust-name">Name</label><input id="cust-name" name="name" maxlength="80" required value="Ada Lovelace">
  <label for="ssn">Document</label><input id="ssn" name="ssn" value="123-45-6789">
  <label>Notes <textarea name="notes">typed-in-textarea</textarea></label>
  <label>Wrapped <input name="wrapped" value="wrapped-value-77"></label>
  <label for="state">State</label>
  <select id="state" name="state"><option>SP</option><option selected>RJ</option></select>
  <label for="customer">Customer</label>
  <select id="customer" name="customer">${Array.from({ length: 150 }, (_, i) => `<option>${i === 7 ? 'Selected Customer Name' : `Customer ${i}`}</option>`).join('')}</select>
  <input type="radio" name="kind" value="a" id="ka"><label for="ka">A</label>
  <input type="radio" name="kind" value="b" id="kb" checked><label for="kb">B</label>
  <input type="hidden" name="token" value="hidden-token-value">
  <input name="vQTY_0001"><input name="vQTY_0002">
  <input type="password" name="pwd" aria-label="Password" value="pw-should-not-appear">
  <button id="save" type="submit">Save</button>
  <input type="button" id="cancel" value="Cancel" disabled>
  <a href="/help">Help</a>
</form>
<table id="orders"><thead><tr><th>Id</th><th>Date</th><th>Total</th></tr></thead><tbody><tr><td>cell-secret-4242</td><td>2026-01-01</td><td>10</td></tr></tbody></table>
<table id="layout"><tr><td>layout only</td></tr></table>
</body></html>`;

test('inspect_dom structure -> inventory: structure is complete and no value leaks', async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(page);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  process.env.SCRAPFORAI_API_KEY = process.env.SCRAPFORAI_API_KEY ?? 'test-key-1234567890';
  process.env.ALLOWED_TARGET_ORIGINS = origin;
  process.env.ALLOWED_RESOURCE_ORIGINS = origin;

  const { inspectDom } = await import('../src/runner/inspectDom.js');
  const { deriveScreenInventory } = await import('../src/inventory/deriveInventory.js');
  try {
    const result = await inspectDom({
      targetUrl: `${origin}/`,
      waitUntil: 'load',
      timeoutMs: 10000,
      includeRenderedHtml: false,
      includeHiddenControls: true,
      includeStructure: true,
      includeConsole: false,
      includeNetwork: false,
      redactSensitiveValues: true,
    });
    assert.equal(result.status, 'passed', JSON.stringify(result.error));
    assert.ok(result.structure, 'structure requested, structure returned');

    const inventory = deriveScreenInventory(result.structure, { screenId: 'customer', title: result.title });
    const serialized = JSON.stringify([result.structure, inventory]);
    for (const secret of SECRETS) assert.ok(!serialized.includes(secret), `value leaked into the structure/inventory: ${secret}`);
    assert.ok(!serialized.includes('hidden-token-value'));
    assert.ok(!serialized.includes('pw-should-not-appear'));

    const byKey = new Map(inventory.fields.map((f) => [f.key, f]));
    assert.deepEqual(
      [...byKey.keys()].sort(),
      ['customer', 'kind', 'name', 'notes', 'pwd', 'ssn', 'state', 'vQTY', 'vQTY#2', 'wrapped'],
      'hidden input excluded, radio group merged, grid-like names normalized',
    );
    const name = byKey.get('name')!;
    assert.deepEqual([name.label, name.required, name.maxLength, name.type], ['Name', true, 80, 'text']);
    assert.equal(byKey.get('notes')!.label, 'Notes', 'a wrapping label contributes its own text only, not the textarea content');
    assert.equal(byKey.get('wrapped')!.label, 'Wrapped');
    assert.deepEqual(byKey.get('state')!.options, ['SP', 'RJ']);
    assert.equal(byKey.get('customer')!.options, undefined, 'a 150-option select is data, not structure');
    assert.equal(byKey.get('kind')!.type, 'radio');
    assert.equal(byKey.get('pwd')!.label, 'Password');

    const actions = new Map(inventory.actions.map((a) => [a.key, a]));
    assert.equal(actions.get('save')!.label, 'Save');
    assert.equal(actions.get('cancel')!.enabled, false);
    assert.equal(actions.get('cancel')!.label, 'Cancel');
    assert.ok([...actions.values()].some((a) => a.label === 'Help'));

    assert.deepEqual(inventory.grids, [{ key: 'orders', columns: ['Id', 'Date', 'Total'] }], 'the layout table is not a grid');
    assert.equal(inventory.title, 'Customer');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
