import assert from 'node:assert/strict';
import test from 'node:test';

import { type ActiveElement, type Candidate, focusIndicatorChanged, type StyleSignature, walkKeyboard } from '../src/runner/keyboardWalk.js';

// T7.6: the rules of the keyboard walk against a scripted browser. No Chromium (test/keyboard-walk.smoke.ts has the real one).

const RING: StyleSignature = { outline: 'auto 1px rgb(0, 0, 0)', shadow: 'none', border: 'b' };
const FLAT: StyleSignature = { outline: 'none 0px rgb(0, 0, 0)', shadow: 'none', border: 'b' };

interface Page {
  /** What Tab lands on, in order; `null` = focus leaves the document. */
  tabs: Array<string | null>;
  /** Controls whose focus leaves no visible change. */
  flat?: string[];
  roles?: Record<string, string>;
  gone?: string[];
}

function driverFor(page: Page, start?: string) {
  let position = start === undefined ? -1 : -2; // -2: focus already on `start`
  let current: string | null = start ?? null;
  const styleReads: string[] = [];
  const el = (key: string | null): ActiveElement =>
    key === null ? { none: true } : { key, tag: 'button', role: page.roles?.[key] ?? 'button', name: key.replace('#', ''), signature: page.flat?.includes(key) ? FLAT : RING };
  return {
    styleReads,
    driver: {
      active: async () => el(current),
      press: async () => {
        position = position === -2 ? 0 : position + 1;
        current = page.tabs[position] ?? null;
      },
      styleOf: async (key: string) => {
        styleReads.push(key);
        return page.gone?.includes(key) ? undefined : FLAT; // not focused any more: no ring
      },
    },
  };
}

const candidate = (key: string, anyOf = [key]): Candidate => ({ key, role: 'button', anyOf });

test('a page walked once: the order, the roles, and the end when focus leaves the document', async () => {
  const { driver } = driverFor({ tabs: ['#a', '#b', '#c', null], roles: { '#b': 'textbox' } });
  const result = await walkKeyboard(driver, { maxTabs: 50 });
  assert.deepEqual(result.order.map((stop) => `${stop.key}:${stop.role}`), ['#a:button', '#b:textbox', '#c:button']);
  assert.equal(result.endedBy, 'left-document');
  assert.equal(result.completed, true);
  assert.equal(result.tabs, 4);
  assert.deepEqual(result.invisibleFocus, []);
  assert.equal(result.order[0]!.focusVisible, true, 'the ring went away when focus moved on: it was a focus indicator');
  assert.equal(result.order[2]!.focusVisible, true, 'the last one is settled when focus leaves the document');
});

test('wrapping to the first element is the normal end; coming back to a LATER element is a focus trap', async () => {
  const wrap = await walkKeyboard(driverFor({ tabs: ['#a', '#b', '#a'] }).driver, { maxTabs: 50 });
  assert.equal(wrap.endedBy, 'wrap');
  assert.equal(wrap.completed, true);
  assert.equal(wrap.trap, undefined);

  const trap = await walkKeyboard(driverFor({ tabs: ['#a', '#b', '#c', '#b'] }).driver, { maxTabs: 50 });
  assert.equal(trap.endedBy, 'trap');
  assert.equal(trap.completed, false);
  assert.deepEqual(trap.trap, { startsAt: '#b', length: 2 });
});

test('Tab that does not move focus: a trap on that element, and no false "invisible focus" (it still has focus)', async () => {
  const stuck = await walkKeyboard(driverFor({ tabs: ['#a', '#editor', '#editor'] }).driver, { maxTabs: 50 });
  assert.equal(stuck.endedBy, 'trap');
  assert.deepEqual(stuck.trap, { startsAt: '#editor', length: 1 });
  assert.equal(stuck.order[1]!.focusVisible, undefined, 'no reading without focus was possible');
  assert.deepEqual(stuck.invisibleFocus, []);

  const single = driverFor({ tabs: ['#only', '#only'] });
  const result = await walkKeyboard(single.driver, { maxTabs: 50 });
  assert.equal(result.endedBy, 'wrap');
  assert.deepEqual(result.invisibleFocus, []);
  assert.deepEqual(single.styleReads, [], 'nothing to compare while the element still holds focus');
});

test('invisible focus: the element looks the same with and without focus', async () => {
  const result = await walkKeyboard(driverFor({ tabs: ['#a', '#flat', '#c', null], flat: ['#flat'] }).driver, { maxTabs: 50 });
  assert.deepEqual(result.invisibleFocus, ['#flat']);
  assert.equal(result.order.find((stop) => stop.key === '#flat')!.focusVisible, false);
  assert.equal(result.order.find((stop) => stop.key === '#a')!.focusVisible, true);
});

test('an element that disappeared when focus left it has no verdict (undefined, not false)', async () => {
  const result = await walkKeyboard(driverFor({ tabs: ['#a', '#b', null], gone: ['#a'] }).driver, { maxTabs: 50 });
  assert.equal(result.order[0]!.focusVisible, undefined);
  assert.deepEqual(result.invisibleFocus, []);
});

test('never focused: only candidates that no Tab reached, radio groups count as reached through any member', async () => {
  const candidates = [candidate('#a'), candidate('#div-button'), candidate('#r1', ['#r1', '#r2', '#r3'])];
  const result = await walkKeyboard(driverFor({ tabs: ['#a', '#r2', null] }).driver, { maxTabs: 50, candidates });
  assert.deepEqual(result.neverFocused, [{ key: '#div-button', role: 'button' }]);
});

