import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// T7.4 / T7.5 / T7.7 without a browser: normalizing an axe answer, comparing two audits, the step's schema, the baseline stored in an evolution
// snapshot (read back and verified), the report and CHANGES.md text, and the platform guidance table. test/accessibility.smoke.ts has the real Chromium.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-a11y-test-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.SYSTEM_EVOLUTION_DIR = path.join(dataDir, 'evolution');
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';
fs.mkdirSync(process.env.SYSTEM_EVOLUTION_DIR, { recursive: true });

const audit = await import('../src/a11y/audit.js');
const guidance = await import('../src/a11y/platformGuidance.js');
const { renderMappingDoc } = await import('../src/a11y/mappingDoc.js');
const { compileDiffConfig } = await import('../src/diff/normalizers.js');
const { accessibilityAuditSchema, accessibilityResultSchema, STANDARD_TAGS } = await import('../src/schemas/accessibility.schema.js');
const { explorationRequestSchema } = await import('../src/schemas/explorationRequest.schema.js');
const { snapshotBodySchema, snapshotManifestSchema } = await import('../src/schemas/evolution.schema.js');
const plan = await import('../src/evolution/snapshotPlan.js');
const store = await import('../src/evolution/snapshotStore.js');
const service = await import('../src/evolution/evolutionService.js');
const compare = await import('../src/evolution/compare.js');
const { renderRunReport, esc } = await import('../src/reports/render.js');
const { axeAuditSource, axeBundle, AXE_VERSION } = await import('../src/runner/trusted/scripts/axe.js');
const { TRUSTED_SCRIPTS, verifyTrustedScripts } = await import('../src/runner/trusted/registry.js');

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const normalizers = compileDiffConfig({});

const rawRule = (ruleId: string, targets: string[], over: Record<string, unknown> = {}) => ({
  ruleId,
  impact: 'serious',
  help: `help of ${ruleId}`,
  wcag: ['1.4.3'],
  total: targets.length,
  targets,
  ...over,
});
const answer = (violations: ReturnType<typeof rawRule>[], over: Record<string, unknown> = {}) => ({
  scopeFound: true,
  axeVersion: '4.14.0',
  violations,
  needsReview: [],
  passedRules: 30,
  truncated: false,
  ...over,
});
const audited = (violations: ReturnType<typeof rawRule>[], options: Record<string, unknown> = {}) =>
  audit.normalizeAxeAnswer(answer(violations), { standard: 'wcag2aa', ...options } as never);

// ---------------------------------------------------------------------------------------------------------------------
// target keys (T4.1 normalizers)

test('a selector is normalized inside its ids: GeneXus row suffix and web component prefix go, position stays', () => {
  assert.equal(audit.normalizeSelector('#vNAME_0001', normalizers), '#vNAME');
  assert.equal(audit.normalizeSelector('#W0012vNAME', normalizers), '#vNAME');
  assert.equal(audit.normalizeSelector('#W0012W0003vNAME_0004', normalizers), '#vNAME');
  assert.equal(audit.normalizeSelector('[id="W0012vTOTAL_0002"]', normalizers), '[id="vTOTAL"]');
  assert.equal(audit.normalizeSelector('table > tr:nth-child(3) > td:nth-child(2)', normalizers), 'table > tr:nth-child(3) > td:nth-child(2)');
  // not a row suffix: only an id that ENDS in four digits loses them, and a class is never touched
  assert.equal(audit.normalizeSelector('.grid_0001', normalizers), '.grid_0001');
});

test('the profile masks apply, and a profile can switch the GeneXus rules off', () => {
  const masked = compileDiffConfig({ maskPatterns: [{ pattern: 'session-\\d+', replacement: 'session-#' }] });
  assert.equal(audit.normalizeSelector('#session-8841 > a', masked), '#session-# > a');
  const plain = compileDiffConfig({ gridRowSuffix: false, webComponentPrefix: false });
  assert.equal(audit.normalizeSelector('#W0012vNAME_0001', plain), '#W0012vNAME_0001');
});

