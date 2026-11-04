import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { formatPercent } from '../public/api.js';

// The UI is served under a CSP with no inline script or style (src/server.ts). These checks guard the Executive screen without a browser.
const publicDir = path.resolve(import.meta.dirname, '..', 'public');
const read = (name: string) => fs.readFileSync(path.join(publicDir, name), 'utf8');

test('executive page: external module script only, no inline script/style/handlers', () => {
  const html = read('executive.html');
  assert.match(html, /<script type="module" src="executive\.js"><\/script>/);
  assert.equal((html.match(/<script/g) ?? []).length, 1);
  assert.ok(!/<style|style=|\son[a-z]+=/i.test(html));
});

test('every UI page (but the login) links to the executive screen', () => {
  for (const page of ['index.html', 'config.html', 'status.html', 'vault.html', 'performance.html', 'health.html', 'executive.html']) {
    assert.match(read(page), /<a href="executive\.html">Executive<\/a>/, page);
  }
});

test('executive.js: DOM built with textContent and SVG classes only, one read-only endpoint', () => {
  const script = read('executive.js');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(script));
  assert.ok(!/\.style\b|setAttribute\(\s*['"]style|'style'/.test(script), 'a style attribute would be blocked by the CSP');
  const calls = [...script.matchAll(/apiFetch\(\s*[`'"]([^`'"]+)/g)].map((m) => m[1]!);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.startsWith('/v1/executive'), calls[0]);
  assert.ok(!/method:\s*['"](POST|PUT|DELETE)/i.test(script));
});

test('executive.js: badge and bar classes come from fixed words, never from the data', () => {
  const script = read('executive.js');
  assert.ok(!/class:\s*`[^`]*\$\{/.test(script));
  assert.ok(!/setAttribute\(\s*['"]class['"]\s*,\s*`/.test(script), 'an SVG class built from a template literal');
  assert.ok(!/className\s*=/.test(script));
});

test('the stylesheet has a class for every part of the executive screen (the script cannot style inline)', () => {
  const css = read('app.css');
  for (const name of ['bar-good', 'bar-mid', 'bar-bad', 'bar-none', 'bar-partial', 'chart-label', 'kv', 'chart', 'row', 'badge\\.warn', 'badge\\.neutral', 'card-head', 'reasons']) {
    assert.match(css, new RegExp(`\\.${name}\\b`), name);
  }
  // The classes the script can pick must all exist.
  const script = read('executive.js');
  const used = new Set([...script.matchAll(/'(bar-[a-z]+(?: bar-[a-z]+)?|badge [a-z]+)'/g)].flatMap((m) => m[1]!.split(' ')));
  for (const name of used) if (name !== 'badge') assert.match(css, new RegExp(`\\.${name}\\b`), name);
});

test('formatPercent: whole basis points, rounded down; only a rate of exactly 1 reads as 100%', () => {
  assert.equal(formatPercent(null), '—');
  assert.equal(formatPercent(undefined), '—');
  assert.equal(formatPercent(1), '100%');
  assert.equal(formatPercent(0.9999), '99.9%', 'one failure in ten thousand is not 100%');
  assert.equal(formatPercent(0.96), '96%');
  assert.equal(formatPercent(0.9615), '96.1%');
  assert.equal(formatPercent(0.57), '57%', 'no float error: 0.57 * 1000 is 569.99...');
  assert.equal(formatPercent(0.5), '50%');
  assert.equal(formatPercent(0), '0%');
  assert.equal(formatPercent(0.0001), '<0.1%', 'a pass is not 0%');
});
