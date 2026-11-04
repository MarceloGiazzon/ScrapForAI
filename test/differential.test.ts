import assert from 'node:assert/strict';
import test from 'node:test';

// T6.3: differential execution. The comparison is pure; the service's verdict rules and the markdown are tested here without a browser.

const { compareRuns, normalizeMessage, normalizePath, describeComparison, describeTiming } = await import('../src/differential/compareRuns.js');
const { compileDiffConfig } = await import('../src/diff/normalizers.js');
const { tally, verdictOf } = await import('../src/differential/differentialService.js');
const { renderDifferentialMarkdown } = await import('../src/differential/render.js');
const { differentialRequestSchema, differentialCompareRequestSchema } = await import('../src/schemas/differential.schema.js');

type Step = { index: number; id?: string; action: string; status: 'passed' | 'failed' | 'skipped'; durationMs: number; error?: { type: string; message: string } };

const step = (index: number, id: string, extra: Partial<Step> = {}): Step & { startedAt: string; finishedAt: string } => ({
  index,
  id,
  action: 'click',
  status: 'passed',
  durationMs: 100,
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:00.100Z',
  ...extra,
});

const run = (over: Record<string, any> = {}): any => ({
  status: 'passed',
  durationMs: 1000,
  steps: [step(0, 'open'), step(1, 'save')],
  extracted: {},
  evidence: { screenshots: [], console: [], consoleErrors: [], pageErrors: [], network: [], networkFailures: [], unexpectedExternalRequests: [], ...(over.evidence ?? {}) },
  ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'evidence')),
});

const request = (method: string, pathname: string, status: number | undefined, extra: Record<string, unknown> = {}) => ({
  origin: 'https://dev.example.test',
  pathname,
  method,
  resourceType: 'xhr',
  ...(status === undefined ? {} : { status }),
  ...extra,
});

test('two identical runs are equivalent and say nothing', () => {
  const comparison = compareRuns(run(), run());
  assert.equal(comparison.equivalent, true);
  assert.equal(comparison.headline, '');
  assert.deepEqual(describeComparison(comparison), []);
});

test('a step that passes on the left and fails on the right is a difference, with both errors', () => {
  const left = run();
  const right = run({
    status: 'failed',
    steps: [step(0, 'open'), step(1, 'save', { status: 'failed', error: { type: 'AssertionError', message: 'expected Saved' } })],
  });
  const comparison = compareRuns(left, right);
  assert.equal(comparison.equivalent, false);
  assert.deepEqual(comparison.steps.differences.map((d) => [d.key, d.kind]), [['(run)', 'run-status'], ['save', 'status']]);
  assert.match(describeComparison(comparison, { left: 'GX17', right: 'GX18' }).join('\n'), /step save: GX17 passed, GX18 failed \(AssertionError: expected Saved\)/);
});

test('a step on one side only (a different login routine) is reported, with a note', () => {
  const comparison = compareRuns(run(), run({ steps: [step(0, 'autologin.u'), step(1, 'open'), step(2, 'save')] }));
  assert.deepEqual(comparison.steps.differences.map((d) => [d.key, d.kind]), [['autologin.u', 'only-right']]);
  assert.ok(comparison.notes.some((note) => /one side only/.test(note)));
});

test('both failing the same way is equivalent but the note says neither side is healthy', () => {
  const failing = () => run({ status: 'failed', steps: [step(0, 'open', { status: 'failed', error: { type: 'Timeout', message: 'a' } })] });
  const comparison = compareRuns(failing(), failing());
  assert.equal(comparison.equivalent, true);
  assert.ok(comparison.notes.some((note) => /neither side is healthy/.test(note)));
});

test('the same step failing with another kind of error is a difference', () => {
  const l = run({ status: 'failed', steps: [step(0, 'open', { status: 'failed', error: { type: 'Timeout', message: 'slow' } })] });
  const r = run({ status: 'failed', steps: [step(0, 'open', { status: 'failed', error: { type: 'AssertionError', message: 'wrong' } })] });
  assert.deepEqual(compareRuns(l, r).steps.differences.map((d) => d.kind), ['error-type']);
});

