import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// T9.4: the executive service over real stores on disk (target profiles, library, perf series, vault, pinned and signed manifests) and the route. No browser.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-executive-test-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';
process.env.SCHEDULER_ENABLED = 'false';

const { getExecutive } = await import('../src/executive/executiveService.js');
const { executiveRouter } = await import('../src/routes/executive.routes.js');
const { appendPerfRecord } = await import('../src/metrics/perfStore.js');
const { saveTarget } = await import('../src/targets/targetStore.js');
const { saveRoutine } = await import('../src/library/routineService.js');
const { saveItem, setFirstGreen, recordLastRun } = await import('../src/vault/regression/regressionVault.js');
const { pinnedEvidenceDir } = await import('../src/config/paths.js');
const { writeManifest } = await import('../src/evidence/manifest.js');
const { signManifest } = await import('../src/evidence/signature.js');
const { loadSigningKey, readPublicKeyIfPresent } = await import('../src/evidence/signingKey.js');
const { default: express } = await import('express');

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const DAY_MS = 24 * 60 * 60_000;
const at = (daysAgo: number): string => new Date(Date.now() - daysAgo * DAY_MS).toISOString();

const profile = (id: string, name: string) => ({
  id, name, platform: 'generic' as const, environment: 'dev' as const, baseUrl: 'https://dev.example.com', credentialSets: [],
  noiseFilters: [], surfaces: {}, screens: [], flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
});

let counter = 0;
const record = (daysAgo: number, status: 'passed' | 'failed', buildId: string) => {
  counter += 1;
  return {
    jobId: `job_${counter}`,
    at: at(daysAgo),
    version: 1,
    profile: 'full' as const,
    env: 'https://dev.example.com',
    buildId,
    status,
    durationMs: 1000,
    steps: [{ id: 'open', durationMs: 500, status: status === 'passed' ? ('passed' as const) : ('failed' as const) }],
  };
};

/** A pinned manifest as `pin` writes it: context, chain position, pin block and an Ed25519 signature. */
async function writePinned(jobId: string, routineId: string, buildId: string, sequence: number, options: { tamper?: boolean } = {}): Promise<void> {
  const key = await loadSigningKey();
  const dir = path.join(pinnedEvidenceDir(), jobId);
  fs.mkdirSync(dir, { recursive: true });
  const signed = signManifest(
    {
      version: 1 as const,
      jobId,
      createdAt: at(1),
      retention: 'pinned' as const,
      resultSha256: 'a'.repeat(64),
      files: [],
      context: { buildId, routine: { id: routineId, version: 1, sha256: 'b'.repeat(64) }, status: 'passed' as const },
      chain: { sequence, previousManifestSha256: null },
      pin: { pinnedAt: at(1), reason: 'homologation', keepTrace: false, traceDiscarded: true, integrityBaseline: 'run' as const },
    },
    key.privateKeyPem,
    key.publicKeyPem,
  );
  const stored = options.tamper ? { ...signed, pin: { ...signed.pin, reason: 'edited after signing' } } : signed;
  await writeManifest(dir, stored as never);
}

test('an empty installation: no systems, no counts, and reading it never creates a signing key', async () => {
  assert.equal(await readPublicKeyIfPresent(), undefined);
  const report = await getExecutive();
  assert.equal(report.kind, 'scrapforai-executive');
  assert.equal(report.totals.systems, 0);
  assert.equal(report.totals.tests.runs, 0);
  assert.equal(report.totals.tests.passRate, null);
  assert.equal(report.trend.direction, 'unknown');
  assert.equal(report.trend.weekly.length, 8);
  assert.equal(fs.existsSync(path.join(dataDir, 'signing', 'ed25519.key')), false, 'a read-only view must not create the installation key');
  assert.equal(await readPublicKeyIfPresent(), undefined);
});

