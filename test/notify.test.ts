import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';

// T3.3: webhook notifications. Pure parts (transitions, presets, scrubbing, egress policy), then the real notifier and the real scheduler engine
// (fake clock, fake dispatcher) against a local HTTP receiver. No browser.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-notify-test-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';

interface Received {
  url: string;
  body: Record<string, any>;
  raw: string;
}
const received: Received[] = [];
const elsewhere: string[] = [];
let respondWith = 200;

const receiver = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    if (req.url?.startsWith('/redirect')) {
      res.writeHead(302, { location: `http://127.0.0.1:${(other.address() as AddressInfo).port}/landed` }).end();
      return;
    }
    let body: Record<string, any> = {};
    try {
      body = JSON.parse(raw);
    } catch {
      /* not JSON */
    }
    received.push({ url: req.url ?? '', body, raw });
    res.writeHead(respondWith, { 'content-type': 'text/plain' }).end(`echo: ${raw}`); // a service that echoes the request: the body must never be kept
  });
});
const other = http.createServer((req, res) => {
  elsewhere.push(req.url ?? '');
  res.writeHead(200).end();
});
await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
process.env.ALLOWED_NOTIFY_ORIGINS = origin;

const { decideChange, verdictOf } = await import('../src/integrations/transitions.js');
const { renderPayload } = await import('../src/integrations/presets.js');
const { changeMessage, summaryMessage } = await import('../src/integrations/message.js');
const { findLeak, scrubText } = await import('../src/integrations/scrub.js');
const { assertNotifyUrl } = await import('../src/integrations/notifyPolicy.js');
const { deliverJson } = await import('../src/integrations/deliver.js');
const { currentStreak, dueSummaryInstant, notifySettled, sendDueSummaries, sendTest } = await import('../src/integrations/notifier.js');
const { getWebhookState } = await import('../src/integrations/webhookStore.js');
const { getWebhookView, listWebhookViews, removeWebhook, saveWebhookDefinition } = await import('../src/integrations/webhookService.js');
const { Scheduler } = await import('../src/scheduler/scheduler.js');
const { getState, listSchedules, putSchedule } = await import('../src/scheduler/scheduleStore.js');
const { removeSchedule, saveScheduleDefinition } = await import('../src/scheduler/scheduleService.js');
const { scheduleSchema } = await import('../src/schemas/schedule.schema.js');
const { saveCredentialSet } = await import('../src/vault/credentials/credentialVault.js');
const { webhooksDir } = await import('../src/config/paths.js');

const T = (text: string): number => Date.parse(text);
const SECRET_PATH = 'T0000/B0000/SUPERSECRETPATHxyz123';
const hookUrl = (name = 'a'): string => `${origin}/services/${name}/${SECRET_PATH}`;
const FAST = { deliver: { retryDelayMs: 1 } };

