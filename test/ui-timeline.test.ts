import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// The UI is served under a CSP with no inline script or style (src/server.ts). These checks guard the Evolution screen without a browser.
const publicDir = path.resolve(import.meta.dirname, '..', 'public');
const read = (name: string) => fs.readFileSync(path.join(publicDir, name), 'utf8');

test('timeline page: external module script only, no inline script/style/handlers', () => {
  const html = read('timeline.html');
  assert.match(html, /<script type="module" src="timeline\.js"><\/script>/);
  assert.equal((html.match(/<script/g) ?? []).length, 1);
  assert.ok(!/<style|style=|\son[a-z]+=/i.test(html));
});

test('every UI page (but the login) links to the evolution screen', () => {
  for (const page of ['index.html', 'executive.html', 'health.html', 'vault.html', 'performance.html', 'config.html', 'team.html', 'status.html', 'timeline.html']) {
    assert.match(read(page), /<a href="timeline\.html">Evolution<\/a>/, page);
  }
});

test('timeline.js: DOM built with textContent, only the two read-only endpoints, no write', () => {
  const script = read('timeline.js');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(script));
  assert.ok(!/\.style\b|setAttribute\(\s*['"]style|'style'/.test(script), 'a style attribute would be blocked by the CSP');
  const calls = [...script.matchAll(/apiFetch\(\s*[`'"]([^`'"?$]+)/g)].map((m) => m[1]!);
  assert.deepEqual(calls.sort(), ['/v1/evolution/', '/v1/targets']);
  assert.ok(!/method:\s*['"](POST|PUT|DELETE|PATCH)/i.test(script));
});

test('timeline.js: badge classes come from fixed words, never from the data', () => {
  const script = read('timeline.js');
  assert.ok(!/class:\s*`[^`]*\$\{/.test(script));
  assert.ok(!/className\s*=/.test(script));
});

test('the stylesheet has the classes the evolution screen uses', () => {
  const css = read('app.css');
  for (const name of ['badge\\.passed', 'badge\\.failed', 'badge\\.warn', 'card-head', 'reasons', 'filters']) assert.match(css, new RegExp(`\\.${name}\\b`), name);
});
