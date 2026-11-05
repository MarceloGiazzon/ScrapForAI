import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';

// T9.1: bug reports. Pure parts first (signature, markdown safety, rendering, "since when"), then the real service, adapter and routes against a
// local stand-in for GitHub that records every request. No browser: a run is a result.json written by the test.

const API_KEY = 'test-api-key-1234567890';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-bug-test-'));
process.env.SCRAPFORAI_API_KEY = API_KEY;
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts'); // .env may pin it
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  raw: string;
}
const seen: Seen[] = [];
const elsewhere: string[] = [];
let answer: { status: number; redirect?: boolean; slowMs?: number } = { status: 201 };

const github = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, raw });
    const reply = (): void => {
      if (answer.redirect) {
        res.writeHead(302, { location: `http://127.0.0.1:${(other.address() as AddressInfo).port}/landed` }).end();
      } else if (req.method === 'GET' && req.url === '/repos/acme/shop' && answer.status === 201) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ has_issues: true, full_name: 'acme/shop' }));
      } else if (answer.status === 201) {
        res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ number: 42, html_url: 'https://github.example/acme/shop/issues/42', echo: raw }));
      } else {
        res.writeHead(answer.status, { 'content-type': 'text/plain' }).end(`echo: ${raw}`); // a service that echoes the request: an error body must never be kept
      }
    };
    if (answer.slowMs) setTimeout(reply, answer.slowMs);
    else reply();
  });
});
const other = http.createServer((req, res) => {
  elsewhere.push(req.url ?? '');
  res.writeHead(200).end();
});
await new Promise<void>((resolve) => github.listen(0, '127.0.0.1', resolve));
await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;
process.env.ALLOWED_INTEGRATION_ORIGINS = origin;

const express = (await import('express')).default;
const { env } = await import('../src/config/env.js');
const { apiAuth } = await import('../src/security/apiAuth.js');
const { bugReportsRouter } = await import('../src/routes/bugReports.routes.js');
const { integrationsRouter } = await import('../src/routes/integrations.routes.js');
const { bugSignature } = await import('../src/bugreport/signature.js');
const { fenced, inlineCode, titleSafe } = await import('../src/bugreport/markdownSafe.js');
const { BUG_STRINGS, renderIssue, MAX_BODY_CHARS } = await import('../src/bugreport/render.js');
const { sinceWhen } = await import('../src/bugreport/since.js');
const { BugReportError, chooseIntegration, dismissBugReport, draftBugReport, resolveBugReport, sendBugReport } = await import('../src/bugreport/service.js');
const { getBugReport, listBugReports } = await import('../src/bugreport/store.js');
const { autoDraftBugReports } = await import('../src/bugreport/autoDraft.js');
const { assertIntegrationUrl } = await import('../src/integrations/integrationPolicy.js');
const { getIntegrationView, listIntegrationViews, removeIntegration, saveIntegrationDefinition, testIntegration } = await import('../src/integrations/integrationService.js');
const { appendPerfRecord } = await import('../src/metrics/perfStore.js');
const { saveCredentialSet } = await import('../src/vault/credentials/credentialVault.js');
const { bugReportsDir, shrinksDir, suitesDir } = await import('../src/config/paths.js');
const { suiteRequestSchema } = await import('../src/schemas/suiteRequest.schema.js');

const TOKEN = 'ghp_FAKEtokenFORtestingOnly0123456789abcdef';
const VAULT_SECRET = 'S3ntinel-Passw0rd-Value';
const CPF = '529.982.247-25'; // a valid CPF (check digits are right), so the personal-data detector sees it

let server: http.Server;
let baseUrl: string;
const bearer = { authorization: `Bearer ${API_KEY}` };

before(async () => {
  await saveCredentialSet('sentinel-set', { boundOrigins: ['https://dev.example.com'], values: { password: VAULT_SECRET }, tags: [] }, 'create');
  const app = express();
  app.use(express.json());
  app.use(apiAuth);
  app.use('/v1/bug-reports', bugReportsRouter);
  app.use('/v1/integrations', integrationsRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  github.close();
  other.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(async () => {
  seen.length = 0;
  elsewhere.length = 0;
  answer = { status: 201 };
  process.env.ALLOWED_INTEGRATION_ORIGINS = origin;
  fs.rmSync(bugReportsDir(), { recursive: true, force: true });
  for (const view of await listIntegrationViews()) await removeIntegration(view.integration.id);
});

// ---- helpers ---------------------------------------------------------------------------------------------------------------------------------

let counter = 0;
interface RunOptions {
  jobId?: string;
  at?: string;
  message?: string;
  stepId?: string;
  errorType?: string;
  routine?: boolean;
  status?: string;
  parameters?: boolean;
  targetUrl?: string;
  consoleErrors?: string[];
  buildId?: string;
}

/** Writes the evidence of a failed run the way the runner would (result.json + request.json). */
function makeRun(options: RunOptions = {}): string {
  counter += 1;
  const jobId = options.jobId ?? `job_bug${counter}`;
  const stepId = options.stepId ?? 'total';
  const errorType = options.errorType ?? 'StepExecutionError';
  const message = options.message ?? 'Expected the total to be 4 but it was 5';
  const dir = path.join(env.ARTIFACT_DIR, jobId);
  fs.mkdirSync(dir, { recursive: true });
  const result = {
    jobId,
    scenarioName: 'Cart total',
    status: options.status ?? 'failed',
    startedAt: options.at ?? '2026-11-04T13:00:00.000Z',
    finishedAt: '2026-11-04T13:00:03.000Z',
    durationMs: 3000,
    targetUrl: options.targetUrl ?? 'https://dev.example.com/cart?session=abc123&email=a@b.com#frag',
    buildId: options.buildId ?? 'rev42',
    buildIdSource: 'provided',
    ...(options.routine === false ? {} : { routine: { id: 'cart-total', version: 3, sha256: 'a'.repeat(64) } }),
    failedStepIndex: 1,
    error: { type: errorType, message },
    steps: [
      { index: 0, id: 'open', action: 'goto', status: 'passed', startedAt: 'x', finishedAt: 'y', durationMs: 120 },
      { index: 1, id: stepId, label: 'Check the total', action: 'assertTextContains', status: 'failed', startedAt: 'x', finishedAt: 'y', durationMs: 510, error: { type: errorType, message } },
    ],
    extracted: {},
    evidence: {
      screenshots: [],
      console: [],
      consoleErrors: (options.consoleErrors ?? ['Uncaught TypeError: x is undefined']).map((text) => ({ text })),
      network: [],
      networkFailures: [{ method: 'GET', origin: 'https://dev.example.com', pathname: '/api/total', status: 500 }],
    },
    ...(options.parameters ? { parameters: { seed: 'seed-1', sample: 2, values: { qty: '1000' }, sources: { qty: { source: 'generator' } } } } : {}),
  };
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result));
  fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify({ targetProfile: 'shop', credentialSet: 'shop-admin' }));
  return jobId;
}

