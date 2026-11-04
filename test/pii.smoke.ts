import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// T7.8 end to end (real Chromium): a page that leaks on purpose through every surface the hunt looks at, and a clean one.
// The values the page leaks are built at run time from pieces, so they are NOT in the HTML source (otherwise the unauthenticated body of "/" would
// find them too and every assertion would be muddied). The test then walks the whole data directory: no raw value may be on disk.

const CPF_LOG = '529.982.247-25'; // printed to the console
const CPF_API = '111.444.777-35'; // served by a public endpoint
const EMAIL_HIDDEN = 'hidden.person@example.com.uy';
const EMAIL_API = 'ana.api@example.com';
const JWT_STORAGE = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzdG9yYWdlIn0.storagesignature12345';
const JWT_URL = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1cmwifQ.urlsignature123456789';
const TOKEN_STORAGE = 'opaque-storage-token-123456';
const TOKEN_URL = 'opaque-url-token-123456';
const API_KEY_HIDDEN = 'live_hiddenkey1234567890';
const SESSION_COOKIE = 'S'.repeat(8) + 'E'.repeat(8) + 'C'.repeat(8) + 'R'.repeat(8);
const PASSWORD = 'Sup3rS3cret!';
const PRIVATE_CPF = '935.411.347-80';

/** A JS expression that rebuilds `value` from two halves, so the literal is not in the page source. */
const lit = (value: string) => `[${JSON.stringify(value.slice(0, 5))},${JSON.stringify(value.slice(5))}].join('')`;

const leakyPage = `<!doctype html><title>Leaky</title>
<input id="pw" type="password"><button id="cookie">go</button><div id="state">idle</div>
<script>
// The page puts the secrets in its own address (as an OAuth callback would), so they do not travel in the request of the run.
history.replaceState(null, '', '/?access_token=' + ${lit(TOKEN_URL)} + '#id_token=' + ${lit(JWT_URL)});
localStorage.setItem('access_token', ${lit(TOKEN_STORAGE)});
localStorage.setItem('profile', JSON.stringify({ jwt: ${lit(JWT_STORAGE)} }));
sessionStorage.setItem('theme', 'dark');
console.log('customer document ' + ${lit(CPF_LOG)});
var hidden = [['customer_email', ${lit(EMAIL_HIDDEN)}], ['csrf_token', 'abcdef1234567890abcdef'], ['api_key', ${lit(API_KEY_HIDDEN)}]];
hidden.forEach(function (pair) {
  var input = document.createElement('input'); input.type = 'hidden'; input.name = pair[0]; input.value = pair[1]; document.body.appendChild(input);
});
document.getElementById('pw').addEventListener('input', function (e) { console.log('typed ' + e.target.value); });
fetch('/public/customers.json').then(function (r) { return r.json(); }).then(function () { document.getElementById('state').textContent = 'public loaded'; });
document.getElementById('cookie').onclick = function () {
  fetch('/login', { method: 'POST' }).then(function () {
    document.cookie = 'app_session=' + ${lit(SESSION_COOKIE)} + '; path=/';
    return fetch('/private/me.json');
  }).then(function (r) { return r.json(); }).then(function () { document.getElementById('state').textContent = 'private loaded'; });
};
</script>`;

const site = await new Promise<{ server: http.Server; origin: string }>((resolve) => {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/login') {
      res.setHeader('set-cookie', 'sid=HTTPONLYVALUE1234567890ABCDEF; Path=/; HttpOnly');
      res.setHeader('content-type', 'application/json');
      return res.end('{"ok":true}');
    }
    if (url.startsWith('/public/customers.json')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ customers: [{ cpf: CPF_API, email: EMAIL_API }] }));
    }
    if (url.startsWith('/private/me.json')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ cpf: PRIVATE_CPF }));
    }
    res.setHeader('content-type', 'text/html');
    res.end(url.startsWith('/clean') ? '<!doctype html><title>Clean</title><h1>Nothing to see</h1><div id="ok">ok</div>' : leakyPage);
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-pii-smoke-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = site.origin;

const { resolveExplorationRequest } = await import('../src/runner/resolveRequest.js');
const { runExploration } = await import('../src/runner/runExploration.js');
const { explorationRequestSchema } = await import('../src/schemas/explorationRequest.schema.js');
const { isValidDocument } = await import('../src/generators/generators.js');