test('extracted values use the T4.1 diff: tolerance, identity, and an ignored path', () => {
  const left = run({ extracted: { total: 100.0, lines: [{ id: 'a', qty: 1 }, { id: 'b', qty: 2 }], stamp: 'x' } });
  const right = run({ extracted: { total: 100.04, lines: [{ id: 'b', qty: 2 }, { id: 'a', qty: 1 }], stamp: 'y' } });
  const exact = compareRuns(left, right, {}, { ignorePaths: ['stamp'] });
  assert.deepEqual(exact.extracted.changed.map((c) => c.path), ['total']);
  const loose = compareRuns(left, right, { diff: { ignorePaths: ['stamp'], numericTolerance: { absolute: 0.05, relative: 0 } } as never });
  assert.equal(loose.equivalent, true);
});

test('a request tolerance REPLACES the profile config; without one the left profile config is used', () => {
  const left = run({ extracted: { n: 1 } });
  const right = run({ extracted: { n: 1.001 } });
  assert.equal(compareRuns(left, right, {}, { numericTolerance: { absolute: 0.01, relative: 0 } }).equivalent, true);
  assert.equal(compareRuns(left, right, { diff: { numericTolerance: { absolute: 0, relative: 0 } } as never }, { numericTolerance: { absolute: 0.01, relative: 0 } }).equivalent, false);
});

test('console: only an error that is NEW on the right is "new"; the environment, ids and counters do not make two messages differ', () => {
  const left = run({
    evidence: {
      consoleErrors: [
        { type: 'error', text: 'GET https://dev.example.test/api/orders/12345?x=1 failed', location: { url: 'https://dev.example.test/app.1a2b3c4d5e.js' } },
        { type: 'error', text: 'only on the baseline' },
      ],
    },
  });
  const right = run({
    evidence: {
      consoleErrors: [
        { type: 'error', text: 'GET https://staging.example.test/api/orders/98765?x=2 failed', location: { url: 'https://staging.example.test/app.ffee00112233.js' } },
        { type: 'error', text: 'GET https://staging.example.test/api/orders/98765?x=2 failed', location: { url: 'https://staging.example.test/app.ffee00112233.js' } },
        { type: 'error', text: 'brand new failure' },
      ],
      pageErrors: ['TypeError: x is undefined'],
    },
  });
  const comparison = compareRuns(left, right);
  assert.deepEqual(comparison.console.newInRight.map((e) => e.text), ['brand new failure', 'page error: TypeError: x is undefined']);
  assert.deepEqual(comparison.console.goneInRight.map((e) => e.text), ['only on the baseline']);
  assert.equal(comparison.equivalent, false);
  assert.match(comparison.headline, /2 new console error\(s\), 1 console error\(s\) gone/);
});

test('network: the shape ignores the origin and masks ids; a new status or a missing call is a difference', () => {
  const left = run({
    evidence: {
      network: [
        request('GET', '/api/orders/10', 200),
        request('GET', '/api/orders/11', 200),
        request('POST', '/api/orders', 201),
        request('GET', '/api/legacy', 200),
        request('GET', '/static/app.0123456789ab.js', 200, { resourceType: 'script', origin: 'https://dev.example.test' }),
      ],
    },
  });
  const right = run({
    evidence: {
      network: [
        { ...request('GET', '/api/orders/20', 200), origin: 'https://staging.example.test' },
        { ...request('POST', '/api/orders', 500), origin: 'https://staging.example.test' },
        { ...request('GET', '/api/audit/1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed', 200), origin: 'https://staging.example.test' },
        { ...request('GET', '/static/app.ffffffffffff.js', 200, { resourceType: 'script' }), origin: 'https://staging.example.test' },
      ],
    },
  });
  const changes = compareRuns(left, right).network.changes.map((c) => `${c.kind} ${c.shape}`);
  assert.deepEqual(changes, ['only-right GET /api/audit/:uuid', 'only-left GET /api/legacy', 'status POST /api/orders']);
});