const makeIntegration = (id = 'gh', over: Record<string, unknown> = {}) => saveIntegrationDefinition(id, { repo: 'acme/shop', apiBaseUrl: origin, token: TOKEN, ...over });

/** The text with fenced blocks and code spans taken out: what a reader would see as live markup. */
function outsideCode(markdown: string): string {
  return markdown.replace(/^(`{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm, '').replace(/(`+)(.+?)\1/g, '');
}

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
}

// ---- signature (pure) ---------------------------------------------------------------------------------------------------------------------

test('signature: the same routine, step and error type are one bug; the message, the version and the environment are not part of it', () => {
  const base = { routineId: 'cart-total', scenarioName: 'Cart total', stepId: 'total', errorType: 'StepExecutionError' };
  const a = bugSignature(base);
  assert.equal(bugSignature({ ...base, scenarioName: 'another name' }).hash, a.hash, 'a routine is identified by its id, not by the scenario name');
  assert.match(a.hash, /^[0-9a-f]{16}$/);
  assert.notEqual(bugSignature({ ...base, stepId: 'other' }).hash, a.hash);
  assert.notEqual(bugSignature({ ...base, errorType: 'TimeoutError' }).hash, a.hash);
  assert.notEqual(bugSignature({ ...base, routineId: 'cart-other' }).hash, a.hash);
  assert.match(a.key, /cart-total \/ step total \/ StepExecutionError/);

  const adHoc = bugSignature({ scenarioName: 'Login', stepId: 's1', errorType: 'X' });
  assert.equal(adHoc.subject, 'scenario:Login', 'a run that is not a routine is told apart by its scenario name');
  // Separators are unambiguous: moving a character from one part to the next is a different bug.
  assert.notEqual(bugSignature({ routineId: 'ab', scenarioName: '', stepId: 'c', errorType: 'd' }).hash, bugSignature({ routineId: 'a', scenarioName: '', stepId: 'bc', errorType: 'd' }).hash);
});

// ---- markdown safety (pure) ---------------------------------------------------------------------------------------------------------------

test('fenced / inlineCode: the text cannot close its own fence, whatever backticks it holds', () => {
  const hostile = 'before\n```\nafter the fence @alice ![x](https://evil.example/p.png)\n````\nand more';
  const block = fenced(hostile);
  const opening = block.split('\n')[0]!;
  assert.match(opening, /^`{5,}text$/, 'the fence is longer than the longest run of backticks in the text');
  assert.equal(outsideCode(`intro\n\n${block}\n\noutro`).includes('@alice'), false);
  assert.equal(outsideCode(`intro\n\n${block}\n\noutro`).includes('evil.example'), false);

  const span = inlineCode('a `tick` and ``two`` and @bob');
  assert.equal(outsideCode(`x ${span} y`).includes('@bob'), false);
  assert.equal(inlineCode('   '), '`(none)`');
  assert.equal(inlineCode('line one\nline two'), '`line one line two`');
});

test('titleSafe: no mention, issue reference, markup or link characters, one line, bounded', () => {
  const title = titleSafe('Hey @alice see #123 <img src=x> [link](http://x) `code`\nnext\u0000line', 200);
  assert.doesNotMatch(title, /[@#<>[\]`\n\u0000]/);
  assert.ok(titleSafe('x'.repeat(500), 50).length <= 50);
  assert.equal(titleSafe('cart_total step-1', 100), 'cart_total step-1', 'ids with underscores and hyphens are left alone');
});

// ---- rendering (pure) ----------------------------------------------------------------------------------------------------------------------

const facts = (over: Record<string, unknown> = {}) => ({
  jobId: 'job_abc123',
  scenarioName: 'OUT-scenario',
  startedAt: '2026-11-04T13:00:00.000Z',
  durationMs: 3000,
  buildId: 'OUT-build',
  buildIdSource: 'provided',
  routine: { id: 'OUT-routine', version: 3 },
  application: 'OUT-application',
  environment: 'OUT-environment',
  platform: 'OUT-platform',
  targetProfile: 'OUT-profile',
  address: 'OUT-address',
  failure: { stepId: 'OUT-step', stepIndex: 1, action: 'OUT-action', label: 'OUT-label', errorType: 'OUT-errortype', errorMessage: 'OUT-message', actor: 'OUT-actor' },
  steps: [{ index: 0, id: 'OUT-s0', action: 'OUT-a0', label: 'OUT-l0', status: 'passed', actor: 'OUT-actor0' }],
  consoleErrors: ['OUT-console'],
  networkFailures: ['OUT-network'],
  parameters: { seed: 'OUT-seed', sample: 2, rows: [{ name: 'OUT-pname', value: 'OUT-pvalue', source: 'OUT-psource', synthetic: true }] },
  shrink: { shrinkId: 'shrink_x', outcome: 'minimal', summary: 'OUT-summary', minimal: { 'OUT-mname': 'OUT-mvalue' }, boundaries: [{ parameter: 'OUT-bparam', fails: 'OUT-bfails', passes: 'OUT-bpasses', precision: 'adjacent' }] },
  since: { lastGreen: { jobId: 'job_g', at: '2026-11-04T10:00:00.000Z', buildId: 'OUT-gbuild', version: 3 }, firstRed: { jobId: 'job_r', at: '2026-11-04T12:00:00.000Z', buildId: 'OUT-rbuild', version: 3 }, buildChanged: true },
  replay: 'OUT-replay',
  evidence: { location: 'ephemeral' as const },
  signature: bugSignature({ routineId: 'cart-total', scenarioName: 's', stepId: 'total', errorType: 'E' }),
  ...over,
});

