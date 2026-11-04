import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// T7.2, the pure half: the fault controller (matching, times, untilStep, allowlist), what the routing layer does with each kind of fault,
// the leak patterns of assertNoTextMatches, the step schema, and the staging switch.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-faults-test-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com,https://stg.example.com';
process.env.ALLOWED_RESOURCE_ORIGINS = 'https://api.example.com';

const { createFaultController, MALFORMED_JSON_BODY, FAULT_HANDLED_BY, usesFaults } = await import('../src/runner/faults.js');
const { installRouting, buildPolicies } = await import('../src/runner/routing.js');
const { findLeaks, MAX_SCANNED_CHARS } = await import('../src/runner/leakPatterns.js');
const { explorationRequestSchema } = await import('../src/schemas/explorationRequest.schema.js');
const { resolveExplorationRequest, RequestResolutionError } = await import('../src/runner/resolveRequest.js');
const { saveTarget } = await import('../src/targets/targetStore.js');

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const req = (url: string, over: Record<string, unknown> = {}) => ({ url, method: 'GET', resourceType: 'fetch', isNavigation: false, ...over });

// ---- controller

test('a rule answers requests whose URL contains the text and whose method matches; others pass', () => {
  const faults = createFaultController();
  faults.add({ match: { urlContains: '/api/save', method: 'post' }, fault: { status: 500, body: '{"error":"boom"}' } });

  const hit = faults.policy(req('https://dev.example.com/api/save?x=1', { method: 'POST' }));
  assert.deepEqual(hit && { ...hit, headers: undefined }, {
    action: 'fulfill',
    handledBy: FAULT_HANDLED_BY,
    status: 500,
    contentType: 'application/json',
    body: '{"error":"boom"}',
    headers: undefined,
    detail: 'status 500',
  });
  assert.equal(faults.policy(req('https://dev.example.com/api/save', { method: 'GET' })), undefined, 'other method');
  assert.equal(faults.policy(req('https://dev.example.com/api/list', { method: 'POST' })), undefined, 'other URL');
});

test('only allowlisted origins are touched', () => {
  const faults = createFaultController();
  faults.add({ match: { urlContains: '/api' }, fault: { status: 503 } });
  assert.ok(faults.policy(req('https://dev.example.com/api/x')), 'target origin');
  assert.ok(faults.policy(req('https://api.example.com/api/x')), 'resource origin');
  assert.equal(faults.policy(req('https://evil.example.org/api/x')), undefined, 'any other origin is left alone');
  assert.equal(faults.policy(req('data:text/plain,/api')), undefined);
});

test('times: the rule answers that many requests and is then gone', () => {
  const faults = createFaultController();
  faults.add({ match: { urlContains: '/api' }, fault: { status: 500 }, times: 2 });
  assert.ok(faults.policy(req('https://dev.example.com/api/1')));
  assert.equal(faults.size, 1);
  assert.ok(faults.policy(req('https://dev.example.com/api/2')));
  assert.equal(faults.size, 0);
  assert.equal(faults.policy(req('https://dev.example.com/api/3')), undefined, 'the third request is real');
});

test('untilStep removes only the rules that wait for that step; clear removes all', () => {
  const faults = createFaultController();
  faults.add({ match: { urlContains: '/a' }, fault: { status: 500 }, untilStep: 'save' });
  faults.add({ match: { urlContains: '/b' }, fault: { status: 500 } });
  faults.stepFinished('other');
  assert.equal(faults.size, 2);
  faults.stepFinished('save');
  assert.equal(faults.size, 1);
  assert.equal(faults.policy(req('https://dev.example.com/a')), undefined);
  assert.ok(faults.policy(req('https://dev.example.com/b')));
  faults.clear();
  assert.equal(faults.size, 0);
});

test('the first matching rule wins', () => {
  const faults = createFaultController();
  faults.add({ match: { urlContains: '/api' }, fault: { status: 500 } });
  faults.add({ match: { urlContains: '/api' }, fault: { status: 404 } });
  assert.equal((faults.policy(req('https://dev.example.com/api')) as { status: number }).status, 500);
});