before(async () => {
  await saveCredentialSet('sentinel-set', { boundOrigins: ['https://dev.example.com'], values: { password: 'S3ntinel-Passw0rd-Value' }, tags: [] }, 'create');
});
after(() => {
  receiver.close();
  other.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(async () => {
  received.length = 0;
  elsewhere.length = 0;
  respondWith = 200;
  for (const { schedule } of await listSchedules()) await removeSchedule(schedule.id);
  for (const view of await listWebhookViews()) await removeWebhook(view.webhook.id);
});

// ---- when to speak (pure) ----------------------------------------------------------------------------------------------------------------

test('transitions: only a CHANGE of verdict speaks; a first red is news, a first green is not', () => {
  assert.deepEqual(decideChange('ok', 'bad'), { kind: 'broken', first: false });
  assert.deepEqual(decideChange('bad', 'ok'), { kind: 'recovered', first: false });
  assert.equal(decideChange('ok', 'ok'), undefined);
  assert.equal(decideChange('bad', 'bad'), undefined, 'still red: silence, however many runs');
  assert.deepEqual(decideChange(undefined, 'bad'), { kind: 'broken', first: true });
  assert.equal(decideChange(undefined, 'ok'), undefined);
});

test('verdictOf: passed is ok; failed, error and a target that cannot run are bad; the rest is not a verdict', () => {
  assert.equal(verdictOf('passed'), 'ok');
  for (const outcome of ['failed', 'error', 'skipped-evaluate']) assert.equal(verdictOf(outcome), 'bad', outcome);
  for (const outcome of ['started', 'skipped-overlap', 'missed']) assert.equal(verdictOf(outcome), undefined, outcome);
});

test('currentStreak: the verdict now and since when, ignoring skipped and missed entries', () => {
  const entry = (at: string, outcome: string) => ({ at, finishedAt: at, outcome }) as never;
  const streak = currentStreak([entry('t1', 'passed'), entry('t2', 'failed'), entry('t3', 'skipped-overlap'), entry('t4', 'error'), entry('t5', 'missed')]);
  assert.deepEqual(streak, { verdict: 'bad', since: 't2' });
  assert.deepEqual(currentStreak([]), {});
});

// ---- presets (pure) ------------------------------------------------------------------------------------------------------------------------

const sampleMessage = () =>
  changeMessage({
    kind: 'broken',
    first: false,
    lang: 'en',
    scheduleId: 'nightly',
    targetLabel: 'routine crud v2',
    outcome: 'failed',
    detail: 'a & b <!channel> *bold*',
    at: '2026-11-03T12:10:00.000Z',
    buildId: 'rev4519',
    failures: ['step s3: AssertionFailed: total is wrong'],
  });

test('presets: generic is plain JSON; slack and google chat are { text } escaped for their markup; teams is an adaptive card', () => {
  const message = sampleMessage();

  const generic = renderPayload('generic', message);
  assert.equal(generic.source, 'scrapforai');
  assert.equal(generic.event, 'broken');
  assert.equal(generic.severity, 'bad');
  assert.ok(Array.isArray(generic.fields));

  const slack = renderPayload('slack', message) as { text: string };
  assert.deepEqual(Object.keys(slack), ['text']);
  assert.match(slack.text, /\*nightly is failing\*/);
  assert.ok(!slack.text.includes('<!channel>'), 'a mention cannot be written by a run');
  assert.match(slack.text, /&lt;!channel&gt;/);
  assert.match(slack.text, /a &amp; b/);

  const chat = renderPayload('googlechat', message) as { text: string };
  assert.deepEqual(Object.keys(chat), ['text']);
  assert.ok(!chat.text.includes('<!channel>'));
  assert.match(chat.text, /\\\*bold\\\*/, 'run text cannot add its own bold');

  const teams = renderPayload('teams', message) as { type: string; attachments: Array<{ contentType: string; content: { type: string; body: Array<{ type: string }> } }> };
  assert.equal(teams.type, 'message');
  assert.equal(teams.attachments[0]!.contentType, 'application/vnd.microsoft.card.adaptive');
  assert.equal(teams.attachments[0]!.content.type, 'AdaptiveCard');
  assert.ok(teams.attachments[0]!.content.body.some((block) => block.type === 'FactSet'));
});

test('messages come in English, Portuguese and Spanish', () => {
  const base = { kind: 'broken' as const, first: false, scheduleId: 'nightly', targetLabel: 'x', outcome: 'failed', at: 'now' };
  assert.match(changeMessage({ ...base, lang: 'en' }).title, /is failing/);
  assert.match(changeMessage({ ...base, lang: 'pt' }).title, /começou a falhar/);
  assert.match(changeMessage({ ...base, lang: 'es' }).title, /empezó a fallar/);
  assert.match(changeMessage({ ...base, kind: 'recovered', lang: 'pt' }).title, /voltou a passar/);
  assert.match(summaryMessage('es', '2026-11-03', 'now', []).text, /Ninguna programación/);
});

// ---- scrubbing and egress ------------------------------------------------------------------------------------------------------------------

test('scrubText: vault values and secret-shaped text are replaced, control and right-to-left characters removed, length bounded', () => {
  const vault = ['S3ntinel-Passw0rd-Value', 'abc'];
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r';
  const scrubbed = scrubText(`login with S3ntinel-Passw0rd-Value failed; token ${jwt} ‮reversed\u0007`, vault);
  assert.ok(!scrubbed.text.includes('S3ntinel'));
  assert.ok(!scrubbed.text.includes('eyJ'));
  assert.ok(!/[‮\u0007]/.test(scrubbed.text));
  assert.equal(scrubbed.redactions, 2);

  assert.equal(scrubText('abcdef', ['abc']).text, 'abcdef', 'a short vault value only matches as the whole text');
  assert.equal(scrubText('abc', ['abc']).text, '[REDACTED]');
  assert.equal(scrubText('x'.repeat(900), []).text.length, 500);
});

test('findLeak: finds a vault value or a secret shape anywhere in a payload, keys included, and never echoes it', () => {
  const vault = ['S3ntinel-Passw0rd-Value'];
  assert.equal(findLeak({ a: [{ b: 'fine' }] }, vault), undefined);
  assert.match(findLeak({ a: [{ b: 'x S3ntinel-Passw0rd-Value x' }] }, vault) ?? '', /vault value/);
  assert.match(findLeak({ 'sk-aaaaaaaaaaaaaaaaaaaaaaaa': 1 }, vault) ?? '', /API key/);
  assert.ok(!(findLeak({ a: 'S3ntinel-Passw0rd-Value' }, vault) ?? '').includes('S3ntinel'));
});

test('egress policy: only origins in ALLOWED_NOTIFY_ORIGINS, no credentials or fragment in the URL, and the refusal never repeats the URL', () => {
  assert.doesNotThrow(() => assertNotifyUrl(hookUrl()));
  const refuse = (url: string, pattern: RegExp) =>
    assert.throws(
      () => assertNotifyUrl(url),
      (error: Error) => {
        assert.match(error.message, pattern);
        assert.ok(!error.message.includes('SUPERSECRET'), 'the secret path is not echoed');
        return true;
      },
    );
  refuse(`https://hooks.slack.com/services/${SECRET_PATH}`, /not in ALLOWED_NOTIFY_ORIGINS/);
  refuse(`http://user:pw@127.0.0.1:${new URL(origin).port}/x/${SECRET_PATH}`, /user name or password/);
  refuse(`${origin}/x/${SECRET_PATH}#frag`, /fragment/);
  refuse(`ftp://127.0.0.1/${SECRET_PATH}`, /http and https/);
  refuse('not a url', /not a valid URL/);
  assert.throws(() => assertNotifyUrl(hookUrl(), []), /ALLOWED_NOTIFY_ORIGINS/, 'an empty list means nothing leaves the server');
});

test('delivery: a redirect is not followed, a 5xx is retried once, the other side\'s reply is not kept', async () => {
  const redirected = await deliverJson(`${origin}/redirect/${SECRET_PATH}`, { a: 1 }, { retryDelayMs: 1 });
  assert.equal(redirected.status, 'failed');
  assert.equal(redirected.httpStatus, 302);
  assert.match(redirected.reason ?? '', /redirects are not followed/);
  assert.deepEqual(elsewhere, [], 'the redirect target was never contacted');

  respondWith = 500;
  const down = await deliverJson(hookUrl(), { a: 1 }, { retryDelayMs: 1 });
  assert.deepEqual([down.status, down.httpStatus, down.attempts], ['failed', 500, 2]);
  assert.ok(!JSON.stringify(down).includes('echo'), 'nothing of the response body is kept');

  respondWith = 404;
  const gone = await deliverJson(hookUrl(), { a: 1 }, { retryDelayMs: 1 });
  assert.equal(gone.attempts, 1, 'a 4xx is not retried');

  const refused = await deliverJson('https://evil.example.com/x', { a: 1 });
  assert.deepEqual([refused.status, refused.attempts], ['failed', 0]);
});

// ---- the webhook entity ---------------------------------------------------------------------------------------------------------------------

test('a webhook: the URL goes to the credential vault, is never read back, and a URL outside the allowlist is refused', async () => {
  await assert.rejects(saveWebhookDefinition('no-url', {}), /url is required/);
  await assert.rejects(saveWebhookDefinition('bad', { url: `https://hooks.slack.com/services/${SECRET_PATH}` }), (error: Error) => {
    assert.equal(error.name, 'NotifyOriginNotAllowed');
    assert.ok(!error.message.includes('SUPERSECRET'));
    return true;
  });
  await assert.rejects(saveWebhookDefinition('bad-time', { url: hookUrl(), dailySummary: { at: '25:99' } }));
  await assert.rejects(saveWebhookDefinition('bad-zone', { url: hookUrl(), dailySummary: { at: '08:00', timezone: 'Mars/Olympus' } }));
  await assert.rejects(saveWebhookDefinition('extra', { url: hookUrl(), password: 'x' }), 'unknown fields are refused');

  const { view, created } = await saveWebhookDefinition('team-chat', { url: hookUrl(), preset: 'slack', lang: 'pt', notes: 'canal #qa' });
  assert.equal(created, true);
  assert.equal(view.urlOrigin, origin);
  assert.equal(view.hasUrl, true);
  assert.equal(view.originAllowed, true);
  assert.equal(JSON.stringify(view).includes('SUPERSECRET'), false, 'the view carries the origin, not the URL');

  const detail = await getWebhookView('team-chat');
  assert.equal(JSON.stringify(detail).includes('SUPERSECRET'), false);

  // On disk: the definition and the state hold nothing secret; the URL is in the (encrypted) vault.
  for (const file of [path.join(webhooksDir(), 'team-chat.json'), path.join(webhooksDir(), 'state', 'team-chat.json'), path.join(dataDir, 'credentials.enc.json')]) {
    assert.equal(fs.readFileSync(file, 'utf8').includes('SUPERSECRET'), false, path.basename(file));
  }
  const { listCredentialSets } = await import('../src/vault/credentials/credentialVault.js');
  const set = (await listCredentialSets()).find((item) => item.id === 'webhook-team-chat')!;
  assert.deepEqual([set.fields, set.boundOrigins, set.tags], [['url'], [origin], ['webhook']]);

  // An update without url keeps the stored one.
  const updated = await saveWebhookDefinition('team-chat', { preset: 'teams' });
  assert.equal(updated.created, false);
  assert.equal(updated.view.hasUrl, true);
  assert.equal((await sendTest('team-chat', FAST))?.status, 'sent');
  assert.equal(received[0]!.body.type, 'message', 'the new preset applies to the old URL');
});

test('a schedule can only notify webhooks that exist, and a webhook a schedule uses cannot be deleted', async () => {
  const body = { cron: '*/10 * * * *', timezone: 'UTC', target: { kind: 'vault' }, notify: ['ghost'] };
  await assert.rejects(saveScheduleDefinition('s1', body), (error: Error) => error.name === 'WebhookNotFound');

  await saveWebhookDefinition('real', { url: hookUrl() });
  await saveScheduleDefinition('s1', { ...body, notify: ['real'] });
  assert.deepEqual((await getWebhookView('real'))!.schedules, ['s1']);
  await assert.rejects(removeWebhook('real'), (error: Error) => error.name === 'WebhookInUse' && /s1/.test(error.message));

  await removeSchedule('s1');
  assert.equal(await removeWebhook('real'), true);
  assert.equal(await getWebhookView('real'), undefined);
  const { getCredentialSetMeta } = await import('../src/vault/credentials/credentialVault.js');
  assert.equal(await getCredentialSetMeta('webhook-real'), undefined, 'the URL left the vault with the webhook');
});

// ---- the scheduler tells the channel -------------------------------------------------------------------------------------------------------

interface Plan {
  outcome: 'passed' | 'failed' | 'error';
  message?: string;
  facts?: { runId?: string; buildId?: string; failures?: string[]; counts?: Record<string, number> };
}

/** A dispatcher that finishes each run at once with the next planned result. */
function planned(plans: Plan[]) {
  let index = 0;
  return {
    async start() {
      const plan = plans[index]!;
      index += 1;
      return { started: true as const, run: { kind: 'suite' as const, id: `suite_${index}` }, done: Promise.resolve(plan) };
    },
    async settledState() {
      return undefined;
    },
  };
}

let clock = T('2026-11-03T12:03:00Z');
function engineWith(plans: Plan[]) {
  return new Scheduler({ dispatcher: planned(plans), now: () => clock, onSettled: (event) => notifySettled(event, FAST) });
}
async function runUntilDone(engine: InstanceType<typeof Scheduler>, times: string[]) {
  for (const time of times) {
    clock = T(time);
    await engine.tick();
    await engine.idle();
  }
}
const TIMES = ['2026-11-03T12:10:05Z', '2026-11-03T12:20:05Z', '2026-11-03T12:30:05Z', '2026-11-03T12:40:05Z', '2026-11-03T12:50:05Z'];

async function register(id: string, notify: string[]) {
  await putSchedule(scheduleSchema.parse({ id, cron: '*/10 * * * *', timezone: 'UTC', target: { kind: 'vault' }, notify }), '2026-11-03T12:03:00Z');
}

test('green -> red -> red -> green -> green: exactly two messages, "broken" then "recovered", each with what a person needs', async () => {
  await saveWebhookDefinition('chan', { url: hookUrl(), preset: 'generic' });
  await register('nightly', ['chan']);
  const engine = engineWith([
    { outcome: 'passed' },
    { outcome: 'failed', message: 'suite red', facts: { runId: 'suite_2', buildId: 'rev4519', counts: { passed: 3, failed: 1 }, failures: ['crud@v2/cred:admin: AssertionFailed'] } },
    { outcome: 'failed', message: 'suite red again' },
    { outcome: 'passed', facts: { runId: 'suite_4' } },
    { outcome: 'passed' },
  ]);
  await runUntilDone(engine, TIMES);

  assert.equal(received.length, 2, 'five runs, two changes');
  const [broken, recovered] = received.map((item) => item.body);
  assert.deepEqual([broken!.event, broken!.severity], ['broken', 'bad']);
  assert.equal(broken!.title, 'nightly is failing');
  const field = (body: Record<string, any>, name: string): string | undefined => body.fields.find((f: { name: string }) => f.name === name)?.value;
  assert.equal(field(broken!, 'Build'), 'rev4519');
  assert.equal(field(broken!, 'Run'), 'suite_2');
  assert.match(field(broken!, 'Failures')!, /AssertionFailed/);
  assert.match(field(broken!, 'Counts')!, /failed: 1/);
  assert.equal(field(broken!, 'Target'), 'regression vault');

  assert.deepEqual([recovered!.event, recovered!.severity], ['recovered', 'good']);
  assert.equal(field(recovered!, 'Failing since'), '2026-11-03T12:20:05.000Z', 'it says since when it was red');

  const state = await getWebhookState('chan');
  assert.equal(state.subjects['schedule:nightly']!.verdict, 'ok');
  assert.deepEqual(state.deliveries.map((d) => [d.kind, d.status]), [['broken', 'sent'], ['recovered', 'sent']]);
});

test('a first result that is red is announced once (flagged as the first this channel sees); a first green is not', async () => {
  await saveWebhookDefinition('chan', { url: hookUrl() });
  await register('fresh-red', ['chan']);
  await runUntilDone(engineWith([{ outcome: 'error', message: 'credential refused' }, { outcome: 'error', message: 'credential refused' }]), TIMES.slice(0, 2));
  assert.equal(received.length, 1);
  assert.equal(received[0]!.body.event, 'broken');
  assert.match(received[0]!.body.text, /First result/);
  assert.match(JSON.stringify(received[0]!.body.fields), /could not run/);
});

test('a webhook that is down is not told it is fixed: the change is retried at the next run, and the run itself is untouched', async () => {
  await saveWebhookDefinition('flaky-chan', { url: hookUrl() });
  await register('s', ['flaky-chan']);
  respondWith = 500;
  const engine = engineWith([{ outcome: 'passed' }, { outcome: 'failed' }, { outcome: 'failed' }]);
  await runUntilDone(engine, TIMES.slice(0, 2));

  const history = (await getState('s'))!.history;
  assert.deepEqual(history.map((entry) => entry.outcome), ['passed', 'failed'], 'a webhook failure never changes the verdict of the run');
  let state = await getWebhookState('flaky-chan');
  assert.deepEqual(state.deliveries.map((d) => [d.kind, d.status, d.httpStatus, d.attempts]), [['broken', 'failed', 500, 2]]);
  assert.equal(state.subjects['schedule:s']!.verdict, 'ok', 'the channel still believes it is green');

  respondWith = 200;
  await runUntilDone(engine, TIMES.slice(2, 3));
  state = await getWebhookState('flaky-chan');
  assert.equal(state.deliveries.at(-1)!.status, 'sent', 'the next red run delivered the pending "broken"');
  assert.equal(state.subjects['schedule:s']!.verdict, 'bad');
});

test('events: a webhook that wants only "broken" is not told about the recovery, but remembers it', async () => {
  await saveWebhookDefinition('only-bad', { url: hookUrl(), events: ['broken'] });
  await register('s', ['only-bad']);
  await runUntilDone(engineWith([{ outcome: 'passed' }, { outcome: 'failed' }, { outcome: 'passed' }, { outcome: 'failed' }]), TIMES.concat('2026-11-03T13:00:05Z').slice(0, 4));
  assert.deepEqual(received.map((item) => item.body.event), ['broken', 'broken'], 'the second "broken" is a change again because the recovery was recorded silently');
});

test('a disabled webhook, an unknown one and several webhooks on one schedule', async () => {
  await saveWebhookDefinition('one', { url: hookUrl('one') });
  await saveWebhookDefinition('two', { url: hookUrl('two'), preset: 'slack' });
  await saveWebhookDefinition('off', { url: hookUrl('off'), enabled: false });
  await register('s', ['one', 'two', 'off', 'one', 'gone']); // a duplicate and a webhook that does not exist: neither stops the others
  await runUntilDone(engineWith([{ outcome: 'passed' }, { outcome: 'failed' }]), TIMES.slice(0, 2));
  assert.deepEqual(received.map((item) => item.url.split('/')[2]).sort(), ['one', 'two']);
  assert.equal(typeof received.find((item) => item.url.includes('/two/'))!.body.text, 'string', 'each webhook gets its own preset');
});

test('a target the scheduler refuses to run (evaluate) is a bad verdict and is announced; an overlap or missed occurrence is not', async () => {
  await saveWebhookDefinition('chan', { url: hookUrl() });
  const schedule = scheduleSchema.parse({ id: 's', cron: '*/10 * * * *', timezone: 'UTC', target: { kind: 'vault' }, notify: ['chan'] });
  await putSchedule(schedule, '2026-11-03T12:03:00Z');
  const engine = new Scheduler({
    dispatcher: { async start() { return { started: false as const, outcome: 'skipped-evaluate' as const, message: 'routine "x" uses evaluate/watch' }; }, async settledState() { return undefined; } },
    now: () => clock,
    onSettled: (event) => notifySettled(event, FAST),
  });
  await runUntilDone(engine, TIMES.slice(0, 2));
  assert.equal(received.length, 1, 'refused twice, told once');
  assert.match(JSON.stringify(received[0]!.body.fields), /not run/);

  const before = received.length;
  for (const outcome of ['skipped-overlap', 'missed', 'started'] as const) {
    assert.deepEqual(await notifySettled({ schedule, outcome, at: 'a', finishedAt: 'b', manual: false, recovered: false }, FAST), []);
  }
  assert.equal(received.length, before);
});

test('a run lost with its process (result unknown) is recorded but not announced as a failure', async () => {
  await saveWebhookDefinition('chan', { url: hookUrl() });
  await register('s', ['chan']);
  const { updateState } = await import('../src/scheduler/scheduleStore.js');
  await updateState('s', (state) => {
    state.history.push({ at: '2026-11-03T12:10:00.000Z', firedAt: '2026-11-03T12:10:01.000Z', outcome: 'started', run: { kind: 'run', id: 'lost' } });
    state.running = { kind: 'run', id: 'lost', startedAt: '2026-11-03T12:10:01.000Z', at: '2026-11-03T12:10:00.000Z' };
  }, '2026-11-03T12:03:00Z');
  const engine = engineWith([]);
  await engine.reconcile();
  await engine.idle();
  assert.equal((await getState('s'))!.history.at(-1)!.outcome, 'error');
  assert.equal(received.length, 0);
});

// ---- nothing secret leaves -----------------------------------------------------------------------------------------------------------------

test('SENTINEL: a vault value, a token and the webhook URL itself inside the failure text never reach the channel', async () => {
  await saveWebhookDefinition('chan', { url: hookUrl('leaky') });
  await register('s', ['chan']);
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r';
  const leaky = `login failed for S3ntinel-Passw0rd-Value; sent ${jwt}; hook ${hookUrl('leaky')}; also sk-abcdefghijklmnopqrstuvwxyz0123456789`;
  await runUntilDone(
    engineWith([{ outcome: 'passed' }, { outcome: 'failed', message: leaky, facts: { runId: 'job_1', failures: [leaky] } }]),
    TIMES.slice(0, 2),
  );

  assert.equal(received.length, 1, 'the message is still delivered, cleaned');
  for (const needle of ['S3ntinel', 'eyJhbGci', 'SUPERSECRET', 'sk-abcdef']) assert.equal(received[0]!.raw.includes(needle), false, `${needle} must not be in the payload`);
  assert.match(received[0]!.raw, /\[REDACTED\]/);

  // ... nor in what the webhook keeps about itself.
  const state = fs.readFileSync(path.join(webhooksDir(), 'state', 'chan.json'), 'utf8');
  for (const needle of ['S3ntinel', 'SUPERSECRET', 'echo']) assert.equal(state.includes(needle), false, `${needle} must not be in the webhook state`);
});

// ---- daily summary ----------------------------------------------------------------------------------------------------------------------------

test('dueSummaryInstant: the latest HH:MM in the webhook\'s own time zone', () => {
  const webhook = (at: string, timezone: string) => ({ id: 'w', preset: 'generic', lang: 'en', enabled: true, events: ['broken', 'recovered'], dailySummary: { at, timezone } }) as never;
  // 08:00 in Montevideo (UTC-3, no DST) = 11:00 UTC
  assert.equal(dueSummaryInstant(webhook('08:00', 'America/Montevideo'), T('2026-11-03T12:00:00Z')), T('2026-11-03T11:00:00Z'));
  assert.equal(dueSummaryInstant(webhook('08:00', 'America/Montevideo'), T('2026-11-03T10:59:59Z')), T('2026-11-02T11:00:00Z'), 'before today\'s time: yesterday\'s');
  assert.equal(dueSummaryInstant({ ...(webhook('08:00', 'UTC') as object), dailySummary: undefined } as never, T('2026-11-03T12:00:00Z')), undefined);
});

test('daily summary: one per day at the chosen time, nothing for the hours before the webhook existed, a failed send is retried after 10 minutes', async () => {
  await saveWebhookDefinition('daily', { url: hookUrl('daily'), lang: 'en', dailySummary: { at: '08:00', timezone: 'UTC' } }, T('2026-11-03T12:00:00Z'));
  await register('green-one', ['daily']);
  await register('red-one', ['daily']);
  await register('not-mine', []);
  const { updateState } = await import('../src/scheduler/scheduleStore.js');
  await updateState('green-one', (state) => void state.history.push({ at: '2026-11-04T07:00:00.000Z', outcome: 'passed', finishedAt: '2026-11-04T07:01:00.000Z' }), 'x');
  await updateState('red-one', (state) => void state.history.push({ at: '2026-11-04T06:00:00.000Z', outcome: 'passed' }, { at: '2026-11-04T07:00:00.000Z', outcome: 'failed', finishedAt: '2026-11-04T07:01:00.000Z' }), 'x');

  const at = (text: string) => ({ ...FAST, now: () => T(text) });
  assert.deepEqual(await sendDueSummaries(at('2026-11-03T12:30:00Z')), [], 'created after 08:00 today: no summary for today');
  assert.deepEqual(await sendDueSummaries(at('2026-11-04T07:59:00Z')), [], 'not yet');

  respondWith = 500;
  const failed = await sendDueSummaries(at('2026-11-04T08:00:20Z'));
  assert.deepEqual(failed.map((d) => [d.kind, d.status]), [['summary', 'failed']]);
  assert.deepEqual(await sendDueSummaries(at('2026-11-04T08:05:00Z')), [], 'retry only after 10 minutes');

  respondWith = 200;
  received.length = 0;
  const sent = await sendDueSummaries(at('2026-11-04T08:11:00Z'));
  assert.deepEqual(sent.map((d) => d.status), ['sent']);
  assert.equal(received.length, 1);
  const body = received[0]!.body;
  assert.equal(body.event, 'summary');
  assert.equal(body.severity, 'bad', 'one schedule is red');
  assert.match(body.title, /2026-11-04/);
  assert.match(body.text, /2 schedule\(s\): 1 passing, 1 failing/);
  assert.deepEqual(body.fields.map((f: { name: string }) => f.name).sort(), ['green-one', 'red-one'], 'only the schedules that notify this webhook');
  assert.match(body.fields.find((f: { name: string }) => f.name === 'red-one').value, /failing since 2026-11-04T07:01:00.000Z/);

  assert.deepEqual(await sendDueSummaries(at('2026-11-04T09:00:00Z')), [], 'one a day');
  received.length = 0;
  assert.equal((await sendDueSummaries(at('2026-11-05T08:00:30Z'))).length, 1, 'and again the next day');
});

test('sendTest: reports a destination that is no longer allowed without sending or echoing the URL', async () => {
  await saveWebhookDefinition('chan', { url: hookUrl() });
  const saved = process.env.ALLOWED_NOTIFY_ORIGINS;
  process.env.ALLOWED_NOTIFY_ORIGINS = 'https://somewhere-else.example.com';
  try {
    const delivery = await sendTest('chan', FAST);
    assert.equal(delivery?.status, 'failed');
    assert.equal(delivery?.attempts, 0);
    assert.match(delivery?.reason ?? '', /not in ALLOWED_NOTIFY_ORIGINS/);
    assert.equal(JSON.stringify(delivery).includes('SUPERSECRET'), false);
    assert.equal(received.length, 0);
    assert.equal((await getWebhookView('chan'))!.originAllowed, false, 'the view says why nothing arrives');
  } finally {
    process.env.ALLOWED_NOTIFY_ORIGINS = saved;
  }
  assert.equal(await sendTest('missing', FAST), undefined);
});

test('T7.8: scrubText masks personal data (document, e-mail) so a message says something was there without carrying it', () => {
  const scrubbed = scrubText('save failed for 529.982.247-25 (maria.perez@example.com.uy), build rev4519', []);
  assert.equal(scrubbed.text, 'save failed for ***.***.***-25 (m***@e***.uy), build rev4519');
  assert.equal(scrubbed.redactions, 2);
  assert.equal(scrubText('nothing personal in rev4519', []).redactions, 0);
});