test('network: a failing request of a type that is not compared is still compared; an aborted one is not a statement about the server', () => {
  const left = run({ evidence: { network: [request('GET', '/img/logo.png', 200, { resourceType: 'image' })] } });
  const right = run({
    evidence: {
      network: [
        request('GET', '/img/logo.png', 404, { resourceType: 'image' }),
        request('GET', '/api/ping', undefined, { failureText: 'net::ERR_ABORTED' }),
        request('GET', '/api/down', undefined, { failureText: 'net::ERR_CONNECTION_REFUSED' }),
      ],
    },
  });
  assert.deepEqual(
    compareRuns(left, right).network.changes.map((c) => `${c.kind} ${c.shape}`),
    ['only-right GET /api/down', 'status GET /img/logo.png'],
  );
  // an empty list means every type
  assert.equal(compareRuns(left, run(), { networkResourceTypes: [] }).network.changes.length, 1);
});

test('timing: a slower step needs the ratio AND the minimum delta; it never makes the pair different; a failed run is not timed', () => {
  const left = run({ steps: [step(0, 'open', { durationMs: 100 }), step(1, 'save', { durationMs: 1000 }), step(2, 'tiny', { durationMs: 10 })] });
  const right = run({ durationMs: 5000, steps: [step(0, 'open', { durationMs: 900 }), step(1, 'save', { durationMs: 1200 }), step(2, 'tiny', { durationMs: 60 })] });
  const comparison = compareRuns(left, right);
  assert.equal(comparison.equivalent, true);
  assert.deepEqual(comparison.timing.steps.map((t) => [t.key, t.direction, t.ratio]), [['open', 'slower', 9]]);
  assert.equal(comparison.timing.run?.direction, 'slower');
  assert.match(describeTiming(comparison, { left: 'a', right: 'b' }).join('\n'), /open: slower on b \(a 100 ms, b 900 ms, x9\)/);

  const failed = compareRuns(left, run({ status: 'failed', steps: [step(0, 'open', { status: 'failed' })] }));
  assert.equal(failed.timing.applicable, false);
});

test('dimensions limits what is compared', () => {
  const right = run({ evidence: { consoleErrors: [{ type: 'error', text: 'boom' }] }, extracted: { a: 1 } });
  assert.equal(compareRuns(run(), right, { dimensions: ['steps'] }).equivalent, true);
  assert.equal(compareRuns(run(), right, { dimensions: ['console'] }).counts.extracted, 0);
  assert.equal(compareRuns(run(), right).counts.console, 1);
});

test('normalizers: messages and paths', () => {
  const n = compileDiffConfig({ maskPatterns: [{ pattern: 'session [A-Z0-9]+', replacement: 'session #' }] });
  assert.equal(normalizeMessage('Failed https://a.test:8443/x/y?token=1 for 1234567 at session AB12', n), 'Failed <origin>/x/y for # at session #');
  assert.equal(normalizePath('/app/orders/123/items/4d3e7b2a9c0f1e6d/x;jsessionid=ABC', n), '/app/orders/:n/items/:hex/x');
  assert.equal(normalizePath('/app/main.0123abcd.js', n), '/app/main.:hash.js');
  assert.equal(normalizePath('/', n), '/');
});

test('verdict: different wins over infra-error; nothing run is not green', () => {
  const pairs = (outcomes: Array<'same' | 'different' | 'infra-error' | undefined>) => {
    const state = { pairs: outcomes.map((outcome, i) => ({ routineId: `r${i}`, version: 1, state: 'done' as const, ...(outcome ? { outcome } : {}) })) } as any;
    state.counts = tally(state);
    return state;
  };
  assert.equal(verdictOf(pairs(['same', 'same']), false).verdict, 'same');
  assert.equal(verdictOf(pairs(['same', 'different', 'infra-error']), false).verdict, 'different');
  assert.equal(verdictOf(pairs(['same', 'infra-error']), false).verdict, 'infra-error');
  assert.equal(verdictOf(pairs(['same', undefined]), true).verdict, 'infra-error');
  assert.match(verdictOf(pairs(['different', 'same']), false).reason, /1 of 2 routine\(s\) behave differently, 1 the same/);
});