// ---------------------------------------------------------------------------------------------------------------------
// normalizing the axe answer

test('findings carry rule, impact, target key, help and WCAG; counts come from axe, not from the cut list', () => {
  const result = audited([rawRule('color-contrast', ['#vNAME_0001', '.btn']), rawRule('image-alt', ['img:nth-child(2)'], { impact: 'critical', wcag: ['1.1.1'] })]);
  assert.deepEqual(accessibilityAuditSchema.parse(result), result, 'the result obeys its own schema');
  assert.deepEqual(result.findings.map((f) => `${f.ruleId} ${f.targetKey}`), ['color-contrast #vNAME', 'color-contrast .btn', 'image-alt img:nth-child(2)'], 'sorted by rule, then target');
  assert.deepEqual(result.counts, { rules: 2, elements: 3, critical: 1, serious: 2, moderate: 0, minor: 0 });
  assert.equal(result.findings[0]!.target, '#vNAME_0001', 'the raw selector is kept for a person to find the element');
  assert.equal(result.truncated, false);
});

test('grid rows that normalize alike stay separate findings: key, key#2, key#3', () => {
  const result = audited([rawRule('label', ['#vQTY_0001', '#vQTY_0002', '#vQTY_0003'])]);
  assert.deepEqual(result.findings.map((f) => f.targetKey), ['#vQTY', '#vQTY#2', '#vQTY#3']);
});

test('an unknown impact is minor, a rules filter keeps only those rules, and the scope is recorded', () => {
  const result = audited([rawRule('label', ['#a'], { impact: null as never }), rawRule('image-alt', ['#b'])], { rules: ['image-alt'], scope: '#main' });
  assert.deepEqual(result.findings.map((f) => f.ruleId), ['image-alt']);
  assert.equal(result.scope, '#main');
  assert.ok(result.notes.some((note) => note.includes('#main')));
  assert.ok(result.notes.some((note) => note.includes('image-alt')));
});

test('a cut list says so: totals stay complete, the flag is set, and the note counts', () => {
  const result = audit.normalizeAxeAnswer(
    answer([rawRule('color-contrast', ['#a', '#b'], { total: 40 })], { truncated: true }),
    { standard: 'wcag2aa' },
  );
  assert.equal(result.counts.elements, 40);
  assert.equal(result.findings.length, 2);
  assert.equal(result.truncated, true);
  assert.match(result.notes[0]!, /2 of 40/);
});

test('nothing the page holds is in the result: no html, text or value field exists to carry it', () => {
  const result = audited([rawRule('label', ['#a'])]);
  const json = JSON.stringify(result);
  assert.ok(!/"html"|"failureSummary"|"message"|"value"|"text"/.test(json));
  assert.ok(accessibilityAuditSchema.safeParse({ ...result, findings: [{ ...result.findings[0], html: '<input value="x">' }] }).success === false, 'strict: an extra field is refused');
});

// ---------------------------------------------------------------------------------------------------------------------
// comparing with a baseline

test('new and fixed are decided by rule and normalized target; an impact change is not new', () => {
  const before = audited([rawRule('color-contrast', ['#vNAME_0001', '.old']), rawRule('label', ['#vQTY'], { impact: 'moderate' })]);
  const after = audited([rawRule('color-contrast', ['#vNAME_0007', '.fresh']), rawRule('label', ['#vQTY'], { impact: 'critical' })]);
  const comparison = audit.compareAudits(before, after);
  assert.ok(comparison.comparable);
  assert.deepEqual(comparison.delta.new.map((f) => f.targetKey), ['.fresh']);
  assert.deepEqual(comparison.delta.fixed.map((f) => f.targetKey), ['.old']);
  assert.equal(comparison.delta.unchanged, 2, 'the grid row that renumbered and the label whose impact changed are the same findings');
  assert.equal(comparison.delta.incomplete, false);
});

