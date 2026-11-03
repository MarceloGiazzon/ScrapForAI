import assert from 'node:assert/strict';
import test from 'node:test';

// T5.1, the pure half: policy order, the allowlist guard, and what installRouting does with a (fake) context and route.

process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';
process.env.ALLOWED_RESOURCE_ORIGINS = 'https://cdn.example.com';

const { allowlistGuard, buildPolicies, decide, installRouting, ALLOWLIST_GUARD } = await import('../src/runner/routing.js');

const req = (url: string, over: Record<string, unknown> = {}) => ({ url, method: 'GET', resourceType: 'image', isNavigation: false, ...over });

test('allowlist guard: allowed origins pass, others are aborted, navigations and non-network schemes are not its business', () => {
  assert.equal(allowlistGuard(req('https://dev.example.com/a.png')), undefined);
  assert.equal(allowlistGuard(req('https://cdn.example.com/lib.js')), undefined, 'ALLOWED_RESOURCE_ORIGINS count');
  assert.deepEqual(allowlistGuard(req('https://evil.example.org/x.png')), { action: 'abort', handledBy: ALLOWLIST_GUARD });
  assert.deepEqual(allowlistGuard(req('http://dev.example.com/x.png')), { action: 'abort', handledBy: ALLOWLIST_GUARD }, 'same host, other scheme = other origin');
  assert.deepEqual(allowlistGuard(req('wss://evil.example.org/socket', { resourceType: 'websocket' })), { action: 'abort', handledBy: ALLOWLIST_GUARD });
  assert.equal(allowlistGuard(req('wss://dev.example.com/socket', { resourceType: 'websocket' })), undefined, 'a websocket to an allowed host is fine');
  assert.equal(allowlistGuard(req('https://evil.example.org/', { isNavigation: true })), undefined, 'navigations are checked by validateTargetUrl');
  for (const url of ['data:image/png;base64,AAAA', 'blob:https://dev.example.com/1', 'about:blank']) assert.equal(allowlistGuard(req(url)), undefined, url);
});

test('policies run in a fixed order: guard, faults, resources; the first answer wins', () => {
  const calls: string[] = [];
  const fault = () => (calls.push('fault'), { action: 'fulfill' as const, handledBy: 'fault', status: 503 });
  const resource = () => (calls.push('resource'), { action: 'abort' as const, handledBy: 'resource' });

  const policies = buildPolicies({ blockUnexpected: true, faults: [fault], resources: [resource] });
  assert.equal(policies.length, 3);
  assert.equal(decide(req('https://evil.example.org/x.png'), policies)?.handledBy, ALLOWLIST_GUARD);
  assert.deepEqual(calls, [], 'the guard answered, nobody after it was asked');
  assert.equal(decide(req('https://dev.example.com/x.png'), policies)?.handledBy, 'fault');
  assert.deepEqual(calls, ['fault']);

  const passThrough = buildPolicies({ blockUnexpected: false, resources: [() => undefined] });
  assert.equal(decide(req('https://evil.example.org/x.png'), passThrough), undefined, 'no guard, nothing answers: the request continues');
  assert.deepEqual(buildPolicies({ blockUnexpected: false }), []);
});

function fakeContext() {
  const state: { installed: Array<(route: any) => Promise<void>> } = { installed: [] };
  return { state, context: { route: async (_pattern: string, handler: (route: any) => Promise<void>) => void state.installed.push(handler) } as never };
}

function fakeRoute(info: ReturnType<typeof req>) {
  const log: string[] = [];
  const request = { url: () => info.url, method: () => info.method, resourceType: () => info.resourceType, isNavigationRequest: () => info.isNavigation };
  return { request, log, route: { request: () => request, continue: async () => void log.push('continue'), abort: async (code: string) => void log.push(`abort:${code}`), fulfill: async (o: { status: number }) => void log.push(`fulfill:${o.status}`) } };
}

test('no policy: nothing is installed at all, so a run is exactly what it was before', async () => {
  const { state, context } = fakeContext();
  const handle = await installRouting(context, []);
  assert.equal(state.installed.length, 0);
  assert.deepEqual([handle.active, handle.entries], [false, []]);
  assert.equal(handle.isAborted({} as never), false);
});

test('installed: abort is recorded with handledBy and remembered; an untouched request just continues and leaves no trace', async () => {
  const { state, context } = fakeContext();
  const handle = await installRouting(context, buildPolicies({ blockUnexpected: true }));
  assert.equal(state.installed.length, 1);
  assert.equal(handle.active, true);

  const blocked = fakeRoute(req('https://evil.example.org/track.png?secret=1'));
  await state.installed[0]!(blocked.route);
  assert.deepEqual(blocked.log, ['abort:blockedbyclient']);
  assert.equal(handle.isAborted(blocked.request as never), true);
  assert.deepEqual(handle.entries, [{ origin: 'https://evil.example.org', pathname: '/track.png', method: 'GET', resourceType: 'image', handledBy: ALLOWLIST_GUARD, action: 'abort' }]);
  assert.ok(!JSON.stringify(handle.entries).includes('secret=1'), 'the query string is not kept');

  const fine = fakeRoute(req('https://dev.example.com/app.js', { resourceType: 'script' }));
  await state.installed[0]!(fine.route);
  assert.deepEqual(fine.log, ['continue']);
  assert.equal(handle.isAborted(fine.request as never), false);
  assert.equal(handle.entries.length, 1);
});

test('a policy can answer instead of aborting; a policy that throws fails open; a closed page does not throw', async () => {
  const { state, context } = fakeContext();
  const handle = await installRouting(context, [
    (r) => (r.url.includes('/boom') ? (() => { throw new Error('bad policy'); })() : undefined),
    (r) => (r.url.includes('/slow') ? { action: 'fulfill', handledBy: 'fault', status: 503, body: 'x' } : undefined),
  ]);

  const answered = fakeRoute(req('https://dev.example.com/slow'));
  await state.installed[0]!(answered.route);
  assert.deepEqual(answered.log, ['fulfill:503']);
  assert.equal(handle.isAborted(answered.request as never), false, 'an answered request is not an aborted one');

  const broken = fakeRoute(req('https://dev.example.com/boom'));
  await state.installed[0]!(broken.route);
  assert.deepEqual(broken.log, ['continue']);

  const closed = fakeRoute(req('https://dev.example.com/slow'));
  closed.route.fulfill = async () => { throw new Error('Target page, context or browser has been closed'); };
  await assert.doesNotReject(state.installed[0]!(closed.route));
});

test('the evidence of touched requests is capped', async () => {
  const { state, context } = fakeContext();
  const handle = await installRouting(context, [() => ({ action: 'abort', handledBy: 'x' })]);
  for (let i = 0; i < 260; i += 1) await state.installed[0]!(fakeRoute(req(`https://e.example.org/${i}`)).route);
  assert.equal(handle.entries.length, 200);
});
