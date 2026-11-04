import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// The UI is served under a CSP with no inline script or style (src/server.ts). These checks guard the Performance screen without a browser;
// test/ui-performance.smoke.ts renders it in Chromium under the same CSP.
const publicDir = path.resolve(import.meta.dirname, '..', 'public');
const read = (name: string) => fs.readFileSync(path.join(publicDir, name), 'utf8');

test('performance page: external module script only, no inline script/style/handlers', () => {
  const html = read('performance.html');
  assert.match(html, /<script type="module" src="performance\.js"><\/script>/);
  assert.equal((html.match(/<script/g) ?? []).length, 1);
  assert.ok(!/<style|style=|\son[a-z]+=/i.test(html));
});

test('every UI page (but the login) links to the performance screen', () => {
  for (const page of ['index.html', 'config.html', 'status.html', 'vault.html', 'performance.html']) {
    assert.match(read(page), /<a href="performance\.html">Performance<\/a>/, page);
  }
});

test('performance.js: DOM built with textContent and SVG classes only (no innerHTML, no style), ids validated, read-only endpoints', () => {
  const script = read('performance.js');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(script));
  assert.ok(!/\.style\b|setAttribute\(\s*['"]style|'style'/.test(script), 'a style attribute would be blocked by the CSP');
  assert.match(script, /ROUTINE_ID = \/\^\[a-zA-Z0-9_-\]\{1,80\}\$\//);
  const calls = [...script.matchAll(/apiFetch\(\s*[`'"]([^`'"]+)/g)].map((m) => m[1]!);
  assert.ok(calls.length >= 2);
  for (const call of calls) assert.match(call, /^\/v1\/metrics\//, call);
  assert.ok(!/method:\s*['"](POST|PUT|DELETE)/i.test(script));
});

test('the stylesheet has a class for every part of the sparkline (the script cannot style inline)', () => {
  const css = read('app.css');
  for (const name of ['spark-line', 'spark-base', 'spark-build', 'spark-dot', 'spark-alert']) assert.match(css, new RegExp(`\\.${name}\\b`), name);
});