test('new findings are listed most serious first', () => {
  const before = audited([]);
  const after = audited([rawRule('a-minor', ['#a'], { impact: 'minor' }), rawRule('b-critical', ['#b'], { impact: 'critical' }), rawRule('c-serious', ['#c'])]);
  const comparison = audit.compareAudits(before, after);
  assert.ok(comparison.comparable);
  assert.deepEqual(comparison.delta.new.map((f) => f.impact), ['critical', 'serious', 'minor']);
});

test('audits of another level or another scope are not comparable, and a cut list or a new axe version is flagged', () => {
  const base = audited([rawRule('label', ['#a'])]);
  assert.deepEqual(audit.compareAudits(base, audited([], { standard: 'wcag21aa' })), { comparable: false, reason: 'the baseline was taken with wcag2aa, this audit uses wcag21aa' });
  const scoped = audit.compareAudits(base, audited([], { scope: '#main' }));
  assert.equal(scoped.comparable, false);

  const cut = audit.normalizeAxeAnswer(answer([rawRule('label', ['#a'])], { truncated: true }), { standard: 'wcag2aa' });
  const newer = audit.normalizeAxeAnswer(answer([rawRule('label', ['#a'])], { axeVersion: '4.15.0' }), { standard: 'wcag2aa' });
  const flagged = audit.compareAudits(base, cut);
  assert.ok(flagged.comparable && flagged.delta.incomplete);
  const versions = audit.compareAudits(base, newer);
  assert.ok(versions.comparable);
  assert.deepEqual(versions.delta.axeVersionChanged, { before: '4.14.0', after: '4.15.0' });
});

test('failOn: any, serious, new and none', () => {
  const clean = audited([]);
  const minor = audited([rawRule('label', ['#a'], { impact: 'minor' })]);
  const serious = audited([rawRule('label', ['#a'], { impact: 'serious' })]);
  assert.equal(audit.failureFor('none', serious), undefined);
  assert.equal(audit.failureFor('any', clean), undefined);
  assert.match(audit.failureFor('any', minor)!, /1 accessibility violation/);
  assert.equal(audit.failureFor('serious', minor), undefined, 'minor is below serious');
  assert.match(audit.failureFor('serious', serious)!, /1 serious or critical/);

  const delta = (audit.compareAudits(clean, serious) as { delta: never }).delta;
  assert.match(audit.failureFor('new', serious, delta)!, /1 new accessibility violation\(s\) since the baseline \(label\)/);
  const same = (audit.compareAudits(serious, serious) as { delta: never }).delta;
  assert.equal(audit.failureFor('new', serious, same), undefined, 'an old violation does not block a build');
  assert.equal(audit.failureFor('new', serious), undefined, 'without a delta there is nothing to call new (the step refuses to run without a baseline)');
});

// ---------------------------------------------------------------------------------------------------------------------
// the step and the snapshot request

test('the step: defaults, failOn new needs a baseline, and unknown keys are refused', () => {
  const parse = (step: Record<string, unknown>) => explorationRequestSchema.safeParse({ targetUrl: 'https://dev.example.com', steps: [{ action: 'auditAccessibility', name: 'a11y', ...step }] });
  const ok = parse({});
  assert.ok(ok.success);
  const step = ok.data.steps[0] as unknown as Record<string, unknown>;
  assert.equal(step.standard, 'wcag2aa');
  assert.equal(step.failOn, 'none');

  assert.equal(parse({ failOn: 'new' }).success, false);
  assert.ok(parse({ failOn: 'new', baseline: { screen: 'customers' } }).success);
  assert.equal(parse({ standard: 'wcag3' }).success, false);
  assert.equal(parse({ script: 'alert(1)' }).success, false, 'the caller cannot send code');
  assert.equal(parse({ rules: [] }).success, false);
  assert.equal(parse({ rules: ['Color Contrast'] }).success, false);
});

