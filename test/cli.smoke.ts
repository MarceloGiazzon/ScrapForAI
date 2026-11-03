import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// The REAL `scrapforai` process (src/cli.ts) against a real API with a real browser: exit codes,
// clean --json on stdout, configuration errors. The unit tests in cli.test.ts cover the logic.

const API_KEY = 'test-api-key-1234567890';
const root = path.resolve(import.meta.dirname, '..');

const site = await new Promise<{ server: http.Server; origin: string }>((resolve) => {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>Fixture</title><h1 id="t">Hello</h1>');
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-cli-smoke-'));
process.env.SCRAPFORAI_API_KEY = API_KEY;
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.SCRAPFORAI_VAULT_KEY = crypto.randomBytes(32).toString('base64');
process.env.ALLOWED_TARGET_ORIGINS = site.origin;
process.env.ALLOWED_RESOURCE_ORIGINS = site.origin;

const express = (await import('express')).default;
const { apiAuth } = await import('../src/security/apiAuth.js');
const { routinesRouter } = await import('../src/routes/routines.routes.js');
const { suitesRouter } = await import('../src/routes/suites.routes.js');
const { runsRouter } = await import('../src/routes/runs.routes.js');
const { saveTarget } = await import('../src/targets/targetStore.js');
const { saveRoutine } = await import('../src/library/routineService.js');
const { cliOutputSchema } = await import('../src/schemas/cliOutput.schema.js');

let api: http.Server;
let apiUrl: string;

function cli(args: string[], envOverride: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', ...args],
      {
        cwd: root,
        env: { ...process.env, SCRAPFORAI_MCP_BASE_URL: apiUrl, ...envOverride },
        timeout: 120_000,
      },
      (error, stdout, stderr) => resolve({ code: error ? ((error as { code?: number }).code ?? 2) : 0, stdout, stderr }),
    );
  });
}

function validJson(stdout: string): any {
  assert.equal(stdout.trim().split('\n').length, 1, `stdout must be exactly one JSON line, got: ${JSON.stringify(stdout.slice(0, 200))}`);
  const parsed = JSON.parse(stdout);
  assert.ok(cliOutputSchema.safeParse(parsed).success, 'matches the published schema');
  return parsed;
}

before(async () => {
  await saveTarget({
    id: 'fixture', name: 'Fixture', platform: 'generic', environment: 'dev', baseUrl: `${site.origin}/`, credentialSets: [],
    noiseFilters: [], surfaces: {}, screens: [], flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  });
  const open = { id: 'open', action: 'goto', url: '$targetUrl' } as const;
  await saveRoutine('ok', { title: 'ok', targetProfile: 'fixture', steps: [open, { id: 'read', action: 'extractText', selector: '#t', name: 'title' }] } as never);
  await saveRoutine('bad', { title: 'bad', targetProfile: 'fixture', steps: [open, { id: 'nope', action: 'assertVisible', selector: '#nope', timeoutMs: 300 }] } as never);

  const app = express();
  app.use(express.json());
  app.use(apiAuth);
  app.use('/v1/routines', routinesRouter);
  app.use('/v1/suites', suitesRouter);
  app.use('/v1/runs', runsRouter);
  api = app.listen(0);
  await new Promise<void>((resolve) => api.once('listening', resolve));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await new Promise<void>((resolve) => site.server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('scrapforai run: exit 0 when it passes, 1 when a step fails; --json is clean', async () => {
  const green = await cli(['run', 'ok', '--json']);
  assert.equal(green.code, 0, green.stderr);
  const parsed = validJson(green.stdout);
  assert.deepEqual([parsed.command, parsed.result.status, parsed.result.routine.id], ['run', 'passed', 'ok']);

  const red = await cli(['run', 'bad', '--json']);
  assert.equal(red.code, 1);
  assert.equal(validJson(red.stdout).result.error.type, 'StepExecutionError');

  const human = await cli(['run', 'ok']);
  assert.equal(human.code, 0);
  assert.match(human.stdout, /^PASSED\s+ok@v1/);
});

test('scrapforai run: exit 2 when the API is down or the routine does not exist', async () => {
  const down = await cli(['run', 'ok', '--json'], { SCRAPFORAI_MCP_BASE_URL: 'http://127.0.0.1:9' });
  assert.equal(down.code, 2);
  assert.equal(validJson(down.stdout).error.type, 'ApiUnreachable');

  const missing = await cli(['run', 'ghost', '--json']);
  assert.equal(missing.code, 2);
  assert.equal(validJson(missing.stdout).error.type, 'RoutineNotFound');
});

test('scrapforai suite: the exit code is the suite verdict', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-cli-suite-'));
  try {
    const greenFile = path.join(dir, 'green.json');
    const redFile = path.join(dir, 'red.json');
    fs.writeFileSync(greenFile, JSON.stringify({ name: 'green', items: [{ routineId: 'ok' }] }));
    fs.writeFileSync(redFile, JSON.stringify({ name: 'red', items: [{ routineId: 'ok' }, { routineId: 'bad' }] }));

    const green = await cli(['suite', greenFile, '--json']);
    assert.equal(green.code, 0, green.stderr);
    assert.equal(validJson(green.stdout).result.verdict, 'green');

    const red = await cli(['suite', redFile, '--json']);
    assert.equal(red.code, 1);
    const parsed = validJson(red.stdout);
    assert.deepEqual([parsed.exitCode, parsed.result.verdict, parsed.result.counts.failed], [1, 'red', 1]);
    assert.match(red.stderr, /\[suite_/, 'progress is on stderr, so stdout stays machine-readable');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scrapforai runs show / pin / routines list against the real API', async () => {
  const run = validJson((await cli(['run', 'ok', '--json'])).stdout);
  const jobId = run.result.jobId as string;

  const show = validJson((await cli(['runs', 'show', jobId, '--json'])).stdout);
  assert.equal(show.result.summary.jobId, jobId);
  assert.equal(show.result.evidenceAvailable, true);

  const pin = await cli(['pin', jobId, '--reason', 'cli smoke', '--ref', 'test:CLI-1', '--json']);
  assert.equal(pin.code, 0, pin.stderr);
  assert.equal(validJson(pin.stdout).result.ref, 'test:CLI-1');

  const list = validJson((await cli(['routines', 'list', '--json'])).stdout);
  assert.deepEqual(list.result.routines.map((r: { id: string }) => r.id), ['bad', 'ok']);
});

test('a broken configuration is exit 2 with a message, not a stack trace', async () => {
  const result = await cli(['run', 'ok', '--json'], { SCRAPFORAI_API_KEY: 'short' });
  assert.equal(result.code, 2);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.error.type, 'ConfigError');
  assert.doesNotMatch(result.stderr, /at .*\.ts:\d+/);

  const help = await cli(['--help'], { SCRAPFORAI_API_KEY: 'short' });
  assert.equal(help.code, 0, '--help needs no configuration');
});
