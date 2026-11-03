import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const API_KEY = 'test-api-key-1234567890';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-evidence-test-'));
process.env.SCRAPFORAI_API_KEY = API_KEY;
process.env.SCRAPFORAI_DATA_DIR = dataDir;
// .env may pin ARTIFACT_DIR; dotenv never overrides an existing variable.
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';
process.env.ALLOWED_RESOURCE_ORIGINS = 'https://dev.example.com';
process.env.ARTIFACT_RETENTION_HOURS = '4';
process.env.STANDARD_RETENTION_DAYS = '30';
process.env.PINNED_EVIDENCE_MAX_MB = '1'; // small on purpose: the quota test fills it

const express = (await import('express')).default;
const { env } = await import('../src/config/env.js');
const { apiAuth, UI_REQUEST_HEADER } = await import('../src/security/apiAuth.js');
const { createSession, SESSION_COOKIE_NAME } = await import('../src/security/sessionStore.js');
const { runsRouter } = await import('../src/routes/runs.routes.js');
const { pruneExpiredArtifacts } = await import('../src/artifacts/artifactStore.js');
const { buildManifest, writeManifest, readManifest, verifyManifest } = await import('../src/evidence/manifest.js');
const { findJobDir } = await import('../src/evidence/locate.js');
const { pinnedEvidenceDir } = await import('../src/config/paths.js');
const { appendRun, getRun, pruneHistory, resetRunHistoryForTests } = await import('../src/history/runHistoryStore.js');

let server: http.Server;
let baseUrl: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(apiAuth);
  app.use('/v1/runs', runsRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const bearer = { authorization: `Bearer ${API_KEY}` };

async function call(method: string, urlPath: string, headers: Record<string, string>, body?: unknown) {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, json: text ? (JSON.parse(text) as Record<string, any>) : undefined };
}

/** Fabricates a finished job directory: result.json, a screenshot, a trace and a manifest. */
async function makeJob(jobId: string, retention: 'ephemeral' | 'standard' = 'ephemeral', traceBytes = 100): Promise<string> {
  const dir = path.join(env.ARTIFACT_DIR, jobId);
  fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ jobId, status: 'passed' }));
  fs.writeFileSync(path.join(dir, 'screenshots', 'home.png'), Buffer.from('not really a png'));
  fs.writeFileSync(path.join(dir, 'trace.zip'), Buffer.alloc(traceBytes, 7));
  await writeManifest(dir, await buildManifest(dir, jobId, retention));
  return dir;
}

test('every file of a job is in the manifest with its sha256; result.json is called out', async () => {
  const dir = await makeJob('job_manifest1');
  const stored = await readManifest(dir);

  assert.deepEqual(stored?.manifest.files.map((f) => f.path), ['result.json', 'screenshots/home.png', 'trace.zip']);
  assert.ok(stored?.manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));
  assert.equal(stored?.manifest.resultSha256, stored?.manifest.files.find((f) => f.path === 'result.json')?.sha256);
  assert.equal((await verifyManifest(dir, stored!.manifest)).ok, true);
});

test('changing 1 byte, deleting a file or adding one is detected', async () => {
  const dir = await makeJob('job_manifest2');
  const { manifest } = (await readManifest(dir))!;

  const png = path.join(dir, 'screenshots', 'home.png');
  const bytes = fs.readFileSync(png);
  bytes[0] = (bytes[0] ?? 0) ^ 0x01;
  fs.writeFileSync(png, bytes);
  assert.deepEqual((await verifyManifest(dir, manifest)).problems, [{ path: 'screenshots/home.png', problem: 'modified' }]);

  fs.rmSync(path.join(dir, 'trace.zip'));
  fs.writeFileSync(path.join(dir, 'extra.txt'), 'planted');
  const problems = (await verifyManifest(dir, manifest)).problems;
  assert.ok(problems.some((p) => p.path === 'trace.zip' && p.problem === 'missing'));
  assert.ok(problems.some((p) => p.path === 'extra.txt' && p.problem === 'unexpected'));
});

test('a manifest edited to point outside the job directory is a problem, not a read', async () => {
  const dir = await makeJob('job_manifest3');
  const { manifest } = (await readManifest(dir))!;
  const hostile = { ...manifest, files: [...manifest.files, { path: '../../outside.txt', bytes: 1, sha256: 'a'.repeat(64) }] };

  assert.ok((await verifyManifest(dir, hostile)).problems.some((p) => p.path === '../../outside.txt'));
});