test('getExecutive reads systems, runs, regressions, guarded bugs and signed evidence from what is on disk', async () => {
  await saveTarget(profile('app-dev', 'App <b>dev</b>'));
  await saveTarget(profile('app-qa', 'App QA'));
  const steps = [{ id: 'open', action: 'goto', url: '$targetUrl' }] as never;
  await saveRoutine('login', { title: 'login', targetProfile: 'app-dev', steps });
  await saveRoutine('checkout', { title: 'checkout', targetProfile: 'app-dev', steps });
  await saveRoutine('parked', { title: 'parked', targetProfile: 'app-dev', steps, status: 'quarantined' });
  await saveRoutine('qa-smoke', { title: 'qa smoke', targetProfile: 'app-qa', steps });

  // login broke on r2 nine days ago and was fixed the next day; checkout is steady; parked fails but is quarantined.
  for (const item of [record(20, 'passed', 'r1'), record(15, 'passed', 'r1'), record(9, 'failed', 'r2'), record(8, 'passed', 'r2'), record(1, 'passed', 'r2')]) await appendPerfRecord('login', item);
  for (const item of [record(5, 'passed', 'r1'), record(1, 'passed', 'r2')]) await appendPerfRecord('checkout', item);
  for (const item of [record(5, 'passed', 'r2'), record(4, 'failed', 'r2')]) await appendPerfRecord('parked', item);
  await appendPerfRecord('qa-smoke', record(1, 'passed', 'r7'));

  await saveItem('REG-1', { title: 'cart total', type: 'BUG', severity: 'HIGH', status: 'ACTIVE', surface: 'cart', tags: [], routine: { id: 'login', version: 1 }, opened: '2026-10-01', redNotCapturedReason: 'fixture' } as never);
  await setFirstGreen('REG-1', { jobId: 'job_green', at: at(8), buildId: 'r2', manifestSha256: 'c'.repeat(64) });
  await recordLastRun('REG-1', { jobId: 'job_vault', status: 'passed', at: at(1), buildId: 'r2' });

  // A good pin of login on r2; a pin of checkout on r2 whose manifest was edited after signing; a pin of login on the older build.
  await writePinned('job_pin_good', 'login', 'r2', 1);
  await writePinned('job_pin_edited', 'checkout', 'r2', 2, { tamper: true });
  await writePinned('job_pin_old', 'login', 'r1', 3);

  const report = await getExecutive({ days: 30, weeks: 8 });
  assert.equal(report.totals.systems, 2);
  const dev = report.systems.find((system) => system.id === 'app-dev')!;
  const qa = report.systems.find((system) => system.id === 'app-qa')!;

  assert.equal(dev.name, 'App <b>dev</b>', 'data is returned as it is; the page shows it as text');
  assert.equal(dev.tests.routines, 2);
  assert.equal(dev.tests.quarantined, 1);
  assert.equal(dev.tests.vaultItems, 1);
  assert.equal(dev.tests.guardedBugs, 1);
  assert.equal(dev.tests.runs, 7, 'login x5 and checkout x2; the quarantined routine is not counted');
  assert.equal(dev.tests.failed, 1);
  assert.equal(dev.tests.passRate, 0.8571);

  assert.deepEqual({ caught: dev.regressions.caught, resolved: dev.regressions.resolved, open: dev.regressions.open }, { caught: 1, resolved: 1, open: 0 });
  assert.equal(dev.regressions.recent[0]!.routineId, 'login');
  assert.equal(dev.regressions.recent[0]!.build, 'r2');
  assert.equal(dev.regressions.recent[0]!.previousBuild, 'r1');

  assert.equal(dev.homologation.status, 'ready', 'a quarantined test that fails does not block');
  assert.equal(dev.homologation.build, 'r2');
  assert.deepEqual([dev.homologation.passed, dev.homologation.total], [3, 3], 'two routines and the vault item');
  assert.deepEqual(dev.homologation.evidence, { runs: 1, tests: 1 }, 'only the pin whose signature checks: the edited one and the older build do not count');

  assert.equal(qa.homologation.status, 'ready');
  assert.equal(qa.homologation.build, 'r7');
  assert.deepEqual(qa.homologation.evidence, { runs: 0, tests: 0 });

  assert.deepEqual(report.totals.readiness, { ready: 2, blocked: 0, incomplete: 0, 'no-data': 0 });
  assert.equal(report.totals.tests.guardedBugs, 1);
  assert.ok(await readPublicKeyIfPresent(), 'the key exists now because the test signed with it');
});

test('a quarantine suggestion makes a routine "unstable": its pass -> fail changes are not claimed as regressions', async () => {
  await saveRoutine('wobbly', { title: 'wobbly', targetProfile: 'app-qa', steps: [{ id: 'open', action: 'goto', url: '$targetUrl' }] as never });
  // Alternating results over the last two weeks: T3.5 flags it flaky.
  for (let index = 0; index < 14; index += 1) await appendPerfRecord('wobbly', record(14 - index, index % 2 === 0 ? 'passed' : 'failed', 'r7'));
  const report = await getExecutive();
  const qa = report.systems.find((system) => system.id === 'app-qa')!;
  assert.equal(qa.regressions.caught, 0);
  assert.ok(qa.regressions.unstable >= 5, `unstable changes: ${qa.regressions.unstable}`);
});

test('GET /v1/executive answers the report; days, weeks and target are validated; an unknown target is 404', async () => {
  const app = express();
  app.use('/v1/executive', executiveRouter);
  const server = app.listen(0);
  try {
    const { port } = server.address() as { port: number };
    const base = `http://127.0.0.1:${port}/v1/executive`;

    const all = (await (await fetch(base)).json()) as { kind: string; period: { days: number }; weeks: number; systems: Array<{ id: string }>; totals: { systems: number } };
    assert.equal(all.kind, 'scrapforai-executive');
    assert.equal(all.period.days, 30);
    assert.equal(all.weeks, 8);
    assert.equal(all.totals.systems, all.systems.length);

    const week = (await (await fetch(`${base}?days=7&weeks=4`)).json()) as { period: { days: number }; weeks: number };
    assert.deepEqual([week.period.days, week.weeks], [7, 4]);

    const one = (await (await fetch(`${base}?target=app-qa`)).json()) as { systems: Array<{ id: string }>; targets: string[] };
    assert.deepEqual(one.systems.map((system) => system.id), ['app-qa']);
    assert.deepEqual(one.targets, ['app-qa']);

    for (const bad of ['days=0', 'days=91', 'weeks=3', 'weeks=27', 'days=abc', 'colour=red']) {
      const response = await fetch(`${base}?${bad}`);
      assert.equal(response.status, 400, bad);
      assert.equal(((await response.json()) as { error: { type: string } }).error.type, 'InvalidQuery');
    }
    const missing = await fetch(`${base}?target=ghost`);
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as { error: { type: string } }).error.type, 'TargetProfileNotFound');
  } finally {
    server.close();
  }
});
