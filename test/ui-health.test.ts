import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// The UI is served under a CSP with no inline script or style (src/server.ts). These checks guard the Health screen without a browser.
const publicDir = path.resolve(import.meta.dirname, '..', 'public');
const read = (name: string) => fs.readFileSync(path.join(publicDir, name), 'utf8');

test('health page: external module script only, no inline script/style/handlers', () => {
  const html = read('health.html');
  assert.match(html, /<script type="module" src="health\.js"><\/script>/);
  assert.equal((html.match(/<script/g) ?? []).length, 1);
  assert.ok(!/<style|style=|\son[a-z]+=/i.test(html));
});

test('every UI page (but the login) links to the health screen', () => {
  for (const page of ['index.html', 'config.html', 'status.html', 'vault.html', 'performance.html', 'health.html']) {
    assert.match(read(page), /<a href="health\.html">Health<\/a>/, page);
  }
});

test('health.js: DOM built with textContent and SVG classes only, one read-only endpoint', () => {
  const script = read('health.js');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(script));
  assert.ok(!/\.style\b|setAttribute\(\s*['"]style|'style'/.test(script), 'a style attribute would be blocked by the CSP');
  const calls = [...script.matchAll(/apiFetch\(\s*[`'"]([^`'"]+)/g)].map((m) => m[1]!);
  assert.deepEqual(calls, ['/v1/health']);
  assert.ok(!/method:\s*['"](POST|PUT|DELETE)/i.test(script));
});

test('health.js: badge classes come from fixed words, never from the data', () => {
  const script = read('health.js');
  // The only `class:` values built from data would be a template literal with ${...}; badges map data to constant strings instead.
  assert.ok(!/class:\s*`[^`]*\$\{/.test(script));
  assert.ok(!/className\s*=/.test(script));
});

test('the stylesheet has a class for every part of the health screen (the script cannot style inline)', () => {
  const css = read('app.css');
  for (const name of ['badge\\.warn', 'badge\\.neutral', 'strip-pass', 'strip-fail', 'card-head', 'reasons']) assert.match(css, new RegExp(`\\.${name}\\b`), name);
});