test('prune honours the class: ephemeral after 4 h, standard after 30 d', async () => {
  const hour = 3600_000;
  const ephemeral = await makeJob('job_prune_eph', 'ephemeral');
  const standard = await makeJob('job_prune_std', 'standard');
  const legacy = path.join(env.ARTIFACT_DIR, 'job_prune_legacy');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'result.json'), '{}');

  await pruneExpiredArtifacts(env.ARTIFACT_DIR, Date.now() + 3 * hour);
  assert.ok([ephemeral, standard, legacy].every((dir) => fs.existsSync(dir)), 'nothing is old enough at +3 h');

  await pruneExpiredArtifacts(env.ARTIFACT_DIR, Date.now() + 5 * hour);
  assert.ok(!fs.existsSync(ephemeral), 'ephemeral gone at +5 h');
  assert.ok(!fs.existsSync(legacy), 'a job without a manifest is treated as ephemeral');
  assert.ok(fs.existsSync(standard), 'standard survives +5 h');

  await pruneExpiredArtifacts(env.ARTIFACT_DIR, Date.now() + 29 * 24 * hour);
  assert.ok(fs.existsSync(standard), 'standard survives +29 d');

  await pruneExpiredArtifacts(env.ARTIFACT_DIR, Date.now() + 31 * 24 * hour);
  assert.ok(!fs.existsSync(standard), 'standard gone at +31 d');
});

test('a pinned job survives the prune, even with the clock a year ahead', async () => {
  const dir = await makeJob('job_pinned1');
  const before = await call('POST', '/v1/runs/job_pinned1/pin', bearer, { reason: 'proof for REG-209', ref: 'npdev:REG-209' });
  assert.equal(before.status, 200, before.text);
  assert.equal(before.json?.traceDiscarded, true, 'trace is dropped by default');
  assert.equal(before.json?.integrityBaseline, 'run');

  assert.ok(!fs.existsSync(dir), 'moved out of the artifact root');
  const pinnedDir = path.join(pinnedEvidenceDir(), 'job_pinned1');
  assert.ok(fs.existsSync(path.join(pinnedDir, 'result.json')));
  assert.ok(!fs.existsSync(path.join(pinnedDir, 'trace.zip')));

  await pruneExpiredArtifacts(env.ARTIFACT_DIR, Date.now() + 365 * 24 * 3600_000);
  assert.ok(fs.existsSync(path.join(pinnedDir, 'result.json')), 'still there after prune');

  // The pinned manifest verifies, records the reason, and links to the manifest the run wrote.
  const { manifest } = (await readManifest(pinnedDir))!;
  assert.equal(manifest.retention, 'pinned');
  assert.equal(manifest.pin?.reason, 'proof for REG-209');
  assert.equal(manifest.pin?.ref, 'npdev:REG-209');
  assert.match(manifest.pin?.originalManifestSha256 ?? '', /^[0-9a-f]{64}$/);
  assert.equal((await verifyManifest(pinnedDir, manifest)).ok, true);

  // Served from the pinned store by the normal run endpoints.
  assert.equal(findJobDir('job_pinned1')?.location, 'pinned');
  const manifestResponse = await call('GET', '/v1/runs/job_pinned1/manifest', bearer);
  assert.equal(manifestResponse.json?.location, 'pinned');
  assert.equal(manifestResponse.json?.verification.ok, true);
  assert.equal((await fetch(`${baseUrl}/v1/runs/job_pinned1/artifacts/screenshots/home.png`, { headers: bearer })).status, 200);
});

test('pinning twice is idempotent; keepTrace keeps the trace', async () => {
  await makeJob('job_pinned2');
  const first = await call('POST', '/v1/runs/job_pinned2/pin', bearer, { reason: 'keep it', keepTrace: true });
  assert.equal(first.json?.traceDiscarded, false);
  assert.ok(fs.existsSync(path.join(pinnedEvidenceDir(), 'job_pinned2', 'trace.zip')));

  const second = await call('POST', '/v1/runs/job_pinned2/pin', bearer, { reason: 'again' });
  assert.equal(second.status, 200);
  assert.equal(second.json?.alreadyPinned, true);
  assert.equal(second.json?.traceDiscarded, false, 'the original pin is unchanged');
});

