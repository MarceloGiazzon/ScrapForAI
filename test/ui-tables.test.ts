import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// The UI is served under a CSP with no inline script or style (src/server.ts). These checks guard the Tables screen without a browser;
// test/tables-ui.smoke.ts runs it in Chromium against the real server.
const publicDir = path.resolve(import.meta.dirname, '..', 'public');
const read = (name: string) => fs.readFileSync(path.join(publicDir, name), 'utf8');

test('tables page: external module script only, no inline script/style/handlers, every id the script uses exists', () => {
  const html = read('tables.html');
  assert.match(html, /<script type="module" src="tables\.js"><\/script>/);
  assert.equal((html.match(/<script/g) ?? []).length, 1);
  assert.ok(!/<style|style=|\son[a-z]+=/i.test(html));
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]!));
  for (const match of read('tables.js').matchAll(/byId\(\s*(['"])([a-z0-9-]+)\1\s*\)/g)) assert.ok(ids.has(match[2]!), `tables.js looks for #${match[2]} which the page does not have`);
});

test('every UI page (but the login) links to the tables screen', () => {
  for (const page of ['index.html', 'config.html', 'status.html', 'vault.html', 'performance.html', 'health.html', 'executive.html', 'timeline.html', 'team.html', 'credentials.html', 'automation.html', 'tables.html']) {
    assert.match(read(page), /<a href="tables\.html">Tables<\/a>/, page);
  }
});

test('tables.js: DOM built with textContent only, no style attribute, classes from fixed words, nothing in storage, no logging', () => {
  const script = read('tables.js');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(script));
  assert.ok(!/\.style\b|setAttribute\(\s*['"]style|'style'/.test(script), 'a style attribute would be blocked by the CSP');
  assert.ok(!/class:\s*`[^`]*\$\{/.test(script));
  assert.ok(!/className\s*=/.test(script));
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie|location\.(search|hash)/.test(script));
  assert.ok(!/console\.|debugger/.test(script));
});

test('tables.js: one write, a PUT of the table to its own route, with the session (the API takes no admin key for test data); reads are the list and the table', () => {
  const script = read('tables.js');
  assert.ok(!/bearer/.test(script), 'a table is not a secret: no admin key is involved');
  assert.deepEqual([...script.matchAll(/method:\s*['"]([A-Z]+)/g)].map((match) => match[1]), ['PUT']);
  assert.match(script, /apiFetch\(tablePath\(id\), \{ method: 'PUT', body: JSON\.stringify\(\{ csv/);
  const reads = [...script.matchAll(/apiFetch\(\s*[`'"]([^`'"?]+)/g)].map((match) => match[1]!);
  assert.deepEqual([...new Set(reads)].sort(), ['/v1/auth/me', '/v1/tables']);
  assert.match(script, /const tablePath = \(id, query = ''\) => `\/v1\/tables\/\$\{encodeURIComponent\(id\)\}\$\{query\}`;/, 'the id is encoded before it is in a URL');
});

test('the role rule of the screen is the server\'s: a viewer reads, a runner or an admin saves', () => {
  const script = read('tables.js');
  assert.match(script, /canWrite = who\.role === 'runner' \|\| who\.role === 'admin'/);
  // roles.ts: a PUT is "any other method" = runner; /v1/tables is not an admin area. If that changes, the screen must follow.
  const roles = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'team', 'roles.ts'), 'utf8');
  assert.ok(!/\/v1\/tables/.test(roles), 'tables are not an admin-only area in roles.ts');
  const route = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'routes', 'tables.routes.ts'), 'utf8');
  assert.ok(!/requireBearer/.test(route), 'the tables routes take no admin key');
});

test('the stylesheet has the classes the tables screen uses', () => {
  const css = read('app.css');
  for (const name of ['field', 'badge\\.neutral', 'warn-banner', 'danger-banner', 'login-error', 'filters', 'compact']) assert.match(css, new RegExp(`\\.${name}\\b`), name);
  assert.match(read('tables.html'), /<table class="compact">/);
});
