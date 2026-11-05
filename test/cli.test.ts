import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { after, before } from 'node:test';

process.env.SCRAPFORAI_API_KEY ??= 'test-api-key-1234567890';
process.env.ALLOWED_TARGET_ORIGINS ??= 'https://dev.example.com';

const { runCli } = await import('../src/cli/runCli.js');
const { cliOutputSchema } = await import('../src/schemas/cliOutput.schema.js');
const { buildCliOutputJsonSchema } = await import('../src/schemas/jsonSchema.js');

const KEY = 'cli-test-key-1234567890';

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  body: unknown;
}

let server: http.Server;
let baseUrl: string;
let seen: Seen[] = [];
let handler: (req: Seen, respond: (status: number, body: unknown) => void) => void = () => undefined;

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const entry: Seen = { method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body: text ? JSON.parse(text) : undefined };
      seen.push(entry);
      handler(entry, (status, body) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function io(extra: Partial<Parameters<typeof runCli>[2]> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (t: string) => void out.push(t), err: (t: string) => void err.push(t), ...extra } };
}

async function cli(args: string[], extra: Partial<Parameters<typeof runCli>[2]> = {}, url = baseUrl) {
  const streams = io(extra);
  seen = [];
  const code = await runCli(args, { baseUrl: url, apiKey: KEY, requestTimeoutMs: 5000 }, streams.io);
  return { code, stdout: streams.out.join(''), stderr: streams.err.join('') };
}

/** Every --json invocation prints exactly one object that matches the published contract. */
function validJson(stdout: string): any {
  assert.equal(stdout.trim().split('\n').length, 1, 'exactly one line of JSON on stdout');
  const parsed = JSON.parse(stdout);
  const check = cliOutputSchema.safeParse(parsed);
  assert.ok(check.success, check.success ? '' : JSON.stringify(check.error.issues.slice(0, 3)));
  assert.equal(parsed.cliSchema, 1);
  return parsed;
}

const passedResult = {
  jobId: 'job_abc', scenarioName: 'crud', status: 'passed', durationMs: 3200, routine: { id: 'crud', version: 2, sha256: 'a'.repeat(64) },
  steps: [{ index: 0, action: 'goto', status: 'passed' }, { index: 1, action: 'click', status: 'passed' }], evidence: { screenshots: [] },
};
const failedResult = {
  ...passedResult, jobId: 'job_bad', status: 'failed', failedStepIndex: 1, error: { type: 'StepExecutionError', message: 'Expected selector to be visible' },
  steps: [{ index: 0, action: 'goto', status: 'passed' }, { index: 1, action: 'assertVisible', status: 'failed' }], teardownStatus: 'failed',
};

test('run: a passing routine exits 0 and sends the right request', async () => {
  handler = (_req, respond) => respond(200, passedResult);
  const result = await cli(['run', 'crud', '--version', '2', '--target', 'qa', '--credential', 'gam-admin', '--var', 'name=Ana', '--var', 'expr=a=b']);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /PASSED\s+crud@v2\s+job_abc/);
  assert.equal(seen[0]!.method, 'POST');
  assert.equal(seen[0]!.url, '/v1/routines/crud/run?version=2');
  assert.equal(seen[0]!.auth, `Bearer ${KEY}`);
  assert.deepEqual(seen[0]!.body, { variables: { name: 'Ana', expr: 'a=b' }, credentialSet: 'gam-admin', targetProfile: 'qa' });
});

test('run: a red routine (HTTP 500 with a result body) exits 1, not 2', async () => {
  handler = (_req, respond) => respond(500, failedResult);
  const result = await cli(['run', 'crud']);

  assert.equal(result.code, 1);
  assert.match(result.stdout, /FAILED/);
  assert.match(result.stdout, /step 2 \(assertVisible\): StepExecutionError: Expected selector to be visible/);
  assert.match(result.stdout, /teardown failed/);
});

test('run --json: stable, versioned, validated against the schema', async () => {
  handler = (_req, respond) => respond(200, passedResult);
  const green = validJson((await cli(['run', 'crud', '--json'])).stdout);
  assert.deepEqual([green.command, green.exitCode, green.result.status, green.result.steps], ['run', 0, 'passed', { total: 2, passed: 2, failed: 0 }]);

  handler = (_req, respond) => respond(500, failedResult);
  const red = await cli(['run', 'crud', '--json']);
  const parsed = validJson(red.stdout);
  assert.equal(red.code, 1);
  assert.deepEqual([parsed.exitCode, parsed.result.failedStepIndex, parsed.result.error.type, parsed.result.teardownStatus], [1, 1, 'StepExecutionError', 'failed']);
});