test('every kind of fault becomes the decision it promises', () => {
  const faults = createFaultController();
  const decide = (fault: Parameters<typeof faults.add>[0]['fault']) => {
    const local = createFaultController();
    local.add({ match: { urlContains: '/x' }, fault });
    return local.policy(req('https://dev.example.com/x'))!;
  };
  assert.deepEqual(decide({ delayMs: 10000 }), { action: 'delay', handledBy: 'fault', delayMs: 10000, detail: 'delay 10000 ms' });
  assert.deepEqual(decide({ abort: 'timedout' }), { action: 'abort', handledBy: 'fault', errorCode: 'timedout', detail: 'abort timedout' });
  assert.deepEqual(decide({ abort: 'failed' }), { action: 'abort', handledBy: 'fault', errorCode: 'failed', detail: 'abort failed' });

  const broken = decide({ malformedJson: true }) as { status: number; body: string; contentType: string; detail: string };
  assert.equal(broken.status, 200);
  assert.equal(broken.contentType, 'application/json');
  assert.equal(broken.body, MALFORMED_JSON_BODY);
  assert.throws(() => JSON.parse(MALFORMED_JSON_BODY), 'the body must really be unparseable');

  const text = decide({ status: 500, body: 'plain' }) as { contentType: string };
  assert.equal(text.contentType, 'text/plain');
  const custom = decide({ status: 422, body: '<e/>', contentType: 'application/xml' }) as { contentType: string };
  assert.equal(custom.contentType, 'application/xml');
});

test('a cross-origin fetch gets CORS headers on a stand-in answer, a same-origin one does not', () => {
  const faults = createFaultController();
  faults.add({ match: { urlContains: '/api' }, fault: { status: 500 } });
  const cross = faults.policy(req('https://api.example.com/api', { initiatorOrigin: 'https://dev.example.com' })) as { headers: Record<string, string> };
  assert.equal(cross.headers['access-control-allow-origin'], 'https://dev.example.com');
  assert.equal(cross.headers['access-control-allow-credentials'], 'true');
  const same = faults.policy(req('https://dev.example.com/api', { initiatorOrigin: 'https://dev.example.com' })) as { headers: Record<string, string> };
  assert.deepEqual(same.headers, {});
});

test('usesFaults looks at steps and teardown', () => {
  assert.equal(usesFaults({ steps: [{ action: 'goto' }] }), false);
  assert.equal(usesFaults({ steps: [{ action: 'goto' }], teardown: [{ action: 'injectFault' }] }), true);
});

// ---- the routing layer with faults

function fakeContext() {
  const state: { handler?: (route: any) => Promise<void> } = {};
  return { state, context: { route: async (_p: string, handler: (route: any) => Promise<void>) => void (state.handler = handler) } as never };
}

function fakeRoute(info: { url: string; method?: string; headers?: Record<string, string> }) {
  const log: string[] = [];
  const request = {
    url: () => info.url,
    method: () => info.method ?? 'GET',
    resourceType: () => 'fetch',
    isNavigationRequest: () => false,
    headers: () => info.headers ?? {},
  };
  const route = {
    request: () => request,
    continue: async () => void log.push('continue'),
    abort: async (code: string) => void log.push(`abort:${code}`),
    fulfill: async (o: { status: number; body?: string }) => void log.push(`fulfill:${o.status}`),
  };
  return { request, route, log };
}

test('routing: delay lets the real request through LATE, is recorded, and is not "handled"', async () => {
  const faults = createFaultController();
  faults.add({ match: { urlContains: '/slow' }, fault: { delayMs: 60 } });
  const { state, context } = fakeContext();
  const handle = await installRouting(context, buildPolicies({ blockUnexpected: false, faults: [faults.policy] }));

  const call = fakeRoute({ url: 'https://dev.example.com/slow/x?token=abc' });
  const started = Date.now();
  await state.handler!(call.route);
  assert.ok(Date.now() - started >= 55, 'it waited');
  assert.deepEqual(call.log, ['continue']);
  assert.deepEqual(handle.entries, [
    { origin: 'https://dev.example.com', pathname: '/slow/x', method: 'GET', resourceType: 'fetch', handledBy: 'fault', action: 'delay', detail: 'delay 60 ms' },
  ]);
  assert.equal(handle.isHandled(call.request as never), false, 'a real request that arrived late can still really fail');
});

test('routing: abort uses the fault error code and is handled; a status is fulfilled and is handled', async () => {
  const faults = createFaultController();
  faults.add({ match: { urlContains: '/drop' }, fault: { abort: 'timedout' } });
  faults.add({ match: { urlContains: '/err' }, fault: { status: 502 } });
  const { state, context } = fakeContext();
  const handle = await installRouting(context, buildPolicies({ blockUnexpected: false, faults: [faults.policy] }));

  const drop = fakeRoute({ url: 'https://dev.example.com/drop' });
  await state.handler!(drop.route);
  assert.deepEqual(drop.log, ['abort:timedout']);
  assert.equal(handle.isHandled(drop.request as never), true);

  const err = fakeRoute({ url: 'https://dev.example.com/err', headers: { origin: 'https://dev.example.com' } });
  await state.handler!(err.route);
  assert.deepEqual(err.log, ['fulfill:502']);
  assert.equal(handle.isHandled(err.request as never), true);

  const real = fakeRoute({ url: 'https://dev.example.com/fine' });
  await state.handler!(real.route);
  assert.deepEqual(real.log, ['continue']);
  assert.equal(handle.entries.length, 2, 'only the touched requests are recorded');
});

