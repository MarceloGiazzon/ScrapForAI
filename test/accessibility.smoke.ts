import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// T7.4 / T7.5 / T7.7 end to end (real Chromium, axe-core injected as a trusted script, ALLOW_EVALUATE off): a page with defects is audited, the
// result holds no value of the page, GeneXus row ids collapse to one target key, an evolution snapshot keeps the baseline, a later audit
// against it finds only what is new, `failOn: new` blocks only the regression, and the report says what to adjust in the user's language.

const SECRET_VALUE = 'typed-secret-value-7731';
const SECRET_IMAGE = 'private-photo-token-9912';

let regress = false; // customers gets an unlabeled input
let repaired = false; // customers loses its image without alt text

const page = (body: string, lang: string | null = 'en') =>
  `<!doctype html><html${lang ? ` lang="${lang}"` : ''}><head><meta charset="utf-8"><title>Fixture</title></head><body>${body}</body></html>`;

const PAGES: Record<string, () => string> = {
  '/good': () => page('<main><h1>Good</h1><label for="n">Name</label><input id="n"><button>Save</button></main>'),
  '/bad': () =>
    page(
      `<main><h1>Bad</h1><img src="/img/${SECRET_IMAGE}.png"><input id="u" value="${SECRET_VALUE}"><p style="color:#cccccc;background:#ffffff">Low contrast text</p>
       <div id="only"><button></button></div></main>`,
    ),
  '/grid': () =>
    page(`<main><h1>Grid</h1><div id="W0012wrap">${[1, 2, 3].map((n) => `<input id="vQTY_000${n}" value="${SECRET_VALUE}">`).join('')}</div></main>`),
  '/customers': () =>
    page(
      `<main><h1>Customers</h1><label for="name">Name</label><input id="name" value="${SECRET_VALUE}">
       ${repaired ? '' : `<img src="/img/${SECRET_IMAGE}.png">`}
       ${regress ? '<input id="phone">' : ''}</main>`,
    ),
  '/orders': () => page('<main><h1>Orders</h1><p>Nothing here.</p></main>'),
};