test('the snapshot request: accessibility is opt in, and the plan adds one audit step per screen', () => {
  const defaults = snapshotBodySchema.parse({ targetProfile: 'app' });
  assert.equal(defaults.accessibility, false);
  assert.equal(defaults.accessibilityStandard, 'wcag2aa');

  const screen = { id: 'customers', name: 'Customers', reach: { url: '/customers' } } as never;
  const withA11y = plan.screenSteps(screen, { baseUrl: 'https://dev.example.com', settleMs: 0, screenshots: false, accessibility: 'wcag21aa' });
  assert.deepEqual(withA11y.map((s) => s.action), ['goto', 'captureInventory', 'auditAccessibility']);
  const audit = withA11y[2] as unknown as Record<string, unknown>;
  assert.equal(audit.failOn, 'none', 'a snapshot records, it does not judge');
  assert.equal(audit.standard, 'wcag21aa');
  assert.ok(explorationRequestSchema.safeParse({ targetUrl: 'https://dev.example.com', steps: withA11y }).success);

  const without = plan.screenSteps(screen, { baseUrl: 'https://dev.example.com', settleMs: 0, screenshots: false });
  assert.deepEqual(without.map((s) => s.action), ['goto', 'captureInventory']);

  const limits = { maxStepsPerJob: 40, jobTimeoutMs: 120_000, stepTimeoutMs: 15_000 };
  const base = { loginStepCount: 5, settleMs: 500, screenshots: true, limits };
  assert.ok(plan.screensPerSession({ ...base, accessibility: 'wcag2aa' }) < plan.screensPerSession(base), 'an extra step per screen means fewer screens per session');
});

test('a manifest written before this task still parses (the new fields are optional)', () => {
  const old = { schemaVersion: 1, targetProfile: 'app', environment: 'dev', buildId: 'b1', buildIdSource: 'provided', createdAt: '2026-01-01T00:00:00.000Z', screenshots: false, complete: true, screens: [{ id: 'a', name: 'A', inventory: 'screens/a.json', inventorySha256: 'x', jobId: 'job_1' }], notCaptured: [] };
  assert.ok(snapshotManifestSchema.safeParse(old).success);
});

// ---------------------------------------------------------------------------------------------------------------------
// the baseline kept in a snapshot

const inventoryOf = (screenId: string) => ({ screenId, fields: [], actions: [], grids: [], unkeyed: 0 });

async function writeSnapshot(buildId: string, day: string, screens: Record<string, ReturnType<typeof audited> | null>, tamper?: (name: string) => void): Promise<string> {
  const createdAt = `${day}T08:00:00.000Z`;
  const files: Array<{ relative: string; data: string }> = [];
  const entries = Object.entries(screens).map(([id, result]) => {
    const inventory = `${JSON.stringify(inventoryOf(id), null, 2)}\n`;
    files.push({ relative: `screens/${id}.json`, data: inventory });
    const entry: Record<string, unknown> = { id, name: id, inventory: `screens/${id}.json`, inventorySha256: store.sha256(inventory), jobId: 'job_x' };
    if (result) {
      const text = `${JSON.stringify(result, null, 2)}\n`;
      files.push({ relative: `screens/${id}.a11y.json`, data: text });
      entry.accessibility = `screens/${id}.a11y.json`;
      entry.accessibilitySha256 = store.sha256(text);
    }
    return entry;
  });
  const manifest = { schemaVersion: 1, targetProfile: 'app', environment: 'dev', buildId, buildIdSource: 'provided', createdAt, screenshots: false, complete: true, screens: entries, notCaptured: [] };
  files.push({ relative: store.MANIFEST_FILE, data: `${JSON.stringify(manifest, null, 2)}\n` });
  const name = plan.snapshotFolderName(createdAt, buildId);
  await store.writeSnapshotFolder('app', name, files);
  tamper?.(name);
  return name;
}

