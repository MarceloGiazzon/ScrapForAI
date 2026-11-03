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

test('the published JSON Schema of the CLI output exists and describes every command', () => {
  const schema = buildCliOutputJsonSchema() as { anyOf?: unknown[] };
  assert.ok(Array.isArray(schema.anyOf) && schema.anyOf.length === 22);
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
