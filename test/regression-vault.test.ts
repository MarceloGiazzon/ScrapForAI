import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const API_KEY = 'test-api-key-1234567890';
const ORIGIN = 'https://dev.example.com';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-vault-reg-test-'));
process.env.SCRAPFORAI_API_KEY = API_KEY;
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts'); // .env may pin it
process.env.ALLOWED_TARGET_ORIGINS = ORIGIN;
process.env.ALLOWED_RESOURCE_ORIGINS = ORIGIN;
delete process.env.REGRESSION_VAULT_DIR;

const express = (await import('express')).default;
const { apiAuth } = await import('../src/security/apiAuth.js');
const { vaultRouter } = await import('../src/routes/vault.routes.js');
const { saveTarget } = await import('../src/targets/targetStore.js');
const { saveRoutine } = await import('../src/library/routineService.js');
const { orderByImpact } = await import('../src/vault/regression/impact.js');
const { listItems, saveItem, getItem, recordLastRun } = await import('../src/vault/regression/regressionVault.js');
const { appendRun, resetRunHistoryForTests } = await import('../src/history/runHistoryStore.js');
const { matchesGlob, globToRegExp } = await import('../src/util/glob.js');
const { regressionItemSchema, regressionItemWriteSchema } = await import('../src/schemas/regressionItem.schema.js');

let server: http.Server;
let baseUrl: string;
const bearer = { authorization: `Bearer ${API_KEY}` };

