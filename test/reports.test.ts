import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const API_KEY = 'test-api-key-1234567890';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-reports-test-'));
process.env.SCRAPFORAI_API_KEY = API_KEY;
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts'); // .env may pin it
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';
process.env.ALLOWED_RESOURCE_ORIGINS = 'https://dev.example.com';

const express = (await import('express')).default;
const { env } = await import('../src/config/env.js');
const { apiAuth } = await import('../src/security/apiAuth.js');
const { runsRouter } = await import('../src/routes/runs.routes.js');
const { suitesRouter } = await import('../src/routes/suites.routes.js');
const { renderRunReport, renderSuiteReport, esc } = await import('../src/reports/render.js');
const { STRINGS, REPORT_LANGS } = await import('../src/reports/i18n.js');
const { buildManifest, writeManifest } = await import('../src/evidence/manifest.js');
const { pinJob } = await import('../src/evidence/pin.js');
const { saveTarget } = await import('../src/targets/targetStore.js');
const { loadPublicKey } = await import('../src/evidence/signingKey.js');
const { suitesDir } = await import('../src/config/paths.js');

let server: http.Server;
let baseUrl: string;
const bearer = { authorization: `Bearer ${API_KEY}` };

before(async () => {
  await saveTarget({
    id: 'shop', name: 'Shop <Main>', platform: 'generic', environment: 'qa', baseUrl: 'https://dev.example.com/', credentialSets: [], noiseFilters: [],
    surfaces: {}, screens: [], flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  });
  const app = express();
  app.use(express.json());
  app.use(apiAuth);
  app.use('/v1/runs', runsRouter);
  app.use('/v1/suites', suitesRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function makeJob(jobId: string, over: Record<string, unknown> = {}): Promise<void> {
  const dir = path.join(env.ARTIFACT_DIR, jobId);
  fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true });
  const result = {
    jobId, scenarioName: 'Cart <script>alert(1)</script>', status: 'failed', startedAt: '2026-11-02T10:00:00.000Z', finishedAt: '2026-11-02T10:00:03.000Z', durationMs: 3000,
    targetUrl: 'https://dev.example.com/cart', caller: { source: 'nightly-ci' }, buildId: 'rev42', failedStepIndex: 1,
    error: { type: 'StepExecutionError', message: 'Expected "<b>Total: 4</b>" & got 5' },
    routine: { id: 'cart-total', version: 3, sha256: 'a'.repeat(64) },
    steps: [
      { index: 0, id: 'open', action: 'goto', status: 'passed', startedAt: 'x', finishedAt: 'y', durationMs: 120 },
      { index: 1, id: 'total', label: 'Check <total>', action: 'assertTextContains', status: 'failed', startedAt: 'x', finishedAt: 'y', durationMs: 510, error: { type: 'StepExecutionError', message: 'Expected "<b>Total: 4</b>" & got 5' } },
    ],
    teardown: [{ index: 0, id: 'bye', action: 'goto', status: 'failed', startedAt: 'x', finishedAt: 'y', durationMs: 5, error: { type: 'X', message: 'no logout' } }],
    teardownStatus: 'failed', extracted: {},
    evidence: {
      screenshots: [{ name: 'failure', path: `artifacts/${jobId}/screenshots/failure.png` }, { name: 'after', path: `artifacts/${jobId}/screenshots/after.png` }],
      console: [{ type: 'error', text: 'boom' }, { type: 'log', text: 'hi' }], consoleErrors: [{ type: 'error', text: 'boom <img src=x onerror=alert(1)>' }], pageErrors: [],
      network: [{ origin: 'https://dev.example.com', pathname: '/api', method: 'GET', status: 500 }],
      networkFailures: [{ origin: 'https://dev.example.com', pathname: '/api', method: 'GET', status: 500 }], unexpectedExternalRequests: [],
    },
    ...over,
  };
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result));
  fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify({ targetProfile: 'shop' }));
  fs.writeFileSync(path.join(dir, 'screenshots', 'failure.png'), PNG);
  fs.writeFileSync(path.join(dir, 'screenshots', 'after.png'), PNG);
  await writeManifest(dir, await buildManifest(dir, jobId, 'ephemeral'));
}

