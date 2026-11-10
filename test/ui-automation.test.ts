import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// The UI is served under a CSP with no inline script or style (src/server.ts). These checks guard the Automation screen (schedules and webhooks) without
// a browser; test/automation-ui.smoke.ts runs it in Chromium against the real server.
const publicDir = path.resolve(import.meta.dirname, '..', 'public');
const read = (name: string) => fs.readFileSync(path.join(publicDir, name), 'utf8');
const SCRIPTS = ['automation.js', 'automationSchedules.js', 'automationWebhooks.js'];

test('automation page: one external module script, no inline script/style/handlers, the ids the modules use exist', () => {
  const html = read('automation.html');
  assert.match(html, /<script type="module" src="automation\.js"><\/script>/);
  assert.equal((html.match(/<script/g) ?? []).length, 1);
  assert.ok(!/<style|style=|\son[a-z]+=/i.test(html));
  for (const id of ['key-form', 'admin-key', 'key-forget', 'key-state']) assert.match(html, new RegExp(`id="${id}"`), `#${id} (adminKey.js)`);

  // Every element the three scripts look up by id is in the page.
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]!));
  for (const name of SCRIPTS) {
    for (const match of read(name).matchAll(/byId\(\s*(['"])([a-z0-9-]+)\1\s*\)/g)) assert.ok(ids.has(match[2]!), `${name} looks for #${match[2]} which the page does not have`);
  }
  // Ids built from a prefix: the messenger of each form.
  for (const id of ['sch-error', 'sch-done', 'wh-error', 'wh-done']) assert.ok(ids.has(id), id);
});

test('every UI page (but the login) links to the automation screen', () => {
  for (const page of ['index.html', 'config.html', 'status.html', 'vault.html', 'performance.html', 'health.html', 'executive.html', 'timeline.html', 'team.html', 'credentials.html', 'automation.html']) {
    assert.match(read(page), /<a href="automation\.html">Automation<\/a>/, page);
  }
});

test('automation scripts: DOM built with textContent only, no style attribute, classes from fixed words', () => {
  for (const name of SCRIPTS) {
    const script = read(name);
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(script), name);
    assert.ok(!/\.style\b|setAttribute\(\s*['"]style|'style'/.test(script), `${name}: a style attribute would be blocked by the CSP`);
    assert.ok(!/class:\s*`[^`]*\$\{/.test(script), `${name}: a class name built from data`);
    assert.ok(!/className\s*=/.test(script), name);
  }
});

test('automation scripts: nothing typed or returned reaches storage, the URL, a log line or a cookie', () => {
  for (const name of [...SCRIPTS, 'adminKey.js']) {
    const source = read(name);
    assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie|location\.(search|hash)/.test(source), name);
    assert.ok(!/console\.|debugger/.test(source), `${name} must not log`);
  }
});

test('the webhook URL is a write-only secret: a password input no manager offers to save, only ever cleared, never read back', () => {
  const html = read('automation.html');
  assert.match(html, /<input type="password" id="wh-url"[^>]*autocomplete="new-password"/);
  const script = read('automationWebhooks.js');
  // The input is only assigned '' (an assignment, not a comparison); the one other assignment is its `type` for "show what I type".
  const assignments = [...script.matchAll(/byId\('wh-url'\)\.([a-zA-Z]+)\s*=(?!=)\s*([^;]+);/g)].map((match) => `${match[1]} = ${match[2]!.trim()}`);
  assert.deepEqual([...new Set(assignments)].sort(), ["required = false", "required = true", "type = byId('wh-show').checked ? 'text' : 'password'", "value = ''"].sort());
  // No member of a reply that could hold the address is read: the server answers hasUrl and the origin only.
  assert.ok(!/(view|webhook|result|reply|data)\.url\b/.test(script.replace(/body\.url/g, '')), 'no reply is read for a "url" member');
  assert.match(script, /urlOrigin/);
  assert.match(script, /window\.addEventListener\('pagehide'/);
  assert.ok(!/el\('input',\s*\{[^}]*\bvalue:\s*(?!')/.test(script), 'no value attribute is set on an input from data');
});

test('automation scripts: every write goes through change() with the admin key, and only the schedule and webhook routes are written', () => {
  const all = SCRIPTS.map(read).join('\n');
  assert.match(read('automation.js'), /import \{ setupAdminKey \} from '\.\/adminKey\.js'/);
  assert.match(read('automation.js'), /setupAdminKey\(\{ showError:/);
  for (const name of SCRIPTS) {
    assert.ok(!/bearer/.test(read(name)), `${name} never builds a Bearer request itself`);
    assert.equal([...read(name).matchAll(/method:\s*['"](POST|PUT|PATCH|DELETE)/gi)].length, 0, `${name}: a write outside change() would go with the session alone`);
  }
  const writes = [...all.matchAll(/change\(\s*'([A-Z]+)',\s*(`[^`]+`)/g)].map((match) => `${match[1]} ${match[2]!.slice(1, -1).replace(/\$\{[^}]*\}/g, ':x')}`);
  assert.deepEqual(
    [...new Set(writes)].sort(),
    [
      'DELETE /v1/schedules/:x',
      'DELETE /v1/webhooks/:x',
      'POST /v1/schedules/:x/run-now',
      'POST /v1/webhooks/:x/test',
      'PUT /v1/schedules/:x',
      'PUT /v1/webhooks/:x',
    ].sort(),
  );
  // Reads: the lists, the choices of the forms, who I am.
  const reads = [...all.matchAll(/apiFetch\(\s*[`'"]([^`'"?]+)/g)].map((match) => match[1]!);
  assert.deepEqual([...new Set(reads)].sort(), ['/v1/auth/me', '/v1/credentials', '/v1/routines', '/v1/schedules', '/v1/targets', '/v1/webhooks']);
});

test('enabling or disabling a schedule resends the stored definition without its id (the server refuses an id in the body)', () => {
  const script = read('automationSchedules.js');
  assert.match(script, /const \{ id, \.\.\.definition \} = schedule;/);
  assert.match(script, /\{ \.\.\.definition, enabled: !schedule\.enabled \}/);
  // A schedule of kind suite has no form: no Edit button for it.
  assert.match(script, /if \(schedule\.target\.kind !== 'suite'\) buttons\.push\(/);
});

test('the sets of the form match what the server accepts (kinds, presets, languages)', () => {
  const html = read('automation.html');
  const schema = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'schemas', 'schedule.schema.ts'), 'utf8');
  for (const kind of [...html.matchAll(/<option value="(routine|vault|evolutionSnapshot|summary)">/g)].map((match) => match[1]!)) {
    assert.match(schema, new RegExp(`z\\.literal\\('${kind}'\\)`), kind);
  }
  const hooks = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'schemas', 'webhook.schema.ts'), 'utf8');
  for (const preset of ['generic', 'slack', 'teams', 'googlechat']) {
    assert.match(html, new RegExp(`<option value="${preset}">`), preset);
    assert.match(hooks, new RegExp(`'${preset}'`), preset);
  }
});

test('the stylesheet has the classes the automation screen uses', () => {
  const css = read('app.css');
  for (const name of ['field', 'badge\\.passed', 'badge\\.failed', 'badge\\.warn', 'badge\\.neutral', 'warn-banner', 'danger-banner', 'login-error', 'filters', 'inline-check', 'compact', 'cell-actions']) {
    assert.match(css, new RegExp(`\\.${name}\\b`), name);
  }
  assert.equal((read('automation.html').match(/<table class="compact">/g) ?? []).length, 2);
});