test('request schema: defaults, no duplicate routine, strict', () => {
  const side = { targetProfile: 'app-dev' };
  const ok = differentialRequestSchema.parse({ routines: [{ routineId: 'a' }], left: side, right: { targetProfile: 'app-qa', label: 'QA' } });
  assert.equal(ok.tolerance.timeRatio, 2);
  assert.deepEqual(ok.tolerance.networkResourceTypes, ['document', 'xhr', 'fetch']);
  assert.equal(differentialRequestSchema.safeParse({ routines: [{ routineId: 'a' }, { routineId: 'a' }], left: side, right: side }).success, false);
  assert.equal(differentialRequestSchema.safeParse({ routines: [{ routineId: 'a' }], left: side, right: side, extra: 1 }).success, false);
  assert.equal(differentialRequestSchema.safeParse({ routines: [], left: side, right: side }).success, false);
  assert.equal(differentialRequestSchema.safeParse({ routines: [{ routineId: 'a' }], left: side, right: side, tolerance: { timeRatio: 1 } }).success, false);
  assert.equal(differentialCompareRequestSchema.safeParse({ leftJobId: 'job_1', rightJobId: '../x' }).success, false);
});

test('markdown: only routines that differ are listed, page text cannot inject markup', () => {
  const comparison = compareRuns(run(), run({ evidence: { consoleErrors: [{ type: 'error', text: '`](http://evil)\n# injected' }] } }));
  const state: any = {
    differentialId: 'diff_x',
    status: 'completed',
    labels: { left: 'dev', right: 'qa' },
    counts: { total: 2, same: 1, different: 1, infraError: 0, notRun: 0 },
    verdict: 'different',
    reason: '1 of 2 routine(s) behave differently, 1 the same',
    pairs: [
      { routineId: 'ok', version: 1, state: 'done', outcome: 'same' },
      { routineId: 'bad', version: 2, state: 'done', outcome: 'different', comparison, lines: describeComparison(comparison, { left: 'dev', right: 'qa' }), left: { jobId: 'job_l', status: 'passed' }, right: { jobId: 'job_r', status: 'passed' } },
    ],
  };
  const md = renderDifferentialMarkdown(state);
  assert.match(md, /## bad@v2: different/);
  assert.doesNotMatch(md, /## ok@v1/);
  assert.doesNotMatch(md, /\n# injected/);
  assert.match(md, /Verdict: \*\*different\*\*/);
});

test('network: recorded traffic (successful requests) is compared; without it the note says only failures were', () => {
  const traffic = (status: number, extra: Record<string, unknown> = {}) => ({ ...request('GET', '/api/audit', status), count: 3, ...extra });
  const left = run({ evidence: { traffic: [traffic(200), { ...request('GET', '/api/orders/77', 200), count: 1 }] } });
  const right = run({ evidence: { traffic: [traffic(500), { ...request('GET', '/api/orders/91', 200), count: 2 }] } });
  const withTraffic = compareRuns(left, right);
  assert.deepEqual(withTraffic.network.changes.map((c) => `${c.kind} ${c.shape}`), ['status GET /api/audit']);
  assert.ok(!withTraffic.notes.some((note) => /failing requests only/.test(note)));

  assert.ok(compareRuns(run(), run()).notes.some((note) => /failing requests only/.test(note)));
  assert.ok(compareRuns(left, run()).notes.some((note) => /only one of the two runs recorded/.test(note)));
  assert.ok(compareRuns(run({ evidence: { trafficTruncated: true } }), run()).notes.some((note) => /more distinct requests/.test(note)));
});