test('pin needs the bearer token, a reason and a job that exists', async () => {
  await makeJob('job_pinned3');
  const { token } = createSession();
  const session = { cookie: `${SESSION_COOKIE_NAME}=${token}`, [UI_REQUEST_HEADER]: '1' };

  assert.equal((await call('POST', '/v1/runs/job_pinned3/pin', session, { reason: 'x' })).status, 403);
  assert.equal((await call('POST', '/v1/runs/job_pinned3/pin', bearer, {})).status, 400);
  assert.equal((await call('POST', '/v1/runs/job_pinned3/pin', bearer, { reason: 'x', keepTrace: 'yes' })).status, 400);
  assert.equal((await call('POST', '/v1/runs/job_nope/pin', bearer, { reason: 'x' })).status, 404);
  assert.equal((await call('POST', '/v1/runs/..%2F..%2Fetc/pin', bearer, { reason: 'x' })).status, 400, 'only job_<id> shaped ids are accepted');
  assert.ok(fs.existsSync(path.join(env.ARTIFACT_DIR, 'job_pinned3')), 'a refused pin leaves the job untouched');
});

test('tampered evidence is not pinned', async () => {
  const dir = await makeJob('job_tampered');
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ jobId: 'job_tampered', status: 'failed' }));

  const response = await call('POST', '/v1/runs/job_tampered/pin', bearer, { reason: 'x' });
  assert.equal(response.status, 409);
  assert.equal(response.json?.error.type, 'EvidenceIntegrityError');
  assert.deepEqual(response.json?.error.details, [{ path: 'result.json', problem: 'modified' }]);
  assert.ok(fs.existsSync(dir), 'and the source is untouched');
  assert.ok(!fs.existsSync(path.join(pinnedEvidenceDir(), 'job_tampered')));
});

test('a job without a manifest can be pinned; the baseline is then the pin itself', async () => {
  const dir = path.join(env.ARTIFACT_DIR, 'job_legacy1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'result.json'), '{"status":"passed"}');

  const response = await call('POST', '/v1/runs/job_legacy1/pin', bearer, { reason: 'old run' });
  assert.equal(response.status, 200);
  assert.equal(response.json?.integrityBaseline, 'pin');
});

test('over quota: 409, nothing deleted, nothing half-pinned', async () => {
  // PINNED_EVIDENCE_MAX_MB is 1. Earlier tests pinned a few KB; this job alone is ~1.5 MB.
  const big = await makeJob('job_big1', 'ephemeral', 1_500_000);
  const alreadyPinned = fs.readdirSync(pinnedEvidenceDir()).sort();

  const response = await call('POST', '/v1/runs/job_big1/pin', bearer, { reason: 'too big', keepTrace: true });
  assert.equal(response.status, 409);
  assert.equal(response.json?.error.type, 'PinnedQuotaExceeded');

  assert.ok(fs.existsSync(path.join(big, 'trace.zip')), 'the source still has every file');
  assert.deepEqual(fs.readdirSync(pinnedEvidenceDir()).sort(), alreadyPinned, 'no partial directory, and no pinned job removed');

  // The same job fits once its heavy trace is dropped (the default), proving the quota counts what is kept.
  const slim = await call('POST', '/v1/runs/job_big1/pin', bearer, { reason: 'without trace' });
  assert.equal(slim.status, 200, slim.text);
});

test('pinned runs keep their history entry past the age cap; others do not', async () => {
  resetRunHistoryForTests();
  const old = '2000-01-01T00:00:00.000Z';
  const summary = (jobId: string) => ({
    jobId, status: 'passed' as const, startedAt: old, finishedAt: old, durationMs: 1, targetUrl: 'https://dev.example.com/',
    stepCount: 1, passedSteps: 1, failedSteps: 0, skippedSteps: 0, screenshotCount: 0, consoleErrorCount: 0,
    networkFailureCount: 0, unexpectedExternalRequestCount: 0, retention: 'ephemeral' as const, pinned: false, artifactRelativeRoot: `artifacts/${jobId}`,
  });

  await appendRun(summary('job_hist_old'));
  await appendRun(summary('job_hist_pinned'));
  const { markRunPinned } = await import('../src/history/runHistoryStore.js');
  await markRunPinned('job_hist_pinned', 'npdev:REG-1');

  const result = await pruneHistory();
  assert.equal(result.removed, 1);
  assert.equal(await getRun('job_hist_old'), undefined);
  assert.equal((await getRun('job_hist_pinned'))?.pinned, true);
  assert.equal((await getRun('job_hist_pinned'))?.pinRef, 'npdev:REG-1');

  // And the pin survives a restart (the file was rewritten, not just the in-memory copy).
  resetRunHistoryForTests();
  assert.equal((await getRun('job_hist_pinned'))?.retention, 'pinned');
});
