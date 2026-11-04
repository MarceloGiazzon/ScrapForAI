import assert from 'node:assert/strict';
import test from 'node:test';

process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';

const { QuietDetector, waitUntilQuiet, NetworkQuietTimeout, usesQuiet, DEFAULT_IDLE_MS } = await import('../src/runner/networkQuiet.js');
const { explorationRequestSchema } = await import('../src/schemas/explorationRequest.schema.js');

type Reading = Parameters<InstanceType<typeof QuietDetector>['observe']>[0] extends ReadonlyMap<string, infer R> ? R : never;
const frames = (...readings: Reading[]) => new Map(readings.map((reading, index) => [String(index), reading] as const));

test('quiet needs nothing pending AND nothing changed for idleMs', () => {
  const detector = new QuietDetector(300);
  assert.equal(detector.observe(frames({ pending: 0, seq: 0 }), 0).quiet, false, 'the first reading only starts the clock');
  assert.equal(detector.observe(frames({ pending: 0, seq: 0 }), 299).quiet, false);
  assert.equal(detector.observe(frames({ pending: 0, seq: 0 }), 300).quiet, true);
});

test('a request that starts and ends between two polls still restarts the idle clock (seq moved)', () => {
  const detector = new QuietDetector(300);
  detector.observe(frames({ pending: 0, seq: 0 }), 0);
  assert.equal(detector.observe(frames({ pending: 0, seq: 2 }), 250).quiet, false);
  assert.equal(detector.observe(frames({ pending: 0, seq: 2 }), 540).quiet, false, '290 ms since the last change');
  assert.equal(detector.observe(frames({ pending: 0, seq: 2 }), 550).quiet, true);
});

test('a pending request is never quiet, however long ago the last change was; the count is reported', () => {
  const detector = new QuietDetector(100);
  detector.observe(frames({ pending: 2, seq: 2 }), 0);
  const state = detector.observe(frames({ pending: 2, seq: 2 }), 5000);
  assert.deepEqual(state, { quiet: false, pending: 2 });
});

test('every frame counts: a pending request in an iframe keeps the page busy; a frame without a tracker is ignored; an unreadable frame is not quiet', () => {
  const detector = new QuietDetector(100);
  detector.observe(frames({ pending: 0, seq: 0 }, { pending: 1, seq: 1 }), 0);
  assert.equal(detector.observe(frames({ pending: 0, seq: 0 }, { pending: 1, seq: 1 }), 1000).quiet, false);

  const fresh = new QuietDetector(100);
  fresh.observe(frames({ pending: 0, seq: 0 }, null), 0);
  assert.equal(fresh.observe(frames({ pending: 0, seq: 0 }, null), 100).quiet, true);

  const navigating = new QuietDetector(100);
  navigating.observe(frames({ pending: 0, seq: 0 }, 'unavailable'), 0);
  assert.equal(navigating.observe(frames({ pending: 0, seq: 0 }, 'unavailable'), 5000).quiet, false);
});

test('a frame that appears or goes away restarts the idle clock', () => {
  const detector = new QuietDetector(100);
  detector.observe(frames({ pending: 0, seq: 0 }), 0);
  assert.equal(detector.observe(frames({ pending: 0, seq: 0 }, { pending: 0, seq: 0 }), 90).quiet, false);
  assert.equal(detector.observe(frames({ pending: 0, seq: 0 }, { pending: 0, seq: 0 }), 150).quiet, false);
  assert.equal(detector.observe(frames({ pending: 0, seq: 0 }, { pending: 0, seq: 0 }), 190).quiet, true);
});

function fakeDeps(script: (t: number) => Reading) {
  let t = 0;
  return {
    deps: { read: async () => frames(script(t)), now: () => t, sleep: async (ms: number) => void (t += ms) },
    elapsed: () => t,
  };
}

test('waitUntilQuiet returns once the page settles, using the default idle time', async () => {
  // busy until 400 ms (a request pending), then nothing.
  const { deps, elapsed } = fakeDeps((t) => (t < 400 ? { pending: 1, seq: 1 } : { pending: 0, seq: 2 }));
  await waitUntilQuiet({ timeoutMs: 5000 }, deps);
  assert.ok(elapsed() >= 400 + DEFAULT_IDLE_MS, `waited ${elapsed()} ms`);
  assert.ok(elapsed() < 400 + DEFAULT_IDLE_MS + 200);
});

test('waitUntilQuiet times out and says how many requests were pending', async () => {
  const { deps } = fakeDeps(() => ({ pending: 3, seq: 3 }));
  await assert.rejects(
    () => waitUntilQuiet({ idleMs: 200, timeoutMs: 1000 }, deps),
    (error: unknown) => error instanceof NetworkQuietTimeout && /3 XHR\/fetch request\(s\) still pending after 1000 ms/.test(error.message),
  );
});

test('a page that never stops making requests times out with a different message', async () => {
  let seq = 0;
  const { deps } = fakeDeps(() => ({ pending: 0, seq: ++seq }));
  await assert.rejects(() => waitUntilQuiet({ idleMs: 200, timeoutMs: 1000 }, deps), /kept making requests/);
});

test('an idle time longer than the timeout is refused up front', async () => {
  const { deps } = fakeDeps(() => ({ pending: 0, seq: 0 }));
  await assert.rejects(() => waitUntilQuiet({ idleMs: 2000, timeoutMs: 1000 }, deps), /longer than the timeout/);
});

test('schema: waitForQuiet step and quiet wait condition are accepted; quiet cannot be combined with another condition', () => {
  const ok = explorationRequestSchema.safeParse({
    targetUrl: 'https://dev.example.com/',
    steps: [
      { action: 'goto', url: '$targetUrl' },
      { id: 'click', action: 'click', selector: '#go', afterWaitFor: undefined, waitFor: { quiet: { idleMs: 200 }, timeoutMs: 8000 } },
      { action: 'waitForQuiet', idleMs: 300, timeoutMs: 5000 },
      { action: 'waitForQuiet' },
    ],
  });
  assert.equal(ok.success, true, JSON.stringify(ok.error?.issues));

  const both = explorationRequestSchema.safeParse({
    targetUrl: 'https://dev.example.com/',
    steps: [{ action: 'click', selector: '#go', waitFor: { quiet: {}, selector: '#x' } }],
  });
  assert.equal(both.success, false);
  assert.equal(explorationRequestSchema.safeParse({ targetUrl: 'https://dev.example.com/', steps: [{ action: 'waitForQuiet', idleMs: 10 }] }).success, false, 'idleMs under 50');
});

test('usesQuiet sees the step, the wait condition and the teardown; a run without them installs nothing', () => {
  assert.equal(usesQuiet({ steps: [{ action: 'goto' }] }), false);
  assert.equal(usesQuiet({ steps: [{ action: 'waitForQuiet' }] }), true);
  assert.equal(usesQuiet({ steps: [{ action: 'click', waitFor: { quiet: {} } }] }), true);
  assert.equal(usesQuiet({ steps: [{ action: 'click', afterWaitFor: { quiet: {} } }] }), true);
  assert.equal(usesQuiet({ steps: [{ action: 'goto' }], teardown: [{ action: 'waitForQuiet' }] }), true);
});
