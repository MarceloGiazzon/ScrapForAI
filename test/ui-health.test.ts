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

test('health.js: report links only point at this server\'s own report routes, with a validated and encoded id', async () => {
  const script = read('health.js');
  // Same patterns as the server's (src/artifacts/artifactStore.ts and src/orchestrator/suiteRunner.ts), so a link is never built from an id the server would not issue.
  const { JOB_ID_PATTERN } = await import('../src/artifacts/artifactStore.js');
  assert.ok(script.includes(`const JOB_ID = ${JOB_ID_PATTERN.toString()};`), 'JOB_ID in health.js must equal JOB_ID_PATTERN');
  assert.ok(script.includes('const SUITE_ID = /^suite_[A-Za-z0-9_-]{1,40}$/;'));
  const hrefs = [...script.matchAll(/idLink\(\s*`([^`]+)`/g)].map((m) => m[1]!);
  assert.deepEqual(hrefs, ['/v1/runs/${encodeURIComponent(jobId)}/report?lang=en', '/v1/suites/${encodeURIComponent(ref.id)}/report?lang=en']);
  assert.ok(/rel:\s*'noopener'/.test(script));
  // The id is tested before it reaches a URL.
  assert.match(script, /JOB_ID\.test\(jobId\)\)\s*return el\('span'/);
  assert.match(script, /SUITE_ID\.test\(ref\.id\)/);
  // Nothing but these two report routes is ever a link target.
  assert.deepEqual([...script.matchAll(/[`'"](\/v1\/[a-z]+)/g)].map((m) => m[1]!).sort(), ['/v1/health', '/v1/runs', '/v1/suites']);
});

// ---- the status editor (public/healthStatus.js): the only write on this screen

test('healthStatus.js: the one write is POST /v1/routines/<id>/status with an encoded id; the reads are /v1/auth/me and nothing else; health.js stays read-only', () => {
  const script = read('healthStatus.js');
  const calls = [...script.matchAll(/apiFetch\(\s*[`'"]([^`'"]+)/g)].map((m) => m[1]!);
  assert.deepEqual(calls, ['/v1/auth/me', '/v1/routines/${encodeURIComponent(current.id)}/status']);
  const writes = [...script.matchAll(/method:\s*['"](\w+)/g)].map((m) => m[1]);
  assert.deepEqual(writes, ['POST']);
  assert.ok(!/bearer/i.test(script), 'no admin key is asked for: a runner session may change a status, exactly as PUT /v1/routines/:id already allows');
  assert.ok(!/method:\s*['"](POST|PUT|DELETE)/i.test(read('health.js')), 'the report itself is still only read');
});

test('healthStatus.js: DOM by textContent, no inline style or handler, classes never taken from data', () => {
  const script = read('healthStatus.js');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(script));
  assert.ok(!/\.style\b|setAttribute\(\s*['"]style|'style'/.test(script));
  assert.ok(!/class:\s*`[^`]*\$\{/.test(script));
  assert.ok(!/className\s*=/.test(script));
});

test('health.html: the dialog is static markup with the ids the script uses, no inline handler, and the page no longer claims it changes no status', () => {
  const html = read('health.html');
  for (const id of ['status-dialog', 'status-title', 'status-current', 'status-select', 'status-help', 'status-reason', 'status-error', 'status-apply', 'status-cancel', 'status-message']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.ok(!/<style|style=|\son[a-z]+=/i.test(html));
  assert.ok(!/changes no status/.test(html));
  assert.match(html, /<textarea[^>]*maxlength="300"/, 'the same cap the server enforces');
});

test('healthStatus.js offers exactly the statuses the server knows, and the suggestions map to real ones', async () => {
  const { routineStatusSchema } = await import('../src/schemas/libraryRoutine.schema.js');
  const script = read('healthStatus.js');
  const listed = /const STATUS_ORDER = \[([^\]]+)\]/.exec(script)![1]!.split(',').map((item) => item.trim().replace(/'/g, ''));
  assert.deepEqual([...listed].sort(), [...routineStatusSchema.options].sort());
  assert.match(script, /quarantine: 'quarantined', release: 'active'/);
  assert.match(script, /const MAX_REASON = 300;/);
});
