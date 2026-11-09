import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// T7.6 + T7.1 end to end (real Chromium): the keyboard walk finds a control that cannot be reached, a focus ring that is not there, and a focus
// trap, says nothing wrong about a good page, never reads a typed value, and works with ALLOW_EVALUATE off (built-in trusted scripts).

const PAGES: Record<string, string> = {
  '/good': `<a href="#end">Skip to content</a>
    <label for="name">Full name</label><input id="name" value="Jane Typed">
    <button id="save">Save</button><div id="end"></div>`,
  '/bad': `<style>#ghost:focus { outline: none; }</style>
    <button id="ok">Ok</button>
    <div id="fake" role="button">Fake button</div>
    <button id="ghost">Ghost</button>
    <input type="radio" name="g" id="r1"><label for="r1">One</label><input type="radio" name="g" id="r2"><label for="r2">Two</label>
    <input id="skipme" tabindex="-1" aria-label="Skipped on purpose"><button id="off" disabled>Off</button>
    <label for="pw">Password</label><input id="pw" type="password" value="s3cr3t-typed-value">`,
  '/trap': `<button id="first">First</button><button id="a">A</button><button id="b">B</button>
    <script>
      var a = document.getElementById('a'), b = document.getElementById('b');
      a.addEventListener('keydown', function (e) { if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); b.focus(); } });
      b.addEventListener('keydown', function (e) { if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); a.focus(); } });
    </script>`,
  // Shift+Tab (T7.6 backward): positive tabindex reorders the forward walk; the backward one is its mirror.
  '/positive': `<button id="a">A</button><button id="b" tabindex="2">B</button><button id="c" tabindex="1">C</button><button id="d">D</button>`,
  // A loop that only exists going backward: the handlers act on Shift+Tab, so the forward walk of this page is clean.
  '/back-trap': `<button id="first">First</button><button id="a">A</button><button id="b">B</button><button id="last">Last</button>
    <script>
      var a = document.getElementById('a'), b = document.getElementById('b');
      a.addEventListener('keydown', function (e) { if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); b.focus(); } });
      b.addEventListener('keydown', function (e) { if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); a.focus(); } });
    </script>`,
  // Focus moved by script going backward: C sends Shift+Tab straight to A, so B is never reached backward although Tab reaches it.
  '/skip-back': `<button id="a">A</button><button id="b">B</button><button id="c">C</button>
    <script>
      document.getElementById('c').addEventListener('keydown', function (e) { if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); document.getElementById('a').focus(); } });
    </script>`,
};

