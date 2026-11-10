import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// The UI is served under a CSP with no inline script or style (src/server.ts). These checks guard the Credentials screen without a browser;
// test/credentials-ui.smoke.ts runs it in Chromium against the real server.
const publicDir = path.resolve(import.meta.dirname, '..', 'public');
const read = (name: string) => fs.readFileSync(path.join(publicDir, name), 'utf8');

test('credentials page: external module script only, no inline script/style/handlers', () => {
  const html = read('credentials.html');
  assert.match(html, /<script type="module" src="credentials\.js"><\/script>/);
  assert.equal((html.match(/<script/g) ?? []).length, 1);
  assert.ok(!/<style|style=|\son[a-z]+=/i.test(html));
});

test('every UI page (but the login) links to the credentials screen', () => {
  for (const page of ['index.html', 'config.html', 'status.html', 'vault.html', 'performance.html', 'health.html', 'executive.html', 'timeline.html', 'team.html', 'credentials.html']) {
    assert.match(read(page), /<a href="credentials\.html">Credentials<\/a>/, page);
  }
});

test('credentials.js: DOM built with textContent only, no style attribute, classes from fixed words', () => {
  const script = read('credentials.js');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(script));
  assert.ok(!/\.style\b|setAttribute\(\s*['"]style|'style'/.test(script), 'a style attribute would be blocked by the CSP');
  assert.ok(!/class:\s*`[^`]*\$\{/.test(script));
  assert.ok(!/className\s*=/.test(script));
});

test('credentials.js: a secret never reaches storage, the URL, a log line or a cookie', () => {
  for (const name of ['credentials.js', 'adminKey.js']) {
    const source = read(name);
    assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie|location\.(search|hash)/.test(source), name);
    assert.ok(!/console\.|debugger/.test(source), `${name} must not log`);
  }
});

test('credentials.js: value inputs are password fields that no password manager offers to save', () => {
  const script = read('credentials.js');
  assert.match(script, /type: byId\('cred-show'\)\.checked \? 'text' : 'password'/);
  assert.match(script, /autocomplete: 'new-password'/);
  // A value is never put back into the page: the list shows field NAMES only, a value input is created empty and only ever assigned ''.
  assert.ok(!/\.value\.value\s*=(?!=)(?!\s*'')/.test(script), 'a secret input is only ever cleared (an assignment, not a comparison)');
  assert.match(script, /entry\.value\.value = ''/);
  assert.ok(!/el\('input',\s*\{[^}]*\bvalue:/.test(script), 'no value attribute is set on an input from data');
  assert.ok(!/\.values\b/.test(script.replace(/body\.values/g, '')), 'no reply is read for a "values" member');
});

test('credentials.js: every write goes through change() with the admin key, and only /v1/credentials is written', () => {
  const script = read('credentials.js');
  assert.match(script, /import \{ setupAdminKey \} from '\.\/adminKey\.js'/);
  assert.match(script, /const \{ change \} = setupAdminKey\(/);
  assert.ok(!/bearer/.test(script), 'credentials.js never builds a Bearer request itself');
  const writes = [...script.matchAll(/method:\s*['"](POST|PUT|PATCH|DELETE)/gi)];
  assert.equal(writes.length, 0, 'a write outside change() would go with the session alone');

  // The method of the save is decided in one place: PUT to edit, POST to add.
  assert.match(script, /const method = editing \? 'PUT' : 'POST'/);
  const changes = [...script.matchAll(/change\(\s*(['"][A-Z]+['"]|method),\s*(`[^`]+`)/g)].map((m) => `${m[1]!.replace(/['"]/g, '')} ${m[2]!.slice(1, -1).replace(/\$\{[^}]*\}/g, ':x')}`);
  assert.deepEqual([...new Set(changes)].sort(), ['DELETE /v1/credentials/:x', 'method /v1/credentials/:x']);

  // Reads: the list and who I am, nothing else.
  const calls = [...script.matchAll(/apiFetch\(\s*[`'"]([^`'"?]+)/g)].map((m) => m[1]!);
  assert.deepEqual([...new Set(calls)].sort(), ['/v1/auth/me', '/v1/credentials']);
});

test('credentials screen: the form always says who may use the set; "everyone" while editing is an explicit null (the server keeps an omitted list)', () => {
  const script = read('credentials.js');
  assert.match(script, /body\.allowedUsers = byId\('cred-users'\)/);
  assert.match(script, /else if \(editing\) body\.allowedUsers = null/);
  // Everyone sees THAT a set is restricted; the names only come with an admin's read, and an empty list reads "admins only".
  assert.match(script, /badge\('restricted'\)/);
  assert.match(script, /badge\('admins only'\)/);
  const html = read('credentials.html');
  for (const id of ['cred-access', 'cred-users']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /<th>Who may use it<\/th>/);
});

test('credentials.js: the sets the webhook and integration stores write are never edited or deleted from here', () => {
  const script = read('credentials.js');
  assert.match(script, /\['webhook-', 'a webhook'\]/);
  assert.match(script, /\['integration-', 'an integration'\]/);
  // Those ids come from src/integrations/{webhookStore,integrationStore}.ts: if a prefix changes there, this screen must follow.
  assert.match(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'integrations', 'webhookStore.ts'), 'utf8'), /`webhook-\$\{id\}`/);
  assert.match(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'integrations', 'integrationStore.ts'), 'utf8'), /`integration-\$\{id\}`/);
});

test('the shared admin-key module keeps the key in memory only and forgets a rejected key', () => {
  const source = read('adminKey.js');
  assert.match(source, /apiFetch\(pathname, \{ method, bearer: adminKey/);
  assert.match(source, /error\.status === 401 \|\| error\.type === 'BearerTokenRequired' \|\| error\.type === 'InsufficientRole'\) forgetKey\(\)/);
  assert.match(source, /window\.addEventListener\('pagehide', forgetKey\)/);
  assert.match(source, /input\.value = ''/, 'the typed key leaves the input');
  for (const page of ['team.html', 'credentials.html']) {
    const html = read(page);
    for (const id of ['key-form', 'admin-key', 'key-forget', 'key-state']) assert.match(html, new RegExp(`id="${id}"`), `${page} #${id}`);
  }
});

test('the stylesheet has the classes the credentials screen uses', () => {
  const css = read('app.css');
  for (const name of ['field-row', 'field', 'badge\\.neutral', 'warn-banner', 'danger-banner', 'login-error', 'filters', 'inline-check', 'compact']) assert.match(css, new RegExp(`\\.${name}\\b`), name);
  // ...and the page uses the two layout classes that keep the action buttons on screen and the checkbox beside its text.
  const html = read('credentials.html');
  assert.match(html, /<table class="compact">/);
  assert.match(html, /<label class="inline-check">/);
});