test('run: the API being down is exit 2 (not 1), in both output modes', async () => {
  const dead = http.createServer();
  await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve));
  const deadUrl = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`;
  await new Promise<void>((resolve) => dead.close(() => resolve()));

  const human = await cli(['run', 'crud'], {}, deadUrl);
  assert.equal(human.code, 2);
  assert.match(human.stderr, /ApiUnreachable/);
  assert.equal(human.stdout, '', 'human errors go to stderr only');

  const json = await cli(['run', 'crud', '--json'], {}, deadUrl);
  assert.equal(json.code, 2);
  const parsed = validJson(json.stdout);
  assert.equal(parsed.error.type, 'ApiUnreachable');
  assert.equal(parsed.result, undefined);
});

test('run: API refusals (404, 409, 400, 429) are exit 2 with the API\'s error type', async () => {
  for (const [status, type] of [[404, 'RoutineNotFound'], [409, 'CredentialInUse'], [400, 'ValidationError'], [429, 'TooManyRequests']] as const) {
    handler = (_req, respond) => respond(status, { error: { type, message: `nope ${type}`, ...(status === 400 ? { details: [{ path: 'x', message: 'bad' }] } : {}) } });
    const result = await cli(['run', 'crud', '--json']);
    assert.equal(result.code, 2, type);
    const parsed = validJson(result.stdout);
    assert.equal(parsed.error.type, type);
    if (status === 400) assert.match(parsed.error.message, /x: bad/);
  }
});

test('usage errors are exit 2 and never reach the API', async () => {
  handler = (_req, respond) => respond(200, passedResult);
  seen = [];

  for (const args of [['run'], ['run', 'a', 'b'], ['run', 'a', '--version', 'abc'], ['run', 'a', '--var', 'novalue'], ['run', 'a', '--retention', 'forever'], ['run', 'a', '--nonsense'], ['bogus'], ['routines'], ['pin', 'job_1'], ['suite']]) {
    const result = await cli(args);
    assert.equal(result.code, 2, args.join(' '));
    assert.match(result.stderr, /^error: /);
  }
  assert.equal(seen.length, 0);

  const json = await cli(['bogus', '--json']);
  assert.equal(validJson(json.stdout).error.type, 'UsageError');
});

test('--help prints usage with exit 0; no arguments is a usage error (2)', async () => {
  const help = await cli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /scrapforai <command>/);
  assert.match(help.stdout, /Exit codes: 0 passed, 1 a test failed, 2/);
  assert.equal((await cli([])).code, 2);
});

const suiteBody = { name: 'nightly', items: [{ routineId: 'crud' }] };
const suiteState = (over: Record<string, unknown>) => ({
  suiteRunId: 'suite_abc', name: 'nightly', status: 'completed', createdAt: new Date().toISOString(), request: { ...suiteBody, statuses: ['active'], mode: 'sequential', failFast: false },
  total: 2, counts: { pending: 0, running: 0, passed: 1, failed: 1, error: 0, notRun: 0 },
  variants: [
    { variantKey: 'crud/cred:a', routineId: 'crud', routineVersion: 1, status: 'passed', jobId: 'job_1' },
    { variantKey: 'crud/cred:b', routineId: 'crud', routineVersion: 1, status: 'failed', jobId: 'job_2', errorType: 'StepExecutionError', errorMessage: 'boom' },
  ],
  verdict: 'red', verdictReason: '1 of 2 run(s) failed', exitCode: 1, ...over,
});

test('suite: waits through long-polls and exits with the suite\'s verdict (red = 1)', async () => {
  let polls = 0;
  handler = (req, respond) => {
    if (req.method === 'POST') return respond(202, { suiteRunId: 'suite_abc', status: 'running', total: 2, variants: [] });
    polls += 1;
    respond(200, polls < 3 ? suiteState({ status: 'running', verdict: undefined, exitCode: undefined, counts: { pending: 1, running: 1, passed: 0, failed: 0, error: 0, notRun: 0 } }) : suiteState({}));
  };

  const result = await cli(['suite', 'nightly.json'], { readFile: async () => JSON.stringify(suiteBody) });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /FAIL\s+crud\/cred:b\s+job_2\s+StepExecutionError: boom/);
  assert.match(result.stdout, /Verdict: RED \(exit 1\)/);
  assert.match(result.stderr, /\[suite_abc\] 0\/2 done/, 'progress goes to stderr');
  assert.equal(polls, 3);
  assert.match(seen.at(-1)!.url, /\/v1\/suites\/suite_abc\?wait=\d+/);
  assert.deepEqual(seen[0]!.body, suiteBody, 'the file is sent as is');
});

test('suite --json: green is 0, infra-error is 2, and stdout is one valid object', async () => {
  for (const [verdict, exitCode, counts] of [
    ['green', 0, { pending: 0, running: 0, passed: 2, failed: 0, error: 0, notRun: 0 }],
    ['infra-error', 2, { pending: 0, running: 0, passed: 1, failed: 0, error: 1, notRun: 0 }],
  ] as const) {
    handler = (req, respond) => respond(req.method === 'POST' ? 202 : 200, req.method === 'POST' ? { suiteRunId: 'suite_abc', status: 'running', total: 2 } : suiteState({ verdict, exitCode, counts }));
    const result = await cli(['suite', '-', '--json'], { readStdin: async () => JSON.stringify(suiteBody) });
    assert.equal(result.code, exitCode, verdict);
    const parsed = validJson(result.stdout);
    assert.deepEqual([parsed.command, parsed.exitCode, parsed.result.verdict], ['suite', exitCode, verdict]);
  }
});

test('suite: --no-wait returns the id at once with exit 0', async () => {
  handler = (_req, respond) => respond(202, { suiteRunId: 'suite_abc', status: 'running', total: 2, variants: [] });
  const result = await cli(['suite', 'f.json', '--no-wait', '--json'], { readFile: async () => JSON.stringify(suiteBody) });
  assert.equal(result.code, 0);
  assert.equal(validJson(result.stdout).result.suiteRunId, 'suite_abc');
  assert.equal(seen.length, 1, 'no polling');
});

test('suite: a rejected definition, an unreadable or invalid file are exit 2', async () => {
  handler = (_req, respond) => respond(404, { error: { type: 'SuiteItemNotFound', message: 'Routine "ghost" does not exist' } });
  const refused = await cli(['suite', 'f.json', '--json'], { readFile: async () => JSON.stringify(suiteBody) });
  assert.equal(refused.code, 2);
  assert.equal(validJson(refused.stdout).error.type, 'SuiteItemNotFound');

  const missing = await cli(['suite', 'nope.json', '--json'], { readFile: async () => { throw new Error('ENOENT'); } });
  assert.equal(validJson(missing.stdout).error.type, 'UsageError');

  const notJson = await cli(['suite', 'f.json', '--json'], { readFile: async () => '{oops' });
  assert.match(validJson(notJson.stdout).error.message, /not valid JSON/);
});

test('suite: --timeout-seconds gives up (exit 2) and says the suite keeps running', async () => {
  handler = async (req, respond) => {
    if (req.method === 'POST') return respond(202, { suiteRunId: 'suite_abc', status: 'running', total: 2 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    respond(200, suiteState({ status: 'running', verdict: undefined, exitCode: undefined }));
  };
  const result = await cli(['suite', 'f.json', '--timeout-seconds', '1', '--json'], { readFile: async () => JSON.stringify(suiteBody) });
  assert.equal(result.code, 2);
  const parsed = validJson(result.stdout);
  assert.equal(parsed.error.type, 'SuiteWaitTimeout');
  assert.match(parsed.error.message, /keeps running/);
});

test('suite: Ctrl-C cancels the suite and exits 2', async () => {
  const controller = new AbortController();
  const cancelled = suiteState({ status: 'cancelled', verdict: 'infra-error', exitCode: 2, verdictReason: 'the suite was cancelled' });
  handler = (req, respond) => {
    if (req.url === '/v1/suites') return respond(202, { suiteRunId: 'suite_abc', status: 'running', total: 2 });
    if (req.url.endsWith('/cancel')) return respond(200, cancelled);
    controller.abort(); // the user hits Ctrl-C during the first poll
    respond(200, suiteState({ status: 'running', verdict: undefined, exitCode: undefined }));
  };

  const result = await cli(['suite', 'f.json', '--json'], { readFile: async () => JSON.stringify(suiteBody), signal: controller.signal });
  assert.equal(result.code, 2);
  assert.equal(validJson(result.stdout).result.status, 'cancelled');
  assert.ok(seen.some((s) => s.url === '/v1/suites/suite_abc/cancel' && s.method === 'POST'));
});

test('routines list, runs show and pin', async () => {
  handler = (_req, respond) => respond(200, { routines: [{ id: 'crud', version: 2, title: 'CRUD', status: 'active', tags: ['smoke'], targetProfile: 'app-dev', sha256: 'a'.repeat(64) }] });
  const list = await cli(['routines', 'list']);
  assert.match(list.stdout, /crud\s+v2\s+active\s+app-dev\s+CRUD\s+\[smoke\]/);
  assert.equal(validJson((await cli(['routines', 'list', '--json'])).stdout).result.routines[0].id, 'crud');

  const summary = {
    jobId: 'job_abc', status: 'passed', startedAt: 'x', finishedAt: 'y', durationMs: 1000, targetUrl: 'https://dev.example.com/', stepCount: 1, passedSteps: 1, failedSteps: 0, skippedSteps: 0,
    screenshotCount: 0, consoleErrorCount: 0, networkFailureCount: 0, unexpectedExternalRequestCount: 0, retention: 'pinned', pinned: true, pinRef: 'npdev:REG-209', artifactRelativeRoot: 'artifacts/job_abc',
  };
  handler = (_req, respond) => respond(200, { summary, evidenceAvailable: true, detail: { big: 'x' } });
  const show = await cli(['runs', 'show', 'job_abc']);
  assert.match(show.stdout, /pinned: npdev:REG-209/);
  const slim = validJson((await cli(['runs', 'show', 'job_abc', '--json'])).stdout);
  assert.equal(slim.result.detail, undefined, 'detail only with --full');
  assert.deepEqual(validJson((await cli(['runs', 'show', 'job_abc', '--json', '--full'])).stdout).result.detail, { big: 'x' });

  handler = (_req, respond) => respond(200, { jobId: 'job_abc', alreadyPinned: false, pinnedAt: 'now', ref: 'npdev:REG-209', files: 3, bytes: 99, traceDiscarded: true, integrityBaseline: 'run', manifestSha256: 'b'.repeat(64) });
  const pin = await cli(['pin', 'job_abc', '--reason', 'proof', '--ref', 'npdev:REG-209', '--keep-trace', '--json']);
  assert.equal(pin.code, 0);
  validJson(pin.stdout);
  assert.deepEqual(seen.at(-1)!.body, { reason: 'proof', ref: 'npdev:REG-209', keepTrace: true });

  handler = (_req, respond) => respond(409, { error: { type: 'PinnedQuotaExceeded', message: 'full' } });
  const full = await cli(['pin', 'job_abc', '--reason', 'proof']);
  assert.equal(full.code, 2);
  assert.match(full.stderr, /PinnedQuotaExceeded/);
});

test('routines lint: errors are exit 1, warnings are 0 (1 with --strict), a file or a stored routine is read, usage errors never reach the API', async () => {
  const finding = { rule: 'GX001', severity: 'error', path: 'steps.3', stepId: 'submit', message: 'no gate', suggestion: 'add one' };
  const warning = { rule: 'WT001', severity: 'warning', path: 'steps.1', message: 'fixed wait' };
  const file = JSON.stringify({ targetProfile: 'gx-app', steps: [{ action: 'reload' }], lintSuppress: [{ rule: 'SEL001', reason: 'a long enough reason' }] });

  handler = (_req, respond) => respond(200, { findings: [finding, warning], suppressed: [{ ...warning, rule: 'SEL001', reason: 'a long enough reason' }] });
  const bad = await cli(['routines', 'lint', 'login.json'], { readFile: async () => file });
  assert.equal(bad.code, 1);
  assert.match(bad.stdout, /ERROR\s+GX001\s+steps\.3 \(submit\): no gate/);
  assert.match(bad.stdout, /warning\s+WT001/);
  assert.match(bad.stdout, /accepted\s+SEL001.*a long enough reason/);
  assert.equal(seen.at(-1)!.url, '/v1/routines/lint');
  assert.deepEqual((seen.at(-1)!.body as { targetProfile: string }).targetProfile, 'gx-app');
  assert.equal(validJson((await cli(['routines', 'lint', 'login.json', '--json'], { readFile: async () => file })).stdout).result.findings.length, 2);

  handler = (_req, respond) => respond(200, { findings: [warning], suppressed: [] });
  assert.equal((await cli(['routines', 'lint', 'login.json'], { readFile: async () => file })).code, 0);
  assert.equal((await cli(['routines', 'lint', 'login.json', '--strict'], { readFile: async () => file })).code, 1);

  // A stored routine: read from the library, then linted as that routine (the server knows if it is the login routine).
  handler = (req, respond) => respond(200, req.url === '/v1/routines/lint' ? { findings: [], suppressed: [] } : { routine: { id: 'gx-login', targetProfile: 'gx-app', steps: [{ action: 'reload' }] }, versions: [] });
  const stored = await cli(['routines', 'lint', 'gx-login']);
  assert.equal(stored.code, 0);
  assert.match(stored.stdout, /No findings/);
  assert.equal((seen.at(-1)!.body as { routineId: string }).routineId, 'gx-login');

  const usage = await cli(['routines', 'lint']);
  assert.equal(usage.code, 2);
  const noProfile = await cli(['routines', 'lint', 'x.json'], { readFile: async () => JSON.stringify({ steps: [{ action: 'reload' }] }) });
  assert.equal(noProfile.code, 2);
  assert.equal(seen.length, 0, 'neither reached the API');
});

test('the published JSON Schema of the CLI output exists and describes every command', () => {
  const schema = buildCliOutputJsonSchema() as { anyOf?: unknown[] };
  assert.ok(Array.isArray(schema.anyOf) && schema.anyOf.length === 59);
  assert.match(JSON.stringify(schema), /"cliSchema"/);
});

const vaultItem = {
  id: 'REG-209', title: 'Total wrong', type: 'BUG', severity: 'P1', status: 'ACTIVE', opened: '2026-11-02', surface: 'cart', tags: [],
  routine: { id: 'reg-209', version: 1 }, ledgerRef: 'npdev:REG-209', provenRed: { jobId: 'job_red', at: 'x', buildId: 'rev1', manifestSha256: 'a'.repeat(64) },
  firstGreen: null,
};

test('vault list / show / export read the API and print one valid object', async () => {
  handler = (req, respond) => respond(200, req.url === '/v1/vault/export' ? { exportedAt: 'now', count: 1, items: [vaultItem] } : req.url.startsWith('/v1/vault/REG-209') ? vaultItem : { items: [vaultItem] });

  const list = await cli(['vault', 'list', '--status', 'ACTIVE', '--tags', 'a,b', '--surface', 'cart']);
  assert.match(list.stdout, /REG-209\s+ACTIVE\s+P1\s+cart\s+RED\/no-green/);
  assert.equal(seen.at(-1)!.url, '/v1/vault?status=ACTIVE&tags=a%2Cb&surface=cart');

  const show = await cli(['vault', 'show', 'REG-209']);
  assert.match(show.stdout, /GREEN: not confirmed yet/);
  assert.match(show.stdout, /RED:\s+job_red \(build rev1\)/);

  const exported = validJson((await cli(['vault', 'export', '--json'])).stdout);
  assert.deepEqual([exported.command, exported.result.count], ['vault export', 1]);
  validJson((await cli(['vault', 'show', 'REG-209', '--json'])).stdout);

  handler = (_req, respond) => respond(404, { error: { type: 'ItemNotFound', message: 'Item REG-1 does not exist' } });
  const missing = await cli(['vault', 'show', 'REG-1', '--json']);
  assert.equal(missing.code, 2);
  assert.equal(validJson(missing.stdout).error.type, 'ItemNotFound');
});

test('vault run <id>: exit 0 passed, 1 failed (HTTP 500 with outcome), 2 refused', async () => {
  const outcome = (status: string) => ({ item: vaultItem, result: { jobId: 'job_r', status, durationMs: 900, ...(status === 'failed' ? { error: { type: 'StepExecutionError', message: 'boom' } } : {}) } });

  handler = (_req, respond) => respond(200, outcome('passed'));
  const green = await cli(['vault', 'run', 'REG-209', '--build-id', 'rev7', '--json']);
  assert.equal(green.code, 0);
  assert.equal(validJson(green.stdout).command, 'vault run');
  assert.deepEqual(seen.at(-1)!.body, { buildId: 'rev7' });

  handler = (_req, respond) => respond(500, outcome('failed'));
  const red = await cli(['vault', 'run', 'REG-209']);
  assert.equal(red.code, 1);
  assert.match(red.stdout, /FAILED\s+REG-209\s+job_r.*StepExecutionError: boom/);

  handler = (_req, respond) => respond(409, { error: { type: 'CredentialInUse', message: 'busy' } });
  assert.equal((await cli(['vault', 'run', 'REG-209', '--json'])).code, 2);
});

test('vault confirm-green: confirmed is 0; still red is 1 and says the item is unchanged', async () => {
  handler = (_req, respond) => respond(200, { confirmed: true, item: { ...vaultItem, firstGreen: { jobId: 'job_g', at: 'x', manifestSha256: 'b'.repeat(64) } }, result: { jobId: 'job_g', status: 'passed', durationMs: 5 } });
  const ok = await cli(['vault', 'confirm-green', 'REG-209', '--build-id', 'rev2']);
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /CONFIRMED\s+REG-209: firstGreen = job_g/);
  assert.equal(seen.at(-1)!.url, '/v1/vault/REG-209/confirm-green');

  handler = (_req, respond) => respond(409, { error: { type: 'StillRed', message: 'x' }, confirmed: false, item: vaultItem, result: { jobId: 'job_s', status: 'failed', durationMs: 5, error: { type: 'StepExecutionError', message: 'still 5' } } });
  const red = await cli(['vault', 'confirm-green', 'REG-209', '--json']);
  assert.equal(red.code, 1);
  assert.deepEqual([validJson(red.stdout).result.confirmed], [false]);
  assert.match((await cli(['vault', 'confirm-green', 'REG-209'])).stdout, /STILL RED.*still 5.*item unchanged/);
});

test('vault run --impact: sends the whole vault as an impact-ordered suite and exits with its verdict', async () => {
  let posted: Record<string, any> | undefined;
  handler = (req, respond) => {
    if (req.method === 'POST') {
      posted = req.body as Record<string, any>;
      return respond(202, { suiteRunId: 'suite_abc', status: 'running', total: 2 });
    }
    respond(200, suiteState({}));
  };

  const result = await cli(['vault', 'run', '--impact', '--changed-files', 'changed.txt', '--surface', 'cart', '--fail-fast', '--build-id', 'rev9', '--json'], {
    readFile: async () => 'src/cart/a.ts\r\n\r\n src/cart/b.ts \n',
  });

  assert.equal(result.code, 1, 'the suite verdict is red');
  assert.equal(validJson(result.stdout).command, 'suite');
  assert.deepEqual(posted, {
    name: 'vault (by impact)', items: [{ vault: {} }], order: 'impact',
    impact: { changedFiles: ['src/cart/a.ts', 'src/cart/b.ts'], surfaces: ['cart'] }, buildId: 'rev9', failFast: true,
  });

  const stdin = await cli(['vault', 'run', '--impact', '--changed-files', '-', '--status', 'ACTIVE,QUARANTINED', '--json'], { readStdin: async () => 'x.ts\n' });
  assert.equal(stdin.code, 1);
  assert.deepEqual(posted!.items, [{ vault: { status: ['ACTIVE', 'QUARANTINED'] } }]);
});

test('vault usage errors are exit 2 and never reach the API', async () => {
  seen = [];
  for (const args of [['vault'], ['vault', 'show'], ['vault', 'run'], ['vault', 'run', 'A-1', 'B-2'], ['vault', 'export', 'x'], ['vault', 'run', '--impact', 'A-1'], ['vault', 'run', 'A-1', '--build-id', 'bad id!'], ['vault', 'frobnicate']]) {
    assert.equal((await cli(args)).code, 2, args.join(' '));
  }
  assert.equal(seen.length, 0);
});

const matrixState = (verdict: 'green' | 'red' | 'infra-error', status = 'completed') => ({
  runId: 'perm_abc', matrixId: 'roles', matrixSha256: 'f'.repeat(64),
  matrix: {
    targetProfile: 'app', loginRoutine: 'login', roles: ['seller'], deniedWhen: [{ status: 403 }],
    probes: [{ kind: 'url', id: 'settings', url: '/settings' }], settleMs: 0, controlWaitMs: 0, isolation: 'perRole',
  },
  targetProfile: 'app', buildId: 'b2', status, createdAt: 'x', sessions: 1,
  cells: [{ role: 'seller', probeId: 'settings', kind: 'url', outcome: 'allowed', jobId: 'job_1' }],
  changes: verdict === 'red' ? [{ role: 'seller', probeId: 'settings', from: 'denied', to: 'allowed', change: 'gainedAccess', alert: true }] : [],
  counts: { pending: 0, allowed: 1, denied: 0, error: 0, mismatches: 0, alerts: verdict === 'red' ? 1 : 0 },
  ...(status === 'running' ? {} : { verdict, verdictReason: 'r', exitCode: verdict === 'green' ? 0 : verdict === 'red' ? 1 : 2 }),
});

test('permissions run: waits and exits with the matrix verdict (an unexpected gain of access is 1)', async () => {
  let polls = 0;
  handler = (req, respond) => {
    if (req.method === 'POST') return respond(202, { runId: 'perm_abc', matrixId: 'roles', status: 'running', cells: 1, sessions: 1 });
    polls += 1;
    respond(200, polls < 2 ? matrixState('red', 'running') : matrixState('red'));
  };
  const text = await cli(['permissions', 'run', 'roles', '--build-id', 'b2']);
  assert.equal(text.code, 1);
  assert.deepEqual(seen[0], { method: 'POST', url: '/v1/permissions/roles/run', auth: `Bearer ${KEY}`, body: { buildId: 'b2' } });
  assert.match(text.stdout, /ALERT\s+seller \/ settings: denied -> allowed/);
  assert.match(text.stdout, /Verdict: RED \(exit 1\)/);

  polls = 5;
  const json = await cli(['permissions', 'run', 'roles', '--json']);
  assert.equal(json.code, 1);
  assert.equal(validJson(json.stdout).command, 'permissions run');

  const started = await cli(['permissions', 'run', 'roles', '--no-wait', '--json']);
  assert.equal(started.code, 0);
  assert.equal(validJson(started.stdout).result.runId, 'perm_abc');
});

test('permissions show: green is 0, a run still going is 2; usage errors never reach the API', async () => {
  handler = (_req, respond) => respond(200, matrixState('green'));
  const green = await cli(['permissions', 'show', 'perm_abc', '--json']);
  assert.equal(green.code, 0);
  assert.equal(validJson(green.stdout).command, 'permissions show');

  handler = (_req, respond) => respond(200, matrixState('green', 'running'));
  assert.equal((await cli(['permissions', 'show', 'perm_abc'])).code, 2);

  handler = (_req, respond) => respond(404, { error: { type: 'PermissionMatrixNotFound', message: 'nope' } });
  const missing = await cli(['permissions', 'run', 'ghost']);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /PermissionMatrixNotFound/);

  for (const args of [['permissions', 'run'], ['permissions', 'show'], ['permissions', 'run', 'a', 'b'], ['permissions', 'run', 'a', '--retention', 'forever']]) {
    assert.equal((await cli(args)).code, 2, args.join(' '));
  }
  assert.equal(seen.length, 0);
});

// T4.4: `scrapforai evolution snapshot|list`

const snapshotState = (status: string, exitCode: 0 | 2, extra: Record<string, unknown> = {}) => ({
  snapshotId: 'evo_abc',
  targetProfile: 'app',
  buildId: 'rev-1',
  buildIdSource: 'probe',
  status,
  createdAt: '2026-11-03T10:00:00.000Z',
  sessions: 1,
  screens: [{ screenId: 'home', name: 'Home', status: 'captured', jobId: 'job_1', counts: { fields: 2, actions: 1, grids: 0, unkeyed: 0 } }],
  warnings: [],
  exitCode,
  ...extra,
});

test('evolution snapshot: sends the options, waits, exit 0 when complete and 2 when not; --json matches the contract', async () => {
  handler = (req, respond) =>
    req.method === 'POST'
      ? respond(202, { snapshotId: 'evo_abc', targetProfile: 'app', status: 'running', screens: 1, sessions: 1 })
      : respond(200, snapshotState('completed', 0, { folder: 'app/2026-11-03_rev-1', git: { repository: true, committed: true, commit: 'abc1234' } }));
  const ok = await cli(['evolution', 'snapshot', 'app', '--build-id', 'rev-1', '--screens', 'home, orders', '--no-screenshots', '--force', '--allow-partial', '--settle-ms', '250', '--json']);
  assert.equal(ok.code, 0);
  assert.deepEqual(seen[0]!.body, { targetProfile: 'app', buildId: 'rev-1', screens: ['home', 'orders'], screenshots: false, force: true, allowPartial: true, settleMs: 250 });
  assert.equal(seen[0]!.auth, `Bearer ${KEY}`);
  assert.equal(validJson(ok.stdout).command, 'evolution snapshot');

  const text = await cli(['evolution', 'snapshot', 'app']);
  assert.match(text.stdout, /OK\s+home\s+2 field\(s\), 1 action\(s\), 0 grid\(s\)/);
  assert.match(text.stdout, /written to app\/2026-11-03_rev-1/);
  assert.match(text.stdout, /committed abc1234/);
  assert.deepEqual(seen[0]!.body, { targetProfile: 'app' }, 'no option, no field: the server defaults apply');

  handler = (req, respond) =>
    req.method === 'POST'
      ? respond(202, { snapshotId: 'evo_abc', targetProfile: 'app', status: 'running', screens: 1, sessions: 1 })
      : respond(200, snapshotState('failed', 2, { reason: '1 of 1 screen(s) could not be captured; nothing was written' }));
  const failed = await cli(['evolution', 'snapshot', 'app', '--json']);
  assert.equal(failed.code, 2);
  assert.equal(validJson(failed.stdout).result.status, 'failed');

  const started = await cli(['evolution', 'snapshot', 'app', '--no-wait', '--json']);
  assert.equal(started.code, 0);
  assert.equal(validJson(started.stdout).result.snapshotId, 'evo_abc');
});

test('evolution snapshot: an API refusal is exit 2 with its type; bad usage never reaches the API', async () => {
  handler = (_req, respond) => respond(409, { error: { type: 'SnapshotExists', message: 'already has a snapshot' } });
  const refused = await cli(['evolution', 'snapshot', 'app', '--build-id', 'rev-1']);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /SnapshotExists/);

  for (const args of [
    ['evolution', 'snapshot'],
    ['evolution', 'snapshot', 'a', 'b'],
    ['evolution', 'snapshot', 'a', '--settle-ms', 'abc'],
    ['evolution', 'snapshot', 'a', '--timeout-seconds', '0'],
    ['evolution', 'snapshot', 'a', '--screens', ' , '],
    ['evolution', 'list'],
    ['evolution'],
  ]) {
    assert.equal((await cli(args)).code, 2, args.join(' '));
  }
  assert.equal(seen.length, 0);
});

test('evolution list: oldest first, partial snapshots flagged, empty is said', async () => {
  const listing = {
    targetProfile: 'app',
    snapshots: [
      { folder: 'app/2026-11-02_rev1', name: '2026-11-02_rev1', buildId: 'rev1', createdAt: '2026-11-02T08:00:00.000Z', complete: true, screens: 3, notCaptured: 0 },
      { folder: 'app/2026-11-03_rev2', name: '2026-11-03_rev2', buildId: 'rev2', createdAt: '2026-11-03T08:00:00.000Z', complete: false, screens: 2, notCaptured: 1 },
    ],
  };
  handler = (_req, respond) => respond(200, listing);
  const text = await cli(['evolution', 'list', 'app']);
  assert.equal(text.code, 0);
  assert.match(text.stdout, /2026-11-02_rev1\s+build rev1\s+3 screen\(s\)\n/);
  assert.match(text.stdout, /PARTIAL \(1 not captured\)/);
  assert.equal(seen[0]!.url, '/v1/evolution/app');
  assert.equal(validJson((await cli(['evolution', 'list', 'app', '--json'])).stdout).result.snapshots.length, 2);

  handler = (_req, respond) => respond(200, { targetProfile: 'app', snapshots: [] });
  assert.match((await cli(['evolution', 'list', 'app'])).stdout, /No snapshots for "app"/);
});

// T4.5 / T4.6 / T4.7: `scrapforai evolution diff|timeline|expected`

const evoDiff = (classified: boolean, unexpected: number) => ({
  targetProfile: 'app',
  from: { buildId: 'rev1', createdAt: '2026-11-01T08:00:00.000Z', complete: true },
  to: { buildId: 'rev2', createdAt: '2026-11-02T08:00:00.000Z', complete: true },
  screens: [{ id: 'customers', name: 'Customers', status: 'changed', changes: [], truncated: false }],
  counts: { screensChanged: 1, screensAdded: 0, screensRemoved: 0, screensUnknown: 0, changes: 2, expected: 2 - unexpected, unexpected },
  classified,
  markdown: '# Changes in app: rev1 -> rev2\n\n## Screen Customers\n- + field Phone (phone) (text, optional)\n',
});

test('evolution diff: prints the deterministic text; exit 1 only when a DECLARED build changed something else', async () => {
  handler = (_req, respond) => respond(200, evoDiff(false, 2));
  const unclassified = await cli(['evolution', 'diff', 'app', '--from', 'rev1', '--to', 'rev2']);
  assert.equal(unclassified.code, 0, 'nothing declared: not an alert');
  assert.match(unclassified.stdout, /^# Changes in app: rev1 -> rev2/);
  assert.equal(seen[0]!.url, '/v1/evolution/app/diff?from=rev1&to=rev2');

  handler = (_req, respond) => respond(200, evoDiff(true, 0));
  assert.equal((await cli(['evolution', 'diff', 'app'])).code, 0);
  assert.equal(seen[0]!.url, '/v1/evolution/app/diff');

  handler = (_req, respond) => respond(200, evoDiff(true, 1));
  const red = await cli(['evolution', 'diff', 'app', '--json']);
  assert.equal(red.code, 1);
  assert.equal(validJson(red.stdout).command, 'evolution diff');

  handler = (_req, respond) => respond(409, { error: { type: 'NoPreviousSnapshot', message: 'first build' } });
  const refused = await cli(['evolution', 'diff', 'app']);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /NoPreviousSnapshot/);
});

test('evolution diff --write / --narrative-file: reads the diff, then asks the server to write CHANGES.md with the agent text', async () => {
  handler = (req, respond) =>
    req.method === 'GET'
      ? respond(200, evoDiff(false, 0))
      : respond(200, { targetProfile: 'app', file: 'app/2026-11-02_rev2/CHANGES.md', git: { repository: true, committed: true, commit: 'abc1234' }, counts: {}, classified: false });
  const written = await cli(['evolution', 'diff', 'app', '--to', 'rev2', '--narrative-file', 'n.txt'], { readFile: async () => 'Customers gained a phone field.' });
  assert.equal(written.code, 0);
  assert.match(written.stdout, /Written to app\/2026-11-02_rev2\/CHANGES\.md \(committed abc1234\)/);
  assert.deepEqual(seen.map((s) => s.method), ['GET', 'POST']);
  assert.equal(seen[1]!.url, '/v1/evolution/app/changes');
  assert.deepEqual(seen[1]!.body, { to: 'rev2', narrative: 'Customers gained a phone field.' });

  const plain = await cli(['evolution', 'diff', 'app', '--write']);
  assert.deepEqual(seen[1]!.body, {}, 'no narrative unless an agent gave one');
  assert.equal(plain.code, 0);

  const unreadable = await cli(['evolution', 'diff', 'app', '--narrative-file', 'missing.txt'], { readFile: async () => { throw new Error('ENOENT'); } });
  assert.equal(unreadable.code, 2);
  assert.equal(seen.length, 0, 'an unreadable narrative never reaches the API');
});

test('evolution timeline: one line per event, and the answer about a control; empty is said', async () => {
  handler = (_req, respond) =>
    respond(200, {
      targetProfile: 'app', snapshots: 3, builds: [], truncated: false,
      events: [{ buildId: 'rev2', createdAt: '2026-11-02T08:00:00.000Z', screen: 'customers', screenName: 'Customers', kind: 'added', path: 'fields[key=phone]', text: '+ field Phone (phone) (text, optional)' }],
      control: { key: 'phone', screen: 'customers', presentInLatest: true, firstSeenIn: { buildId: 'rev2', createdAt: '2026-11-02T08:00:00.000Z', isFirstSnapshot: false } },
    });
  const text = await cli(['evolution', 'timeline', 'app', '--key', 'phone', '--screen', 'customers', '--since', '2026-11-01', '--limit', '10']);
  assert.equal(text.code, 0);
  assert.equal(seen[0]!.url, '/v1/evolution/app/timeline?screen=customers&key=phone&since=2026-11-01&limit=10');
  assert.match(text.stdout, /2026-11-02\s+rev2\s+\[customers\]\s+\+ field Phone/);
  assert.match(text.stdout, /"phone": first seen in rev2 \(2026-11-02\); present now on customers/);
  assert.equal(validJson((await cli(['evolution', 'timeline', 'app', '--json'])).stdout).command, 'evolution timeline');

  handler = (_req, respond) => respond(200, { targetProfile: 'app', snapshots: 2, builds: [], events: [], truncated: false });
  assert.match((await cli(['evolution', 'timeline', 'app'])).stdout, /No changes recorded across 2 snapshot\(s\)\./);
});

test('evolution expected: show, or declare from a file; usage errors never reach the API', async () => {
  const declared = { buildId: 'rev2', expected: [{ screen: 'customers', kind: 'added', path: 'fields[key=phone]', ref: 'REG-301' }] };
  handler = (_req, respond) => respond(200, declared);
  const shown = await cli(['evolution', 'expected', 'app', 'rev2']);
  assert.equal(shown.code, 0);
  assert.equal(seen[0]!.method, 'GET');
  assert.equal(seen[0]!.url, '/v1/evolution/app/expected/rev2');
  assert.match(shown.stdout, /Build rev2 declares 1 expected change\(s\)/);
  assert.match(shown.stdout, /customers\s+added\s+fields\[key=phone\]\s+\(REG-301\)/);

  const put = await cli(['evolution', 'expected', 'app', 'rev2', '--file', 'e.json', '--json'], { readFile: async () => JSON.stringify(declared) });
  assert.equal(put.code, 0);
  assert.equal(seen[0]!.method, 'PUT');
  assert.deepEqual(seen[0]!.body, declared);
  assert.equal(validJson(put.stdout).command, 'evolution expected');

  for (const args of [['evolution', 'expected', 'app'], ['evolution', 'expected', 'app', 'rev2', 'extra'], ['evolution', 'diff'], ['evolution', 'timeline']]) {
    assert.equal((await cli(args)).code, 2, args.join(' '));
  }
  assert.equal((await cli(['evolution', 'expected', 'app', 'rev2', '--file', 'bad.json'], { readFile: async () => '{not json' })).code, 2);
  assert.equal(seen.length, 0);
});

// T5.2: `scrapforai run --profile`

test('run --profile: sent to the API as is; anything but full/functional is a usage error that never reaches it', async () => {
  handler = (_req, respond) => respond(200, { jobId: 'job_1', status: 'passed', durationMs: 1, steps: [], evidence: { screenshots: [], consoleErrors: [], networkFailures: [] } });
  await cli(['run', 'login-flow', '--profile', 'functional', '--json']);
  assert.deepEqual(seen[0]!.body, { profile: 'functional' });
  await cli(['run', 'login-flow', '--json']);
  assert.deepEqual(seen[0]!.body, {}, 'no flag, no field: the routine decides');

  assert.equal((await cli(['run', 'login-flow', '--profile', 'turbo'])).code, 2);
  assert.equal(seen.length, 0);
});

// T5.3: `scrapforai run --seed --sample`

test('run --seed/--sample: sent to the API as they are; a bad sample or an empty seed is a usage error that never reaches it', async () => {
  handler = (_req, respond) => respond(200, { jobId: 'job_1', status: 'passed', durationMs: 1, steps: [], evidence: { screenshots: [], consoleErrors: [], networkFailures: [] } });
  await cli(['run', 'form-flow', '--seed', 'abc', '--sample', '3', '--json']);
  assert.deepEqual(seen[0]!.body, { seed: 'abc', sample: 3 });
  await cli(['run', 'form-flow', '--sample', '0', '--json']);
  assert.deepEqual(seen[0]!.body, { sample: 0 }, 'sample 0 is a real value, not "absent"');

  for (const args of [['run', 'a', '--sample', '-1'], ['run', 'a', '--sample', 'x'], ['run', 'a', '--sample', '1.5'], ['run', 'a', '--seed', '']]) {
    assert.equal((await cli(args)).code, 2, args.join(' '));
  }
  assert.equal(seen.length, 0);
});

// T5.6: `scrapforai shrink`

const shrinkState = (outcome: string, extra: Record<string, unknown> = {}) => ({
  shrinkId: 'shrink_abc',
  status: 'completed',
  createdAt: '2026-11-03T10:00:00.000Z',
  request: { fromJobId: 'job_1', maxShrinkRuns: 30, maxShrinkSeconds: 600 },
  routine: { id: 'shop-total', version: 2 },
  runs: 14,
  outcome,
  summary: 'fails with qty="1000", passes with qty=999 - 14 run(s)',
  currentValues: { qty: '1000' },
  result: {
    status: outcome, failing: { qty: '5000' }, minimal: { qty: '1000' }, minimalJobId: 'job_min', essential: ['qty'],
    boundaries: [{ parameter: 'qty', fails: '1000', passes: '999', precision: 'adjacent' }], runs: 14, trail: [{ run: 1, what: 'confirm the failing values', failed: true, jobId: 'job_a' }],
  },
  replay: { routineId: 'shop-total', version: 2, parameterValues: { qty: '1000' } },
  ...extra,
});

test('shrink: sends the budget and the source, waits, prints the limit; exit 0 for a minimal answer and 2 otherwise; --json matches the contract', async () => {
  handler = (req, respond) => (req.method === 'POST' ? respond(202, { shrinkId: 'shrink_abc', status: 'running' }) : respond(200, shrinkState('minimal')));
  const ok = await cli(['shrink', '--from-job', 'job_1', '--max-runs', '40', '--max-seconds', '120', '--profile', 'functional', '--credential', 'admin', '--var', 'a=b', '--json']);
  assert.equal(ok.code, 0);
  assert.deepEqual(seen[0]!.body, { fromJobId: 'job_1', credentialSet: 'admin', variables: { a: 'b' }, profile: 'functional', maxShrinkRuns: 40, maxShrinkSeconds: 120 });
  assert.equal(validJson(ok.stdout).command, 'shrink');

  const text = await cli(['shrink', 'shop-total', '--seed', 'S', '--sample', '2']);
  assert.deepEqual(seen[0]!.body, { routineId: 'shop-total', seed: 'S', sample: 2 });
  assert.match(text.stdout, /fails with qty="1000", passes with qty=999/);
  assert.match(text.stdout, /proof: job_min/);

  handler = (req, respond) => (req.method === 'POST' ? respond(202, { shrinkId: 'shrink_abc', status: 'running' }) : respond(200, shrinkState('budget')));
  assert.equal((await cli(['shrink', '--from-job', 'job_1'])).code, 2, 'stopped early is not a finished answer');

  const started = await cli(['shrink', '--from-job', 'job_1', '--no-wait', '--json']);
  assert.equal(started.code, 0);
  assert.equal(validJson(started.stdout).result.shrinkId, 'shrink_abc');
});

test('shrink: an API refusal is exit 2 with its type; bad usage never reaches the API', async () => {
  handler = (_req, respond) => respond(409, { error: { type: 'JobDidNotFail', message: 'did not fail' } });
  const refused = await cli(['shrink', '--from-job', 'job_1']);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /JobDidNotFail/);

  for (const args of [['shrink'], ['shrink', 'a', '--from-job', 'job_1'], ['shrink', 'a', 'b'], ['shrink', '--from-job', 'j', '--max-runs', '0'], ['shrink', '--from-job', 'j', '--profile', 'x'], ['shrink', '--from-job', 'j', '--var', 'novalue']]) {
    seen.length = 0;
    const result = await cli(args);
    assert.equal(result.code, 2, args.join(' '));
    assert.equal(seen.length, 0, `${args.join(' ')} must not reach the API`);
  }
});

// T3.2: `scrapforai schedules list|show|run-now`

const scheduleView = (extra: Record<string, unknown> = {}) => ({
  schedule: { id: 'nightly', cron: '30 2 * * *', timezone: 'America/Montevideo', target: { kind: 'routine', routineId: 'crud' }, enabled: true, overlap: 'skip', jitterSeconds: 0, notify: [] },
  createdAt: '2026-11-03T10:00:00.000Z',
  updatedAt: '2026-11-03T10:00:00.000Z',
  next: ['2026-11-04T05:30:00.000Z'],
  counts: { passed: 2, missed: 3 },
  lastRun: { at: '2026-11-03T05:30:00.000Z', outcome: 'passed' },
  ...extra,
});

test('schedules list/show: print the next occurrence and the history; --json matches the contract', async () => {
  handler = (_req, respond) => respond(200, { schedulerRunning: false, schedules: [scheduleView()] });
  const list = await cli(['schedules', 'list']);
  assert.equal(list.code, 0);
  assert.match(list.stdout, /NOT running in this server/);
  assert.match(list.stdout, /on\s+nightly\s+30 2 \* \* \* \(America\/Montevideo\)\s+routine\s+next 2026-11-04T05:30:00.000Z\s+last passed/);
  assert.equal(validJson((await cli(['schedules', 'list', '--json'])).stdout).command, 'schedules list');

  handler = (_req, respond) =>
    respond(200, {
      schedulerRunning: true,
      ...scheduleView({ history: [{ at: '2026-11-03T05:30:00.000Z', outcome: 'started', recovered: true, run: { kind: 'run', id: 'job_1' } }, { at: '2026-11-02T05:30:00.000Z', outcome: 'missed', count: 3, message: 'down' }] }),
    });
  const show = await cli(['schedules', 'show', 'nightly']);
  assert.match(show.stdout, /2026-11-03T05:30:00.000Z\s+started \(recovery\)\s+job_1/);
  assert.match(show.stdout, /missed x3/);
  assert.equal(validJson((await cli(['schedules', 'show', 'nightly', '--json'])).stdout).command, 'schedules show');
  assert.equal(seen.at(-1)!.url, '/v1/schedules/nightly');
});

test('schedules run-now: POSTs with the bearer; a refusal is exit 2 with its type; bad usage never reaches the API', async () => {
  handler = (_req, respond) => respond(202, { at: '2026-11-03T12:00:00.000Z', outcome: 'started', manual: true, run: { kind: 'suite', id: 'suite_1' } });
  const ok = await cli(['schedules', 'run-now', 'nightly', '--json']);
  assert.equal(ok.code, 0);
  assert.equal(validJson(ok.stdout).command, 'schedules run-now');
  assert.equal(seen.at(-1)!.method, 'POST');
  assert.equal(seen.at(-1)!.auth, `Bearer ${KEY}`);

  handler = (_req, respond) => respond(409, { error: { type: 'SchedulerDisabled', message: 'not running' } });
  const refused = await cli(['schedules', 'run-now', 'nightly']);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /SchedulerDisabled/);

  for (const args of [['schedules'], ['schedules', 'show'], ['schedules', 'run-now'], ['schedules', 'list', 'x'], ['schedules', 'show', 'a', 'b']]) {
    seen.length = 0;
    assert.equal((await cli(args)).code, 2, args.join(' '));
    assert.equal(seen.length, 0, `${args.join(' ')} must not reach the API`);
  }
});

// T3.3: `scrapforai webhooks list|show|test`

const webhookView = (extra: Record<string, unknown> = {}) => ({
  webhook: { id: 'team-chat', preset: 'slack', lang: 'pt', enabled: true, events: ['broken', 'recovered'], dailySummary: { at: '08:00', timezone: 'America/Montevideo' } },
  createdAt: '2026-11-03T10:00:00.000Z',
  updatedAt: '2026-11-03T10:00:00.000Z',
  hasUrl: true,
  urlOrigin: 'https://hooks.slack.com',
  originAllowed: true,
  schedules: ['nightly'],
  lastDelivery: { at: '2026-11-03T12:00:00.000Z', kind: 'broken', status: 'sent', httpStatus: 200, attempts: 1 },
  ...extra,
});

test('webhooks list/show: print the destination origin (never a URL), what the channel knows and the deliveries; --json matches the contract', async () => {
  handler = (_req, respond) => respond(200, { webhooks: [webhookView(), webhookView({ originAllowed: false, webhook: { ...webhookView().webhook, id: 'blocked' } })] });
  const list = await cli(['webhooks', 'list']);
  assert.equal(list.code, 0);
  assert.match(list.stdout, /on\s+team-chat\s+slack\/pt\s+https:\/\/hooks\.slack\.com\s+schedules: nightly\s+last broken sent/);
  assert.match(list.stdout, /blocked.*ORIGIN NOT ALLOWED/);
  assert.equal(validJson((await cli(['webhooks', 'list', '--json'])).stdout).command, 'webhooks list');

  handler = (_req, respond) =>
    respond(200, {
      ...webhookView(),
      known: { 'schedule:nightly': { verdict: 'bad', since: '2026-11-03T12:00:00.000Z' } },
      deliveries: [{ at: '2026-11-03T12:00:00.000Z', kind: 'broken', status: 'failed', httpStatus: 500, attempts: 2, reason: 'HTTP 500' }],
    });
  const show = await cli(['webhooks', 'show', 'team-chat']);
  assert.match(show.stdout, /knows: schedule:nightly is bad since 2026-11-03T12:00:00.000Z/);
  assert.match(show.stdout, /broken\s+failed HTTP 500\s+HTTP 500/);
  assert.match(show.stdout, /daily summary 08:00/);
  assert.equal(validJson((await cli(['webhooks', 'show', 'team-chat', '--json'])).stdout).command, 'webhooks show');
  assert.equal(seen.at(-1)!.url, '/v1/webhooks/team-chat');
});

test('webhooks test: POSTs with the bearer; exit 0 if it arrived, 2 if not (the delivery is still printed); bad usage never reaches the API', async () => {
  handler = (_req, respond) => respond(200, { at: '2026-11-03T12:00:00.000Z', kind: 'test', status: 'sent', httpStatus: 200, attempts: 1 });
  const ok = await cli(['webhooks', 'test', 'team-chat', '--json']);
  assert.equal(ok.code, 0);
  assert.equal(validJson(ok.stdout).command, 'webhooks test');
  assert.equal(seen.at(-1)!.method, 'POST');
  assert.equal(seen.at(-1)!.url, '/v1/webhooks/team-chat/test');
  assert.equal(seen.at(-1)!.auth, `Bearer ${KEY}`);

  handler = (_req, respond) => respond(502, { at: '2026-11-03T12:00:00.000Z', kind: 'test', status: 'failed', attempts: 0, reason: 'Origin https://x.example.com is not in ALLOWED_NOTIFY_ORIGINS' });
  const failed = await cli(['webhooks', 'test', 'team-chat']);
  assert.equal(failed.code, 2);
  assert.match(failed.stdout, /failed: Origin .* ALLOWED_NOTIFY_ORIGINS/);
  assert.equal(validJson((await cli(['webhooks', 'test', 'team-chat', '--json'])).stdout).exitCode, 2);

  handler = (_req, respond) => respond(404, { error: { type: 'WebhookNotFound', message: 'Webhook not found' } });
  const missing = await cli(['webhooks', 'test', 'nope']);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /WebhookNotFound/);

  for (const args of [['webhooks'], ['webhooks', 'show'], ['webhooks', 'test'], ['webhooks', 'list', 'x'], ['webhooks', 'show', 'a', 'b']]) {
    seen.length = 0;
    assert.equal((await cli(args)).code, 2, args.join(' '));
    assert.equal(seen.length, 0, `${args.join(' ')} must not reach the API`);
  }
});

// T3.4: `scrapforai perf list|alerts|show`

const perfSeries = (extra: Record<string, unknown> = {}) => ({ id: 'save', points: [], samples: 14, baselineMs: 800, recentMs: 1500, ratio: 1.88, alert: true, buildChanges: [11], suspectBuild: 'r101', ...extra });
const perfDetail = (extra: Record<string, unknown> = {}) => ({
  routineId: 'crud',
  thresholds: { baselineRuns: 20, recentRuns: 3, minBaselineRuns: 5, alertRatio: 1.3, minDeltaMs: 100 },
  population: { version: 2, profile: 'full', env: 'https://dev.example.com', runs: 15, lastAt: '2026-11-03T12:00:00.000Z' },
  populations: [],
  runs: 16,
  greenRuns: 15,
  run: perfSeries({ id: '(run)', baselineMs: 1000, recentMs: 1700, ratio: 1.7 }),
  steps: [perfSeries({ id: 'open', alert: false, baselineMs: 200, recentMs: 205, ratio: 1.03, suspectBuild: undefined }), perfSeries()],
  alerts: ['(run)', 'save'],
  ...extra,
});

test('perf show/list/alerts: print baseline -> recent and the suspect build; --json matches the contract; exit 0 unless --fail-on-alert', async () => {
  handler = (_req, respond) => respond(200, perfDetail());
  const show = await cli(['perf', 'show', 'crud', '--version', '2', '--profile', 'full']);
  assert.equal(show.code, 0);
  assert.match(show.stdout, /crud: version 2, full, https:\/\/dev.example.com {2}\(15\/16 green runs\)/);
  assert.match(show.stdout, /ALERT {2}save\s+14 runs\s+800 ms ->\s+1500 ms {2}x1.88 {2}build r101/);
  assert.match(show.stdout, /open\s+14 runs\s+200 ms ->\s+205 ms/);
  assert.equal(seen.at(-1)!.url, '/v1/metrics/routines/crud?limit=1&version=2&profile=full');
  assert.equal(validJson((await cli(['perf', 'show', 'crud', '--json'])).stdout).command, 'perf show');
  assert.equal((await cli(['perf', 'show', 'crud', '--fail-on-alert'])).code, 1, 'a CI guard asked to fail on an alert');
  handler = (_req, respond) => respond(200, perfDetail({ alerts: [] }));
  assert.equal((await cli(['perf', 'show', 'crud', '--fail-on-alert'])).code, 0);

  handler = (_req, respond) => respond(200, { routines: [{ routineId: 'crud', runs: 16, greenRuns: 15, run: { samples: 15, baselineMs: 1000, recentMs: 1700, alert: true }, alerts: [{ routineId: 'crud', series: 'save' }] }, { routineId: 'new', runs: 2, greenRuns: 2, run: { samples: 2, note: 'needs 8 green runs for a baseline (has 2)', alert: false }, alerts: [] }] });
  const list = await cli(['perf', 'list']);
  assert.match(list.stdout, /ALERT {2}crud {2}15\/16 green {2}run 1000 ms -> 1700 ms/);
  assert.match(list.stdout, /new {2}2\/2 green.*needs 8 green runs/);
  assert.equal(validJson((await cli(['perf', 'list', '--json'])).stdout).command, 'perf list');
  assert.equal((await cli(['perf', 'list', '--fail-on-alert'])).code, 1);

  handler = (_req, respond) => respond(200, { count: 1, alerts: [{ routineId: 'crud', series: 'save', baselineMs: 800, recentMs: 1500, ratio: 1.88, suspectBuild: 'r101' }] });
  const alerts = await cli(['perf', 'alerts']);
  assert.equal(alerts.code, 0);
  assert.match(alerts.stdout, /ALERT crud save: 800 ms -> 1500 ms \(x1.88\) {2}new build in the slow runs: r101/);
  assert.equal(validJson((await cli(['perf', 'alerts', '--json'])).stdout).command, 'perf alerts');
  assert.equal((await cli(['perf', 'alerts', '--fail-on-alert'])).code, 1);
  handler = (_req, respond) => respond(200, { count: 0, alerts: [] });
  assert.match((await cli(['perf', 'alerts', '--fail-on-alert'])).stdout, /No performance alerts/);
});

test('perf show: an unknown routine is exit 2 with its type; bad usage never reaches the API', async () => {
  handler = (_req, respond) => respond(404, { error: { type: 'NoPerformanceData', message: 'no runs yet' } });
  const missing = await cli(['perf', 'show', 'ghost']);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /NoPerformanceData/);

  for (const args of [['perf'], ['perf', 'show'], ['perf', 'list', 'x'], ['perf', 'alerts', 'x'], ['perf', 'show', 'a', 'b'], ['perf', 'show', 'a', '--profile', 'x'], ['perf', 'show', 'a', '--version', '0']]) {
    seen.length = 0;
    assert.equal((await cli(args)).code, 2, args.join(' '));
    assert.equal(seen.length, 0, `${args.join(' ')} must not reach the API`);
  }
});

// T3.5: `scrapforai flaky list|show`

const flakyDetail = (extra: Record<string, unknown> = {}) => ({
  routineId: 'crud',
  status: 'active',
  thresholds: { window: 20, minRuns: 10, threshold: 0.2 },
  population: { version: 2, profile: 'full', env: 'https://dev.example.com', runs: 20, lastAt: '2026-11-03T12:00:00.000Z' },
  populations: [],
  runs: 20,
  passed: 17,
  failed: 3,
  transitions: 6,
  comparablePairs: 19,
  skippedAtBuildChange: 0,
  score: 0.316,
  recoveredOnRetry: 2,
  flaky: true,
  results: [...'PPFPPPPFPPPPPFPPPPPP'].map((letter, index) => ({ jobId: `job_${index}`, at: '2026-11-03T12:00:00.000Z', status: letter === 'P' ? 'passed' : 'failed' })),
  suggestion: { action: 'quarantine', reason: '6 state change(s) in 19 comparable pair(s) over the last 20 run(s) (score 0.316, threshold 0.2)' },
  ...extra,
});

test('flaky show/list: score, the pass/fail strip and the suggestion; --json matches the contract; exit 0 unless --fail-on-suggestion', async () => {
  handler = (_req, respond) => respond(200, flakyDetail());
  const show = await cli(['flaky', 'show', 'crud', '--version', '2']);
  assert.equal(show.code, 0, 'a suggestion is information, not a failed test');
  assert.match(show.stdout, /crud \(active\): version 2, full, https:\/\/dev.example.com/);
  assert.match(show.stdout, /score 0.32 {2}\(6 change\(s\) in 19 comparable pair\(s\), 20 run\(s\), 3 failed; threshold 0.2\)/);
  assert.match(show.stdout, /runs \(oldest first\): \.\.X\.{5}X\.{5}X\.{6} /.test(show.stdout) ? /./ : /runs \(oldest first\): [.X]{20}/);
  assert.match(show.stdout, /2 time\(s\) failed and then passed on the automatic new attempt/);
  assert.match(show.stdout, /QUARANTINE: 6 state change/);
  assert.equal(seen.at(-1)!.url, '/v1/metrics/flaky/crud?version=2');
  assert.equal(validJson((await cli(['flaky', 'show', 'crud', '--json'])).stdout).command, 'flaky show');
  assert.equal((await cli(['flaky', 'show', 'crud', '--fail-on-suggestion'])).code, 1, 'a guard that opted in');
  handler = (_req, respond) => respond(200, flakyDetail({ suggestion: undefined, flaky: false }));
  assert.equal((await cli(['flaky', 'show', 'crud', '--fail-on-suggestion'])).code, 0);

  handler = (_req, respond) =>
    respond(200, {
      count: 2,
      suggestions: 1,
      thresholds: { window: 20, minRuns: 10, threshold: 0.2 },
      routines: [
        { routineId: 'crud', status: 'active', runs: 20, transitions: 6, flaky: true, score: 0.316, suggestion: { action: 'quarantine', reason: 'unstable' } },
        { routineId: 'new', status: 'active', runs: 3, transitions: 1, flaky: false, score: 0.5, note: '3 of the 10 runs needed before anything is suggested' },
      ],
    });
  const list = await cli(['flaky', 'list']);
  assert.match(list.stdout, /SUGGEST {2}0.32 {2}active {6}crud {2}6 change\(s\) in 20 run\(s\) {2}-> QUARANTINE: unstable/);
  assert.match(list.stdout, /new {2}1 change\(s\) in 3 run\(s\) {2}\(3 of the 10 runs needed/);
  assert.equal(validJson((await cli(['flaky', 'list', '--json'])).stdout).command, 'flaky list');
  assert.equal((await cli(['flaky', 'list', '--fail-on-suggestion'])).code, 1);
  handler = (_req, respond) => respond(200, { count: 0, suggestions: 0, thresholds: {}, routines: [] });
  assert.match((await cli(['flaky', 'list'])).stdout, /No runs recorded yet/);
});

test('flaky show: an unknown routine is exit 2 with its type; bad usage never reaches the API', async () => {
  handler = (_req, respond) => respond(404, { error: { type: 'NoRunData', message: 'no runs yet' } });
  const missing = await cli(['flaky', 'show', 'ghost']);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /NoRunData/);

  for (const args of [['flaky'], ['flaky', 'show'], ['flaky', 'list', 'x'], ['flaky', 'show', 'a', 'b'], ['flaky', 'show', 'a', '--profile', 'x'], ['flaky', 'show', 'a', '--version', '0']]) {
    seen.length = 0;
    assert.equal((await cli(args)).code, 2, args.join(' '));
    assert.equal(seen.length, 0, `${args.join(' ')} must not reach the API`);
  }
});

// T3.7: `scrapforai health`

const healthTarget = (over: Record<string, unknown> = {}) => ({
  id: 'app-dev',
  environment: 'dev',
  known: true,
  status: 'red',
  reasons: ['1 routine failing in the last run', '1 flaky routine'],
  routines: {
    total: 3,
    counts: { failing: 1, flaky: 1, slower: 0, passing: 1, 'never-run': 0, quarantined: 0, inactive: 0 },
    list: [
      { id: 'crud', version: 2, state: 'failing', trend: 'worsening' },
      { id: 'search', version: 1, state: 'flaky', trend: 'unknown' },
      { id: 'login', version: 1, state: 'passing', trend: 'steady' },
    ],
  },
  vault: { total: 2, passing: 1, failing: 0, notRun: 1 },
  schedules: [{ id: 'nightly' }],
  ...over,
});

const healthBody = (over: Record<string, unknown> = {}) => ({
  generatedAt: '2026-11-03T12:00:00.000Z',
  schedulerRunning: true,
  totals: { targets: 1, red: 1, yellow: 0, green: 0, empty: 0 },
  targets: [healthTarget()],
  unscoped: { vault: {}, schedules: [] },
  ...over,
});

test('health: one block per target with the reasons and the routines that need a look; --json matches the contract; exit 0 unless --fail-on-red', async () => {
  handler = (_req, respond) => respond(200, healthBody());
  const out = await cli(['health']);
  assert.equal(out.code, 0, 'a red target is information, not a failed test');
  assert.match(out.stdout, /RED {3}app-dev \(dev\)/);
  assert.match(out.stdout, /routines: 1 failing, 1 flaky, 1 passing; vault: 1 passing, 0 failing, 1 not run; schedules: 1/);
  assert.match(out.stdout, /- 1 routine failing in the last run/);
  assert.match(out.stdout, /failing {2}crud v2 \(worsening\)/);
  assert.match(out.stdout, /flaky {4}search v1\n/);
  assert.ok(!/login v1/.test(out.stdout), 'a passing routine is not listed');
  assert.equal(seen.at(-1)!.url, '/v1/health');
  assert.equal(validJson((await cli(['health', '--json'])).stdout).command, 'health');
  assert.equal((await cli(['health', '--fail-on-red'])).code, 1, 'a guard that opted in');

  handler = (_req, respond) => respond(200, healthBody({ schedulerRunning: false, totals: { targets: 1, red: 0, yellow: 0, green: 1, empty: 0 }, targets: [healthTarget({ status: 'green', reasons: [] })] }));
  const green = await cli(['health', '--fail-on-red', '--target', 'app-dev']);
  assert.equal(green.code, 0);
  assert.equal(seen.at(-1)!.url, '/v1/health?target=app-dev');
  assert.match(green.stdout, /Scheduler: NOT running/);

  handler = (_req, respond) => respond(200, healthBody({ totals: { targets: 0, red: 0, yellow: 0, green: 0, empty: 0 }, targets: [], schedulerRunning: true }));
  assert.match((await cli(['health'])).stdout, /No target profile yet/);
});

// T9.3: `scrapforai summary`
const summaryBody = () => ({
  kind: 'scrapforai-summary', generatedAt: '2026-11-09T11:00:00.000Z', period: { from: '2026-11-02T11:00:00.000Z', to: '2026-11-09T11:00:00.000Z', days: 7 },
  counts: { red: 1, broke: 1, fixed: 0, stillFailing: 0, flaky: 0, perfAlerts: 0, snapshots: 0, screensChanged: 0, unexpectedChanges: 0, a11yNew: 0 },
  markdown: '# ScrapForAI summary, 2026-11-02 to 2026-11-09\n\n- cart [app-dev]: broke\n',
});

test('summary: prints the markdown, passes the filters, --out writes the file, --json matches the contract, exit 0', async () => {
  handler = (_req, respond) => respond(200, summaryBody());
  const out = await cli(['summary']);
  assert.equal(out.code, 0);
  assert.match(out.stdout, /^# ScrapForAI summary/);
  assert.equal(seen.at(-1)!.url, '/v1/summary');

  await cli(['summary', '--days', '14', '--target', 'app-dev,app-qa', '--lang', 'pt']);
  assert.equal(seen.at(-1)!.url, '/v1/summary?days=14&target=app-dev%2Capp-qa&lang=pt');

  const written: Array<{ path: string; data: string }> = [];
  const toFile = await cli(['summary', '--out', 'week.md'], { writeFile: async (file: string, data: Buffer) => void written.push({ path: file, data: data.toString('utf8') }) });
  assert.equal(toFile.code, 0);
  assert.match(toFile.stdout, /Summary written to week\.md/);
  assert.deepEqual(written, [{ path: 'week.md', data: summaryBody().markdown }]);

  assert.equal(validJson((await cli(['summary', '--json'])).stdout).command, 'summary');
  assert.equal((await cli(['summary', '--lang', 'fr'])).code, 2);
  assert.equal((await cli(['summary', '--days', 'week'])).code, 2);
  assert.equal(seen.length, 0, 'bad usage never reaches the API');
});

test('health: an unknown target is exit 2 with its type; bad usage never reaches the API', async () => {
  handler = (_req, respond) => respond(404, { error: { type: 'TargetNotFound', message: 'no such target' } });
  const missing = await cli(['health', '--target', 'ghost']);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /TargetNotFound/);

  seen.length = 0;
  assert.equal((await cli(['health', 'extra'])).code, 2);
  assert.equal(seen.length, 0);
});

test('suite text: quarantined runs and the failed attempt of a retried run are visible, and the counts are those of the runs that count', async () => {
  const state = suiteState({
    verdict: 'green', exitCode: 0, verdictReason: '1 of 1 run(s) passed (1 passed only on a new attempt)',
    counts: { pending: 0, running: 0, passed: 1, failed: 1, error: 0, notRun: 0 },
    quarantine: { total: 1, passed: 0, failed: 1, error: 0, notRun: 0 },
    variants: [
      { variantKey: 'a', routineId: 'a', routineVersion: 1, status: 'passed', jobId: 'job_2', passedOnRetry: true, attempts: [{ attempt: 1, jobId: 'job_1', status: 'failed', errorType: 'Timeout' }, { attempt: 2, jobId: 'job_2', status: 'passed' }] },
      { variantKey: 'b', routineId: 'b', routineVersion: 1, status: 'failed', jobId: 'job_3', quarantined: true },
    ],
  });
  handler = (req, respond) => respond(req.method === 'POST' ? 202 : 200, req.method === 'POST' ? { suiteRunId: 'suite_abc', status: 'running', total: 2 } : state);
  const out = await cli(['suite', 'nightly.json'], { readFile: async () => JSON.stringify(suiteBody) });

  assert.equal(out.code, 0, 'the quarantined failure is not in the verdict');
  assert.match(out.stdout, /PASS {3}a {2}job_2 {2}\[passed on a new attempt\]/);
  assert.match(out.stdout, /attempt 1: failed {2}job_1 {2}Timeout/);
  assert.match(out.stdout, /FAIL {3}b {2}job_3 {2}\[quarantined: not counted\]/);
  assert.match(out.stdout, /1 passed, 0 failed, 0 error, 0 not run\n/);
  assert.match(out.stdout, /quarantined, not in the verdict: 1 ran - 0 passed, 1 failed, 0 error/);
  validJson((await cli(['suite', 'nightly.json', '--json'], { readFile: async () => JSON.stringify(suiteBody) })).stdout);
});

// T6.3: `scrapforai differential`

const differentialState = (verdict: 'same' | 'different' | 'infra-error', exitCode: 0 | 1 | 2) => ({
  differentialId: 'diff_abc',
  status: 'completed',
  createdAt: '2026-11-04T10:00:00.000Z',
  request: {},
  labels: { left: 'GX17', right: 'GX18' },
  counts: { total: 2, same: 1, different: verdict === 'different' ? 1 : 0, infraError: verdict === 'infra-error' ? 1 : 0, notRun: 0 },
  pairs: [
    { routineId: 'crud', version: 1, state: 'done', outcome: 'same' },
    verdict === 'different'
      ? { routineId: 'orders', version: 3, state: 'done', outcome: 'different', comparison: { headline: '1 new console error(s)' }, lines: ['console, new on GX18: boom'], timeLines: ['save: slower on GX18 (GX17 100 ms, GX18 900 ms, x9)'] }
      : { routineId: 'orders', version: 3, state: 'done', outcome: verdict === 'same' ? 'same' : 'infra-error', error: 'right: CredentialSetNotFound' },
  ],
  verdict,
  exitCode,
  reason: 'reason',
});

test('differential: sends both sides, waits, prints the differences, and the exit code is the verdict (0 same, 1 different, 2 could not run)', async () => {
  handler = (req, respond) => (req.method === 'POST' ? respond(202, { differentialId: 'diff_abc', status: 'running', counts: {}, warnings: ['a fixed address'] }) : respond(200, differentialState('different', 1)));
  const different = await cli(['differential', 'crud', 'orders', '--left', 'gx17', '--right', 'gx18', '--left-credential', 'a17', '--right-credential', 'a18', '--right-build', 'b2', '--right-label', 'GX18', '--var', 'k=v', '--profile', 'functional', '--time-ratio', '3', '--json']);
  assert.equal(different.code, 1);
  assert.deepEqual(seen[0]!.body, {
    routines: [{ routineId: 'crud' }, { routineId: 'orders' }],
    left: { targetProfile: 'gx17', credentialSet: 'a17' },
    right: { targetProfile: 'gx18', credentialSet: 'a18', buildId: 'b2', label: 'GX18' },
    variables: { k: 'v' },
    profile: 'functional',
    tolerance: { timeRatio: 3 },
  });
  assert.equal(validJson(different.stdout).command, 'differential');
  assert.match(different.stderr, /warning: a fixed address/);

  const text = await cli(['differential', 'crud', '--left', 'gx17', '--right', 'gx18']);
  assert.match(text.stdout, /orders@v3: DIFFERENT - 1 new console error/);
  assert.match(text.stdout, /console, new on GX18: boom/);
  assert.match(text.stdout, /time: save: slower on GX18/);

  handler = (req, respond) => (req.method === 'POST' ? respond(202, { differentialId: 'diff_abc', status: 'running' }) : respond(200, differentialState('same', 0)));
  assert.equal((await cli(['differential', 'crud', '--left', 'a', '--right', 'b'])).code, 0);
  handler = (req, respond) => (req.method === 'POST' ? respond(202, { differentialId: 'diff_abc', status: 'running' }) : respond(200, differentialState('infra-error', 2)));
  assert.equal((await cli(['differential', 'crud', '--left', 'a', '--right', 'b'])).code, 2);

  const started = await cli(['differential', 'crud', '--left', 'a', '--right', 'b', '--no-wait', '--json']);
  assert.equal(started.code, 0);
  assert.equal(validJson(started.stdout).result.differentialId, 'diff_abc');
});

test('differential --from-jobs: compares two past runs; 0 when the same, 1 when different; bad usage never reaches the API', async () => {
  const compared = (verdict: string) => ({
    left: { jobId: 'job_l', label: 'dev', status: 'passed' },
    right: { jobId: 'job_r', label: 'qa', status: 'passed' },
    verdict,
    comparison: { equivalent: verdict === 'same', headline: verdict === 'same' ? '' : '1 extracted value(s)' },
    lines: verdict === 'same' ? [] : ['extracted ~ total changed'],
    timeLines: [],
    notes: ['the runs used different versions of crud'],
  });
  handler = (_req, respond) => respond(200, compared('different'));
  const different = await cli(['differential', '--from-jobs', 'job_l', 'job_r', '--json']);
  assert.equal(different.code, 1);
  assert.deepEqual(seen[0]!.body, { leftJobId: 'job_l', rightJobId: 'job_r' });
  assert.equal(validJson(different.stdout).command, 'differential');
  const text = await cli(['differential', '--from-jobs', 'job_l', 'job_r']);
  assert.match(text.stdout, /extracted ~ total changed/);
  assert.match(text.stdout, /note: the runs used different versions/);

  handler = (_req, respond) => respond(200, compared('same'));
  assert.equal((await cli(['differential', '--from-jobs', 'job_l', 'job_r'])).code, 0);

  seen.length = 0;
  assert.equal((await cli(['differential', '--from-jobs', 'job_l'])).code, 2);
  assert.equal((await cli(['differential', 'crud', '--left', 'a'])).code, 2);
  assert.equal((await cli(['differential', 'crud', '--left', 'a', '--right', 'b', '--time-ratio', '1'])).code, 2);
  assert.equal(seen.length, 0, 'usage errors are caught before any request');
});

// --- T9.2: `scrapforai manual build|show` ------------------------------------------------------------------------------------------

const manualState = (status: 'completed' | 'failed', exitCode: 0 | 2, overrides: Record<string, unknown> = {}) => ({
  buildRunId: 'man_abc',
  targetProfile: 'app',
  status,
  createdAt: '2026-11-04T12:00:00.000Z',
  request: { targetProfile: 'app', langs: ['en', 'pt'], formats: ['md', 'html'] },
  routines:
    status === 'completed'
      ? [{ routineId: '01-orders', version: 2, title: 'Orders', state: 'done', outcome: 'ok', figures: 4 }]
      : [{ routineId: '01-orders', version: 2, title: 'Orders', state: 'done', outcome: 'failed', error: 'step "press-save": DocFigureError: doc.highlight "#nope" matched no visible element' }],
  skipped: [{ routineId: '03-draft', status: 'draft', reason: 'draft: only active routines are built into the manual' }],
  ...(status === 'completed'
    ? {
        output: {
          folder: '/docs/manual/app',
          buildId: 'rev-3',
          buildIdSource: 'provided',
          langs: ['en', 'pt'],
          formats: ['md', 'html'],
          files: 12,
          removedFiles: 0,
          figures: { total: 4, new: 1, changed: 2, negligible: 0, unchanged: 1, removed: 0 },
          changes: {
            firstBuild: false,
            previousBuildId: 'rev-2',
            new: ['01-orders/saved'],
            removed: [],
            changed: [{ id: '01-orders/open', reason: 'visual', changedCells: 40, totalCells: 1024, percent: 3.9 }, { id: '01-orders/press-save', reason: 'resized' }],
            negligible: [],
            unchanged: 1,
          },
          missingCaptions: 2,
        },
        reason: 'manual written: 4 figure(s) in 1 chapter(s)',
      }
    : { reason: '1 of 1 routine(s) did not pass (01-orders); nothing was written, the previous manual is untouched' }),
  exitCode,
  ...overrides,
});

const manualStarted = { buildRunId: 'man_abc', targetProfile: 'app', status: 'running', routines: 1, skipped: [] };

test('manual build: sends the languages and formats, waits, lists the figures to review, and exits 0 when written, 2 when not', async () => {
  handler = (req, respond) => (req.method === 'POST' ? respond(202, manualStarted) : respond(200, manualState('completed', 0)));
  const done = await cli(['manual', 'build', 'app', '--lang', 'en,pt', '--format', 'md', '--build-id', 'rev-3', '--json']);
  assert.equal(done.code, 0);
  assert.equal(seen[0]!.url, '/v1/manual/builds');
  assert.equal(seen[0]!.auth, `Bearer ${KEY}`);
  assert.deepEqual(seen[0]!.body, { targetProfile: 'app', langs: ['en', 'pt'], formats: ['md'], buildId: 'rev-3' });
  assert.equal(validJson(done.stdout).command, 'manual build');

  const text = await cli(['manual', 'build', 'app']);
  assert.deepEqual(seen[0]!.body, { targetProfile: 'app' }, 'nothing is sent that the user did not ask for');
  assert.match(text.stdout, /OK\s+01-orders v2\s+4 figure\(s\)/);
  assert.match(text.stdout, /skipped\s+03-draft: draft/);
  assert.match(text.stdout, /written to \/docs\/manual\/app\s+\(build rev-3, en,pt, md,html, 12 files\)/);
  assert.match(text.stdout, /figures: 4 - 2 changed, 1 new, 0 removed, 0 differ slightly, 1 unchanged/);
  assert.match(text.stdout, /review: \/docs\/manual\/app\/<lang>\/figures-changed\.md/);
  assert.match(text.stdout, /changed\s+01-orders\/open\s+\(3\.9% of the picture\)/);
  assert.match(text.stdout, /changed\s+01-orders\/press-save\s+\(other size\)/);
  assert.match(text.stdout, /new\s+01-orders\/saved/);
  assert.match(text.stdout, /2 caption\(s\) have no text in a requested language/);

  handler = (req, respond) => (req.method === 'POST' ? respond(202, manualStarted) : respond(200, manualState('failed', 2)));
  const failed = await cli(['manual', 'build', 'app']);
  assert.equal(failed.code, 2);
  assert.match(failed.stdout, /FAIL\s+01-orders v2\s+step "press-save": DocFigureError/);
  assert.match(failed.stdout, /nothing was written, the previous manual is untouched/);
  assert.equal(validJson((await cli(['manual', 'build', 'app', '--json'])).stdout).exitCode, 2);

  const started = await cli(['manual', 'build', 'app', '--no-wait', '--json']);
  assert.equal(started.code, 0);
  assert.equal(validJson(started.stdout).result.buildRunId, 'man_abc');
});

test('manual build: a first build says there is nothing to compare; an API refusal is exit 2 with its type; bad usage never reaches the API', async () => {
  const firstOutput = { ...(manualState('completed', 0).output as Record<string, unknown>), changes: { firstBuild: true, new: [], removed: [], changed: [], negligible: [], unchanged: 0 } };
  handler = (req, respond) => (req.method === 'POST' ? respond(202, manualStarted) : respond(200, manualState('completed', 0, { output: firstOutput })));
  const first = await cli(['manual', 'build', 'app']);
  assert.match(first.stdout, /figures: 4 \(first build of this manual: nothing to compare with\)/);
  assert.ok(!/review:/.test(first.stdout));

  handler = (_req, respond) => respond(404, { error: { type: 'NoDocRoutines', message: 'No active routine of target profile "app" is tagged "doc"' } });
  const refused = await cli(['manual', 'build', 'app', '--json']);
  assert.equal(refused.code, 2);
  assert.equal(JSON.parse(refused.stdout).error.type, 'NoDocRoutines');

  seen.length = 0;
  assert.equal((await cli(['manual', 'build'])).code, 2);
  assert.equal((await cli(['manual', 'build', 'app', '--lang', 'fr'])).code, 2);
  assert.equal((await cli(['manual', 'build', 'app', '--lang', ''])).code, 2);
  assert.equal((await cli(['manual', 'build', 'app', '--format', 'pdf'])).code, 2);
  assert.equal((await cli(['manual', 'build', 'app', '--timeout-seconds', '0'])).code, 2);
  assert.equal((await cli(['manual', 'show'])).code, 2);
  assert.equal(seen.length, 0, 'usage errors are caught before any request');
});

test('manual show: what the last build wrote; no manual yet is exit 2 with its type', async () => {
  const manifest = {
    manualVersion: 1,
    targetProfile: 'app',
    title: 'The Orders App',
    buildId: 'rev-3',
    createdAt: '2026-11-04T12:00:00.000Z',
    langs: ['en', 'pt'],
    formats: ['md', 'html'],
    routines: [{ id: '01-orders', version: 2, title: 'Orders', jobId: 'job_1', figures: 4 }],
    figures: [{ id: '01-orders/open' }, { id: '01-orders/saved' }],
    changes: { firstBuild: false, previousBuildId: 'rev-2', new: [], removed: [], changed: [{ id: '01-orders/open', reason: 'visual' }], negligible: ['x/y'], unchanged: 1 },
    missingCaptions: [{ routineId: '01-orders', stepId: 'open', field: 'caption', lang: 'pt' }],
    files: [],
    folder: '/docs/manual/app',
  };
  handler = (_req, respond) => respond(200, manifest);
  const shown = await cli(['manual', 'show', 'app']);
  assert.equal(shown.code, 0);
  assert.equal(seen[0]!.url, '/v1/manual/app');
  assert.match(shown.stdout, /Manual of "app": build rev-3/);
  assert.match(shown.stdout, /chapters: 1, figures: 2, languages: en,pt, formats: md,html/);
  assert.match(shown.stdout, /since the previous build \(rev-2\): 1 changed, 0 new, 0 removed, 1 differ slightly, 1 unchanged/);
  assert.match(shown.stdout, /1 caption\(s\) have no text in a requested language/);
  assert.equal(validJson((await cli(['manual', 'show', 'app', '--json'])).stdout).command, 'manual show');

  handler = (_req, respond) => respond(404, { error: { type: 'ManualNotFound', message: 'No manual has been built for "app" yet' } });
  const none = await cli(['manual', 'show', 'app', '--json']);
  assert.equal(none.code, 2);
  assert.equal(JSON.parse(none.stdout).error.type, 'ManualNotFound');
});

// ---- T9.1: bug reports and integrations ----------------------------------------------------------------------------------------------------------

const bugReportBody = (over: Record<string, unknown> = {}) => ({
  id: 'bug_abc123',
  status: 'draft',
  createdAt: '2026-11-04T13:00:00.000Z',
  updatedAt: '2026-11-04T13:00:00.000Z',
  lang: 'en',
  signature: { hash: '0123456789abcdef', key: 'cart-total / step total / StepExecutionError', subject: 'cart-total', stepId: 'total', errorType: 'StepExecutionError' },
  source: { jobId: 'job_x' },
  targetProfile: 'shop',
  title: '[ScrapForAI] cart-total failed at step total: StepExecutionError',
  body: '## Where\n\n- Page: `https://dev.example.com/cart`\n',
  redactions: 2,
  occurrenceCount: 1,
  occurrences: [{ jobId: 'job_x', at: '2026-11-04T13:00:00.000Z', via: 'manual' }],
  attempts: [],
  ...over,
});

