import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// The UI is served under a CSP with no inline script or style (src/server.ts), so a page that breaks that
// rule would silently do nothing. These checks guard the Vault screen without needing a browser.
const publicDir = path.resolve(import.meta.dirname, '..', 'public');
const read = (name: string) => fs.readFileSync(path.join(publicDir, name), 'utf8');

test('vault page: external module script only, no inline script/style/handlers', () => {
  const html = read('vault.html');
  assert.match(html, /<script type="module" src="vault\.js"><\/script>/);
  assert.equal((html.match(/<script/g) ?? []).length, 1);
  assert.ok(!/<style|style=|\son[a-z]+=/i.test(html));
});

test('every UI page links to the vault screen', () => {
  for (const page of ['index.html', 'config.html', 'status.html', 'vault.html']) {
    assert.match(read(page), /<a href="vault\.html">Vault<\/a>/, page);
  }
});

test('vault.js builds the DOM with textContent only (no innerHTML) and validates job ids before linking', () => {
  const script = read('vault.js');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(script));
  assert.match(script, /JOB_ID = \/\^job_\[A-Za-z0-9_-\]\{1,64\}\$\//);
  assert.match(script, /rel: 'noopener'/);
});

test('the vault screen only calls endpoints a cookie session may use (no bearer-only write)', () => {
  const script = read('vault.js');
  const calls = [...script.matchAll(/apiFetch\(\s*[`'"]([^`'"]+)/g)].map((m) => m[1]!);
  assert.ok(calls.length >= 4);
  for (const call of calls) {
    assert.ok(!/add-from-run|confirm-green|credentials|\/pin/.test(call), call);
  }
});