const site = await new Promise<{ server: http.Server; origin: string }>((resolve) => {
  const server = http.createServer((req, res) => {
    const render = PAGES[new URL(req.url ?? '/', 'http://x').pathname];
    res.statusCode = render ? 200 : 404;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(render ? render() : 'not found');
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-a11y-smoke-'));
const evolutionDir = path.join(dataDir, 'evolution');
fs.mkdirSync(evolutionDir);
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.SYSTEM_EVOLUTION_DIR = evolutionDir;
process.env.ALLOWED_TARGET_ORIGINS = site.origin;
process.env.ALLOWED_RESOURCE_ORIGINS = site.origin;
delete process.env.ALLOW_EVALUATE;

const { saveTarget } = await import('../src/targets/targetStore.js');
const { saveRoutine, runLibraryRoutine } = await import('../src/library/routineService.js');
const { startSnapshot, waitForSnapshotRun } = await import('../src/evolution/snapshotRunner.js');
const { snapshotBodySchema } = await import('../src/schemas/evolution.schema.js');
const { diffBuilds, writeChanges } = await import('../src/evolution/evolutionService.js');
const { buildRunReport } = await import('../src/reports/buildReport.js');

after(async () => {
  await new Promise<void>((resolve) => site.server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

interface Finding {
  ruleId: string;
  impact: string;
  targetKey: string;
  target: string;
  help: string;
  wcag: string[];
}
interface Audit {
  kind: string;
  standard: string;
  axeVersion: string;
  findings: Finding[];
  counts: Record<string, number>;
  truncated: boolean;
  baseline?: { buildId: string; new: Finding[]; fixed: Finding[]; unchanged: number };
}

const auditStep = (extra: Record<string, unknown> = {}) => ({ id: 'audit', action: 'auditAccessibility', name: 'a11y', ...extra });

async function audit(routineId: string, pagePath: string, extra: Record<string, unknown> = {}) {
  await saveRoutine(routineId, {
    title: routineId,
    targetProfile: 'a11y',
    steps: [{ id: 'open', action: 'goto', url: `${site.origin}${pagePath}` }, auditStep(extra)] as never,
  });
  const result = await runLibraryRoutine(routineId, undefined, {});
  return { result, audit: result.extracted.a11y as unknown as Audit | undefined };
}

const ruleIds = (found: Audit | undefined): string[] => [...new Set(found!.findings.map((finding) => finding.ruleId))].sort();

test('setup: the target profile with a two-screen catalogue', async () => {
  await saveTarget({
    id: 'a11y', name: 'Accessibility fixture', platform: 'generic', environment: 'dev', baseUrl: `${site.origin}/`, credentialSets: [],
    noiseFilters: [], surfaces: {}, flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
    screens: [
      { id: 'customers', name: 'Customers', reach: { url: '/customers' } },
      { id: 'orders', name: 'Orders', reach: { url: '/orders' } },
    ],
  } as never);
});

test('a good page has no violations; a page with defects names them, with no value from the page', async () => {
  const good = await audit('a11y-good', '/good');
  assert.equal(good.result.status, 'passed', JSON.stringify(good.result.error));
  assert.equal(good.audit!.kind, 'accessibility-audit');
  assert.equal(good.audit!.standard, 'wcag2aa');
  assert.match(good.audit!.axeVersion, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(good.audit!.findings, []);

  const bad = await audit('a11y-bad', '/bad');
  assert.equal(bad.result.status, 'passed', 'the default failOn is none: the step only records');
  assert.deepEqual(ruleIds(bad.audit), ['button-name', 'color-contrast', 'image-alt', 'label']);
  const image = bad.audit!.findings.find((finding) => finding.ruleId === 'image-alt')!;
  assert.equal(image.impact, 'critical');
  assert.deepEqual(image.wcag, ['1.1.1']);
  assert.equal(image.target, 'img');
  assert.equal(bad.audit!.counts.elements, bad.audit!.findings.length);

  // The audit is what is under test: the network evidence of the run legitimately names the image URL it asked for.
  const extracted = JSON.stringify(bad.result.extracted);
  assert.ok(!extracted.includes(SECRET_VALUE), 'the value of a field never reaches the result');
  assert.ok(!extracted.includes(SECRET_IMAGE), 'neither does the html of an element (the image source)');
});

test('GeneXus names: grid rows and web component prefixes collapse to one target key, rows told apart as key, key#2', async () => {
  const grid = await audit('a11y-grid', '/grid');
  const labels = grid.audit!.findings.filter((finding) => finding.ruleId === 'label');
  assert.deepEqual(labels.map((finding) => finding.targetKey), ['#vQTY', '#vQTY#2', '#vQTY#3']);
  assert.deepEqual(labels.map((finding) => finding.target), ['#vQTY_0001', '#vQTY_0002', '#vQTY_0003']);
});

test('failOn, rules and scope', async () => {
  const any = await audit('a11y-any', '/bad', { failOn: 'any' });
  assert.equal(any.result.status, 'failed');
  assert.match(any.result.error?.message ?? '', /auditAccessibility: \d+ accessibility violation\(s\) in 4 rule\(s\)/);
  assert.ok(any.audit, 'the audit is kept even when the step fails');

  const serious = await audit('a11y-serious', '/bad', { failOn: 'serious' });
  assert.match(serious.result.error?.message ?? '', /serious or critical/);
  assert.equal((await audit('a11y-good-any', '/good', { failOn: 'any' })).result.status, 'passed');

  const only = await audit('a11y-rules', '/bad', { rules: ['image-alt'] });
  assert.deepEqual(ruleIds(only.audit), ['image-alt']);

  const scoped = await audit('a11y-scope', '/bad', { scope: '#only' });
  assert.deepEqual(ruleIds(scoped.audit), ['button-name']);
  assert.equal((scoped.audit as unknown as { scope: string }).scope, '#only');

  const missing = await audit('a11y-noscope', '/bad', { scope: '#nowhere' });
  assert.equal(missing.result.status, 'failed');
  assert.match(missing.result.error?.message ?? '', /scope selector matched nothing/);
});

test('a stricter level finds at least as much as a looser one', async () => {
  const a = await audit('a11y-std-a', '/bad', { standard: 'wcag2a' });
  const aa = await audit('a11y-std-aa', '/bad', { standard: 'wcag22aa' });
  assert.ok(aa.audit!.findings.length >= a.audit!.findings.length);
  assert.ok(!ruleIds(a.audit).includes('color-contrast'), 'contrast is level AA, so wcag2a does not ask for it');
  assert.ok(ruleIds(aa.audit).includes('color-contrast'));
});

async function snapshot(buildId: string) {
  const started = await startSnapshot(snapshotBodySchema.parse({ targetProfile: 'a11y', buildId, screenshots: false, accessibility: true, settleMs: 0 }));
  const state = await waitForSnapshotRun(started.snapshotId, 90_000);
  assert.equal(state!.status, 'completed', JSON.stringify(state));
  return state!;
}

test('a baseline without an accessibility snapshot says how to make one', async () => {
  const lost = await audit('a11y-nobase', '/customers', { baseline: { screen: 'customers' } });
  assert.equal(lost.result.status, 'failed');
  assert.match(lost.result.error?.message ?? '', /No snapshot of "a11y" has an accessibility baseline for screen "customers"/);
});

test('a snapshot keeps the accessibility of every screen as that build\'s baseline, with nothing the page holds', async () => {
  const state = await snapshot('rev-1');
  assert.deepEqual(state.warnings, []);
  assert.ok(state.screens.every((screen) => screen.accessibility), 'every screen has its counts');
  assert.equal(state.screens.find((screen) => screen.screenId === 'customers')!.accessibility!.rules, 1);
  assert.equal(state.screens.find((screen) => screen.screenId === 'orders')!.accessibility!.elements, 0);

  const folder = path.join(evolutionDir, state.folder!);
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'snapshot.json'), 'utf8'));
  assert.equal(manifest.accessibility.standard, 'wcag2aa');
  assert.match(manifest.screens.find((screen: { id: string }) => screen.id === 'customers').accessibilitySha256, /^[0-9a-f]{64}$/);
  const stored = fs.readFileSync(path.join(folder, 'screens', 'customers.a11y.json'), 'utf8');
  assert.ok(!stored.includes(SECRET_VALUE) && !stored.includes(SECRET_IMAGE));
});

let regressionJobId = '';

test('after a regression: the audit against the baseline lists only the new violation, and failOn new blocks it', async () => {
  regress = true;
  const recorded = await audit('a11y-vs-base', '/customers', { baseline: { screen: 'customers', build: 'rev-1' } });
  assert.equal(recorded.result.status, 'passed', 'without failOn the comparison is information');
  assert.equal(recorded.audit!.baseline!.buildId, 'rev-1');
  assert.deepEqual(recorded.audit!.baseline!.new.map((finding) => `${finding.ruleId} ${finding.targetKey}`), ['label #phone']);
  assert.deepEqual(recorded.audit!.baseline!.fixed, []);
  assert.equal(recorded.audit!.baseline!.unchanged, 1, 'the image without alt was already in the baseline');

  const blocked = await audit('a11y-gate', '/customers', { baseline: { screen: 'customers', build: 'rev-1' }, failOn: 'new' });
  assert.equal(blocked.result.status, 'failed');
  assert.match(blocked.result.error?.message ?? '', /1 new accessibility violation\(s\) since the baseline \(label\)/);
  regressionJobId = blocked.result.jobId;
});

test('the run report shows what is new in the reader\'s language, with what to adjust, and not the old violation', async () => {
  const pt = await buildRunReport(regressionJobId, 'pt');
  assert.match(pt, /Acessibilidade/);
  assert.match(pt, /Novas desde a linha de base \(1\)/);
  assert.match(pt, /#phone/);
  assert.match(pt, /Label Position/, 'the platform note for a field without a label');
  assert.ok(!pt.includes('image-alt'), 'a violation that was already in the baseline is not repeated');
  assert.ok(!pt.includes(SECRET_VALUE));

  const en = await buildRunReport(regressionJobId, 'en');
  assert.match(en, /New since the baseline \(1\)/);
});

test('a repaired and a regressed build, compared: new and fixed per screen, in CHANGES.md', async () => {
  repaired = true; // the image now has no violation; the unlabeled phone input is still there
  await snapshot('rev-2');

  const { diff } = await diffBuilds('a11y', 'rev-1', 'rev-2');
  assert.deepEqual(diff.accessibility, { screensCompared: 2, new: 1, fixed: 1, notComparable: 0 });
  assert.equal(diff.counts.changes, 1, 'the structural diff sees only the new Phone field; the accessibility changes are not mixed into its counts');

  const { file } = await writeChanges('a11y', { from: 'rev-1', to: 'rev-2' });
  const text = fs.readFileSync(path.join(evolutionDir, ...file.split('/')), 'utf8');
  assert.match(text, /Accessibility: 1 new violation\(s\), 1 fixed/);
  assert.match(text, /\*\*NEW\*\* \[\w+\] label at `#phone`/);
  assert.match(text, /fixed \[critical\] image-alt at `img`/);
});

test('against the newest baseline the page is clean again: failOn new passes', async () => {
  const gate = await audit('a11y-gate-2', '/customers', { baseline: { screen: 'customers' }, failOn: 'new' });
  assert.equal(gate.result.status, 'passed', JSON.stringify(gate.result.error));
  assert.equal(gate.audit!.baseline!.buildId, 'rev-2');
  assert.deepEqual(gate.audit!.baseline!.new, []);

  // and the old build is still there to ask for
  const old = await audit('a11y-gate-old', '/customers', { baseline: { screen: 'customers', build: 'rev-1' }, failOn: 'new' });
  assert.equal(old.result.status, 'failed');
});