test('bug-report create: POSTs the run, says whether it is new, rebuilt or a recurrence, and never sends anything; --json matches the contract', async () => {
  handler = (_req, respond) => respond(201, { report: bugReportBody(), created: true, refreshed: false });
  const created = await cli(['bug-report', 'create', '--from-job', 'job_x', '--shrink', 'shrink_1', '--lang', 'pt']);
  assert.equal(created.code, 0);
  assert.equal(seen[0]!.method, 'POST');
  assert.equal(seen[0]!.url, '/v1/bug-reports');
  assert.deepEqual(seen[0]!.body, { fromJobId: 'job_x', shrinkId: 'shrink_1', lang: 'pt' });
  assert.equal(seen[0]!.auth, `Bearer ${KEY}`);
  assert.match(created.stdout, /Draft bug_abc123 created: cart-total \/ step total \/ StepExecutionError/);
  assert.match(created.stdout, /2 value\(s\) masked/);
  assert.match(created.stdout, /approve and send: scrapforai bug-report send bug_abc123/);
  assert.equal(validJson((await cli(['bug-report', 'create', '--from-job', 'job_x', '--json'])).stdout).command, 'bug-report create');

  handler = (_req, respond) => respond(200, { report: bugReportBody({ occurrenceCount: 3, status: 'sent', issue: { integrationId: 'gh', number: 42, url: 'https://github.com/acme/shop/issues/42', sentAt: 'x' } }), created: false, refreshed: false });
  const again = await cli(['bug-report', 'create', '--from-job', 'job_y']);
  assert.match(again.stdout, /already has bug_abc123 \(sent\); the occurrence was added/);
  assert.match(again.stdout, /3 occurrence\(s\)/);
  assert.match(again.stdout, /issue: #42 https:\/\/github\.com\/acme\/shop\/issues\/42/);

  handler = (_req, respond) => respond(200, { report: bugReportBody(), created: false, refreshed: true });
  assert.match((await cli(['bug-report', 'create', '--from-job', 'job_z'])).stdout, /unsent draft bug_abc123 was rebuilt from this run/);

  for (const args of [['bug-report', 'create'], ['bug-report', 'create', 'extra', '--from-job', 'job_x'], ['bug-report', 'create', '--from-job', 'job_x', '--lang', 'fr']]) {
    seen.length = 0;
    const bad = await cli(args);
    assert.equal(bad.code, 2, args.join(' '));
    assert.equal(seen.length, 0, 'bad usage never reaches the API');
  }
  handler = (_req, respond) => respond(409, { error: { type: 'RunNotFailed', message: 'Run job_ok did not fail' } });
  const refused = await cli(['bug-report', 'create', '--from-job', 'job_ok']);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /RunNotFailed/);
});

