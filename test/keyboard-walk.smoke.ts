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