// ---- leak patterns

const kinds = (text: string, options?: Parameters<typeof findLeaks>[1]) => findLeaks(text, options).map((f) => f.kind);

test('leak patterns: real traces and errors are found', () => {
  assert.deepEqual(kinds('Error\n\tat com.acme.sales.OrderService.save(OrderService.java:42)'), ['stackTrace']);
  assert.deepEqual(kinds('at Acme.Sales.OrderService.Save(Order o) in C:\\src\\Acme\\OrderService.cs:line 88'), ['stackTrace', 'serverPath']);
  assert.deepEqual(kinds('TypeError\n    at save (http://localhost:3000/static/app.js:10:5)'), ['stackTrace']);
  assert.deepEqual(kinds('Traceback (most recent call last):'), ['stackTrace']);
  assert.deepEqual(kinds("Server Error in '/' Application."), ['stackTrace']);
  assert.deepEqual(kinds('java.lang.NullPointerException'), ['exception']);
  assert.deepEqual(kinds('System.InvalidOperationException: Sequence contains no elements'), ['exception']);
  assert.deepEqual(kinds('Uncaught TypeError: x is undefined'), ['exception']);
  assert.deepEqual(kinds('ORA-00942: table or view does not exist'), ['sqlError']);
  assert.deepEqual(kinds("You have an error in your SQL syntax near 'x'"), ['sqlError']);
  assert.deepEqual(kinds('Unclosed quotation mark after the character string'), ['sqlError']);
  assert.deepEqual(kinds('Failed to open C:\\inetpub\\wwwroot\\app\\config.xml'), ['serverPath']);
  assert.deepEqual(kinds('/var/www/html/app/index.php on line 3'), ['serverPath']);
});

test('leak patterns: ordinary text is clean', () => {
  const clean = [
    'The order was saved. Total: 1.234,56',
    'Please try again later. If the problem persists, contact support.',
    'Visit https://example.com/var/www/index.html or call us.',
    'You can arrive at 10:30 at the main office (floor 3).',
    'Error: the field "Name" is required',
    'Exception handling is covered in chapter 3',
    'Save the file to C:\\Users\\me',
  ];
  for (const text of clean) assert.deepEqual(findLeaks(text), [], text);
});

test('leak findings: counts, one clipped example, kinds filter and literal fragments', () => {
  const text = 'ORA-00942 first. ORA-01017 second. ' + 'x'.repeat(300);
  const [finding] = findLeaks(text);
  assert.equal(finding!.kind, 'sqlError');
  assert.equal(finding!.count, 2);
  assert.equal(finding!.example, 'ORA-00942');

  assert.deepEqual(findLeaks(text, { kinds: ['stackTrace'] }), []);
  const literal = findLeaks('internal id GX-ERR-7 and GX-ERR-7 again', { kinds: [], contains: ['GX-ERR-7', 'absent'] });
  assert.deepEqual(literal, [{ kind: 'contains', count: 2, example: 'GX-ERR-7' }]);
  assert.ok(findLeaks('at com.acme.' + 'A'.repeat(500) + '.B.save(B.java:1)'.padEnd(10), { kinds: ['stackTrace'] }).length <= 1);
});

test('leak patterns cost stays small on hostile input, and the scan is capped', () => {
  const hostile = ['C:\\' + 'a\\'.repeat(60000), '/var/' + 'a/'.repeat(60000), 'at ' + 'a.'.repeat(60000), 'at x(' + 'b'.repeat(100000), 'java.' + 'a.'.repeat(60000)];
  for (const text of hostile) {
    const started = Date.now();
    findLeaks(text);
    assert.ok(Date.now() - started < 2000, `${text.slice(0, 12)}... took ${Date.now() - started} ms`);
  }
  const beyondCap = 'x'.repeat(MAX_SCANNED_CHARS) + ' ORA-00942';
  assert.deepEqual(findLeaks(beyondCap), [], 'text past the cap is not scanned');
});

// ---- schema

const base = { targetUrl: 'https://dev.example.com/', steps: [] as unknown[] };
const parse = (steps: unknown[]) => explorationRequestSchema.safeParse({ ...base, steps });