test('bug-report list / show: a row per report, the issue text on screen or in a file', async () => {
  handler = (_req, respond) => respond(200, { bugReports: [{ ...bugReportBody({ occurrenceCount: 4 }), body: undefined }, { ...bugReportBody({ id: 'bug_def456', status: 'sent', issue: { integrationId: 'gh', number: 7, url: 'https://x', sentAt: 'y' } }), body: undefined }] });
  const list = await cli(['bug-report', 'list', '--status', 'draft']);
  assert.equal(seen[0]!.url, '/v1/bug-reports?status=draft');
  assert.match(list.stdout, /bug_abc123\s+draft\s+x4\s+cart-total \/ step total \/ StepExecutionError/);
  assert.match(list.stdout, /bug_def456\s+sent.*-> #7/);
  assert.equal(validJson((await cli(['bug-report', 'list', '--json'])).stdout).command, 'bug-report list');

  handler = (_req, respond) => respond(200, bugReportBody());
  const shown = await cli(['bug-report', 'show', 'bug_abc123']);
  assert.equal(seen[0]!.url, '/v1/bug-reports/bug_abc123');
  assert.match(shown.stdout, /^bug_abc123\s+draft\s+x1/);
  assert.match(shown.stdout, /# \[ScrapForAI\] cart-total failed at step total: StepExecutionError\n\n## Where/);
  assert.equal(validJson((await cli(['bug-report', 'show', 'bug_abc123', '--json'])).stdout).command, 'bug-report show');

  const written: Array<{ path: string; data: string }> = [];
  const toFile = await cli(['bug-report', 'show', 'bug_abc123', '--out', 'issue.md'], { writeFile: async (file: string, data: Buffer) => void written.push({ path: file, data: data.toString('utf8') }) });
  assert.equal(toFile.code, 0);
  assert.equal(written[0]!.path, 'issue.md');
  assert.ok(written[0]!.data.startsWith('# [ScrapForAI] cart-total failed'));
  assert.match(toFile.stdout, /Issue text written to issue\.md/);

  seen.length = 0;
  assert.equal((await cli(['bug-report', 'show'])).code, 2);
  assert.equal(seen.length, 0);
});

test('bug-report send: exit 0 only when the issue exists; a refusal or a blocked text exits 2 and says the report is still a draft', async () => {
  const sentReport = bugReportBody({ status: 'sent', issue: { integrationId: 'gh', number: 42, url: 'https://github.com/acme/shop/issues/42', sentAt: 'x' } });
  handler = (_req, respond) => respond(200, { status: 'sent', attempt: { at: 'x', integrationId: 'gh', status: 'sent' }, report: sentReport });
  const ok = await cli(['bug-report', 'send', 'bug_abc123', '--integration', 'gh']);
  assert.equal(ok.code, 0);
  assert.equal(seen[0]!.url, '/v1/bug-reports/bug_abc123/send');
  assert.deepEqual(seen[0]!.body, { integrationId: 'gh' });
  assert.match(ok.stdout, /Sent as issue #42 https:\/\/github\.com\/acme\/shop\/issues\/42/);
  assert.equal(validJson((await cli(['bug-report', 'send', 'bug_abc123', '--json'])).stdout).command, 'bug-report send');
  assert.deepEqual(seen[0]!.body, {}, 'no integration named: the server picks the only one that serves the profile');

  handler = (_req, respond) => respond(502, { status: 'failed', attempt: { at: 'x', integrationId: 'gh', status: 'failed', httpStatus: 401, reason: 'the token was rejected (HTTP 401)' }, report: bugReportBody() });
  const failed = await cli(['bug-report', 'send', 'bug_abc123']);
  assert.equal(failed.code, 2);
  assert.match(failed.stdout, /Not sent \(failed\): the token was rejected \(HTTP 401\)\. The report is still a draft\./);

  handler = (_req, respond) => respond(422, { status: 'blocked', attempt: { at: 'x', integrationId: 'gh', status: 'blocked', reason: 'the report still contained a credential vault value after cleaning; nothing was sent' }, report: bugReportBody() });
  const blocked = await cli(['bug-report', 'send', 'bug_abc123', '--json']);
  assert.equal(blocked.code, 2);
  assert.equal(validJson(blocked.stdout).result.status, 'blocked');

  handler = (_req, respond) => respond(409, { error: { type: 'BugReportNotDraft', message: 'Already sent as issue #42' } });
  const twice = await cli(['bug-report', 'send', 'bug_abc123']);
  assert.equal(twice.code, 2);
  assert.match(twice.stderr, /BugReportNotDraft/);
});

test('bug-report dismiss / resolve: POST the decision with its note', async () => {
  handler = (_req, respond) => respond(200, bugReportBody({ status: 'dismissed' }));
  const dismissed = await cli(['bug-report', 'dismiss', 'bug_abc123', '--note', 'known']);
  assert.equal(seen[0]!.url, '/v1/bug-reports/bug_abc123/dismiss');
  assert.deepEqual(seen[0]!.body, { note: 'known' });
  assert.match(dismissed.stdout, /bug_abc123 is now dismissed/);
  assert.equal(validJson((await cli(['bug-report', 'dismiss', 'bug_abc123', '--json'])).stdout).command, 'bug-report dismiss');

  handler = (_req, respond) => respond(200, bugReportBody({ status: 'resolved' }));
  const resolved = await cli(['bug-report', 'resolve', 'bug_abc123']);
  assert.equal(seen[0]!.url, '/v1/bug-reports/bug_abc123/resolve');
  assert.match(resolved.stdout, /is now resolved/);
  assert.equal(validJson((await cli(['bug-report', 'resolve', 'bug_abc123', '--json'])).stdout).command, 'bug-report resolve');
});

const integrationView = (over: Record<string, unknown> = {}) => ({
  integration: { id: 'gh', kind: 'github', enabled: true, repo: 'acme/shop', apiBaseUrl: 'https://api.github.com', labels: ['scrapforai'], targetProfiles: [], onScheduledFailure: 'draft', lang: 'en' },
  createdAt: '2026-11-04T12:00:00.000Z',
  updatedAt: '2026-11-04T12:00:00.000Z',
  hasToken: true,
  apiOrigin: 'https://api.github.com',
  originAllowed: true,
  ...over,
});

test('integrations list / show / test: the destination and whether there is a token, never the token; test exits 2 when the repository cannot be read', async () => {
  handler = (_req, respond) => respond(200, { integrations: [integrationView(), integrationView({ originAllowed: false, hasToken: false, integration: { ...integrationView().integration, id: 'blocked' } })] });
  const list = await cli(['integrations', 'list']);
  assert.match(list.stdout, /on\s+gh\s+github acme\/shop\s+https:\/\/api\.github\.com\s+on scheduled failure: draft/);
  assert.match(list.stdout, /blocked.*ORIGIN NOT ALLOWED.*NO TOKEN/);
  assert.equal(validJson((await cli(['integrations', 'list', '--json'])).stdout).command, 'integrations list');

  handler = (_req, respond) => respond(200, integrationView());
  const show = await cli(['integrations', 'show', 'gh']);
  assert.equal(seen[0]!.url, '/v1/integrations/gh');
  assert.match(show.stdout, /token: stored \(write-only\)/);
  assert.match(show.stdout, /target profiles: any/);
  assert.equal(validJson((await cli(['integrations', 'show', 'gh', '--json'])).stdout).command, 'integrations show');

  handler = (_req, respond) => respond(200, { ok: true, issuesEnabled: true });
  const ok = await cli(['integrations', 'test', 'gh']);
  assert.equal(ok.code, 0);
  assert.equal(seen[0]!.method, 'POST');
  assert.equal(seen[0]!.url, '/v1/integrations/gh/test');
  assert.equal(validJson((await cli(['integrations', 'test', 'gh', '--json'])).stdout).command, 'integrations test');

  handler = (_req, respond) => respond(502, { ok: false, reason: 'the token was rejected (HTTP 401)', httpStatus: 401 });
  const failed = await cli(['integrations', 'test', 'gh']);
  assert.equal(failed.code, 2);
  assert.match(failed.stdout, /failed: the token was rejected \(HTTP 401\) \(HTTP 401\)/);

  for (const args of [['integrations'], ['integrations', 'show'], ['integrations', 'test'], ['integrations', 'list', 'x']]) {
    seen.length = 0;
    assert.equal((await cli(args)).code, 2, args.join(' '));
    assert.equal(seen.length, 0);
  }
});

const teamUser = (over: Record<string, unknown> = {}) => ({
  id: 'ana', name: 'Ana', role: 'runner', disabled: false, createdAt: '2026-11-05T10:00:00.000Z', createdBy: 'root',
  keys: [{ id: 'abcdef012345', createdAt: '2026-11-05T10:00:00.000Z', active: true }],
  ...over,
});

test('users: list/create/set/delete/key-create/key-revoke call the team API with the bearer; a key is printed once and never needed as an argument', async () => {
  handler = (_req, respond) => respond(200, { users: [teamUser(), teamUser({ id: 'old', role: 'viewer', disabled: true, keys: [] })] });
  const list = await cli(['users', 'list']);
  assert.match(list.stdout, /on\s+ana\s+runner\s+Ana\s+keys: 1 active/);
  assert.match(list.stdout, /off\s+old\s+viewer/);
  assert.equal(validJson((await cli(['users', 'list', '--json'])).stdout).command, 'users list');
  assert.equal(seen.at(-1)!.url, '/v1/team/users');

  const KEY = 'sfa_abcdef012345_' + 'k'.repeat(43);
  handler = (_req, respond) => respond(201, { user: teamUser(), key: KEY, notice: 'Copy this key now' });
  const created = await cli(['users', 'create', 'ana', '--role', 'runner', '--name', 'Ana']);
  assert.equal(created.code, 0);
  assert.ok(created.stdout.includes(KEY) && /shown only now/.test(created.stdout));
  assert.deepEqual(seen.at(-1)!.body, { id: 'ana', name: 'Ana', role: 'runner' });
  assert.equal(seen.at(-1)!.method, 'POST');
  assert.match(seen.at(-1)!.auth ?? '', /^Bearer .+/);
  assert.equal(validJson((await cli(['users', 'create', 'ana', '--role', 'runner', '--json'])).stdout).command, 'users create');

  handler = (_req, respond) => respond(200, teamUser({ role: 'viewer', disabled: true }));
  const changed = await cli(['users', 'set', 'ana', '--role', 'viewer', '--disabled', 'true']);
  assert.equal(changed.code, 0);
  assert.equal(seen.at(-1)!.method, 'PATCH');
  assert.deepEqual(seen.at(-1)!.body, { role: 'viewer', disabled: true });

  handler = (_req, respond) => respond(200, { deleted: 'ana' });
  assert.equal((await cli(['users', 'delete', 'ana'])).code, 0);
  assert.equal(seen.at(-1)!.method, 'DELETE');
  assert.equal(seen.at(-1)!.url, '/v1/team/users/ana');

  handler = (_req, respond) => respond(201, { key: KEY, keyId: 'abcdef012345', view: {}, notice: 'Copy this key now' });
  const key = await cli(['users', 'key-create', 'ana', '--label', 'laptop', '--expires', '2027-01-01T00:00:00Z']);
  assert.ok(key.stdout.includes(KEY));
  assert.deepEqual(seen.at(-1)!.body, { label: 'laptop', expiresAt: '2027-01-01T00:00:00Z' });

  handler = (_req, respond) => respond(200, { id: 'abcdef012345', createdAt: 'x', active: false });
  assert.equal((await cli(['users', 'key-revoke', 'ana', 'abcdef012345'])).code, 0);
  assert.equal(seen.at(-1)!.url, '/v1/team/users/ana/keys/abcdef012345');

  handler = (_req, respond) => respond(403, { error: { type: 'InsufficientRole', message: 'This operation needs an admin key; this key is runner' } });
  const refused = await cli(['users', 'list']);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /InsufficientRole/);

  for (const args of [['users'], ['users', 'create', 'ana'], ['users', 'set', 'ana'], ['users', 'set', 'ana', '--disabled', 'maybe'], ['users', 'key-revoke', 'ana'], ['users', 'delete']]) {
    seen.length = 0;
    const bad = await cli(args);
    assert.equal(bad.code, 2, args.join(' '));
    assert.equal(seen.length, 0, `${args.join(' ')} never reached the API`);
  }
});

test('audit: filters go to the API; verify exits 1 when the chain is broken', async () => {
  handler = (_req, respond) =>
    respond(200, {
      hasMore: true,
      entries: [
        { seq: 7, at: '2026-11-05T10:00:00.000Z', event: 'request', actor: { userId: 'ana', role: 'runner', via: 'bearer' }, method: 'POST', path: '/v1/explorations/run', status: 200, refs: { jobId: 'job-1' } },
        { seq: 6, at: '2026-11-05T09:59:00.000Z', event: 'auth.failed', status: 401, detail: { via: 'bearer' } },
      ],
    });
  const log = await cli(['audit', '--user', 'ana', '--area', 'explorations', '--limit', '2']);
  assert.match(log.stdout, /7\s+2026-11-05T10:00:00.000Z\s+ana\(runner\)\s+POST \/v1\/explorations\/run 200\s+jobId=job-1/);
  assert.match(log.stdout, /auth\.failed 401/);
  assert.match(log.stdout, /more: use --before/);
  assert.equal(seen.at(-1)!.url, '/v1/audit?user=ana&area=explorations&limit=2');
  assert.equal(validJson((await cli(['audit', '--json'])).stdout).command, 'audit');

  handler = (_req, respond) => respond(200, { ok: true, entries: 12, lastSeq: 12, lastHash: 'x', problems: [] });
  const intact = await cli(['audit', 'verify']);
  assert.equal(intact.code, 0);
  assert.match(intact.stdout, /intact: 12 entries/);

  handler = (_req, respond) => respond(200, { ok: false, entries: 12, lastSeq: 12, lastHash: 'x', problems: [{ seq: 4, problem: 'its content does not match its hash: the line was edited' }] });
  const broken = await cli(['audit', 'verify', '--json']);
  assert.equal(broken.code, 1);
  assert.equal(validJson(broken.stdout).command, 'audit verify');
  assert.match((await cli(['audit', 'verify'])).stdout, /DOES NOT VERIFY[\s\S]*#4/);
});

test('pack apply: fills the GeneXus templates, saves the profile first and then the routines; --dry-run and a missing answer send nothing', async () => {
  const fs = await import('node:fs');
  const example = fs.readFileSync(new URL('../templates/genexus-pack.answers.example.json', import.meta.url), 'utf8');
  const readFile = async () => example;

  handler = (_req, respond) => respond(200, { saved: true });
  const dry = await cli(['pack', 'apply', 'answers.json', '--dry-run', '--json'], { readFile });
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(seen.length, 0, 'a dry run sends nothing');
  const dryJson = validJson(dry.stdout);
  assert.equal(dryJson.command, 'pack apply');
  assert.equal(dryJson.result.dryRun, true);
  assert.deepEqual(dryJson.result.items.map((item: any) => item.path), ['/v1/targets/app-dev', '/v1/routines/login', '/v1/routines/smoke-page', '/v1/routines/work-with-search']);

  const applied = await cli(['pack', 'apply', 'answers.json'], { readFile });
  assert.equal(applied.code, 0, applied.stderr);
  assert.match(applied.stdout, /saved\s+PUT \/v1\/targets\/app-dev/);
  assert.match(applied.stdout, /routines are drafts/);
  assert.equal(seen.length, 4, 'one PUT per item');

  const order: Array<{ method: string; url: string; auth?: string; body: any }> = [];
  handler = (req, respond) => {
    order.push(req as never);
    respond(201, { ok: true });
  };
  await cli(['pack', 'apply', 'answers.json'], { readFile });
  assert.deepEqual(order.map((entry) => `${entry.method} ${entry.url}`), [
    'PUT /v1/targets/app-dev', 'PUT /v1/routines/login', 'PUT /v1/routines/smoke-page', 'PUT /v1/routines/work-with-search',
  ]);
  assert.equal(order[0]!.body.platform, 'genexus');
  assert.equal(order[1]!.body.targetProfile, 'app-dev', 'the routines point at the profile the answers named');
  assert.equal(order.every((entry) => entry.auth === `Bearer ${KEY}`), true);
  assert.doesNotMatch(JSON.stringify(order.map((entry) => entry.body)), /REPLACE_[A-Z0-9]/, 'nothing is left to replace (the prose "REPLACE_*" of a description is not a placeholder)');

  // An answer that is missing: nothing at all is sent, and the message names it.
  const incomplete = JSON.stringify({ ...JSON.parse(example), values: { ...JSON.parse(example).values, REPLACE_BASE_URL: '' } });
  order.length = 0;
  const refused = await cli(['pack', 'apply', 'answers.json'], { readFile: async () => incomplete });
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /PackIncomplete/);
  assert.match(refused.stderr, /REPLACE_BASE_URL/);
  assert.equal(order.length, 0, 'not one item was sent');

  // The API refuses an item: it stops there and says what was already saved.
  handler = (req, respond) => (req.url.startsWith('/v1/routines/login') ? respond(400, { error: { type: 'ValidationError', message: 'no' } }) : respond(200, { ok: true }));
  const stopped = await cli(['pack', 'apply', 'answers.json'], { readFile });
  assert.equal(stopped.code, 2);
  assert.match(stopped.stderr, /Items saved before it stay saved/);

  for (const args of [['pack'], ['pack', 'apply'], ['pack', 'apply', 'a.json', 'b.json'], ['pack', 'build']]) {
    const bad = await cli(args, { readFile });
    assert.equal(bad.code, 2, args.join(' '));
  }
});

test('pack build writes a zip with the templates, the guides and a manifest', async () => {
  let written: { path: string; data: Buffer } | undefined;
  const result = await cli(['pack', 'build', '--out', 'pack.zip', '--json'], { writeFile: async (path, data) => void (written = { path, data }) });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(validJson(result.stdout).command, 'pack build');
  assert.equal(written?.path, 'pack.zip');
  const { readZip } = await import('../src/evidence/zip.js');
  const names = readZip(written!.data).map((entry) => entry.name);
  for (const name of ['MANIFEST.sha256', 'templates/targets/genexus-dev.target.json', 'docs/genexus-pack/README.es.md', 'docs/genexus-pack/README.pt.md', 'skill/scrapforai/SKILL.md']) assert.ok(names.includes(name), name);
});