const site = await new Promise<{ server: http.Server; origin: string }>((resolve) => {
  const server = http.createServer((req, res) => {
    const body = PAGES[req.url ?? ''];
    res.statusCode = body ? 200 : 404;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><meta charset="utf-8"><title>T</title>${body ?? ''}`);
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-kbd-smoke-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = site.origin;
process.env.ALLOWED_RESOURCE_ORIGINS = site.origin;
delete process.env.ALLOW_EVALUATE;

const { saveTarget } = await import('../src/targets/targetStore.js');
const { saveRoutine, runLibraryRoutine } = await import('../src/library/routineService.js');

after(async () => {
  await new Promise<void>((resolve) => site.server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

interface Walk {
  order: Array<{ key: string; role: string; name?: string; focusVisible?: boolean }>;
  tabs: number;
  completed: boolean;
  endedBy: string;
  direction?: string;
  trap?: { startsAt: string; length: number };
  neverFocused?: Array<{ key: string; role: string; name?: string }>;
  invisibleFocus: string[];
  notes: string[];
}

const walkStep = (extra: Record<string, unknown> = {}) => ({ id: 'walk', action: 'keyboardWalk', name: 'kb', ...extra });

async function walk(routineId: string, page: string, extra: Record<string, unknown> = {}) {
  await saveRoutine(routineId, { title: routineId, targetProfile: 'kbd', steps: [{ id: 'open', action: 'goto', url: `${site.origin}${page}` }, walkStep(extra)] as never });
  const result = await runLibraryRoutine(routineId, undefined, {});
  return { result, walk: result.extracted.kb as unknown as Walk | undefined };
}

test('a good page: every control is reached in order, with a visible focus ring, and nothing is reported', async () => {
  await saveTarget({
    id: 'kbd', name: 'Keyboard', platform: 'generic', environment: 'dev', baseUrl: `${site.origin}/`, credentialSets: [],
    noiseFilters: [], surfaces: {}, screens: [], flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  });
  const { result, walk: kb } = await walk('kbd-good', '/good', { failOn: ['neverFocused', 'focusTrap', 'invisibleFocus'] });
  assert.equal(result.status, 'passed', JSON.stringify(result.error));
  assert.deepEqual(kb!.order.map((stop) => `${stop.role}:${stop.name}`), ['link:Skip to content', 'textbox:Full name', 'button:Save']);
  assert.deepEqual(kb!.order.map((stop) => stop.focusVisible), [true, true, true]);
  assert.deepEqual(kb!.neverFocused, []);
  assert.deepEqual(kb!.invisibleFocus, []);
  assert.equal(kb!.completed, true);
  assert.ok(['wrap', 'left-document'].includes(kb!.endedBy), kb!.endedBy);
  assert.ok(!JSON.stringify(result).includes('Jane Typed'), 'the value of a field is never read');
});

test('a page with defects: the unreachable div, the invisible focus; radio group, tabindex=-1 and disabled are not false alarms', async () => {
  const { result, walk: kb } = await walk('kbd-bad', '/bad');
  assert.equal(result.status, 'passed', 'findings do not fail the step unless failOn says so');
  assert.deepEqual(kb!.neverFocused!.map((control) => `${control.role}:${control.name}`), ['button:Fake button']);
  assert.deepEqual(kb!.invisibleFocus, ['#ghost']);
  const keys = kb!.order.map((stop) => stop.key);
  assert.ok(keys.includes('#ok') && keys.includes('#pw'));
  assert.ok(keys.includes('#r1') !== keys.includes('#r2'), 'Tab reaches ONE radio of the group, and the group counts as reached');
  assert.ok(!keys.includes('#skipme') && !keys.includes('#off'));
  assert.equal(kb!.order.find((stop) => stop.key === '#pw')!.name, 'Password');
  assert.ok(!JSON.stringify(result).includes('s3cr3t-typed-value'), 'a password typed or pre-filled never reaches the result');
  assert.ok(!(result.evidence?.console ?? []).some((line) => String(line).includes('s3cr3t')));
});

test('failOn turns a finding into a failed step that names it', async () => {
  const unreachable = await walk('kbd-bad-fail', '/bad', { failOn: ['neverFocused'] });
  assert.equal(unreachable.result.status, 'failed');
  assert.match(unreachable.result.error?.message ?? '', /keyboardWalk: 1 control\(s\) never received keyboard focus/);
  assert.ok(unreachable.walk, 'the evidence of the walk is kept even when the step fails');

  const ring = await walk('kbd-bad-ring', '/bad', { failOn: ['invisibleFocus'] });
  assert.match(ring.result.error?.message ?? '', /1 element\(s\) show no outline, shadow or border change when focused/);
});

test('a focus trap is found, and a walk started inside it comes back to its start without an alarm', async () => {
  const trapped = await walk('kbd-trap', '/trap', { failOn: ['focusTrap'] });
  assert.equal(trapped.result.status, 'failed');
  assert.match(trapped.result.error?.message ?? '', /focus trap: Tab loops over 2 element\(s\)/);
  assert.equal(trapped.walk!.endedBy, 'trap');
  assert.deepEqual(trapped.walk!.trap, { startsAt: '#a', length: 2 });
  assert.equal(trapped.walk!.neverFocused, undefined, 'nothing is claimed about what lies behind a trap');

  const inside = await walk('kbd-trap-start', '/trap', { startSelector: '#a' });
  assert.equal(inside.walk!.endedBy, 'wrap', 'two controls that hand focus to each other, started on one of them, is a closed loop');
  assert.deepEqual(inside.walk!.order.map((stop) => stop.key), ['#a', '#b']);
  assert.equal(inside.walk!.neverFocused, undefined, 'a start element without a scope judges no control');
});

test('maxTabs cuts a walk short and says so; a scope that matches nothing is an error', async () => {
  const cut = await walk('kbd-cut', '/bad', { maxTabs: 2 });
  assert.equal(cut.walk!.endedBy, 'max-tabs');
  assert.equal(cut.walk!.completed, false);
  assert.equal(cut.walk!.tabs, 2);
  assert.equal(cut.walk!.neverFocused, undefined);
  assert.match(cut.walk!.notes.join(' '), /Raise maxTabs/);

  const missing = await walk('kbd-scope', '/bad', { scope: '#nowhere' });
  assert.equal(missing.result.status, 'failed');
  assert.match(missing.result.error?.message ?? '', /scope selector matched nothing/);
});

test('direction forward (explicit) is the same walk as the default, and writes no direction field', async () => {
  const implicit = await walk('kbd-dir-default', '/good');
  const explicit = await walk('kbd-dir-forward', '/good', { direction: 'forward' });
  assert.deepEqual(explicit.walk, implicit.walk);
  assert.equal('direction' in explicit.walk!, false);
});

test('backward: Shift+Tab walks the page from the end, and with positive tabindex it is the mirror of the forward order', async () => {
  const forward = await walk('kbd-pos-fwd', '/positive');
  const backward = await walk('kbd-pos-back', '/positive', { direction: 'backward' });
  assert.deepEqual(forward.walk!.order.map((stop) => stop.key), ['#c', '#b', '#a', '#d'], 'positive tabindex first, then document order');
  assert.equal(backward.walk!.direction, 'backward');
  assert.deepEqual(backward.walk!.order.map((stop) => stop.key), ['#d', '#a', '#b', '#c'], 'the browser mirrors it going back');
  assert.equal(backward.walk!.completed, true);
  assert.ok(['wrap', 'left-document'].includes(backward.walk!.endedBy), backward.walk!.endedBy);
  assert.deepEqual(backward.walk!.neverFocused, []);
});

test('backward: a trap that only exists going backward is found, and the forward walk of that page is clean', async () => {
  const forward = await walk('kbd-bt-fwd', '/back-trap', { failOn: ['focusTrap'] });
  assert.equal(forward.result.status, 'passed', JSON.stringify(forward.result.error));
  assert.equal(forward.walk!.trap, undefined);

  const backward = await walk('kbd-bt-back', '/back-trap', { direction: 'backward', failOn: ['focusTrap'] });
  assert.equal(backward.result.status, 'failed');
  assert.match(backward.result.error?.message ?? '', /focus trap: Tab loops over 2 element\(s\)/);
  assert.equal(backward.walk!.direction, 'backward');
  assert.equal(backward.walk!.endedBy, 'trap');
  assert.deepEqual(backward.walk!.trap, { startsAt: '#b', length: 2 });
  assert.equal(backward.walk!.neverFocused, undefined);
});

test('backward: focus moved by script makes the backward order differ from the reverse of the forward one, and the unreached control is listed', async () => {
  const forward = await walk('kbd-skip-fwd', '/skip-back');
  const backward = await walk('kbd-skip-back', '/skip-back', { direction: 'backward' });
  const forwardKeys = forward.walk!.order.map((stop) => stop.key);
  const backwardKeys = backward.walk!.order.map((stop) => stop.key);
  assert.deepEqual(forwardKeys, ['#a', '#b', '#c']);
  assert.deepEqual(backwardKeys, ['#c', '#a']);
  assert.notDeepEqual(backwardKeys, [...forwardKeys].reverse());
  assert.equal(backward.walk!.completed, true);
  assert.deepEqual(backward.walk!.neverFocused!.map((control) => control.name), ['B'], 'Shift+Tab never reaches B');
});

test('backward with startSelector: the start element is stop 0 and the walk goes toward the top', async () => {
  const { walk: kb } = await walk('kbd-pos-start', '/positive', { direction: 'backward', startSelector: '#d' });
  assert.deepEqual(kb!.order.slice(0, 3).map((stop) => stop.key), ['#d', '#a', '#b']);
  assert.equal(kb!.neverFocused, undefined, 'a start element without a scope judges no control');
});