test('never focused is not claimed after a trap or a cut-off walk: the notes say why', async () => {
  const candidates = [candidate('#a'), candidate('#z')];
  const trapped = await walkKeyboard(driverFor({ tabs: ['#a', '#b', '#a2', '#b'] }).driver, { maxTabs: 50, candidates });
  assert.equal(trapped.neverFocused, undefined);
  assert.match(trapped.notes.join(' '), /Focus trap/);

  const cut = await walkKeyboard(driverFor({ tabs: ['#a', '#b', '#c', '#d', '#e'] }).driver, { maxTabs: 3, candidates });
  assert.equal(cut.endedBy, 'max-tabs');
  assert.equal(cut.completed, false);
  assert.equal(cut.tabs, 3);
  assert.equal(cut.neverFocused, undefined);
  assert.match(cut.notes.join(' '), /Raise maxTabs or narrow the scope/);
  assert.equal(cut.order.at(-1)!.focusVisible, undefined, 'the last stop of a cut walk was never left');
});

test('no candidates supplied: no claim about unreached controls at all', async () => {
  const result = await walkKeyboard(driverFor({ tabs: ['#a', null] }).driver, { maxTabs: 50 });
  assert.equal(result.neverFocused, undefined);
  assert.deepEqual(result.notes, []);
});

test('a walk started on an element: it is stop 0, and coming back to it ends the walk as a wrap', async () => {
  const result = await walkKeyboard(driverFor({ tabs: ['#ok', '#cancel', '#start'] }, '#start').driver, { maxTabs: 50, startFocused: true });
  assert.deepEqual(result.order.map((stop) => stop.key), ['#start', '#ok', '#cancel']);
  assert.equal(result.endedBy, 'wrap', 'inside a dialog, going back to where it started is the right behaviour');

  const lost = driverFor({ tabs: ['#a', null] });
  const none = await walkKeyboard({ ...lost.driver, active: async () => ({ none: true }) }, { maxTabs: 5, startFocused: true });
  assert.match(none.notes.join(' '), /did not take focus/);
});

test('the time limit stops the walk and says so', async () => {
  let clock = 0;
  const result = await walkKeyboard(driverFor({ tabs: ['#a', '#b', '#c', '#d'] }).driver, { maxTabs: 50, deadline: 100, now: () => (clock += 60) });
  assert.equal(result.endedBy, 'time-limit');
  assert.equal(result.completed, false);
  assert.ok(result.order.length < 4);
});

test('focusIndicatorChanged: outline, shadow or border; identical readings are no indicator', () => {
  assert.equal(focusIndicatorChanged(RING, FLAT), true);
  assert.equal(focusIndicatorChanged({ ...FLAT, shadow: '0 0 0 3px blue' }, FLAT), true);
  assert.equal(focusIndicatorChanged({ ...FLAT, border: 'c' }, FLAT), true);
  assert.equal(focusIndicatorChanged(FLAT, { ...FLAT }), false);
});

test('backward: the same rules apply and the result says so; a forward walk has no direction field', async () => {
  // The driver presses Shift+Tab; here it is a scripted list read from the end of the page.
  const forward = await walkKeyboard(driverFor({ tabs: ['#a', '#b', null] }).driver, { maxTabs: 50 });
  assert.equal('direction' in forward, false, 'default output unchanged');
  const explicitForward = await walkKeyboard(driverFor({ tabs: ['#a', '#b', null] }).driver, { maxTabs: 50, direction: 'forward' });
  assert.deepEqual(explicitForward, forward);

  const candidates = [candidate('#a'), candidate('#b'), candidate('#c')];
  const back = await walkKeyboard(driverFor({ tabs: ['#c', '#b', '#a', null], flat: ['#b'] }).driver, { maxTabs: 50, direction: 'backward', candidates });
  assert.equal(back.direction, 'backward');
  assert.equal(back.endedBy, 'left-document');
  assert.equal(back.completed, true);
  assert.deepEqual(back.order.map((stop) => stop.key), ['#c', '#b', '#a']);
  assert.deepEqual(back.invisibleFocus, ['#b']);
  assert.deepEqual(back.neverFocused, []);

  const wrap = await walkKeyboard(driverFor({ tabs: ['#c', '#b', '#c'] }).driver, { maxTabs: 50, direction: 'backward' });
  assert.equal(wrap.endedBy, 'wrap');
  const trap = await walkKeyboard(driverFor({ tabs: ['#c', '#b', '#a', '#b'] }).driver, { maxTabs: 50, direction: 'backward', candidates });
  assert.equal(trap.endedBy, 'trap');
  assert.deepEqual(trap.trap, { startsAt: '#b', length: 2 });
  assert.equal(trap.neverFocused, undefined);
  assert.equal(trap.direction, 'backward');
});

test('schema: direction is optional with no default, and only forward or backward', async () => {
  const { explorationRequestSchema } = await import('../src/schemas/explorationRequest.schema.js');
  const base = { targetUrl: 'http://127.0.0.1:4999/', steps: [{ action: 'keyboardWalk', name: 'kb' }] };
  const plain = explorationRequestSchema.parse(base);
  assert.equal('direction' in plain.steps[0]!, false, 'no default: older digests hold');
  const back = explorationRequestSchema.parse({ ...base, steps: [{ action: 'keyboardWalk', name: 'kb', direction: 'backward' }] });
  assert.equal((back.steps[0] as { direction?: string }).direction, 'backward');
  assert.equal(explorationRequestSchema.safeParse({ ...base, steps: [{ action: 'keyboardWalk', name: 'kb', direction: 'sideways' }] }).success, false);
});