after(async () => {
  await new Promise<void>((resolve) => site.server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('the sample CPFs are valid (a typo here would silently weaken the test)', () => {
  for (const cpf of [CPF_LOG, CPF_API, PRIVATE_CPF]) assert.ok(isValidDocument('cpf', cpf), cpf);
});

async function run(input: { url?: string; steps: unknown[]; options?: Record<string, unknown>; credentials?: Record<string, string> }) {
  const request = explorationRequestSchema.parse({
    targetUrl: `${site.origin}/`,
    ...(input.credentials ? { credentials: input.credentials } : {}),
    ...(input.options ? { options: input.options } : {}),
    steps: [{ id: 'open', action: 'goto', url: input.url ?? `${site.origin}/` }, ...input.steps],
  });
  return runExploration(await resolveExplorationRequest(request));
}

const stateBecomes = (text: string) => ({ action: 'waitForSelector', selector: `#state:has-text("${text}")`, state: 'visible', timeoutMs: 8000 });
const leakySteps = [
  stateBecomes('public loaded'),
  { action: 'fill', selector: '#pw', valueFromCredential: 'password' },
  { action: 'click', selector: '#cookie' },
  stateBecomes('private loaded'),
];
const leakyUrl = () => `${site.origin}/`;

type Report = NonNullable<Awaited<ReturnType<typeof run>>['pii']>;
const find = (report: Report, detector: string, surface: string) => report.findings.filter((finding) => finding.detector === detector && finding.surface === surface);

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
}

test('options.piiScan: every surface is found, severities are as documented, the authenticated body and the HttpOnly cookie are not', async () => {
  const result = await run({ url: leakyUrl(), steps: leakySteps, options: { piiScan: true, trace: false }, credentials: { password: PASSWORD } });
  assert.equal(result.status, 'passed', JSON.stringify(result.error));
  const pii = result.pii;
  assert.ok(pii, 'the result carries the report');
  assert.equal(pii.kind, 'pii-scan');

  // URL: a token in the query and a JWT in the fragment, both high.
  assert.equal(find(pii, 'secret-named', 'url')[0]?.severity, 'high');
  assert.match(find(pii, 'secret-named', 'url')[0]!.location, /\[query:access_token\]/);
  assert.match(find(pii, 'jwt', 'url')[0]!.location, /\[fragment:id_token\]/);
  // Console: the document the page printed, and the password the run typed (a vault value: known-secret).
  assert.equal(find(pii, 'cpf', 'console').length, 1);
  assert.equal(find(pii, 'cpf', 'console')[0]?.maskedSample, '***.***.***-25');
  assert.equal(find(pii, 'known-secret', 'console').length, 1);
  // Storage.
  assert.equal(find(pii, 'secret-named', 'storage')[0]?.location, 'localStorage["access_token"]');
  assert.equal(find(pii, 'jwt', 'storage')[0]?.location, 'localStorage["profile"]');
  assert.equal(find(pii, 'secret-named', 'storage')[0]?.severity, 'medium');
  // Hidden inputs: the e-mail (informative) and the api key; the anti-forgery token is meant to be there.
  assert.equal(find(pii, 'email', 'hidden-input')[0]?.severity, 'info');
  assert.deepEqual(find(pii, 'secret-named', 'hidden-input').map((finding) => finding.location), ['hidden input "api_key"']);
  // Cookies: the one a script can read; never the HttpOnly one.
  assert.deepEqual(find(pii, 'cookie-no-httponly', 'cookie').map((finding) => finding.location.split(' (')[0]), ['cookie "app_session"']);
  assert.ok(!pii.findings.some((finding) => finding.location.includes('"sid"')), 'an HttpOnly cookie is not exposed to scripts');
  // Bodies of requests WITHOUT credentials: the public endpoint leaks; the one that carried the session cookie is the user's own and is skipped.
  assert.equal(find(pii, 'cpf', 'response-body').length, 1);
  assert.match(find(pii, 'cpf', 'response-body')[0]!.location, /GET http:\/\/127\.0\.0\.1:\d+\/public\/customers\.json \(response, no credentials sent\)/);
  assert.equal(find(pii, 'cpf', 'response-body')[0]?.severity, 'high');
  assert.equal(find(pii, 'email', 'response-body')[0]?.severity, 'low');
  assert.ok(!pii.findings.some((finding) => finding.location.includes('/private/')), 'a body fetched with the session cookie is not scanned');
  assert.ok(pii.scanned.urls > 0 && pii.scanned.console > 0 && pii.scanned.responseBodies >= 2 && pii.scanned.storageEntries === 3 && pii.scanned.hiddenInputs === 3 && pii.scanned.jarEntries >= 2, JSON.stringify(pii.scanned));
  assert.equal(pii.counts.total, pii.findings.length);
  assert.ok(pii.findings[0] && pii.findings[0].severity === 'high', 'most severe first');
  assert.ok(pii.findings.every((finding) => /^[0-9a-f]{64}$/.test(finding.fingerprint)));

  // Nothing raw anywhere in the report...
  const reported = JSON.stringify(pii);
  for (const raw of [CPF_LOG, CPF_API, EMAIL_HIDDEN, EMAIL_API, JWT_STORAGE, JWT_URL, TOKEN_STORAGE, TOKEN_URL, API_KEY_HIDDEN, SESSION_COOKIE, PASSWORD, PRIVATE_CPF]) {
    assert.ok(!reported.includes(raw), `the report holds ${raw.slice(0, 8)}...`);
  }
  // ...and nothing raw on disk: a run that hunts also masks what it keeps as console evidence, the URL a console line came from and the final URL.
  const disk = walk(dataDir)
    .filter((file) => !/vault\.key|pii-fingerprint\.key|signing/.test(file))
    .map((file) => ({ file, text: fs.readFileSync(file, 'latin1') }));
  assert.ok(disk.length > 0);
  for (const raw of [CPF_LOG, CPF_API, EMAIL_HIDDEN, EMAIL_API, JWT_STORAGE, JWT_URL, TOKEN_STORAGE, TOKEN_URL, API_KEY_HIDDEN, SESSION_COOKIE, PASSWORD, PRIVATE_CPF]) {
    const where = disk.find((entry) => entry.text.includes(raw));
    const at = where ? where.text.indexOf(raw) : -1;
    assert.ok(!where, `${raw.slice(0, 8)}... is on disk in ${where?.file}, around: ${where?.text.slice(Math.max(0, at - 90), at).replace(/\s+/g, ' ')}<VALUE>`);
  }
});

test('a run that does not ask for the hunt has no report and attaches nothing', async () => {
  const result = await run({ url: leakyUrl(), steps: [stateBecomes('public loaded')] });
  assert.equal(result.pii, undefined);
});

test('scanForPii: failOn "high" fails and names the finding masked; "none" only records; the verdict of other levels', async () => {
  const strict = await run({ url: leakyUrl(), steps: [stateBecomes('public loaded'), { id: 'hunt', action: 'scanForPii', name: 'pii', failOn: 'high' }] });
  assert.equal(strict.status, 'failed');
  const failure = strict.steps.find((step) => step.id === 'hunt');
  assert.equal(failure?.status, 'failed');
  assert.match(failure?.error?.message ?? '', /scanForPii: \d+ finding\(s\) at "high" or above, e\.g\. \w[\w-]* \(high\) in \w[\w-]*: /);
  for (const raw of [TOKEN_URL, JWT_URL, CPF_API]) assert.ok(!(failure?.error?.message ?? '').includes(raw));
  assert.ok((strict.extracted['pii'] as { findings: unknown[] }).findings.length > 0, 'the report is kept even when the step fails');
  assert.equal(strict.pii, undefined, 'result.pii is for options.piiScan; a step reports in extracted');

  const lenient = await run({ url: leakyUrl(), steps: [stateBecomes('public loaded'), { action: 'scanForPii', name: 'pii' }] });
  assert.equal(lenient.status, 'passed');
  assert.ok((lenient.extracted['pii'] as { counts: { total: number } }).counts.total > 0);
});

test('scanForPii with surfaces only reports those', async () => {
  const result = await run({ url: leakyUrl(), steps: [stateBecomes('public loaded'), { action: 'scanForPii', name: 'pii', surfaces: ['storage'] }] });
  const report = result.extracted['pii'] as Report;
  assert.ok(report.findings.length > 0);
  assert.ok(report.findings.every((finding) => finding.surface === 'storage'));
});

test('a clean page has no findings, and the report says what was looked at', async () => {
  const result = await run({ url: `${site.origin}/clean`, steps: [{ action: 'assertVisible', selector: '#ok' }], options: { piiScan: true } });
  assert.equal(result.status, 'passed');
  assert.equal(result.pii?.counts.total, 0);
  assert.ok((result.pii?.scanned.urls ?? 0) > 0, 'it looked at the URLs');
  assert.ok((result.pii?.scanned.responseBodies ?? 0) >= 1, 'it read the page it was served');
});

test('T7.9: the profile re-rates and suppresses; the suppressed finding stays visible with its reason and does not fail a step; known-secret cannot be hidden', async () => {
  const { saveTarget } = await import('../src/targets/targetStore.js');
  const { targetProfileSchema } = await import('../src/schemas/targetProfile.schema.js');
  const until = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  await saveTarget(
    targetProfileSchema.parse({
      id: 'leaky',
      name: 'Leaky',
      environment: 'qa',
      baseUrl: `${site.origin}/`,
      pii: {
        severity: [{ detector: 'secret-named', surface: 'storage', severity: 'low', note: 'this app keeps its API token in storage by design' }],
        suppressions: [
          { id: 'hidden-email', detector: 'email', surface: 'hidden-input', locationContains: 'customer_email', reason: 'the form carries the signed-in user e-mail on purpose', until },
          { id: 'api-cpf', detector: 'cpf', surface: 'response-body', locationContains: '/public/customers.json', reason: 'fixture endpoint returns test documents', until },
        ],
      },
    }),
  );

  const request = explorationRequestSchema.parse({
    targetUrl: `${site.origin}/`,
    targetProfile: 'leaky',
    credentials: { password: PASSWORD },
    options: { piiScan: true },
    steps: [{ id: 'open', action: 'goto', url: leakyUrl() }, ...leakySteps, { id: 'hunt', action: 'scanForPii', name: 'pii', surfaces: ['hidden-input', 'storage', 'response-body'], failOn: 'medium' }],
  });
  const result = await runExploration(await resolveExplorationRequest(request));
  const pii = result.pii!;
  assert.ok(pii);

  // The e-mail in the hidden input and the CPF of the public endpoint are expected: out of the list, in `suppressed`, with the why.
  assert.ok(!pii.findings.some((f) => f.detector === 'email' && f.surface === 'hidden-input'));
  assert.ok(!pii.findings.some((f) => f.detector === 'cpf' && f.surface === 'response-body'));
  assert.deepEqual(pii.suppressed?.map((x) => x.suppression).sort(), ['api-cpf', 'hidden-email']);
  assert.ok(pii.suppressed?.every((x) => x.reason.length > 10 && x.until === until));
  assert.equal(pii.counts.total, pii.findings.length, 'suppressed findings are not counted');

  // The storage token was medium; the profile says low, and the finding says why.
  const token = pii.findings.find((f) => f.detector === 'secret-named' && f.surface === 'storage')!;
  assert.equal(token.severity, 'low');
  assert.match(token.severityReason ?? '', /^profile policy: medium -> low \(this app keeps its API token in storage by design\)/);

  // What the profile did not cover still counts, including the vault value on the console, which no policy can touch.
  assert.ok(pii.findings.some((f) => f.detector === 'known-secret' && f.surface === 'console' && f.severity === 'high'));
  assert.ok(pii.findings.some((f) => f.detector === 'jwt' && f.surface === 'url'));

  // The step looked at three surfaces with failOn "medium": the hidden api key and the JWT in storage (both medium) fail it; the suppressed items did not count.
  const hunt = result.steps.find((step) => step.id === 'hunt');
  assert.equal(hunt?.status, 'failed');
  assert.match(hunt?.error?.message ?? '', /scanForPii: 2 finding\(s\) at "medium" or above, e\.g\. secret-named \(medium\) in hidden-input: hidden input "api_key"/);
});
