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
  assert.ok(Array.isArray(schema.anyOf) && schema.anyOf.length === 15);
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
