import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// The UI is served under a CSP with no inline script or style (src/server.ts). These checks guard the Team screen (T10.1) without a browser.
const publicDir = path.resolve(import.meta.dirname, '..', 'public');
const read = (name: string) => fs.readFileSync(path.join(publicDir, name), 'utf8');

test('team page: external module script only, no inline script/style/handlers', () => {
  const html = read('team.html');
  assert.match(html, /<script type="module" src="team\.js"><\/script>/);
  assert.equal((html.match(/<script/g) ?? []).length, 1);
  assert.ok(!/<style|style=|\son[a-z]+=/i.test(html));
});

test('every UI page (but the login) links to the team screen', () => {
  for (const page of ['index.html', 'config.html', 'status.html', 'vault.html', 'performance.html', 'health.html', 'executive.html', 'team.html']) {
    assert.match(read(page), /<a href="team\.html">Team<\/a>/, page);
  }
});

test('team.js: DOM built with textContent only, no style attribute, classes from fixed words', () => {
  const script = read('team.js');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(script));
  assert.ok(!/\.style\b|setAttribute\(\s*['"]style|'style'/.test(script), 'a style attribute would be blocked by the CSP');
  assert.ok(!/class:\s*`[^`]*\$\{/.test(script));
  assert.ok(!/className\s*=/.test(script));
});

test('team.js: the admin key lives in a variable only (no storage, no cookie, no URL) and every change sends it as a Bearer token', () => {
  const script = read('team.js');
  const keyModule = read('adminKey.js');
  for (const source of [script, keyModule]) {
    assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie|location\.(search|hash)/.test(source));
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\.style\b|className\s*=/.test(source));
  }
  // Reads go with the session; every write goes through change() (adminKey.js), which sends the key.
  assert.match(script, /import \{ setupAdminKey \} from '\.\/adminKey\.js'/);
  assert.match(script, /const \{ change \} = setupAdminKey\(/);
  assert.ok(!/bearer/.test(script), 'team.js never builds a Bearer request itself');
  const writes = [...script.matchAll(/method:\s*['"](POST|PUT|PATCH|DELETE)/gi)];
  assert.equal(writes.length, 0, 'a write outside change() would go with the session alone');
  assert.match(keyModule, /apiFetch\(pathname, \{ method, bearer: adminKey/);
  assert.match(keyModule, /window\.addEventListener\('pagehide', forgetKey\)/);
  const changes = [...script.matchAll(/change\(\s*['"](POST|PATCH|DELETE)['"],\s*([`'"][^`'"]+)/g)].map((m) => `${m[1]} ${m[2]!.slice(1).replace(/\$\{[^}]*\}/g, ':x')}`);
  assert.deepEqual(
    [...new Set(changes)].sort(),
    ['DELETE /v1/team/users/:x', 'DELETE /v1/team/users/:x/keys/:x', 'PATCH /v1/team/users/:x', 'POST /v1/team/users', 'POST /v1/team/users/:x/keys'].sort(),
  );
  // Only /v1/team and /v1/audit (plus who am I) are ever called.
  const calls = [...script.matchAll(/apiFetch\(\s*[`'"]([^`'"?]+)/g)].map((m) => m[1]!.replace(/\$\{[^}]*\}/g, ':x'));
  for (const call of calls) assert.match(call, /^\/v1\/(team|audit|auth\/me)/, call);
});

test('api.js: a typed Bearer key does not bounce to the sign-in page on a 401, and is never put in the URL', () => {
  const api = read('api.js');
  assert.match(api, /response\.status === 401 && !bearer/);
  assert.match(api, /headers\.set\('Authorization', `Bearer \$\{bearer\}`\)/);
});

test('the stylesheet has the classes the team screen uses', () => {
  const css = read('app.css');
  for (const name of ['badge\\.warn', 'badge\\.neutral', 'warn-banner', 'danger-banner', 'reasons', 'row', 'pager', 'filters']) assert.match(css, new RegExp(`\\.${name}\\b`), name);
});