test('the baseline is the newest snapshot that audited the screen; a build can be asked for; a missing one says how to make it', async () => {
  await writeSnapshot('b1', '2026-03-01', { customers: audited([rawRule('label', ['#a'])]), orders: audited([]) });
  await writeSnapshot('b2', '2026-03-02', { customers: null, orders: audited([rawRule('label', ['#z'])]) });

  const newest = await service.loadAccessibilityBaseline('app', 'customers');
  assert.equal(newest.buildId, 'b1', 'b2 did not audit customers, so the newest one that did is b1');
  assert.equal((await service.loadAccessibilityBaseline('app', 'orders')).buildId, 'b2');
  assert.equal((await service.loadAccessibilityBaseline('app', 'orders', 'b1')).audit.findings.length, 0);

  await assert.rejects(() => service.loadAccessibilityBaseline('app', 'customers', 'b2'), /build "b2" has no accessibility baseline for screen "customers"/);
  await assert.rejects(() => service.loadAccessibilityBaseline('app', 'ghost'), (error: Error & { type?: string }) => error.message.includes('--accessibility') && error.message.includes('"ghost"'));
  await assert.rejects(() => service.loadAccessibilityBaseline('app', 'orders', 'nope'), /No snapshot of build "nope"/);
});

test('an audit edited after capture is refused, not trusted', async () => {
  const name = await writeSnapshot('b3', '2026-03-03', { cart: audited([rawRule('label', ['#a'])]) });
  const file = path.join(store.targetFolder('app'), name, 'screens', 'cart.a11y.json');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('label', 'LABEL'));
  await assert.rejects(() => service.loadAccessibilityBaseline('app', 'cart', 'b3'), /does not match the sha256/);
  await assert.rejects(() => service.loadSnapshotView('app', name), /does not match the sha256/);
});

// ---------------------------------------------------------------------------------------------------------------------
// the diff between two builds and CHANGES.md

const viewOf = (buildId: string, screens: Record<string, ReturnType<typeof audited> | undefined>) => ({
  buildId,
  createdAt: '2026-04-01T00:00:00.000Z',
  complete: true,
  inventories: new Map(Object.keys(screens).map((id) => [id, inventoryOf(id)])),
  notCaptured: new Map<string, string>(),
  names: new Map(Object.keys(screens).map((id) => [id, id.toUpperCase()])),
  ...(Object.values(screens).some(Boolean)
    ? { accessibility: new Map(Object.entries(screens).filter(([, value]) => value).map(([id, value]) => [id, value!])) }
    : {}),
});

