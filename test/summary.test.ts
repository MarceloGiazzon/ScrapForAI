import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// T9.3: the periodic summary. Pure rules (which run counts, broke/fixed/still failing/intermittent), then the real stores on disk (targets, library,
// perf series, evolution snapshots), the schedule (validation, file, webhooks in their own language, a webhook that is down), the scheduler engine with
// the real dispatcher, and the route. No browser.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-summary-test-'));
const summaryDir = path.join(dataDir, 'shared-summaries');
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.SYSTEM_EVOLUTION_DIR = path.join(dataDir, 'evolution');
process.env.SUMMARY_OUTPUT_DIR = summaryDir;
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com,https://qa.example.com';
process.env.SCHEDULER_ENABLED = 'false';

const received: Array<{ url: string; body: Record<string, any> }> = [];
let respondWith = 200;
const receiver = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    received.push({ url: req.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
    res.writeHead(respondWith).end();
  });
});
await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
process.env.ALLOWED_NOTIFY_ORIGINS = origin;

const { classifyRegression, effectiveRuns, renderSummaryMarkdown, summaryReportMessage, MESSAGE_LINES_PER_FIELD } = await import('../src/summary/summaryAnalysis.js');
const { getSummary } = await import('../src/summary/summaryService.js');
const { runSummarySchedule, summaryFileStem } = await import('../src/summary/summarySchedule.js');
const { appendPerfRecord } = await import('../src/metrics/perfStore.js');
const { saveTarget } = await import('../src/targets/targetStore.js');
const { saveRoutine } = await import('../src/library/routineService.js');
const { saveScheduleDefinition } = await import('../src/scheduler/scheduleService.js');
const { getState } = await import('../src/scheduler/scheduleStore.js');
const { Scheduler } = await import('../src/scheduler/scheduler.js');
const { createDispatcher } = await import('../src/scheduler/dispatcher.js');
const { saveWebhookDefinition, getWebhookView } = await import('../src/integrations/webhookService.js');
const { notifySettled } = await import('../src/integrations/notifier.js');
const { writeSnapshotFolder, MANIFEST_FILE, sha256 } = await import('../src/evolution/snapshotStore.js');
const { snapshotFolderName } = await import('../src/evolution/snapshotPlan.js');
const { scheduleSchema } = await import('../src/schemas/schedule.schema.js');
const { summaryRouter } = await import('../src/routes/summary.routes.js');
const { default: express } = await import('express');