async function call(method: string, urlPath: string, body?: unknown, headers: Record<string, string> = bearer) {
  const response = await fetch(`${baseUrl}${urlPath}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as Record<string, any>) : undefined };
}

const definition = (over: Record<string, unknown> = {}) => ({
  title: 'Total is wrong', type: 'BUG', severity: 'HIGH', status: 'ACTIVE', surface: 'inventory', tags: ['smoke'],
  routine: { id: 'r-inv', version: 1 }, redNotCapturedReason: 'legacy: found before the vault existed', ...over,
});

before(async () => {
  await saveTarget({
    id: 'app-dev', name: 'App', platform: 'generic', environment: 'dev', baseUrl: ORIGIN, credentialSets: [],
    noiseFilters: [], surfaces: { inventory: ['src/inventory/**', 'web/inv*.ts'], billing: ['src/billing/**'] }, screens: [],
    flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  });
  const steps = [{ id: 'open', action: 'goto', url: '$targetUrl' }] as never;
  for (const id of ['r-inv', 'r-bill', 'r-misc', 'r-other']) await saveRoutine(id, { title: id, targetProfile: 'app-dev', steps });

  const app = express();
  app.use(express.json());
  app.use(apiAuth);
  app.use('/v1/vault', vaultRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('glob: * stays inside a directory, ** crosses them, ? is one character, separators are normalized', () => {
  assert.equal(matchesGlob('src/inventory/a/b.ts', 'src/inventory/**'), true);
  assert.equal(matchesGlob('src/inventory/a.ts', 'src/inventory/*.ts'), true);
  assert.equal(matchesGlob('src/inventory/a/b.ts', 'src/inventory/*.ts'), false);
  assert.equal(matchesGlob('src/inventory', 'src/inventory/**'), false, 'the directory itself is not a file under it');
  assert.equal(matchesGlob('a/b/c.ts', '**/c.ts'), true);
  assert.equal(matchesGlob('c.ts', '**/c.ts'), true, '**/ matches zero directories');
  assert.equal(matchesGlob('x.ts', '?.ts'), true);
  assert.equal(matchesGlob('xy.ts', '?.ts'), false);
  assert.equal(matchesGlob('.\\src\\inventory\\a.ts', 'src/inventory/*.ts'), true, 'Windows paths and a leading ./ are normalized');
  assert.equal(matchesGlob('src/inventoryX/a.ts', 'src/inventory/**'), false);
  assert.equal(matchesGlob('a.ts', 'a.ts'), true);
  assert.equal(matchesGlob('a+b(1).ts', 'a+b(1).ts'), true, 'regex metacharacters are literal');
  assert.ok(globToRegExp('**').test('anything/at/all'));
});

test('an item needs a proper id, and a RED or a reason why there is none', () => {
  const base = { ...definition(), id: 'REG-209', opened: '2026-11-02', provenRed: null, firstGreen: null };
  assert.equal(regressionItemSchema.safeParse(base).success, true);
  assert.equal(regressionItemSchema.safeParse({ ...base, redNotCapturedReason: undefined }).success, false, 'null provenRed without a reason');
  assert.equal(regressionItemSchema.safeParse({ ...base, id: 'reg-209' }).success, false);
  assert.equal(regressionItemSchema.safeParse({ ...base, id: 'REG209' }).success, false);
  assert.equal(regressionItemSchema.safeParse({ ...base, severity: 'URGENT' }).success, false);
  assert.equal(regressionItemSchema.safeParse({ ...base, unknown: 1 }).success, false);

  for (const forged of ['provenRed', 'firstGreen', 'lastRun', 'id']) {
    assert.equal(regressionItemWriteSchema.safeParse({ ...definition(), [forged]: {} }).success, false, `${forged} cannot be written by hand`);
  }
});

test('PUT creates and updates the definition; evidence fields are kept and cannot be forged', async () => {
  const created = await call('PUT', '/v1/vault/GX-12', definition());
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json?.provenRed, null);
  assert.equal(created.json?.firstGreen, null);
  assert.match(created.json?.opened, /^\d{4}-\d{2}-\d{2}$/);

  const forged = await call('PUT', '/v1/vault/GX-12', { ...definition(), firstGreen: { jobId: 'job_x', at: 'now', manifestSha256: 'a'.repeat(64) } });
  assert.equal(forged.status, 400);

  await recordLastRun('GX-12', { jobId: 'job_run1', status: 'failed', at: '2026-11-02T10:00:00Z' });
  const updated = await call('PUT', '/v1/vault/GX-12', definition({ title: 'Total is wrong (retitled)', severity: 'P0' }));
  assert.equal(updated.status, 200);
  assert.equal(updated.json?.title, 'Total is wrong (retitled)');
  assert.equal(updated.json?.lastRun?.jobId, 'job_run1', 'evidence survives an edit of the definition');
  assert.equal(updated.json?.opened, created.json?.opened, 'opened date is kept');
});

test('PUT validates: routine must exist, a missing RED needs a reason, bad ids', async () => {
  assert.equal((await call('PUT', '/v1/vault/GX-13', definition({ routine: { id: 'nope', version: 1 } }))).json?.error.type, 'RoutineNotFound');
  assert.equal((await call('PUT', '/v1/vault/GX-13', definition({ routine: { id: 'r-inv', version: 9 } }))).status, 404);
  assert.equal((await call('PUT', '/v1/vault/GX-13', definition({ redNotCapturedReason: undefined }))).status, 400, 'no provenRed and no reason');
  assert.equal((await call('PUT', '/v1/vault/bad-id', definition())).status, 400);
  assert.equal((await call('GET', '/v1/vault/lower-1')).status, 404);
});

test('writes need the bearer token; reads and runs do not', async () => {
  const noAuth = await call('PUT', '/v1/vault/GX-14', definition(), {});
  assert.equal(noAuth.status, 401);
  assert.equal((await call('POST', '/v1/vault/add-from-run', {}, {})).status, 401);
  assert.equal((await call('GET', '/v1/vault/GX-12')).status, 200);
});

test('list filters by status/tags/surface/type; export is sorted and deterministic', async () => {
  await call('PUT', '/v1/vault/GX-2', definition({ surface: 'billing', tags: ['smoke', 'money'], routine: { id: 'r-bill', version: 1 } }));
  await call('PUT', '/v1/vault/GX-100', definition({ status: 'QUARANTINED', type: 'SCENARIO', routine: { id: 'r-misc', version: 1 } }));

  const ids = async (q: string) => ((await call('GET', `/v1/vault${q}`)).json?.items as Array<{ id: string }>).map((i) => i.id);
  assert.deepEqual(await ids(''), ['GX-2', 'GX-12', 'GX-100'], 'numeric-aware order, not lexicographic');
  assert.deepEqual(await ids('?status=ACTIVE'), ['GX-2', 'GX-12']);
  assert.deepEqual(await ids('?tags=money'), ['GX-2']);
  assert.deepEqual(await ids('?tags=smoke,money'), ['GX-2'], 'all tags must match');
  assert.deepEqual(await ids('?surface=inventory'), ['GX-12', 'GX-100']);
  assert.deepEqual(await ids('?type=SCENARIO'), ['GX-100']);
  assert.equal((await call('GET', '/v1/vault?status=WRONG')).status, 400);

  const first = (await call('GET', '/v1/vault/export')).json!;
  const second = (await call('GET', '/v1/vault/export')).json!;
  assert.equal(first.count, 3);
  assert.deepEqual(first.items, second.items);
  assert.deepEqual(first.items.map((i: { id: string }) => i.id), ['GX-2', 'GX-12', 'GX-100']);
});

async function seedOutcomes(routineId: string, outcomes: Array<'passed' | 'failed'>) {
  for (const status of outcomes) {
    await appendRun({
      jobId: `job_${routineId}_${Math.random().toString(36).slice(2, 8)}`, status, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 1,
      targetUrl: `${ORIGIN}/`, stepCount: 1, passedSteps: 1, failedSteps: 0, skippedSteps: 0, screenshotCount: 0, consoleErrorCount: 0, networkFailureCount: 0,
      unexpectedExternalRequestCount: 0, retention: 'ephemeral', pinned: false, routineId, routineVersion: 1, artifactRelativeRoot: 'artifacts/x',
    });
  }
}

test('impact order: surface hit > recent failures > severity > the rest, each with its reason', async () => {
  resetRunHistoryForTests();
  const mk = (id: string, over: Record<string, unknown>) => saveItem(id, { ...definition(), ...over } as never);
  await mk('IMP-1', { title: 'quiet', surface: 'misc', severity: null, routine: { id: 'r-misc', version: 1 } });
  await mk('IMP-2', { title: 'severe but untouched', surface: 'misc2', severity: 'P0', routine: { id: 'r-other', version: 1 } });
  await mk('IMP-3', { title: 'billing', surface: 'billing', severity: 'LOW', routine: { id: 'r-bill', version: 1 } });
  await mk('IMP-4', { title: 'inventory', surface: 'inventory', severity: 'MEDIUM', routine: { id: 'r-inv', version: 1 } });
  await seedOutcomes('r-misc', ['passed', 'failed', 'failed']); // IMP-1 failed twice recently

  const items = (await listItems()).filter((i) => i.id.startsWith('IMP-'));
  const ordered = await orderByImpact(items, { changedFiles: ['./src/inventory/stock/level.ts', 'README.md'] });

  assert.deepEqual(ordered.map((o) => o.item.id), ['IMP-4', 'IMP-1', 'IMP-2', 'IMP-3']);
  assert.deepEqual(ordered.map((o) => o.position), [1, 2, 3, 4]);

  const reasons = (id: string) => ordered.find((o) => o.item.id === id)!.reasons.map((r) => `${r.rule}: ${r.detail}`).join(' | ');
  assert.match(reasons('IMP-4'), /surface: changed file src\/inventory\/stock\/level\.ts matches src\/inventory\/\*\* \(surface "inventory"\)/);
  assert.match(reasons('IMP-1'), /recent-failure: failed 2 of its last 3 run\(s\)/);
  assert.match(reasons('IMP-2'), /severity: severity P0/);
  assert.match(reasons('IMP-3'), /severity: severity LOW/);
  assert.match(reasons('IMP-4'), /awaiting-fix/, 'an item without firstGreen says a failure is expected');
});

test('impact order: explicit surfaces, no signal at all, and severity ties break by id', async () => {
  const items = (await listItems()).filter((i) => i.id.startsWith('IMP-'));

  const explicit = await orderByImpact(items, { surfaces: ['billing'] });
  assert.equal(explicit[0]!.item.id, 'IMP-3');
  assert.match(explicit[0]!.reasons[0]!.detail, /named explicitly/);

  fs.rmSync(path.join(dataDir, 'history', 'runs.jsonl'), { force: true });
  resetRunHistoryForTests(); // forget the failures (memory and disk)
  const none = await orderByImpact(items, {});
  assert.deepEqual(none.map((o) => o.item.id), ['IMP-2', 'IMP-4', 'IMP-3', 'IMP-1'], 'only severity applies: P0, MEDIUM, LOW, none');
  assert.ok(none.at(-1)!.reasons.some((r) => r.rule === 'rest'));
});

test('POST /v1/vault/plan shows the order and reasons without running anything', async () => {
  const response = await call('POST', '/v1/vault/plan', { changedFiles: ['src/billing/invoice.ts'], tags: ['smoke'] });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json?.order.slice(0, 2).map((entry: { id: string }) => entry.id), ['GX-2', 'IMP-3'], 'both billing items first, tie broken by id');
  assert.match(response.json?.order[0].reasons[0].detail, /src\/billing\/invoice\.ts matches src\/billing\/\*\*/);
  assert.equal((await call('POST', '/v1/vault/plan', { changedFiles: 'not-a-list' })).status, 400);
  assert.equal((await getItem('IMP-3'))?.lastRun, undefined, 'a plan runs nothing');
});