test('schema: injectFault accepts each fault form and refuses a mixed or unknown one', () => {
  const ok = (fault: unknown, extra: Record<string, unknown> = {}) =>
    parse([{ action: 'injectFault', match: { urlContains: '/api/save', method: 'POST' }, fault, ...extra }]).success;
  assert.ok(ok({ status: 500 }));
  assert.ok(ok({ status: 503, body: '{"e":1}', contentType: 'application/json' }));
  assert.ok(ok({ delayMs: 10000 }));
  assert.ok(ok({ abort: 'failed' }));
  assert.ok(ok({ abort: 'timedout' }, { times: 1 }));
  assert.ok(ok({ malformedJson: true }));
  assert.ok(!ok({ status: 99 }));
  assert.ok(!ok({ status: 500, delayMs: 5 }), 'one kind of fault per step');
  assert.ok(!ok({ abort: 'reset' }));
  assert.ok(!ok({ malformedJson: false }));
  assert.ok(!ok({ delayMs: 0 }));
  assert.ok(!ok({}));
  assert.ok(!parse([{ action: 'injectFault', match: { urlContains: '' }, fault: { status: 500 } }]).success);
  assert.ok(!parse([{ action: 'injectFault', fault: { status: 500 } }]).success, 'a match is required');
});

test('schema: untilStep must name a later step of the same list', () => {
  const fault = { action: 'injectFault', match: { urlContains: '/x' }, fault: { status: 500 } };
  // The id of a step AFTER the fault is the useful case ("break the API until the click has finished"), so it is allowed...
  assert.ok(parse([{ ...fault, untilStep: 'save' }, { id: 'save', action: 'reload' }]).success);
  // ...an id that exists nowhere is a typo that would leave the fault on for the whole run...
  assert.ok(!parse([{ ...fault, untilStep: 'sve' }, { id: 'save', action: 'reload' }]).success);
  // ...and a step BEFORE the fault has already finished, so it could never end it.
  assert.ok(!parse([{ id: 'save', action: 'reload' }, { ...fault, untilStep: 'save' }]).success);
  assert.ok(parse([{ id: 'save', action: 'reload' }, fault]).success, 'no untilStep: lasts to the end of the run');
});

test('schema: assertNoTextMatches takes built-in kinds and literals, never a regular expression', () => {
  assert.ok(parse([{ action: 'assertNoTextMatches' }]).success);
  assert.ok(parse([{ action: 'assertNoTextMatches', selector: '#main', kinds: ['stackTrace', 'sqlError'], contains: ['GX-ERR'] }]).success);
  assert.ok(!parse([{ action: 'assertNoTextMatches', kinds: ['everything'] }]).success);
  assert.ok(!parse([{ action: 'assertNoTextMatches', patterns: ['(a+)+$'] }]).success, 'no caller regex');
  assert.ok(!parse([{ action: 'assertNoTextMatches', kinds: [] }]).success);
});

// ---- staging switch

test('resolve: a staging profile refuses injectFault unless flags.allowFaults is set', async () => {
  await saveTarget({
    id: 'app-stg',
    name: 'App (staging)',
    platform: 'generic',
    environment: 'staging',
    baseUrl: 'https://stg.example.com/app',
    credentialSets: [],
    noiseFilters: [],
    surfaces: {},
    screens: [],
    flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  });
  await saveTarget({
    id: 'app-stg-chaos',
    name: 'App (staging, chaos ok)',
    platform: 'generic',
    environment: 'staging',
    baseUrl: 'https://stg.example.com/app',
    credentialSets: [],
    noiseFilters: [],
    surfaces: {},
    screens: [],
    flags: { allowDestructive: false, allowFaults: true, maxSessionsPerCredential: 1 },
  });
  await saveTarget({
    id: 'app-dev',
    name: 'App (dev)',
    platform: 'generic',
    environment: 'dev',
    baseUrl: 'https://dev.example.com/app',
    credentialSets: [],
    noiseFilters: [],
    surfaces: {},
    screens: [],
    flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  });

  const withFault = (targetProfile: string) =>
    explorationRequestSchema.parse({
      targetProfile,
      steps: [{ action: 'goto', url: '$targetUrl' }, { action: 'injectFault', match: { urlContains: '/api' }, fault: { status: 500 } }],
    });
  const noFault = explorationRequestSchema.parse({ targetProfile: 'app-stg', steps: [{ action: 'goto', url: '$targetUrl' }] });

  await assert.rejects(
    () => resolveExplorationRequest(withFault('app-stg')),
    (error: unknown) => error instanceof RequestResolutionError && error.status === 403 && /allowFaults/.test(error.message),
  );
  await resolveExplorationRequest(withFault('app-stg-chaos'));
  await resolveExplorationRequest(withFault('app-dev'));
  await resolveExplorationRequest(noFault);
});
