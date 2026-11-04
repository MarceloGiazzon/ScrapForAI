import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// T3.3 (last test): the same engine tells a webhook about a CHANGE of verdict, through the real routes and a real Chromium run.
// T3.2 end to end (real Chromium, the real dispatcher and the real HTTP routes): a schedule is stored through PUT, started with run-now, runs
// a routine and a vault suite in the job queue at `scheduled` priority, and the history records the verdicts; the bearer token is required to
// write; an evaluate routine is refused; the second run-now while one is going is skipped.

let siteBroken = false; // the T3.3 test flips this: the page then has no #t
const site = await new Promise<{ server: http.Server; origin: string }>((resolve) => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>T</title>${siteBroken && req.url === '/flip' ? '<p>maintenance</p>' : `<h1 id="t">${req.url === '/slow' ? 'slow' : 'ok'}</h1>`}`);
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
});

const hookCalls: Array<{ url: string; body: Record<string, any>; raw: string }> = [];
const hookServer = await new Promise<{ server: http.Server; origin: string }>((resolve) => {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      hookCalls.push({ url: req.url ?? '', body: JSON.parse(raw), raw });
      res.writeHead(200).end('ok');
    });
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-scheduler-smoke-'));
const API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_API_KEY = API_KEY;
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = site.origin;
process.env.ALLOWED_RESOURCE_ORIGINS = site.origin;
process.env.MAX_PARALLEL_JOBS = '3';
process.env.SCHEDULER_ENABLED = 'true';
process.env.SCHEDULER_TICK_SECONDS = '3600'; // the clock never fires here: only run-now does
process.env.ALLOW_EVALUATE = 'true';
process.env.ALLOWED_NOTIFY_ORIGINS = hookServer.origin;

const express = (await import('express')).default;
const { apiAuth } = await import('../src/security/apiAuth.js');
const { schedulesRouter } = await import('../src/routes/schedules.routes.js');
const { webhooksRouter } = await import('../src/routes/webhooks.routes.js');
const { credentialsRouter } = await import('../src/routes/credentials.routes.js');
const { startScheduler, stopScheduler } = await import('../src/scheduler/runtime.js');
const { saveTarget } = await import('../src/targets/targetStore.js');
const { saveRoutine } = await import('../src/library/routineService.js');

const app = express();
app.use(express.json());
app.use(apiAuth);
app.use('/v1/schedules', schedulesRouter);
app.use('/v1/webhooks', webhooksRouter);
app.use('/v1/credentials', credentialsRouter);
const api = app.listen(0);
await new Promise<void>((resolve) => api.once('listening', resolve));
const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

after(async () => {
  stopScheduler();
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await new Promise<void>((resolve) => site.server.close(() => resolve()));
  await new Promise<void>((resolve) => hookServer.server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method: string, urlPath: string, body?: unknown, auth = true) {
  const response = await fetch(`${apiUrl}${urlPath}`, {
    method,
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${API_KEY}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

const until = async <T>(read: () => Promise<T | undefined>, ms = 60_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};

test('store a schedule over HTTP, run it now, read the verdict from its history', async () => {
  await saveTarget({
    id: 'app', name: 'App', platform: 'generic', environment: 'dev', baseUrl: `${site.origin}/`, credentialSets: [],
    noiseFilters: [], surfaces: {}, screens: [], flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  });
  await saveRoutine('home', { title: 'home', targetProfile: 'app', steps: [{ id: 'open', action: 'goto', url: '$targetUrl' }, { id: 'h', action: 'assertVisible', selector: '#t' }] as never });
  await saveRoutine('broken', { title: 'broken', targetProfile: 'app', steps: [{ id: 'open', action: 'goto', url: '$targetUrl' }, { id: 'h', action: 'assertVisible', selector: '#nope', timeoutMs: 500 }] as never });
  await saveRoutine('js', { title: 'js', targetProfile: 'app', steps: [{ id: 'open', action: 'goto', url: '$targetUrl' }, { id: 'e', action: 'evaluate', name: 'x', script: '1+1' }] as never });

  // Writing needs the bearer token; reading does not widen anything.
  const body = { cron: '0 3 * * *', timezone: 'America/Montevideo', target: { kind: 'routine', routineId: 'home' } };
  assert.equal((await call('PUT', '/v1/schedules/nightly-home', body, false)).status, 401);
  const created = await call('PUT', '/v1/schedules/nightly-home', body);
  assert.equal(created.status, 201);
  assert.equal(created.body.next.length, 3);
  assert.equal((await call('PUT', '/v1/schedules/nightly-home', { ...body, jitterSeconds: 30 })).status, 200);
  assert.equal((await call('PUT', '/v1/schedules/bad', { ...body, cron: '99 * * * *' })).status, 400);
  assert.equal((await call('PUT', '/v1/schedules/bad', { ...body, target: { kind: 'routine', routineId: 'ghost' } })).status, 404);

  // Before the scheduler exists in this process, run-now is a 409.
  assert.equal((await call('POST', '/v1/schedules/nightly-home/run-now')).status, 409);
  const scheduler = await startScheduler((message, error) => process.stderr.write(`${message}: ${String(error)}\n`));
  assert.ok(scheduler);
  assert.equal((await call('GET', '/v1/schedules')).body.schedulerRunning, true);

  const started = await call('POST', '/v1/schedules/nightly-home/run-now');
  assert.equal(started.status, 202);
  assert.equal(started.body.outcome, 'started');
  await scheduler.idle();

  const shown = await call('GET', '/v1/schedules/nightly-home');
  assert.equal(shown.body.running, undefined);
  assert.equal(shown.body.history[0].outcome, 'passed');
  assert.equal(shown.body.history[0].manual, true);
  assert.match(shown.body.history[0].message, /^job_/);
  assert.equal(shown.body.lastRun.outcome, 'passed');
  assert.deepEqual(shown.body.counts, { passed: 1 });
});

test('a failing routine is recorded as failed; a suite and the vault are scheduled too; evaluate is refused', async () => {
  const scheduler = (await import('../src/scheduler/runtime.js')).getScheduler()!;

  await call('PUT', '/v1/schedules/breaks', { cron: '0 3 * * *', target: { kind: 'routine', routineId: 'broken' } });
  await call('POST', '/v1/schedules/breaks/run-now');
  await scheduler.idle();
  assert.equal((await call('GET', '/v1/schedules/breaks')).body.history[0].outcome, 'failed');

  await call('PUT', '/v1/schedules/suite', { cron: '0 4 * * *', target: { kind: 'suite', suite: { name: 'both', items: [{ routineId: 'home' }, { routineId: 'broken' }] } } });
  await call('POST', '/v1/schedules/suite/run-now');
  await scheduler.idle();
  const suite = (await call('GET', '/v1/schedules/suite')).body.history[0];
  assert.equal(suite.outcome, 'failed', 'one red routine makes the suite red');
  assert.equal(suite.run.kind, 'suite');
  assert.match(suite.message, /1 of 2 run\(s\) failed/);

  await call('PUT', '/v1/schedules/js', { cron: '0 5 * * *', target: { kind: 'routine', routineId: 'js' } });
  const refused = (await call('POST', '/v1/schedules/js/run-now')).body;
  assert.equal(refused.outcome, 'skipped-evaluate');
  assert.match(refused.message, /SCHEDULED_ALLOW_EVALUATE/);
  await scheduler.idle();

  // The vault target with nothing in the vault cannot make a suite: the reason is recorded, nothing hangs.
  await call('PUT', '/v1/schedules/vault', { cron: '0 6 * * *', target: { kind: 'vault' } });
  const vault = (await call('POST', '/v1/schedules/vault/run-now')).body;
  assert.equal(vault.outcome, 'error');
  assert.match(vault.message, /No regression-vault item matches/);
});

test('run-now while the previous run is still going is skipped, and deleting a schedule removes it', async () => {
  const scheduler = (await import('../src/scheduler/runtime.js')).getScheduler()!;
  await call('PUT', '/v1/schedules/twice', { cron: '0 7 * * *', target: { kind: 'suite', suite: { name: 'two', items: [{ routineId: 'home' }, { routineId: 'home' }, { routineId: 'home' }] } } });

  const first = (await call('POST', '/v1/schedules/twice/run-now')).body;
  assert.equal(first.outcome, 'started');
  const second = (await call('POST', '/v1/schedules/twice/run-now')).body;
  assert.equal(second.outcome, 'skipped-overlap');
  assert.equal(scheduler.isRunning('twice'), true);
  await until(async () => ((await call('GET', '/v1/schedules/twice')).body.running ? undefined : true));
  await scheduler.idle();

  const history = (await call('GET', '/v1/schedules/twice')).body.history;
  assert.deepEqual(history.map((entry: { outcome: string }) => entry.outcome).sort(), ['passed', 'skipped-overlap']);

  assert.equal((await call('DELETE', '/v1/schedules/twice', undefined, false)).status, 401);
  assert.equal((await call('DELETE', '/v1/schedules/twice')).status, 204);
  assert.equal((await call('GET', '/v1/schedules/twice')).status, 404);
});

test('T3.3: a webhook hears about green -> red -> red -> green, once each, with the failing step and run; the URL never comes back', async () => {
  const scheduler = (await import('../src/scheduler/runtime.js')).getScheduler()!;
  await saveRoutine('flip', { title: 'flip', targetProfile: 'app', steps: [{ id: 'open', action: 'goto', url: `${site.origin}/flip` }, { id: 'h', action: 'assertVisible', selector: '#t', timeoutMs: 500 }] as never });

  const secretUrl = `${hookServer.origin}/services/T0000/B0000/SUPERSECRETPATHxyz123`;
  assert.equal((await call('PUT', '/v1/webhooks/chan', { url: secretUrl }, false)).status, 401, 'a webhook sends data out: bearer only');
  const refusedOrigin = await call('PUT', '/v1/webhooks/evil', { url: 'https://evil.example.com/hook/SUPERSECRETPATHxyz123' });
  assert.equal(refusedOrigin.status, 400);
  assert.equal(refusedOrigin.body.error.type, 'NotifyOriginNotAllowed');
  assert.equal(JSON.stringify(refusedOrigin.body).includes('SUPERSECRET'), false);

  const created = await call('PUT', '/v1/webhooks/chan', { url: secretUrl, preset: 'generic', lang: 'en' });
  assert.equal(created.status, 201);
  assert.equal(created.body.urlOrigin, hookServer.origin);
  assert.equal(JSON.stringify(created.body).includes('SUPERSECRET'), false);
  assert.equal(JSON.stringify((await call('GET', '/v1/webhooks')).body).includes('SUPERSECRET'), false);
  assert.equal((await call('GET', '/v1/credentials/webhook-chan')).body.fields.join(), 'url', 'the URL lives in the credential vault');
  assert.equal((await call('PUT', '/v1/schedules/flip', { cron: '0 8 * * *', target: { kind: 'routine', routineId: 'flip' }, notify: ['ghost'] })).status, 404);
  assert.equal((await call('PUT', '/v1/schedules/flip', { cron: '0 8 * * *', target: { kind: 'routine', routineId: 'flip' }, notify: ['chan'] })).status, 201);

  const test = await call('POST', '/v1/webhooks/chan/test');
  assert.equal(test.status, 200);
  assert.equal(hookCalls.at(-1)!.body.event, 'test');
  hookCalls.length = 0;

  const runNow = async () => {
    await call('POST', '/v1/schedules/flip/run-now');
    await scheduler.idle();
  };
  siteBroken = false;
  await runNow(); // green: nothing to say
  assert.equal(hookCalls.length, 0);
  siteBroken = true;
  await runNow(); // green -> red
  await runNow(); // still red: silence
  siteBroken = false;
  await runNow(); // red -> green

  assert.deepEqual(hookCalls.map((call) => call.body.event), ['broken', 'recovered']);
  const [broken, recovered] = hookCalls.map((call) => call.body);
  const field = (body: Record<string, any>, name: string): string | undefined => body.fields.find((f: { name: string }) => f.name === name)?.value;
  assert.equal(broken!.title, 'flip is failing');
  assert.match(field(broken!, 'Run')!, /^job_/);
  assert.match(field(broken!, 'Failures')!, /step h/, 'the failing step is named');
  assert.equal(field(broken!, 'Target'), 'routine flip');
  assert.ok(field(recovered!, 'Failing since'));
  for (const call of hookCalls) assert.equal(call.raw.includes('SUPERSECRET'), false);

  const detail = (await call('GET', '/v1/webhooks/chan')).body;
  assert.deepEqual(detail.deliveries.map((d: { kind: string; status: string }) => [d.kind, d.status]), [['recovered', 'sent'], ['broken', 'sent'], ['test', 'sent']]);
  assert.equal(detail.known['schedule:flip'].verdict, 'ok');
  assert.equal((await call('DELETE', '/v1/webhooks/chan')).status, 409, 'a schedule still notifies it');
  assert.equal((await call('DELETE', '/v1/schedules/flip')).status, 204);
  assert.equal((await call('DELETE', '/v1/webhooks/chan')).status, 204);
});