after(() => {
  receiver.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const FAST = { deliver: { retryDelayMs: 1 } };
/** Monday 2026-11-09 08:00 in Montevideo; the period is the 7 days before it. */
const TO = '2026-11-09T11:00:00.000Z';
const FROM_MS = Date.parse(TO) - 7 * 24 * 60 * 60_000;

interface RecOptions {
  build?: string;
  failedStep?: string;
  retryOf?: string;
  parametric?: true;
}
const rec = (jobId: string, at: string, status: 'passed' | 'failed', options: RecOptions = {}) => ({
  jobId,
  at: `${at}T10:00:00.000Z`,
  version: 1,
  profile: 'full' as const,
  env: 'https://dev.example.com',
  ...(options.build ? { buildId: options.build } : {}),
  status,
  durationMs: 1000,
  steps: [
    { id: 'open', durationMs: 300, status: 'passed' as const },
    { id: options.failedStep ?? 'save', durationMs: 300, status: status === 'failed' ? ('failed' as const) : ('passed' as const) },
  ],
  ...(options.retryOf ? { attempt: 2, retryOf: options.retryOf } : {}),
  ...(options.parametric ? { parametric: true as const } : {}),
});

const routineInput = (records: ReturnType<typeof rec>[], status: 'active' | 'quarantined' = 'active') => ({ id: 'r', status, targetProfile: 'app-dev', records });
const classify = (records: ReturnType<typeof rec>[]) => classifyRegression(routineInput(records), FROM_MS, Date.parse(TO));

test('which runs count: the automatic new attempt replaces the first one, and runs with generated values are left out', () => {
  const runs = effectiveRuns([rec('a', '2026-11-04', 'failed'), rec('b', '2026-11-04', 'passed', { retryOf: 'a' }), rec('c', '2026-11-05', 'failed', { parametric: true }), rec('d', '2026-11-03', 'passed')]);
  assert.deepEqual(runs.map((run) => run.jobId), ['d', 'b'], 'oldest first, the first attempt and the parametric sample gone');
});

test('classifyRegression: broke, fixed, still failing, intermittent, and silence', () => {
  const broke = classify([rec('p0', '2026-10-30', 'passed', { build: 'r1' }), rec('p1', '2026-11-03', 'passed', { build: 'r1' }), rec('f1', '2026-11-05', 'failed', { build: 'r2', failedStep: 'total' }), rec('f2', '2026-11-06', 'failed', { build: 'r2' })]);
  assert.deepEqual(broke, {
    routineId: 'r', targetProfile: 'app-dev', runs: 3, failed: 2, kind: 'broke', since: '2026-11-05T10:00:00.000Z', jobId: 'f1', build: 'r2', previousBuild: 'r1', failedStep: 'total',
  });

  assert.equal(classify([rec('f0', '2026-10-30', 'failed'), rec('p1', '2026-11-04', 'passed', { build: 'r3' }), rec('p2', '2026-11-05', 'passed')])?.kind, 'fixed');
  const fixed = classify([rec('f0', '2026-10-30', 'failed'), rec('p1', '2026-11-04', 'passed', { build: 'r3' })])!;
  assert.equal(fixed.build, 'r3', 'the build of the first pass');

  const still = classify([rec('p0', '2026-10-28', 'passed'), rec('f0', '2026-10-30', 'failed'), rec('f1', '2026-11-04', 'failed')])!;
  assert.equal(still.kind, 'still-failing', 'the streak began before the period: not news of this week');
  assert.equal(still.since, '2026-10-30T10:00:00.000Z');
  assert.equal(classify([rec('f1', '2026-11-04', 'failed'), rec('f2', '2026-11-05', 'failed')])?.kind, 'still-failing', 'never seen passing: it cannot have broken now');

  assert.equal(classify([rec('p0', '2026-10-30', 'passed'), rec('p1', '2026-11-03', 'passed'), rec('f1', '2026-11-04', 'failed'), rec('p2', '2026-11-05', 'passed')])?.kind, 'intermittent');
  assert.equal(classify([rec('p0', '2026-10-30', 'passed'), rec('p1', '2026-11-03', 'passed')]), undefined, 'passing throughout: nothing to say');
  assert.equal(classify([rec('f0', '2026-10-20', 'failed')]), undefined, 'no run in the period');
  assert.equal(classify([rec('p0', '2026-11-03', 'passed'), rec('a', '2026-11-04', 'failed'), rec('b', '2026-11-04', 'passed', { retryOf: 'a' })]), undefined, 'a pass on the new attempt is a pass');
  assert.equal(classifyRegression(routineInput([rec('p', '2026-11-03', 'passed'), rec('f', '2026-11-04', 'failed')], 'quarantined'), FROM_MS, Date.parse(TO))?.quarantined, true);
});

// ---- real stores -----------------------------------------------------------------------------------------------------------------------------

const profile = (id: string, baseUrl = 'https://dev.example.com') => ({
  id, name: id, platform: 'generic' as const, environment: 'dev' as const, baseUrl, credentialSets: [],
  noiseFilters: [], surfaces: {}, screens: [], flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
});
const steps = [{ id: 'open', action: 'goto', url: '$targetUrl' }] as never;

const field = (key: string, over: Record<string, unknown> = {}) => ({ key, label: key, type: 'text', required: false, enabled: true, visible: true, ...over });
async function writeSnapshot(target: string, buildId: string, day: string, fields: unknown[]): Promise<string> {
  const createdAt = `${day}T08:00:00.000Z`;
  const inventory = `${JSON.stringify({ screenId: 'orders', fields, actions: [], grids: [], unkeyed: 0 }, null, 2)}\n`;
  const manifest = {
    schemaVersion: 1, targetProfile: target, environment: 'dev', buildId, buildIdSource: 'provided', createdAt, screenshots: false, complete: true, notCaptured: [],
    screens: [{ id: 'orders', name: 'Orders', inventory: 'screens/orders.json', inventorySha256: sha256(inventory), jobId: 'job_x' }],
  };
  const name = snapshotFolderName(createdAt, buildId);
  await writeSnapshotFolder(target, name, [{ relative: 'screens/orders.json', data: inventory }, { relative: MANIFEST_FILE, data: `${JSON.stringify(manifest, null, 2)}\n` }]);
  return name;
}

let seeded = false;
async function seed(): Promise<void> {
  if (seeded) return;
  seeded = true;
  await saveTarget(profile('app-dev'));
  await saveTarget(profile('app-qa', 'https://qa.example.com'));
  for (const id of ['cart', 'login', 'search', 'export', 'retry', 'idle']) await saveRoutine(id, { title: id, targetProfile: 'app-dev', steps });
  await saveRoutine('parked', { title: 'parked', targetProfile: 'app-dev', steps, status: 'quarantined' });
  await saveRoutine('sketch', { title: 'sketch', targetProfile: 'app-dev', steps, status: 'draft' });
  await saveRoutine('qa-smoke', { title: 'qa smoke', targetProfile: 'app-qa', steps });

  const series: Record<string, ReturnType<typeof rec>[]> = {
    cart: [rec('c0', '2026-10-30', 'passed', { build: 'r1' }), rec('c1', '2026-11-03', 'passed', { build: 'r1' }), rec('c2', '2026-11-05', 'failed', { build: 'r2', failedStep: 'total' }), rec('c3', '2026-11-06', 'failed', { build: 'r2' })],
    login: [rec('l0', '2026-10-30', 'failed'), rec('l1', '2026-11-04', 'passed', { build: 'r2' })],
    search: [rec('s0', '2026-10-30', 'failed'), rec('s1', '2026-11-04', 'failed')],
    export: [rec('e0', '2026-10-30', 'passed'), rec('e1', '2026-11-03', 'failed'), rec('e2', '2026-11-04', 'passed')],
    retry: [rec('t0', '2026-11-03', 'passed'), rec('t1', '2026-11-04', 'failed'), rec('t2', '2026-11-04', 'passed', { retryOf: 't1' })],
    idle: [rec('i0', '2026-10-20', 'failed')],
    parked: [rec('k0', '2026-11-03', 'passed'), rec('k1', '2026-11-04', 'failed')],
    sketch: [rec('d0', '2026-11-03', 'passed'), rec('d1', '2026-11-04', 'failed')],
    'qa-smoke': [rec('q0', '2026-11-03', 'passed'), rec('q1', '2026-11-04', 'failed')],
  };
  for (const [id, records] of Object.entries(series)) for (const record of records) await appendPerfRecord(id, record);

  await writeSnapshot('app-dev', 'r1', '2026-10-25', [field('customer')]);
  await writeSnapshot('app-dev', 'r2', '2026-11-04', [field('customer'), field('phone')]);
  await writeSnapshot('app-dev', 'r3', '2026-11-06', [field('customer', { required: true }), field('phone')]);
  await writeSnapshot('app-qa', 'q1', '2026-11-05', [field('customer')]);
}

test('getSummary reads the stores: regressions by kind, quarantine apart, drafts out, evolution pairs of the period, filter by target', async () => {
  await seed();
  const report = await getSummary({ to: new Date(TO), days: 7 });
  assert.equal(report.period.from, '2026-11-02T11:00:00.000Z');

  const kinds = Object.fromEntries(report.regressions.items.map((item) => [item.routineId, item.kind]));
  assert.deepEqual(kinds, { cart: 'broke', 'qa-smoke': 'broke', search: 'still-failing', export: 'intermittent', login: 'fixed', parked: 'broke' });
  assert.equal(report.regressions.items.at(-1)!.routineId, 'parked', 'quarantined ones last');
  assert.deepEqual(report.regressions.counts, { broke: 2, fixed: 1, 'still-failing': 1, intermittent: 1 }, 'the quarantined routine is listed, not counted');
  const cart = report.regressions.items.find((item) => item.routineId === 'cart')!;
  assert.equal(cart.build, 'r2');
  assert.equal(cart.previousBuild, 'r1');
  assert.equal(cart.failedStep, 'total');

  const dev = report.evolution.find((item) => item.target === 'app-dev')!;
  assert.deepEqual(dev.firstSnapshots, []);
  assert.deepEqual(dev.pairs.map((pair) => `${pair.from}->${pair.to}`), ['r1->r2', 'r2->r3'], 'the r1 snapshot is before the period but is the base of the first pair');
  assert.equal(dev.pairs[0]!.counts!.screensChanged, 1);
  assert.deepEqual(report.evolution.find((item) => item.target === 'app-qa')!.firstSnapshots, ['q1']);
  assert.equal(report.counts.snapshots, 3);
  assert.equal(report.counts.screensChanged, 2);

  assert.equal(report.health.totals.targets, 2);
  assert.equal(report.health.targets.find((target) => target.id === 'app-dev')!.status, 'red');

  const only = await getSummary({ to: new Date(TO), days: 7, targets: ['app-dev'] });
  assert.equal(only.regressions.items.some((item) => item.routineId === 'qa-smoke'), false);
  assert.deepEqual(only.health.targets.map((target) => target.id), ['app-dev']);
  assert.deepEqual(only.evolution.map((item) => item.target), ['app-dev']);

  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('"title"'), false, 'no free text from routines');
});

test('Markdown and webhook message in three languages; empty sections left out of the message; long sections cut with a count', async () => {
  await seed();
  const report = await getSummary({ to: new Date(TO), days: 7 });
  const en = renderSummaryMarkdown(report, 'en');
  assert.match(en, /^# ScrapForAI summary, 2026-11-02 to 2026-11-09/);
  assert.match(en, /## Regressions\n\n- cart \[app-dev\]: broke, 3 run\(s\), 2 failed, since 2026-11-05 10:00, build r2, last good build r1, step total/);
  assert.match(en, /parked \[app-dev\]: broke.*quarantined, not counted/);
  assert.match(en, /app-dev r1 -> r2: 1 changed, 0 added, 0 removed; no declared changes/);
  assert.match(en, /app-qa: q1: first snapshot \(baseline\)/);
  assert.match(renderSummaryMarkdown(report, 'pt'), /## Regressões[\s\S]*cart \[app-dev\]: quebrou/);
  assert.match(renderSummaryMarkdown(report, 'es'), /## Regresiones[\s\S]*cart \[app-dev\]: se rompió/);

  const message = summaryReportMessage(report, 'pt');
  assert.equal(message.kind, 'summary');
  assert.equal(message.severity, 'bad');
  assert.ok(message.fields.every((item) => item.value.length > 0));
  assert.equal(message.fields.some((item) => item.name === 'Acessibilidade'), false, 'no audit in the period: no empty field');

  const crowded = { ...report, regressions: { ...report.regressions, items: Array.from({ length: 12 }, (_, i) => ({ ...report.regressions.items[0]!, routineId: `r${i}` })) } };
  const regressions = summaryReportMessage(crowded, 'en').fields.find((item) => item.name === 'Regressions')!;
  assert.equal(regressions.value.split('\n').length, MESSAGE_LINES_PER_FIELD + 1);
  assert.match(regressions.value, /\.\.\. and 4 more$/);
});

test('a tampered snapshot is reported by its error code, never by a path, and the rest of the summary still comes', async () => {
  await seed();
  const target = 'app-dev';
  const folder = path.join(process.env.SYSTEM_EVOLUTION_DIR!, target, snapshotFolderName('2026-11-06T08:00:00.000Z', 'r3'));
  const file = path.join(folder, 'screens', 'orders.json');
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original.replace('customer', 'client'));
  try {
    const report = await getSummary({ to: new Date(TO), days: 7 });
    const pair = report.evolution.find((item) => item.target === target)!.pairs.find((item) => item.to === 'r3')!;
    assert.equal(pair.error, 'SnapshotTampered');
    assert.equal(pair.counts, undefined);
    assert.equal(JSON.stringify(report).includes(dataDir.replace(/\\/g, '\\\\')), false);
    assert.match(renderSummaryMarkdown(report, 'en'), /r2 -> r3: could not be compared \(SnapshotTampered\)/);
  } finally {
    fs.writeFileSync(file, original);
  }
});

test('summary schedules: validation, the file in its language, each webhook in its own, a webhook that is down makes the outcome error', async () => {
  await seed();
  const base = { cron: '0 8 * * MON', timezone: 'America/Montevideo', enabled: true, overlap: 'skip', jitterSeconds: 0, retries: 1 };
  await assert.rejects(saveScheduleDefinition('nowhere', { ...base, notify: [], target: { kind: 'summary', file: false } }), (error: Error) => error.name === 'SummaryHasNoOutput');
  await assert.rejects(saveScheduleDefinition('ghost', { ...base, notify: [], target: { kind: 'summary', targets: ['nope'] } }), (error: Error) => error.name === 'TargetProfileNotFound');
  assert.throws(() => scheduleSchema.parse({ id: 'x', cron: '@daily', target: { kind: 'summary', periodDays: 60 } }), 'at most 31 days');

  await saveWebhookDefinition('team-pt', { url: `${origin}/pt`, preset: 'generic', lang: 'pt' });
  await saveWebhookDefinition('team-es', { url: `${origin}/es`, preset: 'slack', lang: 'es' });
  await saveWebhookDefinition('muted', { url: `${origin}/muted`, enabled: false });
  const { view } = await saveScheduleDefinition('weekly', { ...base, notify: ['team-pt', 'team-es', 'muted'], target: { kind: 'summary', lang: 'en', targets: ['app-dev'] } });
  assert.deepEqual(view.schedule.target, { kind: 'summary', periodDays: 7, lang: 'en', file: true, targets: ['app-dev'] });

  received.length = 0;
  respondWith = 200;
  const settled = await runSummarySchedule(view.schedule, TO, FAST);
  assert.equal(settled.outcome, 'passed', settled.message);
  assert.match(settled.message!, /file weekly\/2026-11-09_0800\.md, 2\/2 webhook\(s\)/);
  assert.equal(settled.facts?.counts?.broke, 1, 'app-dev only: cart (qa-smoke is on app-qa, parked is quarantined)');

  const stem = path.join(summaryDir, 'weekly', '2026-11-09_0800');
  assert.match(fs.readFileSync(`${stem}.md`, 'utf8'), /^# ScrapForAI summary/);
  assert.equal(JSON.parse(fs.readFileSync(`${stem}.json`, 'utf8')).kind, 'scrapforai-summary');

  assert.deepEqual(received.map((item) => item.url).sort(), ['/es', '/pt'], 'the disabled webhook is skipped');
  const pt = received.find((item) => item.url === '/pt')!.body;
  assert.equal(pt.event, 'summary');
  assert.match(pt.title, /^Resumo do ScrapForAI, 2026-11-02 a 2026-11-09/);
  assert.match(received.find((item) => item.url === '/es')!.body.text, /Resumen de ScrapForAI/);
  const deliveries = (await getWebhookView('team-pt'))!.deliveries;
  assert.equal(deliveries.at(-1)!.kind, 'summary');
  assert.equal(deliveries.at(-1)!.subject, 'summary:weekly');

  // A summary run is never told to the channel as "broken"/"recovered": the message is the summary itself.
  received.length = 0;
  await notifySettled({ schedule: view.schedule, outcome: 'error', at: TO, finishedAt: TO, manual: false, recovered: false });
  assert.equal(received.length, 0);

  respondWith = 500;
  const down = await runSummarySchedule(view.schedule, TO, FAST);
  assert.equal(down.outcome, 'error');
  assert.match(down.message!, /file weekly\/2026-11-09_0800\.md, 0\/2 webhook\(s\); webhook team-pt: failed/);
  respondWith = 200;
});

test('the scheduler engine runs a summary schedule through the real dispatcher (run-now) and records it in the history', async () => {
  await seed();
  await saveScheduleDefinition('weekly-file', { cron: '0 8 * * MON', notify: [], target: { kind: 'summary', periodDays: 3, lang: 'pt' } });
  const scheduler = new Scheduler({ dispatcher: createDispatcher(), now: () => Date.parse(TO) });
  const started = await scheduler.runNow('weekly-file');
  assert.equal(started.run?.kind, 'summary');
  await scheduler.idle();
  const entry = (await getState('weekly-file'))!.history.at(-1)!;
  assert.equal(entry.outcome, 'passed', entry.message);
  assert.match(fs.readFileSync(path.join(summaryDir, 'weekly-file', '2026-11-09_0800.md'), 'utf8'), /^# Resumo do ScrapForAI, 2026-11-06 a 2026-11-09/);
});

test('file names use the local date and time of the schedule zone', () => {
  assert.equal(summaryFileStem(Date.parse('2026-11-09T02:30:00.000Z'), 'America/Montevideo'), '2026-11-08_2330');
  assert.equal(summaryFileStem(Date.parse('2026-11-09T02:30:00.000Z'), 'UTC'), '2026-11-09_0230');
});

test('GET /v1/summary: JSON with markdown, ?format=md, bad query 400, unknown target 404', async () => {
  await seed();
  const app = express();
  app.use('/v1/summary', summaryRouter);
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/summary`;
  try {
    const json = await (await fetch(`${url}?days=30&target=app-dev&lang=es`)).json();
    assert.equal(json.kind, 'scrapforai-summary');
    assert.equal(json.period.days, 30);
    assert.deepEqual(json.targets, ['app-dev']);
    assert.match(json.markdown, /^# Resumen de ScrapForAI/);

    const md = await fetch(`${url}?format=md`);
    assert.match(md.headers.get('content-type') ?? '', /text\/markdown/);
    assert.match(await md.text(), /^# ScrapForAI summary/);

    assert.equal((await fetch(`${url}?days=0`)).status, 400);
    assert.equal((await fetch(`${url}?lang=fr`)).status, 400);
    assert.equal((await fetch(`${url}?extra=1`)).status, 400);
    const missing = await fetch(`${url}?target=app-dev,ghost`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.type, 'TargetProfileNotFound');
  } finally {
    server.close();
  }
});