test('between builds: new and fixed per screen, kept apart from the structural counts, and CHANGES.md says what to adjust', () => {
  const before = viewOf('b1', { customers: audited([rawRule('color-contrast', ['.old'])]), orders: audited([]) });
  const after = viewOf('b2', { customers: audited([rawRule('color-contrast', ['.fresh'])]), orders: audited([]) });
  const diff = compare.diffSnapshots(before as never, after as never);
  assert.deepEqual(diff.accessibility, { screensCompared: 2, new: 1, fixed: 1, notComparable: 0 });
  assert.equal(diff.counts.changes, 0, 'a new violation is not a structural change');
  assert.equal(diff.counts.unexpected, 0);

  const markdown = compare.renderChangesMarkdown(diff, 'app');
  assert.match(markdown, /Accessibility: 1 new violation\(s\), 1 fixed, across 2 screen\(s\) compared/);
  assert.match(markdown, /## Screen CUSTOMERS/);
  assert.match(markdown, /\*\*NEW\*\* \[serious\] color-contrast at `\.fresh`/);
  assert.match(markdown, /fixed \[serious\] color-contrast at `\.old`/);
  assert.match(markdown, /theme/i, 'the platform note for colour contrast is attached');
  const npdevMarkdown = compare.renderChangesMarkdown(diff, 'app', 'npdev');
  assert.match(npdevMarkdown, /NPDev workbench \(verified on the WmsOffice build/, 'an NPDev target gets the NPDev note');
  assert.doesNotMatch(npdevMarkdown, /Theme object/);
  assert.match(compare.renderChangesFile(diff, 'app', undefined, 'npdev'), /NPDev workbench \(verified/);
  assert.ok(!markdown.includes('## Screen ORDERS'), 'a screen with nothing new and nothing fixed is not listed');
});

test('between builds: the first audit is a baseline not a change, a different level is not compared, and no audits at all adds nothing', () => {
  const none = compare.diffSnapshots(viewOf('b1', { a: undefined }) as never, viewOf('b2', { a: undefined }) as never);
  assert.equal(none.accessibility, undefined);
  assert.match(compare.renderChangesMarkdown(none, 'app'), /No structural change between these two snapshots\./);

  const first = compare.diffSnapshots(viewOf('b1', { a: undefined }) as never, viewOf('b2', { a: audited([rawRule('label', ['#x'])]) }) as never);
  assert.equal(first.screens[0]!.accessibility!.status, 'first-audit');
  assert.deepEqual(first.accessibility, { screensCompared: 0, new: 0, fixed: 0, notComparable: 0 });
  assert.match(compare.renderChangesMarkdown(first, 'app'), /first audit of this screen \(wcag2aa\)/);

  const levels = compare.diffSnapshots(viewOf('b1', { a: audited([]) }) as never, viewOf('b2', { a: audited([], { standard: 'wcag21aa' }) }) as never);
  assert.equal(levels.screens[0]!.accessibility!.status, 'not-comparable');
  assert.equal(levels.accessibility!.notComparable, 1);
});

// ---------------------------------------------------------------------------------------------------------------------
// the report

const reportData = (result: unknown) => ({
  jobId: 'job_1',
  status: 'passed' as const,
  targetUrl: 'https://dev.example.com',
  startedAt: '2026-04-01T00:00:00.000Z',
  finishedAt: '2026-04-01T00:00:01.000Z',
  durationMs: 1000,
  executor: 'test',
  steps: [],
  accessibility: [{ name: 'a11y', result: accessibilityResultSchema.parse(result) }],
  screenshots: [],
  consoleCount: 0,
  consoleErrors: [],
  networkCount: 0,
  networkFailures: [],
  integrity: { state: 'none' as const },
  generatedAt: '2026-04-01T00:00:02.000Z',
});

test('the report with a baseline shows new and fixed, with the platform note in the report language, and never the whole list', () => {
  const before = audited([rawRule('color-contrast', ['.old']), rawRule('label', ['#same'])]);
  const after = audited([rawRule('color-contrast', ['.fresh']), rawRule('label', ['#same'])]);
  const comparison = audit.compareAudits(before, after);
  assert.ok(comparison.comparable);
  const result = { ...after, baseline: { screen: 'customers', buildId: 'b1', createdAt: '2026-03-01T08:00:00.000Z', ...comparison.delta } };

  const en = renderRunReport(reportData(result) as never, 'en');
  assert.match(en, /New since the baseline \(1\)/);
  assert.match(en, /Fixed since the baseline \(1\)/);
  assert.ok(en.includes('.fresh') && en.includes('.old'));
  assert.ok(!en.includes('#same'), 'a finding that was already there is not listed');
  assert.match(en, /Theme object/);

  const pt = renderRunReport(reportData(result) as never, 'pt');
  assert.match(pt, /Novas desde a linha de base \(1\)/);
  assert.match(pt, /Corrija no tema/);
  const es = renderRunReport(reportData(result) as never, 'es');
  assert.match(es, /Nuevas desde la línea base \(1\)/);
  assert.match(es, /Corrija en el tema/);
});

test('the report of an NPDev target prints the NPDev note (or says it is not verified), never the GeneXus controls', () => {
  const result = audited([rawRule('label', ['input[data-fkey="h:dataExpedicao"]']), rawRule('image-alt', ['#logo'])]);
  const npdev = { ...reportData(result), platform: 'npdev' };

  const en = renderRunReport(npdev as never, 'en');
  assert.match(en, /NPDev workbench \(verified on the WmsOffice build/);
  assert.match(en, /Not verified for NPDev yet/, 'a rule nobody checked on NPDev says so');
  assert.doesNotMatch(en, /Label Position|Textblock/);
  assert.match(renderRunReport(npdev as never, 'pt'), /Workbench do NPDev \(verificado/);
  assert.match(renderRunReport(npdev as never, 'es'), /Workbench de NPDev \(verificado/);

  // Same data on a GeneXus target (or one with no platform) keeps the GeneXus text.
  for (const platform of ['genexus', undefined]) {
    const html = renderRunReport({ ...reportData(result), platform } as never, 'en');
    assert.match(html, /Label Position/);
    assert.doesNotMatch(html, /NPDev workbench \(verified/);
  }
});

test('the report without a baseline says so and lists only the most serious findings', () => {
  const many = Array.from({ length: 30 }, (_, index) => `#el${index}`);
  const html = renderRunReport(reportData(audited([rawRule('label', many, { impact: 'minor' }), rawRule('image-alt', ['#hero'], { impact: 'critical' })])) as never, 'en');
  assert.match(html, /No baseline was given/);
  assert.ok(html.includes('#hero'), 'the critical finding is shown');
  assert.ok(html.includes('#el0') === true && html.includes('#el29') === false, 'the list is cut');
  assert.match(html, /… 11/);
});

test('hostile text from the page is escaped in the report', () => {
  const html = renderRunReport(reportData(audited([rawRule('label', ['#a<script>alert(1)</script>'], { help: '<img src=x onerror=alert(1)>' })])) as never, 'en');
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes(esc('#a<script>alert(1)</script>')));
});

// ---------------------------------------------------------------------------------------------------------------------
// the platform guidance (T7.7)

test('every rule axe checks for WCAG has a note, in the three languages, and no note names a rule axe does not have', () => {
  const require = createRequire(import.meta.url);
  const axe = require('axe-core') as { getRules(tags?: string[]): Array<{ ruleId: string }> };
  const known = new Set(axe.getRules().map((rule) => rule.ruleId));
  for (const rule of guidance.GUIDED_RULES) assert.ok(known.has(rule), `"${rule}" is not a rule of axe-core ${AXE_VERSION}`);

  const wcag = axe.getRules(STANDARD_TAGS.wcag22aa).map((rule) => rule.ruleId);
  const missing = wcag.filter((rule) => !guidance.GUIDED_RULES.includes(rule));
  assert.deepEqual(missing, [], 'a rule of the supported standards has no platform note: add it to src/a11y/platformGuidance.ts');

  for (const group of guidance.GUIDANCE_GROUPS) {
    for (const lang of guidance.GUIDANCE_LANGS) {
      assert.ok(group.title[lang].length > 3, `${group.id} title ${lang}`);
      assert.ok(group.text[lang].what.length > 20, `${group.id} what ${lang}`);
      assert.ok(group.text[lang].platform.length > 20, `${group.id} platform ${lang}`);
    }
  }
  const seen = new Map<string, string>();
  for (const group of guidance.GUIDANCE_GROUPS) {
    for (const rule of group.rules) {
      assert.ok(!seen.has(rule), `"${rule}" is in both ${seen.get(rule)} and ${group.id}`);
      seen.set(rule, group.id);
    }
  }
  assert.equal(guidance.guidanceFor('no-such-rule', 'en'), undefined);
});

test('NPDev targets get the verified NPDev note, or an honest "not verified"; everything else keeps the GeneXus text', () => {
  // Reproduced 2026-11-10 on the WmsOffice (NPDev) workbenches: label, select-name and color-contrast, traced to the generated HTML.
  for (const rule of ['label', 'select-name', 'color-contrast']) {
    const group = guidance.guidanceGroupFor(rule);
    assert.ok(group?.npdev, `${rule} must have a verified NPDev note`);
    for (const lang of guidance.GUIDANCE_LANGS) {
      const generic = guidance.guidanceFor(rule, lang);
      const npdev = guidance.guidanceFor(rule, lang, 'npdev');
      assert.equal(npdev?.platform, group.npdev[lang]);
      assert.ok(npdev!.platform.length > 60, `${rule} ${lang}`);
      assert.notEqual(npdev!.platform, generic!.platform);
      assert.equal(npdev!.what, generic!.what, 'what the rule means is platform-neutral');
      assert.doesNotMatch(npdev!.platform, /Label Position|Textblock|Theme object|objeto Theme/, `${rule} ${lang}: the NPDev note must not name GeneXus controls`);
    }
  }
  // A group nobody verified on NPDev says so instead of showing GeneXus property names.
  const unverified = guidance.guidanceFor('image-alt', 'en', 'npdev');
  assert.equal(unverified?.platform, guidance.NPDEV_UNVERIFIED.en);
  assert.match(unverified!.platform, /Not verified for NPDev/);
  // GeneXus, no platform, or an unknown one: the text that was there before.
  for (const platform of [undefined, 'genexus', 'something-else']) {
    assert.equal(guidance.guidanceFor('label', 'en', platform)?.platform, guidance.guidanceGroupFor('label')!.text.en.platform);
  }
  assert.equal(guidance.guidanceFor('no-such-rule', 'en', 'npdev'), undefined);
  // Only groups with a verified note carry one, and it exists in every language.
  for (const group of guidance.GUIDANCE_GROUPS) {
    if (!group.npdev) continue;
    for (const lang of guidance.GUIDANCE_LANGS) assert.ok(group.npdev[lang].length > 60, `${group.id} npdev ${lang}`);
  }
});

test('docs/a11y-platform-mapping.md is the generated one (run: npm run generate:a11y-doc)', () => {
  const file = path.resolve(import.meta.dirname, '..', 'docs', 'a11y-platform-mapping.md');
  assert.equal(fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n'), `${renderMappingDoc()}\n`);
});

// ---------------------------------------------------------------------------------------------------------------------
// the trusted script that carries axe (T7.1)

test('axe is registered as one pinned trusted script made of the untouched package bundle plus our small runner', () => {
  assert.doesNotThrow(() => verifyTrustedScripts());
  const script = TRUSTED_SCRIPTS.find((entry) => entry.id === 'a11y-axe');
  assert.ok(script);
  assert.ok(script.source.includes(axeBundle), 'the bundle is embedded whole, so its MPL-2.0 header travels with every copy');
  assert.match(axeBundle.slice(0, 200), /axe v\d+\.\d+\.\d+/);
  assert.match(axeBundle.slice(0, 600), /Mozilla Public[\s*]+License/);
  assert.ok(script.source.includes(JSON.stringify(AXE_VERSION)), 'the injected copy is only reused when it has the version this server pinned');

  // our own part keeps the rules of the other trusted scripts: nothing that reaches out or reads storage
  const own = axeAuditSource.replace(axeBundle, '');
  assert.ok(!own.includes('${'));
  assert.ok(!/\beval\s*\(|new Function|document\.write|innerHTML\s*=|fetch\s*\(|XMLHttpRequest|localStorage|sessionStorage|document\.cookie/.test(own), 'our runner reads and writes nothing it should not');
  assert.ok(!/\.html\b|failureSummary|\.message\b/.test(own.replace('rule.help', '')), 'the runner never copies an element html or axe failure messages');
});

test('the answer of the page is bounded: the cap is per rule and in all, and a rule is always listed with its real total', () => {
  assert.match(axeAuditSource, /Math\.min\(rule\.nodes\.length, maxPerRule, remaining\)/);
  const script = TRUSTED_SCRIPTS.find((entry) => entry.id === 'a11y-axe')!;
  assert.ok(script.maxOutputChars <= 300_000);
  assert.ok(script.timeoutMs <= 60_000);
});