test('render: EVERY string that comes from outside goes through `clean` (a marker proves it), in each language', () => {
  for (const lang of ['en', 'pt', 'es'] as const) {
    const { title, body } = renderIssue(facts() as never, lang, (text) => text.replaceAll('OUT-', 'CLEAN-'));
    assert.equal(`${title}\n${body}`.includes('OUT-'), false, `${lang}: something from outside reached the issue without being cleaned`);
    for (const piece of ['routine', 'step', 'message', 'console', 'network', 'pname', 'pvalue', 'mname', 'mvalue', 'bparam', 'gbuild', 'rbuild', 'replay', 'summary', 'application', 'profile', 'address', 'seed', 'actor0', 'label']) {
      assert.ok(`${title}\n${body}`.includes(`CLEAN-${piece}`), `${lang}: ${piece} is missing from the report`);
    }
    assert.ok(body.includes('scrapforai:bug-signature='), 'the hidden marker that ties an issue to its signature');
  }
});

test('render: nothing a page writes can mention, link, embed or break out of the report', () => {
  const hostile = 'boom ``` \n@alice and #123 ![x](https://evil.example/t.png) <img src=https://evil.example/p> [click](https://evil.example)\n````\n## fake heading';
  const { title, body } = renderIssue(
    facts({
      scenarioName: hostile,
      routine: undefined,
      application: hostile,
      failure: { stepId: 'step', stepIndex: 1, action: 'click', label: hostile, errorType: 'E', errorMessage: hostile },
      consoleErrors: [hostile],
      networkFailures: [hostile],
      steps: [{ index: 0, id: 'a', action: 'goto', label: hostile, status: 'failed' }],
    }) as never,
    'en',
    (text, max = 300) => text.slice(0, max),
  );
  assert.doesNotMatch(title.replace('[ScrapForAI] ', ''), /[@#<>[\]`]/);
  const live = outsideCode(body);
  for (const bad of ['@alice', '#123', 'evil.example', '<img', '[click]', 'fake heading']) assert.equal(live.includes(bad), false, `${bad} is live markup outside a code block`);
});

test('render: a very long report is cut to fit an issue, and keeps its signature marker', () => {
  const long = 'x'.repeat(2000);
  const many = Array.from({ length: 80 }, (_, index) => ({ index, id: `s${index}`, action: 'click', label: long, status: 'passed' }));
  const { body } = renderIssue(facts({ steps: many, failure: { stepId: 's', stepIndex: 0, action: 'a', errorType: 'E', errorMessage: long } }) as never, 'en', (text) => text);
  assert.ok(body.length <= MAX_BODY_CHARS + 200, `body is ${body.length}`);
  assert.ok(body.includes('scrapforai:bug-signature='));
  assert.ok(body.includes('steps shown'), 'it says that the step list was cut');
});

test('render: all three languages have every string', () => {
  const keys = Object.keys(BUG_STRINGS.en).sort();
  assert.deepEqual(Object.keys(BUG_STRINGS.pt).sort(), keys);
  assert.deepEqual(Object.keys(BUG_STRINGS.es).sort(), keys);
});

// ---- since when (pure) ----------------------------------------------------------------------------------------------------------------------

const record = (jobId: string, at: string, status: 'passed' | 'failed', over: Record<string, unknown> = {}) =>
  ({ jobId, at, version: 3, profile: 'full', env: 'https://dev.example.com', status, durationMs: 100, steps: [], ...over }) as never;
const current = { jobId: 'job_now', at: '2026-11-04T13:00:00.000Z', version: 3, env: 'https://dev.example.com', profile: 'full' as const, buildId: 'b3' };

test('sinceWhen: the last passing run before the failure, the first failing one after it, and whether the build changed', () => {
  const since = sinceWhen(
    [
      record('job_g1', '2026-11-04T09:00:00.000Z', 'passed', { buildId: 'b1' }),
      record('job_g2', '2026-11-04T10:00:00.000Z', 'passed', { buildId: 'b1' }),
      record('job_r1', '2026-11-04T11:00:00.000Z', 'failed', { buildId: 'b2' }),
      record('job_now', '2026-11-04T13:00:00.000Z', 'failed', { buildId: 'b3' }),
    ],
    current,
  );
  assert.equal(since?.lastGreen.jobId, 'job_g2');
  assert.equal(since?.firstRed.jobId, 'job_r1', 'the FIRST failure after the last pass, not the one being reported');
  assert.equal(since?.buildChanged, true);
});

test('sinceWhen: never passed, other environment, generated values and a retried first attempt do not count', () => {
  assert.equal(sinceWhen([record('job_r', '2026-11-04T09:00:00.000Z', 'failed')], current), undefined, 'never seen passing: there is no "since"');
  assert.equal(sinceWhen([record('job_g', '2026-11-04T09:00:00.000Z', 'passed', { env: 'https://other.example.com' })], current), undefined, 'another environment is another population');
  assert.equal(sinceWhen([record('job_g', '2026-11-04T09:00:00.000Z', 'passed', { parametric: true })], current), undefined, 'a run with generated values is not a baseline');

  const retried = sinceWhen(
    [record('job_g', '2026-11-04T09:00:00.000Z', 'passed'), record('job_a1', '2026-11-04T10:00:00.000Z', 'failed'), record('job_a2', '2026-11-04T10:01:00.000Z', 'passed', { attempt: 2, retryOf: 'job_a1' })],
    current,
  );
  assert.equal(retried?.lastGreen.jobId, 'job_a2', 'a pass on the new attempt is a pass: the first attempt is not a failure here');

  const unknown = sinceWhen([record('job_g', '2026-11-04T09:00:00.000Z', 'passed')], { ...current, buildId: undefined });
  assert.equal(unknown?.buildChanged, undefined, 'a build that is not known is not "changed" nor "the same"');
});

// ---- egress policy (pure) --------------------------------------------------------------------------------------------------------------------

test('integration policy: https, or http for this machine only; allowlisted; no credentials, query or fragment', () => {
  const allowed = ['https://api.github.com', 'https://ghe.example.com', 'http://127.0.0.1:9', 'http://intranet.example.com'];
  assert.equal(assertIntegrationUrl('https://api.github.com', allowed).origin, 'https://api.github.com');
  assert.equal(assertIntegrationUrl('https://ghe.example.com/api/v3', allowed).pathname, '/api/v3');
  assert.equal(assertIntegrationUrl('http://127.0.0.1:9', allowed).hostname, '127.0.0.1');
  const refuse = (url: string, pattern: RegExp, list = allowed): void => assert.throws(() => assertIntegrationUrl(url, list), pattern, url);
  refuse('http://intranet.example.com', /https/, allowed); // a bearer token must not cross a network in clear text
  refuse('https://user:pw@api.github.com', /user name or password/);
  refuse('https://api.github.com/?x=1', /query or a fragment/);
  refuse('https://api.github.com/#f', /query or a fragment/);
  refuse('https://evil.example.com', /not in ALLOWED_INTEGRATION_ORIGINS/);
  refuse('not a url', /not a valid URL/);
  refuse('https://api.github.com', /ALLOWED_INTEGRATION_ORIGINS/, []);
});

// ---- drafting -----------------------------------------------------------------------------------------------------------------------------------

test('draft: a failed run becomes a stored draft; secrets and personal data are masked; the page address has no query', async () => {
  const jobId = makeRun({ message: `Timeout on #total for ${CPF} with password ${VAULT_SECRET} and Bearer abcdefghijklmnopqrstuvwxyz0123456789 ‮evil`, consoleErrors: [`console saw ${VAULT_SECRET}`] });
  const { report, created, refreshed } = await draftBugReport({ fromJobId: jobId }, { via: 'manual' });

  assert.equal(created, true);
  assert.equal(refreshed, false);
  assert.equal(report.status, 'draft');
  assert.equal(report.occurrenceCount, 1);
  assert.match(report.id, /^bug_/);
  assert.equal(report.signature.stepId, 'total');
  assert.equal(report.signature.subject, 'cart-total');
  assert.equal(report.targetProfile, 'shop');
  assert.ok(report.redactions >= 3, `redactions: ${report.redactions}`);

  const text = `${report.title}\n${report.body}`;
  assert.equal(text.includes(VAULT_SECRET), false, 'a vault value');
  assert.equal(text.includes(CPF), false, 'a CPF');
  assert.equal(text.includes('abcdefghijklmnopqrstuvwxyz0123456789'), false, 'a bearer token');
  assert.equal(text.includes('‮'), false, 'a right-to-left override');
  assert.ok(text.includes('[REDACTED]'));
  assert.ok(report.body.includes('https://dev.example.com/cart'), 'the page, without its query');
  assert.equal(text.includes('session=abc123'), false, 'the query is never copied');
  assert.equal(text.includes('a@b.com'), false);
  assert.match(report.title, /^\[ScrapForAI\] cart-total failed at step total: StepExecutionError$/);
  assert.ok(report.body.includes('scrapforai run cart-total --version 3 --target shop --credential shop-admin'), 'a command that repeats the run');
  assert.ok(report.body.includes('The screenshot is not attached'), 'a picture cannot be checked for personal data, so it never goes');

  const stored = JSON.parse(fs.readFileSync(path.join(bugReportsDir(), `${report.id}.json`), 'utf8'));
  assert.equal(JSON.stringify(stored).includes(VAULT_SECRET), false, 'nothing secret on disk');
});

test('draft: a run that passed, a run that expired and a bad id are refused with a reason', async () => {
  const passed = makeRun({ status: 'passed' });
  await assert.rejects(draftBugReport({ fromJobId: passed }, { via: 'manual' }), (error: unknown) => error instanceof BugReportError && error.status === 409 && error.name === 'RunNotFailed');
  await assert.rejects(draftBugReport({ fromJobId: 'job_doesnotexist' }, { via: 'manual' }), (error: unknown) => error instanceof BugReportError && error.status === 404 && error.name === 'EvidenceNotFound');
});

test('draft: the history says since when (last pass, first failure, builds), with the performance series as the source', async () => {
  await appendPerfRecord('cart-total', { jobId: 'job_hist_g', at: '2026-11-04T09:00:00.000Z', version: 3, profile: 'full', env: 'https://dev.example.com', buildId: 'b1', status: 'passed', durationMs: 10, steps: [] });
  await appendPerfRecord('cart-total', { jobId: 'job_hist_r', at: '2026-11-04T11:00:00.000Z', version: 3, profile: 'full', env: 'https://dev.example.com', buildId: 'b2', status: 'failed', durationMs: 10, steps: [] });
  const jobId = makeRun({ at: '2026-11-04T13:00:00.000Z', buildId: 'b3' });
  const { report } = await draftBugReport({ fromJobId: jobId }, { via: 'manual' });
  assert.ok(report.body.includes('job_hist_g') && report.body.includes('job_hist_r'));
  assert.ok(report.body.includes('b1') && report.body.includes('b2'));
  assert.match(report.body, /It is not a diagnosis/);
});

test('draft: a shrink of THIS failure puts the smallest failing input in; one of another failure, or still running, is refused', async () => {
  const jobId = makeRun({ parameters: true });
  const shrink = (id: string, over: Record<string, unknown>): void => {
    fs.mkdirSync(shrinksDir(), { recursive: true });
    fs.writeFileSync(
      path.join(shrinksDir(), `${id}.json`),
      JSON.stringify({
        shrinkId: id,
        status: 'completed',
        createdAt: 'x',
        request: {},
        runs: 5,
        routine: { id: 'cart-total', version: 3 },
        signature: { stepId: 'total', errorType: 'StepExecutionError' },
        outcome: 'minimal',
        summary: 'fails with qty=1000, passes with qty=999',
        result: { status: 'minimal', failing: { qty: '1000' }, minimal: { qty: '1000' }, essential: ['qty'], boundaries: [{ parameter: 'qty', fails: '1000', passes: '999', precision: 'adjacent' }], runs: 5, trail: [] },
        ...over,
      }),
    );
  };
  shrink('shrink_ok', {});
  const { report } = await draftBugReport({ fromJobId: jobId, shrinkId: 'shrink_ok' }, { via: 'manual' });
  assert.ok(report.body.includes('fails with qty=1000, passes with qty=999'));
  assert.ok(report.body.includes('`qty` = `1000`'));
  assert.equal(report.source.shrinkId, 'shrink_ok');
  assert.ok(report.body.includes('--seed seed-1 --sample 2'), 'the replay command carries the seed and sample');

  shrink('shrink_other', { signature: { stepId: 'elsewhere', errorType: 'StepExecutionError' } });
  await assert.rejects(draftBugReport({ fromJobId: jobId, shrinkId: 'shrink_other' }, { via: 'manual' }), (error: unknown) => error instanceof BugReportError && error.name === 'ShrinkDoesNotMatch');
  shrink('shrink_running', { status: 'running', result: undefined });
  await assert.rejects(draftBugReport({ fromJobId: jobId, shrinkId: 'shrink_running' }, { via: 'manual' }), (error: unknown) => error instanceof BugReportError && error.name === 'ShrinkRunning');
  await assert.rejects(draftBugReport({ fromJobId: jobId, shrinkId: 'shrink_missing' }, { via: 'manual' }), (error: unknown) => error instanceof BugReportError && error.name === 'ShrinkNotFound');
});

// ---- deduplication -----------------------------------------------------------------------------------------------------------------------------

test('dedup: the same failure again is an occurrence, not a second report; another step or error type is another report', async () => {
  const first = await draftBugReport({ fromJobId: makeRun({ message: 'got 5' }) }, { via: 'schedule' });
  const again = await draftBugReport({ fromJobId: makeRun({ message: 'got 6', at: '2026-11-04T14:00:00.000Z' }) }, { via: 'schedule' });
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(again.report.id, first.report.id);
  assert.equal(again.report.occurrenceCount, 2);
  assert.equal(again.report.occurrences.length, 2);
  assert.ok(again.report.body.includes('got 5'), 'a scheduled recurrence does not rewrite the draft');

  const sameRunAgain = await draftBugReport({ fromJobId: first.report.occurrences[0]!.jobId }, { via: 'schedule' });
  assert.equal(sameRunAgain.report.occurrenceCount, 2, 'the same run is not counted twice');

  const otherStep = await draftBugReport({ fromJobId: makeRun({ stepId: 'subtotal' }) }, { via: 'manual' });
  const otherError = await draftBugReport({ fromJobId: makeRun({ errorType: 'TimeoutError' }) }, { via: 'manual' });
  assert.equal(otherStep.created && otherError.created, true);
  assert.equal((await listBugReports()).length, 3);
});

test('dedup: asking by hand for a run whose failure has an unsent draft rebuilds the draft from THAT run and keeps the earlier occurrences', async () => {
  const first = await draftBugReport({ fromJobId: makeRun({ message: 'old message' }) }, { via: 'schedule' });
  const jobId = makeRun({ message: 'new message', at: '2026-11-04T15:00:00.000Z' });
  const refreshed = await draftBugReport({ fromJobId: jobId, lang: 'pt' }, { via: 'manual' });
  assert.equal(refreshed.created, false);
  assert.equal(refreshed.refreshed, true);
  assert.equal(refreshed.report.id, first.report.id);
  assert.equal(refreshed.report.source.jobId, jobId);
  assert.equal(refreshed.report.lang, 'pt');
  assert.ok(refreshed.report.body.includes('new message') && !refreshed.report.body.includes('old message'));
  assert.equal(refreshed.report.occurrenceCount, 2);
});

test('dedup: dismissed only counts; resolved opens a NEW report that points at the old one', async () => {
  const first = await draftBugReport({ fromJobId: makeRun() }, { via: 'manual' });
  const dismissed = await dismissBugReport(first.report.id, 'known, not worth an issue');
  assert.equal(dismissed.status, 'dismissed');
  const counted = await draftBugReport({ fromJobId: makeRun({ at: '2026-11-04T14:00:00.000Z' }) }, { via: 'manual' });
  assert.equal(counted.created, false);
  assert.equal(counted.report.status, 'dismissed', 'a person said no: the failure is counted and nothing more');
  assert.equal(counted.report.occurrenceCount, 2);
  await assert.rejects(dismissBugReport(first.report.id), (error: unknown) => error instanceof BugReportError && error.name === 'InvalidTransition');

  const resolved = await resolveBugReport(first.report.id, 'fixed in rev43');
  assert.equal(resolved.status, 'resolved');
  const back = await draftBugReport({ fromJobId: makeRun({ at: '2026-11-04T16:00:00.000Z' }) }, { via: 'schedule' });
  assert.equal(back.created, true, 'it came back after being fixed');
  assert.equal(back.report.recurrenceOf, first.report.id);
  assert.ok(back.report.body.includes(first.report.id), 'the report says it has come back');
  assert.equal(back.report.occurrenceCount, 1);
});

test('dedup: two drafts of one failure at the same moment make one report', async () => {
  const [a, b] = await Promise.all([draftBugReport({ fromJobId: makeRun() }, { via: 'schedule' }), draftBugReport({ fromJobId: makeRun() }, { via: 'schedule' })]);
  assert.equal([a.created, b.created].filter(Boolean).length, 1);
  assert.equal((await listBugReports()).length, 1);
  assert.equal((await listBugReports())[0]!.occurrenceCount, 2);
});

// ---- integrations -------------------------------------------------------------------------------------------------------------------------------

test('integration: the token goes to the vault and is never returned; an address outside the allowlist is refused when saving', async () => {
  const { view, created } = await makeIntegration('gh', { labels: ['scrapforai', 'bug'] });
  assert.equal(created, true);
  assert.equal(view.hasToken, true);
  assert.equal(view.originAllowed, true);
  assert.equal(JSON.stringify(view).includes(TOKEN), false);
  assert.equal(JSON.stringify(await getIntegrationView('gh')).includes(TOKEN), false);
  for (const file of filesUnder(dataDir)) assert.equal(fs.readFileSync(file).includes(TOKEN), false, `${file} holds the token`);

  await assert.rejects(saveIntegrationDefinition('bad', { repo: 'acme/shop', apiBaseUrl: 'https://evil.example.com', token: TOKEN }), /not in ALLOWED_INTEGRATION_ORIGINS/);
  await assert.rejects(saveIntegrationDefinition('new', { repo: 'acme/shop', apiBaseUrl: origin }), /token is required/);
  await assert.rejects(saveIntegrationDefinition('gh2', { repo: '../etc/passwd', apiBaseUrl: origin, token: TOKEN }));
  await assert.rejects(saveIntegrationDefinition('gh3', { repo: 'acme/shop', apiBaseUrl: origin, token: TOKEN, targetProfiles: ['no-such-profile'] }), /does not exist/);

  // An update without a token keeps the stored one, but only for the SAME origin.
  const kept = await saveIntegrationDefinition('gh', { repo: 'acme/shop', apiBaseUrl: origin, labels: ['x'] });
  assert.equal(kept.created, false);
  assert.equal(kept.view.hasToken, true);
  process.env.ALLOWED_INTEGRATION_ORIGINS = `${origin},http://127.0.0.1:9`;
  await assert.rejects(saveIntegrationDefinition('gh', { repo: 'acme/shop', apiBaseUrl: 'http://127.0.0.1:9' }), /send the token again/);
});

test('integration test: the stored token is used to read the repository, nothing is created', async () => {
  await makeIntegration();
  const check = await testIntegration('gh');
  assert.deepEqual(check, { ok: true, issuesEnabled: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.method, 'GET');
  assert.equal(seen[0]!.headers.authorization, `Bearer ${TOKEN}`);

  answer = { status: 401 };
  seen.length = 0;
  const denied = await testIntegration('gh');
  assert.equal(denied?.ok, false);
  assert.match(denied?.reason ?? '', /token was rejected/);
});

// ---- sending ------------------------------------------------------------------------------------------------------------------------------------

test('send: the approved draft becomes an issue; the token is only in the Authorization header; the report records the issue', async () => {
  await makeIntegration('gh', { labels: ['scrapforai', 'bug'] });
  const { report } = await draftBugReport({ fromJobId: makeRun() }, { via: 'manual' });
  const outcome = await sendBugReport(report.id);

  assert.equal(outcome.attempt.status, 'sent');
  assert.equal(outcome.report.status, 'sent');
  assert.deepEqual({ number: outcome.report.issue?.number, url: outcome.report.issue?.url, integrationId: outcome.report.issue?.integrationId }, { number: 42, url: 'https://github.example/acme/shop/issues/42', integrationId: 'gh' });

  assert.equal(seen.length, 1);
  const request = seen[0]!;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/repos/acme/shop/issues');
  assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
  assert.match(String(request.headers['user-agent']), /ScrapForAI/);
  const sent = JSON.parse(request.raw);
  assert.deepEqual(Object.keys(sent).sort(), ['body', 'labels', 'title']);
  assert.deepEqual(sent.labels, ['scrapforai', 'bug']);
  assert.equal(sent.title, outcome.report.title);
  assert.equal(request.raw.includes(TOKEN), false, 'the token is not in the payload');
  assert.ok(sent.body.includes('scrapforai:bug-signature='));

  const stored = JSON.stringify(await getBugReport(report.id));
  assert.equal(stored.includes(TOKEN), false);

  await assert.rejects(sendBugReport(report.id), (error: unknown) => error instanceof BugReportError && error.status === 409 && error.name === 'BugReportNotDraft' && error.message.includes('issues/42'));
  assert.equal(seen.length, 1, 'a sent report is never sent twice');
});

test('send: two approvals at the same moment make ONE issue', async () => {
  await makeIntegration();
  const { report } = await draftBugReport({ fromJobId: makeRun() }, { via: 'manual' });
  answer = { status: 201, slowMs: 150 };
  const results = await Promise.allSettled([sendBugReport(report.id), sendBugReport(report.id), sendBugReport(report.id)]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(seen.filter((item) => item.method === 'POST').length, 1, 'the tracker received exactly one issue');
  for (const item of results) if (item.status === 'rejected') assert.ok(item.reason instanceof BugReportError && item.reason.status === 409);
  assert.equal((await getBugReport(report.id))?.status, 'sent');
});

test('send: a failure is told by a code, the reply body is never read or kept, there is no second try, and the report stays a draft', async () => {
  await makeIntegration();
  const { report } = await draftBugReport({ fromJobId: makeRun() }, { via: 'manual' });
  const expectations: Array<[number, RegExp]> = [
    [401, /token was rejected/],
    [403, /forbidden/],
    [404, /repository not found/],
    [410, /issues are disabled/],
    [422, /refused the issue/],
    [500, /^HTTP 500$/],
  ];
  for (const [status, reason] of expectations) {
    seen.length = 0;
    answer = { status };
    const outcome = await sendBugReport(report.id);
    assert.equal(outcome.attempt.status, 'failed', String(status));
    assert.equal(outcome.attempt.httpStatus, status);
    assert.match(outcome.attempt.reason ?? '', reason);
    assert.equal(JSON.stringify(outcome.attempt).includes(report.title), false, 'the echoed request body is not in the attempt');
    assert.equal(seen.length, 1, `HTTP ${status}: one request only (creating an issue is not safe to repeat)`);
    assert.equal(outcome.report.status, 'draft');
  }
  assert.equal((await getBugReport(report.id))?.attempts.length, expectations.length);
});

test('send: a redirect is a failure and the other host receives nothing, not even the token', async () => {
  await makeIntegration();
  const { report } = await draftBugReport({ fromJobId: makeRun() }, { via: 'manual' });
  answer = { status: 302, redirect: true };
  const outcome = await sendBugReport(report.id);
  assert.equal(outcome.attempt.status, 'failed');
  assert.match(outcome.attempt.reason ?? '', /redirects are not followed/);
  assert.deepEqual(elsewhere, []);
});

test('send: nothing leaves when the origin is not allowed (re-read at every send), and the draft stays a draft', async () => {
  await makeIntegration();
  const { report } = await draftBugReport({ fromJobId: makeRun() }, { via: 'manual' });
  process.env.ALLOWED_INTEGRATION_ORIGINS = 'https://somewhere-else.example.com';
  const outcome = await sendBugReport(report.id);
  assert.equal(outcome.attempt.status, 'failed');
  assert.match(outcome.attempt.reason ?? '', /not in ALLOWED_INTEGRATION_ORIGINS/);
  assert.equal(seen.length, 0);
  assert.equal(outcome.report.status, 'draft');
  assert.equal((await getIntegrationView('gh'))?.originAllowed, false);
});

test('send: a secret still in the payload after cleaning stops the send (sentinel in the one field that is not cleaned)', async () => {
  await makeIntegration('gh', { labels: [VAULT_SECRET] }); // configuration, not text: it is not scrubbed, so only the final check can catch it
  const { report } = await draftBugReport({ fromJobId: makeRun() }, { via: 'manual' });
  const outcome = await sendBugReport(report.id);
  assert.equal(outcome.attempt.status, 'blocked');
  assert.match(outcome.attempt.reason ?? '', /nothing was sent/);
  assert.equal(seen.length, 0);
  assert.equal(outcome.report.status, 'draft');
});

test('send: a secret added to the vault AFTER the draft was made is hidden at send time', async () => {
  await makeIntegration();
  const jobId = makeRun({ message: 'the server said: LATE-secret-value-98765 is wrong' });
  const { report } = await draftBugReport({ fromJobId: jobId }, { via: 'manual' });
  assert.ok(report.body.includes('LATE-secret-value-98765'), 'unknown at draft time');
  await saveCredentialSet('late-set', { boundOrigins: ['https://dev.example.com'], values: { key: 'LATE-secret-value-98765' }, tags: [] }, 'create');
  const outcome = await sendBugReport(report.id);
  assert.equal(outcome.attempt.status, 'sent');
  assert.equal(seen[0]!.raw.includes('LATE-secret-value-98765'), false);
  assert.ok(seen[0]!.raw.includes('[REDACTED]'));
});

test('send: which integration — one that serves the profile, a named one, never a guess between several; a disabled one is refused', async () => {
  const { report } = await draftBugReport({ fromJobId: makeRun() }, { via: 'manual' });
  await assert.rejects(chooseIntegration(report), (error: unknown) => error instanceof BugReportError && error.name === 'IntegrationRequired');

  await makeIntegration('one');
  assert.equal((await chooseIntegration(report)).integration.id, 'one');
  await makeIntegration('two');
  await assert.rejects(chooseIntegration(report), /Several integrations/);

  await makeIntegration('two', { enabled: false });
  assert.equal((await chooseIntegration(report)).integration.id, 'one', 'a disabled integration is not a candidate');
  await assert.rejects(sendBugReport(report.id, { integrationId: 'two' }), (error: unknown) => error instanceof BugReportError && error.name === 'IntegrationDisabled');
  await assert.rejects(sendBugReport(report.id, { integrationId: 'nope' }), (error: unknown) => error instanceof BugReportError && error.status === 404);

  await makeIntegration('one', { targetProfiles: ['another-profile'] }).catch(() => undefined); // profile does not exist: refused at save
  assert.equal((await chooseIntegration(report)).integration.id, 'one');
});

// ---- by itself, when a scheduled run fails ----------------------------------------------------------------------------------------------------

const settled = (run: { kind: 'run' | 'suite'; id: string }, outcome = 'failed') => ({ schedule: { id: 'nightly', notify: [] }, outcome, at: 'x', finishedAt: 'y', run, manual: false, recovered: false }) as never;

test('auto: with no integration a failed scheduled run leaves no report; a run that could not execute never does', async () => {
  const jobId = makeRun();
  assert.deepEqual(await autoDraftBugReports(settled({ kind: 'run', id: jobId })), []);
  assert.equal((await listBugReports()).length, 0);

  await makeIntegration();
  assert.deepEqual(await autoDraftBugReports(settled({ kind: 'run', id: jobId }, 'error')), [], 'outcome `error`: the platform failed, not the application');
  assert.deepEqual(await autoDraftBugReports(settled({ kind: 'run', id: jobId }, 'passed')), []);
});

test('auto: by default a failed scheduled run prepares a DRAFT and sends nothing; a recurrence adds an occurrence', async () => {
  await makeIntegration();
  const first = await autoDraftBugReports(settled({ kind: 'run', id: makeRun() }));
  assert.equal(first.length, 1);
  assert.equal(first[0]!.created, true);
  assert.equal(first[0]!.sent, undefined);
  assert.equal(seen.length, 0, 'draft mode: a person approves');
  const again = await autoDraftBugReports(settled({ kind: 'run', id: makeRun({ at: '2026-11-04T20:00:00.000Z' }) }));
  assert.equal(again[0]!.created, false);
  const [report] = await listBugReports();
  assert.equal(report!.occurrenceCount, 2);
  assert.equal(report!.status, 'draft');
});

test('auto: `send` is opt-in and sends once; `ignore` does nothing; a profile the integration does not serve is skipped', async () => {
  await makeIntegration('auto', { onScheduledFailure: 'send' });
  const sent = await autoDraftBugReports(settled({ kind: 'run', id: makeRun() }));
  assert.equal(sent[0]!.sent, true);
  assert.equal(seen.length, 1);
  const recurrence = await autoDraftBugReports(settled({ kind: 'run', id: makeRun({ at: '2026-11-04T20:00:00.000Z' }) }));
  assert.equal(recurrence[0]!.sent, undefined, 'already an issue: another occurrence is counted, not sent again');
  assert.equal(seen.length, 1);

  await removeIntegration('auto');
  await makeIntegration('quiet', { onScheduledFailure: 'ignore' });
  assert.deepEqual(await autoDraftBugReports(settled({ kind: 'run', id: makeRun({ stepId: 'other-step' }) })), []);
});

test('auto: a blocked report is not retried by itself, and a run that drew generated values is skipped (edge values fail on purpose)', async () => {
  await makeIntegration('auto', { onScheduledFailure: 'send', labels: [VAULT_SECRET] });
  const first = await autoDraftBugReports(settled({ kind: 'run', id: makeRun() }));
  assert.equal(first[0]!.sent, false);
  assert.equal(seen.length, 0);
  const second = await autoDraftBugReports(settled({ kind: 'run', id: makeRun({ at: '2026-11-04T20:00:00.000Z' }) }));
  assert.equal(second[0]!.sent, undefined, 'blocked: it needs a person to look, not another automatic attempt');
  assert.equal((await listBugReports())[0]!.attempts.length, 1);

  const parametric = await autoDraftBugReports(settled({ kind: 'run', id: makeRun({ parameters: true, stepId: 'param-step' }) }));
  assert.match(parametric[0]!.skipped ?? '', /generated values/);
});

test('auto: a failed suite reports each failed variant that counts — not a quarantined one, not a pass on a new attempt, not a generated sample', async () => {
  await makeIntegration();
  const variant = (key: string, jobId: string | undefined, over: Record<string, unknown> = {}) => ({ variantKey: key, routineId: 'cart-total', routineVersion: 3, status: 'failed', jobId, ...over });
  const request = suiteRequestSchema.parse({ name: 'nightly', items: [{ routineId: 'cart-total' }] });
  const state = {
    suiteRunId: 'suite_auto1',
    name: 'nightly',
    status: 'completed',
    createdAt: '2026-11-04T00:00:00.000Z',
    request,
    total: 4,
    counts: { pending: 0, running: 0, passed: 1, failed: 3, error: 0, notRun: 0 },
    verdict: 'red',
    variants: [
      variant('a', makeRun({ stepId: 'step-a' })),
      variant('b', makeRun({ stepId: 'step-b' }), { quarantined: true }),
      variant('c', makeRun({ stepId: 'step-c' }), { status: 'passed', passedOnRetry: true }),
      variant('d', makeRun({ stepId: 'step-d' }), { sample: 1 }),
    ],
  };
  fs.mkdirSync(suitesDir(), { recursive: true });
  fs.writeFileSync(path.join(suitesDir(), 'suite_auto1.json'), JSON.stringify(state));

  const results = await autoDraftBugReports(settled({ kind: 'suite', id: 'suite_auto1' }));
  const reports = await listBugReports();
  assert.equal(results.length, 1, JSON.stringify(results));
  assert.deepEqual(reports.map((item) => item.signature.stepId), ['step-a']);
});

// ---- the HTTP surface -----------------------------------------------------------------------------------------------------------------------------

test('routes: drafting is open to a session, sending and integrations need the bearer token, nothing returns the token', async () => {
  const call = (method: string, url: string, body?: unknown, headers: Record<string, string> = bearer) =>
    fetch(`${baseUrl}${url}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  const put = await call('PUT', '/v1/integrations/gh', { repo: 'acme/shop', apiBaseUrl: origin, token: TOKEN });
  assert.equal(put.status, 201);
  assert.equal((await put.text()).includes(TOKEN), false);
  const noToken = await call('PUT', '/v1/integrations/new', { repo: 'acme/shop', apiBaseUrl: origin });
  assert.equal(noToken.status, 400);
  assert.equal((await call('PUT', '/v1/integrations/gh2', { repo: 'acme/shop', apiBaseUrl: 'https://evil.example.com', token: TOKEN })).status, 400);
  const invalid = await call('PUT', '/v1/integrations/gh3', { repo: 'acme/shop', apiBaseUrl: origin, token: 'short' });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.text()).includes('short'), false, 'a validation error never echoes the submitted token');
  assert.equal((await call('GET', '/v1/integrations/gh')).status, 200);
  assert.equal((await call('POST', '/v1/integrations/gh/test')).status, 200);

  const jobId = makeRun();
  const created = await call('POST', '/v1/bug-reports', { fromJobId: jobId });
  assert.equal(created.status, 201);
  const { report } = (await created.json()) as { report: { id: string } };
  assert.equal((await call('POST', '/v1/bug-reports', { fromJobId: makeRun() })).status, 200, 'the same failure: no new report');
  assert.equal((await call('POST', '/v1/bug-reports', { fromJobId: 'not-a-job' })).status, 400);
  assert.equal((await call('POST', '/v1/bug-reports', { fromJobId: 'job_nothere' })).status, 404);
  assert.equal((await call('POST', '/v1/bug-reports', { fromJobId: jobId, extra: 1 })).status, 400, 'unknown fields are refused');

  const list = (await (await call('GET', '/v1/bug-reports')).json()) as { bugReports: Array<Record<string, unknown>> };
  assert.equal(list.bugReports.length, 1);
  assert.equal('body' in list.bugReports[0]!, false, 'the list does not carry the body');
  assert.equal(list.bugReports[0]!.occurrenceCount, 2);
  assert.equal((await call('GET', '/v1/bug-reports?status=bogus')).status, 400);
  const markdown = await call('GET', `/v1/bug-reports/${report.id}?format=md`);
  assert.match(markdown.headers.get('content-type') ?? '', /text\/markdown/);
  assert.match(await markdown.text(), /^# \[ScrapForAI\] cart-total failed at step total/);
  assert.equal((await call('GET', '/v1/bug-reports/bug_nothere')).status, 404);

  assert.equal((await call('POST', `/v1/bug-reports/${report.id}/send`, {}, {})).status, 401, 'no credentials');
  assert.equal(seen.filter((item) => item.method === 'POST').length, 0);
  const sent = await call('POST', `/v1/bug-reports/${report.id}/send`, {});
  assert.equal(sent.status, 200);
  const sentBody = (await sent.json()) as { status: string; report: { issue: { number: number } } };
  assert.equal(sentBody.status, 'sent');
  assert.equal(sentBody.report.issue.number, 42);
  assert.equal((await call('POST', `/v1/bug-reports/${report.id}/send`, {})).status, 409);

  const second = makeRun({ stepId: 'second-bug' });
  const other = (await (await call('POST', '/v1/bug-reports', { fromJobId: second })).json()) as { report: { id: string } };
  answer = { status: 500 };
  assert.equal((await call('POST', `/v1/bug-reports/${other.report.id}/send`, {})).status, 502, 'the tracker did not take it');
  answer = { status: 201 };
  assert.equal((await call('POST', `/v1/bug-reports/${other.report.id}/dismiss`, { note: 'not now' })).status, 200);
  assert.equal((await call('POST', `/v1/bug-reports/${other.report.id}/send`, {})).status, 409, 'a dismissed report cannot be sent');
  assert.equal((await call('POST', `/v1/bug-reports/${report.id}/resolve`, {})).status, 200);

  assert.equal((await call('DELETE', '/v1/integrations/gh')).status, 204);
  assert.equal((await call('GET', '/v1/integrations/gh')).status, 404);
});
