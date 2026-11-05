import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// T5.7 end to end (real Chromium). The fixture has a session cookie, a server rule with a boundary bug (a total that is wrong from quantity 1000), a
// redirect to an origin that is NOT allowlisted, and an error page that prints a "stack trace". The step must: carry the page's cookie, find the bug with
// the formula oracle, not follow the redirect, not call an address off the allowlist, and never copy a response body into the result.

const listen = (handler: http.RequestListener) =>
  new Promise<{ server: http.Server; origin: string }>((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });

let otherHits = 0;
const other = await listen((_req, res) => {
  otherHits += 1;
  res.end('other origin');
});

const readBody = (req: http.IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });

const calls: Array<{ method: string; url: string; cookie: string; contentType: string }> = [];
const site = await listen(async (req, res) => {
  const url = req.url ?? '/';
  calls.push({ method: req.method ?? '', url, cookie: req.headers.cookie ?? '', contentType: String(req.headers['content-type'] ?? '') });
  const json = (status: number, body: unknown, extra: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...extra });
    res.end(JSON.stringify(body));
  };
  if (url === '/login') {
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'sid=ana-session; Path=/; HttpOnly' });
    return res.end('<!doctype html><title>Login</title><p>logged in</p>');
  }
  if (url === '/api/me') {
    return (req.headers.cookie ?? '').includes('sid=ana-session') ? json(200, { user: { name: 'ana', roles: ['a', 'b'] } }, { 'x-request-id': 'req-42', 'set-cookie': 'rotated=1' }) : json(401, { error: 'no session' });
  }
  if (url === '/api/price' && req.method === 'POST') {
    const { qty, price } = JSON.parse(await readBody(req)) as { qty: number; price: number };
    // The defect: a discount is applied from 1000 units on, by mistake.
    return json(200, { total: qty >= 1000 ? qty * price - 1 : qty * price });
  }
  if (url.startsWith('/api/echo/')) {
    return json(200, { segment: decodeURIComponent(url.slice('/api/echo/'.length)) });
  }
  if (url === '/api/boom') {
    res.writeHead(500, { 'content-type': 'text/plain' });
    return res.end('java.lang.NullPointerException\n\tat com.acme.Secret.run(Secret.java:12) SENTINEL-BODY-TEXT');
  }
  if (url === '/redirect') {
    res.writeHead(302, { location: `${other.origin}/landed` });
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>Home</title><p>home</p>');
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-http-smoke-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = site.origin;

const { resolveExplorationRequest } = await import('../src/runner/resolveRequest.js');
const { runExploration } = await import('../src/runner/runExploration.js');
const { explorationRequestSchema } = await import('../src/schemas/explorationRequest.schema.js');
const { saveTarget } = await import('../src/targets/targetStore.js');

await saveTarget({
  id: 'api-app',
  name: 'API app',
  platform: 'generic',
  environment: 'dev',
  baseUrl: `${site.origin}/`,
  credentialSets: [],
  noiseFilters: [],
  surfaces: {},
  screens: [],
  http: { allowedMethods: ['GET', 'POST'] },
  flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
} as never);

after(async () => {
  for (const { server } of [site, other]) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function run(steps: unknown[]) {
  const request = explorationRequestSchema.parse({ targetProfile: 'api-app', steps });
  return runExploration(await resolveExplorationRequest(request));
}
const login = { id: 'login', action: 'goto', url: `${site.origin}/login` };
const get = (over: Record<string, unknown> = {}) => ({ action: 'httpRequest', name: 'r', method: 'GET', url: '/api/me', ...over });

test('the call carries the cookie the page received, and extracts a JSON path and a header', async () => {
  const result = await run([login, get({ id: 'me', extract: [{ name: 'user', json: 'user.name' }, { name: 'second_role', json: 'user.roles[1]' }, { name: 'rid', header: 'x-request-id' }] })]);
  assert.equal(result.status, 'passed', JSON.stringify(result.error));
  assert.equal(result.extracted.user, 'ana');
  assert.equal(result.extracted.second_role, 'b');
  assert.equal(result.extracted.rid, 'req-42');
  const summary = result.extracted.r as Record<string, unknown>;
  assert.equal(summary.status, 200);
  assert.equal(summary.pathname, '/api/me');
  assert.equal(summary.contentType, 'application/json');
  assert.ok(!JSON.stringify(result.extracted).includes('rotated'), 'a Set-Cookie value is never copied');
  assert.ok(calls.some((call) => call.url === '/api/me' && call.cookie.includes('sid=ana-session')));
});

test('without the session the same call is a 401 and the step fails, naming the path and status', async () => {
  const result = await run([get({ id: 'me' })]);
  assert.equal(result.status, 'failed');
  assert.match(result.steps[0]!.error!.message, /GET \/api\/me answered 401 \(expected 2xx\)/);
  assert.equal((result.extracted.r as Record<string, unknown>).status, 401, 'the answer is kept as evidence');
});

test('expectStatus accepts a status that is the point of the test', async () => {
  const result = await run([get({ expectStatus: [401] })]);
  assert.equal(result.status, 'passed', JSON.stringify(result.error));
});

test('a server rule is checked with the oracle: the total is wrong from 1000 units on', async () => {
  const price = (qty: number) => ({
    id: `price-${qty}`,
    action: 'httpRequest',
    name: `p${qty}`,
    method: 'POST',
    url: '/api/price',
    body: JSON.stringify({ qty, price: 2 }),
    extract: [{ name: `total${qty}`, json: 'total' }],
  });
  const result = await run([
    price(999),
    { action: 'assertEquals', actual: { extracted: 'total999' }, expected: { value: '1998' } },
    price(1000),
    { id: 'rule', action: 'assertEquals', actual: { extracted: 'total1000' }, expected: { value: '2000' } },
  ]);
  assert.equal(result.status, 'failed');
  assert.equal(result.steps[result.failedStepIndex!]!.id, 'rule');
  assert.match(result.steps[result.failedStepIndex!]!.error!.message, /1999/);
  assert.equal(calls.filter((call) => call.url === '/api/price').every((call) => call.contentType === 'application/json'), true, 'JSON is the default content type');
});

test('parameters reach the body and the url: each sample is one call, and the oracle finds the boundary', async () => {
  const steps = [
    {
      id: 'price',
      action: 'httpRequest',
      name: 'p',
      method: 'POST',
      url: '/api/price',
      body: '{"qty": {{qty}}, "price": 2}',
      extract: [{ name: 'total', json: 'total' }],
    },
    { id: 'rule', action: 'assertEquals', actual: { extracted: 'total' }, expected: { expr: 'qty * 2' } },
  ];
  const withSample = async (sample: number) => {
    const request = explorationRequestSchema.parse({
      targetProfile: 'api-app',
      steps,
      parameters: [{ name: 'qty', cases: ['999', '1000'] }],
      seed: 'http-params',
      sample,
    });
    return runExploration(await resolveExplorationRequest(request));
  };

  const ok = await withSample(0);
  assert.equal(ok.status, 'passed', JSON.stringify(ok.error));
  assert.equal(ok.extracted.total, 1998);
  assert.equal(ok.parameters?.values.qty, '999', 'the value that was sent is in the record');

  const bad = await withSample(1);
  assert.equal(bad.status, 'failed');
  assert.equal(bad.steps[bad.failedStepIndex!]!.id, 'rule');
  assert.match(bad.steps[bad.failedStepIndex!]!.error!.message, /qty=1000/);
  assert.equal(bad.parameters?.sample, 1);
  assert.ok(calls.some((call) => call.url === '/api/price'), 'the call really went out');
});

test('a hostile value in the url is one encoded segment: it cannot add a path, a query or another host', async () => {
  const request = explorationRequestSchema.parse({
    targetProfile: 'api-app',
    steps: [{ id: 'echo', action: 'httpRequest', name: 'e', method: 'GET', url: '/api/echo/{{who}}', extract: [{ name: 'seen', json: 'segment' }] }],
    parameters: [{ name: 'who', cases: ['a b/../c?x=1#y'] }],
  });
  const result = await runExploration(await resolveExplorationRequest(request));
  assert.equal(result.status, 'passed', JSON.stringify(result.error));
  assert.equal(result.extracted.seen, 'a b/../c?x=1#y', 'the server saw the whole value as ONE segment');
  assert.ok(calls.some((call) => call.url === '/api/echo/a%20b%2F..%2Fc%3Fx%3D1%23y'));
});

test('an error page is never copied: the result names the status, not the stack trace', async () => {
  const result = await run([get({ id: 'boom', url: '/api/boom' })]);
  assert.equal(result.status, 'failed');
  assert.match(result.steps[0]!.error!.message, /answered 500/);
  assert.ok(!JSON.stringify(result).includes('SENTINEL-BODY-TEXT'));
  assert.ok(!JSON.stringify(result).includes('NullPointerException'));
});

test('a redirect is the answer: it is not followed to an origin that is not allowlisted', async () => {
  otherHits = 0;
  const result = await run([get({ id: 'redirect', url: '/redirect', expectStatus: [302], extract: [{ name: 'where', header: 'location' }] })]);
  assert.equal(result.status, 'passed', JSON.stringify(result.error));
  assert.equal(otherHits, 0, 'the other origin was never called');
  assert.equal((result.extracted.r as Record<string, unknown>).status, 302);
});

test('an address off the allowlist is refused before any request is made', async () => {
  otherHits = 0;
  const result = await run([get({ id: 'off', url: `${other.origin}/x` })]);
  assert.equal(result.status, 'failed');
  assert.match(result.steps[0]!.error!.type, /TargetUrlNotAllowed|NotAllowed/);
  assert.equal(otherHits, 0);
});

test('a method the profile does not list is refused by the runner too, not only by the resolver', async () => {
  const request = explorationRequestSchema.parse({ targetProfile: 'api-app', steps: [get({ id: 'del', method: 'DELETE', url: '/api/me' })] });
  await assert.rejects(() => resolveExplorationRequest(request), /DELETE/);
  // Bypass the resolver on purpose: a resolved request built another way must still be stopped.
  const resolved = await resolveExplorationRequest(explorationRequestSchema.parse({ targetProfile: 'api-app', steps: [get()] }));
  const forged = { ...resolved, steps: [{ ...get({ id: 'del', method: 'DELETE', url: '/api/me' }) }], httpMethods: ['GET' as const, 'POST' as const] };
  const result = await runExploration(forged as never);
  assert.equal(result.status, 'failed');
  assert.match(result.steps[0]!.error!.message, /DELETE is not allowed/);
});