const get = async (url: string) => {
  const response = await fetch(`${baseUrl}${url}`, { headers: bearer });
  return { status: response.status, type: response.headers.get('content-type') ?? '', text: await response.text() };
};

test('every language has every string (no key left untranslated)', () => {
  const keys = Object.keys(STRINGS.en).sort();
  for (const lang of REPORT_LANGS) {
    assert.deepEqual(Object.keys(STRINGS[lang]).sort(), keys, lang);
    assert.ok(Object.values(STRINGS[lang]).every((value) => value.length > 0), lang);
  }
  assert.notEqual(STRINGS.pt.verdict, STRINGS.en.verdict);
  assert.notEqual(STRINGS.es.proves, STRINGS.pt.proves);
});

test('esc neutralizes HTML, quotes and non-strings', () => {
  assert.equal(esc(`<a href="x" onclick='y'>&</a>`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  assert.equal(esc(undefined), '');
  assert.equal(esc(5), '5');
});

test('run report: header, verdict, steps, failure evidence, teardown warning - and nothing from the run is raw HTML', async () => {
  await makeJob('job_rep1');
  const response = await get('/v1/runs/job_rep1/report?lang=en');
  assert.equal(response.status, 200);
  assert.match(response.type, /text\/html/);

  const html = response.text;
  assert.match(html, /<html lang="en">/);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"/);
  assert.match(html, /FAILED/);
  for (const expected of ['Shop &lt;Main&gt;', 'qa', 'rev42', 'nightly-ci', 'cart-total v3', 'job_rep1', '3.0 s', 'Check &lt;total&gt;', 'Evidence of the failure', 'The cleanup failed', 'Not signed']) {
    assert.ok(html.includes(expected), `missing: ${expected}`);
  }
  assert.equal((html.match(/<img /g) ?? []).length, 2, 'the failure shot up top and the other one in the gallery; no injected element');

  // The hostile strings are text, never markup.
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('<b>Total: 4</b>'));
  assert.ok(html.includes('boom &lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!/<script/i.test(html), 'the report contains no script element at all');
});

test('the same report in Portuguese and Spanish, and a bad lang or format is a 400', async () => {
  const pt = (await get('/v1/runs/job_rep1/report?lang=pt')).text;
  assert.match(pt, /<html lang="pt">/);
  assert.ok(pt.includes('REPROVADO') && pt.includes('Evidência da falha') && pt.includes('Executado por'));

  const es = (await get('/v1/runs/job_rep1/report?lang=es')).text;
  assert.ok(es.includes('REPROBADO') && es.includes('Evidencia del fallo') && es.includes('Ejecutado por'));

  assert.equal((await get('/v1/runs/job_rep1/report?lang=fr')).status, 400);
  assert.equal((await get('/v1/runs/job_rep1/report?format=docx')).status, 400);
  assert.equal((await get('/v1/runs/job_nope/report')).status, 404);
  assert.equal((await get('/v1/runs/..%2Fx/report')).status, 400);
  assert.equal((await fetch(`${baseUrl}/v1/runs/job_rep1/report`)).status, 401);
});

test('a pinned run reports a valid signature, key id, manifest hash and chain position; an unsigned one says so', async () => {
  await makeJob('job_rep2', { status: 'passed', error: undefined, failedStepIndex: undefined, teardownStatus: 'passed' });
  const pinned = await pinJob('job_rep2', { reason: 'homologation' });
  const { keyId } = await loadPublicKey();

  const html = (await get('/v1/runs/job_rep2/report?lang=en')).text;
  assert.match(html, /PASSED/);
  assert.ok(html.includes('Signature valid'));
  assert.ok(html.includes(keyId));
  assert.ok(html.includes(pinned.manifestSha256));
  assert.match(html, /Position in the chain of signed evidence<\/th><td>#\d+/);
  assert.ok(!html.includes('Not signed'));
  assert.ok(html.includes('does not prove that the test itself was correct'), 'the report is honest about what the signature means');

  // Tampering with a pinned manifest makes the report refuse to look trustworthy.
  const manifestFile = path.join(dataDir, 'evidence', 'pinned', 'job_rep2', 'manifest.json');
  const original = fs.readFileSync(manifestFile, 'utf8');
  fs.writeFileSync(manifestFile, original.replace('homologation', 'forged'));
  try {
    const tampered = (await get('/v1/runs/job_rep2/report?lang=en')).text;
    assert.ok(tampered.includes('SIGNATURE INVALID'));
    assert.ok(!tampered.includes('Signature valid'));
  } finally {
    fs.writeFileSync(manifestFile, original);
  }
});

test('suite report: verdict, counts, one row per run; refused while the suite is running', async () => {
  fs.mkdirSync(suitesDir(), { recursive: true });
  const base = {
    suiteRunId: 'suite_rep1', name: 'Nightly <all>', createdAt: '2026-11-02T01:00:00.000Z', finishedAt: '2026-11-02T01:05:00.000Z',
    request: { name: 'x', items: [{ routineId: 'a' }], statuses: ['active'], order: 'asIs', mode: 'sequential', failFast: false, buildId: 'rev42' },
    total: 3, counts: { pending: 0, running: 0, passed: 1, failed: 1, error: 1, notRun: 0 }, teardownFailures: 1,
    variants: [
      { variantKey: 'a/cred:admin', routineId: 'a', routineVersion: 1, status: 'passed', jobId: 'job_s1', durationMs: 1500 },
      { variantKey: 'a/cred:ro', routineId: 'a', routineVersion: 1, status: 'failed', jobId: 'job_s2', durationMs: 900, errorType: 'StepExecutionError', errorMessage: 'bad <b>x</b>' },
      { variantKey: 'a/cred:none', routineId: 'a', routineVersion: 1, status: 'error', errorType: 'CredentialSetNotAllowed', errorMessage: 'nope' },
    ],
  };
  fs.writeFileSync(path.join(suitesDir(), 'suite_rep1.json'), JSON.stringify({ ...base, status: 'completed', verdict: 'infra-error', verdictReason: '1 run(s) could not be executed', exitCode: 2 }));
  fs.writeFileSync(path.join(suitesDir(), 'suite_rep2.json'), JSON.stringify({ ...base, suiteRunId: 'suite_rep2', status: 'running' }));

  const html = (await get('/v1/suites/suite_rep1/report?lang=pt')).text;
  assert.match(html, /<html lang="pt">/);
  assert.ok(html.includes('ERRO DE INFRAESTRUTURA'));
  assert.ok(html.includes('Nightly &lt;all&gt;') && html.includes('rev42'));
  assert.ok(html.includes('a/cred:ro') && html.includes('job_s2') && html.includes('CredentialSetNotAllowed'));
  assert.ok(html.includes('bad &lt;b&gt;x&lt;/b&gt;'));
  assert.ok(html.includes('1 APROVADO, 1 REPROVADO, 1 ERRO, 0 NÃO EXECUTADO'));
  assert.ok(html.includes((await loadPublicKey()).keyId));

  const running = await get('/v1/suites/suite_rep2/report');
  assert.equal(running.status, 409);
  assert.equal((await get('/v1/suites/suite_nope/report')).status, 404);
});

test('renderers work from plain data, with nothing optional present', () => {
  const run = renderRunReport(
    { jobId: 'job_min', status: 'passed', targetUrl: 'https://x/', startedAt: 'a', finishedAt: 'b', durationMs: 1, executor: 'ScrapForAI', steps: [], screenshots: [], consoleCount: 0, consoleErrors: [], networkCount: 0, networkFailures: [], integrity: { state: 'none' }, generatedAt: 'now' },
    'en',
  );
  assert.ok(run.includes('not recorded') && run.includes('The evidence has expired'));
  const suite = renderSuiteReport({ suiteRunId: 'suite_min', name: 'n', status: 'completed', createdAt: 'a', counts: { passed: 0, failed: 0, error: 0, notRun: 0 }, total: 0, executor: 'ScrapForAI', variants: [], generatedAt: 'now' }, 'es');
  assert.ok(suite.includes('ERROR DE INFRAESTRUCTURA'), 'no verdict recorded is never presented as a pass');
});

test('T3.5: the suite report shows quarantined routines in a block apart and every attempt of a retried run, in every language, escaped', () => {
  const data = {
    suiteRunId: 'suite_q', name: 'nightly', status: 'completed', verdict: 'green' as const, verdictReason: '1 of 1 run(s) passed', exitCode: 0, createdAt: '2026-11-03T03:00:00.000Z',
    counts: { passed: 3, failed: 1, error: 0, notRun: 0 }, total: 4, executor: 'ScrapForAI', generatedAt: 'now',
    variants: [
      {
        variantKey: 'steady', routineId: 'steady', routineVersion: 1, status: 'passed', jobId: 'job_second', passedOnRetry: true,
        attempts: [
          { attempt: 1, jobId: 'job_first', status: 'failed', errorType: 'AssertionFailed', errorMessage: 'saw <b>x</b>' },
          { attempt: 2, jobId: 'job_second', status: 'passed' },
        ],
      },
      { variantKey: 'wobbly<script>', routineId: 'wobbly', routineVersion: 2, status: 'failed', jobId: 'job_q', quarantined: true, errorType: 'Timeout', errorMessage: 'slow' },
    ],
  };

  for (const lang of REPORT_LANGS) {
    const html = renderSuiteReport(data, lang);
    const s = STRINGS[lang];
    assert.ok(html.includes(s.quarantineTitle), `${lang}: quarantine block`);
    assert.ok(html.includes(s.passedOnRetryNote), `${lang}: retry note`);
    assert.ok(html.includes('job_first') && html.includes('job_second'), `${lang}: both attempts keep their own run id`);
    assert.ok(!html.includes('<script>') && !html.includes('<b>x</b>'), `${lang}: everything from a run is escaped`);

    // The summary counts what counts: the quarantined failure is not in it, and the quarantined run sits AFTER the quarantine heading.
    assert.ok(html.includes(`1: 1 ${s.passed}, 0 ${s.failed}`), `${lang}: counted variants only`);
    assert.ok(html.indexOf('wobbly') > html.indexOf(s.quarantineTitle), `${lang}: the quarantined run is listed under its own heading`);
    assert.ok(html.indexOf('steady') < html.indexOf(s.quarantineTitle));
  }

  const plain = renderSuiteReport({ ...data, variants: [data.variants[0]!.passedOnRetry ? { ...data.variants[0]!, passedOnRetry: undefined, attempts: undefined } : data.variants[0]!] }, 'en');
  assert.ok(!plain.includes(STRINGS.en.quarantineTitle) && !plain.includes(STRINGS.en.passedOnRetryNote), 'no quarantine and no retry: neither block appears');
});

test('T7.2/T7.3: a run with a simulated clock or broken answers says so, in every language, grouped and escaped; a normal run has no such section', async () => {
  await makeJob('job_rep_sim', {
    clock: [
      { stepId: 'jump', mode: 'install', time: '2030-01-31T23:59:50.000Z', fastForwardMs: 90_061_000 },
      { mode: 'fixed', time: '2031-02-03T00:00:00.000Z' },
    ],
    evidence: {
      screenshots: [], console: [], consoleErrors: [], pageErrors: [], network: [], networkFailures: [], unexpectedExternalRequests: [],
      routing: [
        { origin: 'https://dev.example.com', pathname: '/api/save<img src=x>', method: 'POST', handledBy: 'fault', action: 'fulfill', detail: 'status 500' },
        { origin: 'https://dev.example.com', pathname: '/api/save<img src=x>', method: 'POST', handledBy: 'fault', action: 'fulfill', detail: 'status 500' },
        { origin: 'https://dev.example.com', pathname: '/api/list', method: 'GET', handledBy: 'fault', action: 'delay', detail: 'delay 10000 ms' },
        { origin: 'https://evil.example.org', pathname: '/x.png', method: 'GET', handledBy: 'allowlist-guard', action: 'abort' },
      ],
    },
  });

  const en = (await get('/v1/runs/job_rep_sim/report?lang=en')).text;
  for (const expected of ['Simulated conditions', 'Browser clock started at', '2030-01-31T23:59:50.000Z', 'then moved forward by 1 d 1 h 1 min 1 s', 'Browser clock fixed at', 'Only the browser&#39;s clock was changed', 'status 500', 'delay 10000 ms']) {
    assert.ok(en.includes(expected), `missing: ${expected}`);
  }
  assert.ok(en.includes('POST /api/save&lt;img src=x&gt;'), 'the path is text');
  assert.ok(!en.includes('<img src=x>'));
  assert.match(en, /<td>2<\/td>/, 'two identical faults are one row with a count of 2');
  assert.ok(!en.includes('allowlist-guard') && !en.includes('/x.png'), 'only faults are listed, not other policies');

  const pt = (await get('/v1/runs/job_rep_sim/report?lang=pt')).text;
  assert.ok(pt.includes('Condições simuladas') && pt.includes('Relógio do navegador iniciado em') && pt.includes('e adiantado em'));
  const es = (await get('/v1/runs/job_rep_sim/report?lang=es')).text;
  assert.ok(es.includes('Condiciones simuladas') && es.includes('Reloj del navegador fijado en'));

  const normal = (await get('/v1/runs/job_rep1/report?lang=en')).text;
  assert.ok(!normal.includes('Simulated conditions'));
});

test('T7.8: a run that hunted for personal data shows the scan in every language: severity, masked sample, where it looked; escaped; no raw value; a normal run has no section', async () => {
  const fingerprint = 'a'.repeat(64);
  const scan = {
    kind: 'pii-scan',
    findings: [
      { detector: 'jwt', surface: 'url', location: 'GET https://dev.example.com/cb?token,x <script>alert(1)</script> [fragment:id_token]', maskedSample: 'eyJ*** (143 chars)', fingerprint, severity: 'high', count: 2 },
      { detector: 'email', surface: 'hidden-input', location: 'hidden input "customer_email"', maskedSample: 'm***@e***.uy', fingerprint: 'b'.repeat(64), severity: 'info', count: 1 },
    ],
    counts: { total: 2, bySeverity: { high: 1, medium: 0, low: 0, info: 1 }, byDetector: [{ detector: 'jwt', count: 1 }, { detector: 'email', count: 1 }], bySurface: [{ surface: 'url', count: 1 }, { surface: 'hidden-input', count: 1 }] },
    scanned: { urls: 12, console: 3, responseBodies: 4, responseBodiesSkipped: 1, storageEntries: 5, jarEntries: 2, hiddenInputs: 1 },
    truncated: true,
    notes: ['cookies could not be read (Error)'],
  };
  await makeJob('job_rep_pii', { pii: scan, extracted: { sweep: { ...scan, findings: [], counts: { total: 0, bySeverity: { high: 0, medium: 0, low: 0, info: 0 }, byDetector: [], bySurface: [] }, truncated: false, notes: [] } } });

  const en = (await get('/v1/runs/job_rep_pii/report?lang=en')).text;
  for (const expected of ['Privacy scan', 'sev-high', 'eyJ*** (143 chars)', 'm***@e***.uy', 'hidden input &quot;customer_email&quot;', 'URLs 12 · console 3 · bodies 4 (+1 skipped) · storage 5 · cookies 2 · hidden inputs 1', 'The list was cut at its limit', 'cookies could not be read', 'No personal data or secrets were found in the places that were looked at', 'The values are not stored']) {
    assert.ok(en.includes(expected), `missing: ${expected}`);
  }
  assert.ok(!en.includes('<script>alert(1)</script>'), 'a location comes from a page: it is text');
  assert.ok(en.indexOf('eyJ***') < en.indexOf('m***@e***.uy'), 'most severe first');
  assert.ok(!en.includes(fingerprint), 'the fingerprint is for correlation, not for the page of a person');
  assert.ok((await get('/v1/runs/job_rep_pii/report?lang=pt')).text.includes('Varredura de privacidade'));
  assert.ok((await get('/v1/runs/job_rep_pii/report?lang=es')).text.includes('Escaneo de privacidad'));
  assert.ok(!(await get('/v1/runs/job_rep1/report?lang=en')).text.includes('Privacy scan'));
});
