import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

// T9.2 (the living manual) without a browser: the `doc` schema and its rules, the secret lint over captions, DOC001/DOC002, the model, the Markdown/HTML
// renderer (everything from a routine is plain text, escaped), the store (a build removes only what the previous manifest listed) and the logic of the
// in-page highlight script run against a fake DOM. The browser side is test/manual.smoke.ts.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-manual-test-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts'); // .env may pin it
process.env.MANUAL_OUTPUT_DIR = path.join(dataDir, 'manual-out');
process.env.SCRAPFORAI_VAULT_KEY = crypto.randomBytes(32).toString('base64');
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';
process.env.ALLOWED_RESOURCE_ORIGINS = 'https://dev.example.com';
process.env.MAX_STEPS_PER_JOB = '20';
process.env.ALLOW_EVALUATE = 'false';

const { explorationRequestSchema } = await import('../src/schemas/explorationRequest.schema.js');
const { routineContentSchema } = await import('../src/schemas/libraryRoutine.schema.js');
const { docCaptionSchema, defaultDocWhen, docWhenOf, pickCaption } = await import('../src/schemas/docStep.schema.js');
const { lintRoutineDoc, lintRoutineSteps } = await import('../src/library/routineLint.js');
const { lintConventions } = await import('../src/library/conventionLint.js');
const { chapterIntro, chapterTitle, figureFileOf, missingCaptionsOf, slugOfStepId } = await import('../src/manual/manualModel.js');
const { escapeMarkdown, figuresChangedMarkdown, renderManual } = await import('../src/manual/manualRender.js');
const { readManualManifest, targetFolder, writeManual } = await import('../src/manual/manualStore.js');
const { manualBuildBodySchema } = await import('../src/schemas/manual.schema.js');
const { docHighlightSource } = await import('../src/runner/trusted/scripts/doc.js');
const { TRUSTED_SCRIPTS, sha256Of } = await import('../src/runner/trusted/registry.js');

const caption = (en: string) => ({ en });
const request = (steps: unknown[], extra: Record<string, unknown> = {}) => explorationRequestSchema.safeParse({ targetUrl: 'https://dev.example.com/app', steps, ...extra });
const messages = (result: ReturnType<typeof request>): string[] => (result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`));

// --- the schema -------------------------------------------------------------------------------------------------------------------

test('a caption needs text in at least one language, and nothing else', () => {
  assert.ok(docCaptionSchema.safeParse({ en: 'Open it' }).success);
  assert.ok(docCaptionSchema.safeParse({ pt: 'Abra', es: 'Abra', en: 'Open' }).success);
  assert.ok(!docCaptionSchema.safeParse({}).success);
  assert.ok(!docCaptionSchema.safeParse({ en: '   ' }).success);
  assert.ok(!docCaptionSchema.safeParse({ fr: 'Ouvrir' }).success);
});

test('a step with doc and an id is valid; the figure time defaults by what the step does', () => {
  const ok = request([{ id: 'go', action: 'click', selector: '#save', doc: { caption: caption('Press Save'), highlight: '#save' } }]);
  assert.ok(ok.success, messages(ok).join('; '));
  assert.equal(defaultDocWhen('click'), 'before');
  assert.equal(defaultDocWhen('fill'), 'before');
  assert.equal(defaultDocWhen('selectOption'), 'before');
  assert.equal(defaultDocWhen('goto'), 'after');
  assert.equal(defaultDocWhen('assertVisible'), 'after');
  assert.equal(defaultDocWhen('screenshot'), 'after');
  assert.equal(docWhenOf({ action: 'click' }), 'before');
  assert.equal(docWhenOf({ action: 'click', doc: { when: 'after' } }), 'after');
});

test('a step with doc must have an id', () => {
  const result = request([{ action: 'goto', url: '$targetUrl', doc: { caption: caption('Open the page') } }]);
  assert.ok(messages(result).some((message) => /needs an id/.test(message)), messages(result).join('; '));
});

test('doc is refused in a teardown and inside a parallel branch', () => {
  const inTeardown = request([{ action: 'goto', url: '$targetUrl' }], { teardown: [{ id: 'bye', action: 'click', selector: '#out', doc: { caption: caption('Log out') } }] });
  assert.ok(messages(inTeardown).some((message) => /not allowed in a teardown/.test(message)), messages(inTeardown).join('; '));

  const inBranch = request(
    [
      {
        action: 'parallel',
        branches: [
          [{ id: 'a1', actor: 'alice', action: 'click', selector: '#a', doc: { caption: caption('Alice clicks') } }],
          [{ id: 'b1', actor: 'bob', action: 'click', selector: '#b' }],
        ],
      },
    ],
    { actors: { alice: {}, bob: {} } },
  );
  assert.ok(messages(inBranch).some((message) => /inside a parallel branch/.test(message)), messages(inBranch).join('; '));
});

test('a figure cannot be taken AFTER a step that types a vault value', () => {
  const typed = (when: 'before' | 'after' | undefined) =>
    request([{ id: 'pw', action: 'fill', selector: '#password', valueFromCredential: 'password', doc: { caption: caption('Type your password'), ...(when ? { when } : {}) } }]);
  assert.ok(typed(undefined).success, 'the default for a fill is before');
  assert.ok(typed('before').success);
  assert.ok(messages(typed('after')).some((message) => /vault value/.test(message)), messages(typed('after')).join('; '));
});

test('docFigures needs the full profile and screenshots', () => {
  const steps = [{ id: 'go', action: 'goto', url: '$targetUrl', doc: { caption: caption('Open') } }];
  assert.ok(request(steps, { options: { docFigures: true } }).success);
  assert.ok(messages(request(steps, { options: { docFigures: true, profile: 'functional' } })).some((message) => /full profile/.test(message)));
  assert.ok(messages(request(steps, { options: { docFigures: true, screenshots: 'off' } })).some((message) => /screenshots/.test(message)));
});

test('a routine can carry a chapter title and introduction per language; a doc-less routine keeps its shape', () => {
  const base = { title: 'Orders', targetProfile: 'app', steps: [{ id: 'go', action: 'goto', url: '$targetUrl' }] };
  const withDoc = routineContentSchema.safeParse({ ...base, tags: ['doc'], doc: { title: { en: 'Orders', pt: 'Pedidos' }, intro: { en: 'How to find an order' } } });
  assert.ok(withDoc.success);
  const without = routineContentSchema.parse(base);
  assert.ok(!('doc' in without), 'no default: a routine saved before the manual keeps its digest');
});

// --- the secret lint --------------------------------------------------------------------------------------------------------------

test('a caption that looks like a secret, or holds a vault value, is refused: it ends up in a published manual', () => {
  const secret = 'sk-' + 'a'.repeat(30);
  const steps = [{ id: 'k', action: 'goto', url: '$targetUrl', doc: { caption: { en: `Use the key ${secret}`, pt: 'ok' } } }] as never;
  const issues = lintRoutineSteps(steps, []);
  assert.deepEqual(issues.map((issue) => issue.path), ['steps.0.doc.caption.en']);
  assert.ok(!JSON.stringify(issues).includes(secret), 'the message never echoes the text');

  const vaulted = lintRoutineSteps([{ id: 'k', action: 'goto', url: '$targetUrl', doc: { caption: { es: 'La clave es hunter2hunter2' } } }] as never, ['hunter2hunter2']);
  assert.deepEqual(vaulted.map((issue) => issue.path), ['steps.0.doc.caption.es']);

  assert.deepEqual(lintRoutineDoc({ title: { en: 'Fine' }, intro: { pt: secret } }, []).map((issue) => issue.path), ['doc.intro.pt']);
  assert.deepEqual(lintRoutineDoc(undefined, []), []);
});

// --- DOC001 / DOC002 ------------------------------------------------------------------------------------------------------------

const context = { platform: 'generic' as const };
const stepWithDoc = { id: 'go', action: 'goto', url: '$targetUrl', doc: { caption: { en: 'Open' } } };

test('DOC001: documented steps in a routine that is not tagged doc; DOC002: tagged doc and nothing documented', () => {
  const untagged = lintConventions({ steps: [stepWithDoc] as never, tags: ['smoke'] }, context);
  assert.deepEqual(untagged.findings.map((finding) => finding.rule), ['DOC001']);
  assert.equal(untagged.findings[0]!.stepId, 'go');

  const empty = lintConventions({ steps: [{ id: 'go', action: 'goto', url: '$targetUrl' }] as never, tags: ['doc'] }, context);
  assert.deepEqual(empty.findings.map((finding) => finding.rule), ['DOC002']);

  assert.deepEqual(lintConventions({ steps: [stepWithDoc] as never, tags: ['doc'] }, context).findings, []);
  assert.deepEqual(lintConventions({ steps: [stepWithDoc] as never }, context).findings, [], 'bare steps: tags unknown, nothing is claimed');
  // The documented steps may come from an included routine: the includer is not accused of having none.
  assert.deepEqual(lintConventions({ steps: [{ action: 'include', routineId: 'login' }] as never, tags: ['doc'] }, context).findings, []);
});

test('SEL001 also looks at doc.highlight, and a justified suppression still lists the finding', () => {
  const positional = { id: 'go', action: 'goto', url: '$targetUrl', doc: { caption: { en: 'Open' }, highlight: 'ul > li:nth-child(3)' } };
  assert.deepEqual(lintConventions({ steps: [positional] as never, tags: ['doc'] }, context).findings.map((finding) => finding.rule), ['SEL001']);
  const suppressed = lintConventions({ steps: [positional] as never, tags: ['doc'], lintSuppress: [{ rule: 'SEL001', reason: 'the third item is the one the manual shows', stepId: 'go' }] }, context);
  assert.deepEqual(suppressed.findings, []);
  assert.deepEqual(suppressed.suppressed.map((finding) => finding.rule), ['SEL001']);
});

// --- the model --------------------------------------------------------------------------------------------------------------------

const chapter = (routineId: string, steps: Array<{ stepId: string; caption: Record<string, string> }>, extra: Record<string, unknown> = {}) => ({
  routineId,
  version: 1,
  title: `Routine ${routineId}`,
  jobId: `job_${routineId}`,
  steps: steps.map((step) => ({ ...step, figure: { id: `${routineId}/${step.stepId}`, file: figureFileOf(routineId, step.stepId), width: 640, height: 400 } })),
  ...extra,
});

test('figure files are named after the routine and the step id, safely', () => {
  assert.equal(figureFileOf('login', 'open page'), 'figures/login/open-page.png');
  assert.equal(slugOfStepId('login.user'), 'login.user');
  assert.equal(slugOfStepId('../../etc/passwd'), 'etc-passwd');
  assert.equal(slugOfStepId('***'), 'step');
  assert.ok(slugOfStepId('x'.repeat(200)).length <= 80);
});

test('a missing language is reported, and the text shown is the first one that exists', () => {
  assert.deepEqual(pickCaption({ pt: 'Abra', en: 'Open' }, 'es'), { text: 'Open', lang: 'en', fallback: true });
  assert.deepEqual(pickCaption({ pt: 'Abra', en: 'Open' }, 'pt'), { text: 'Abra', lang: 'pt', fallback: false });
  assert.equal(pickCaption(undefined, 'en'), undefined);

  const chapters = [
    chapter('a', [{ stepId: 's1', caption: { en: 'One', pt: 'Um', es: 'Uno' } }, { stepId: 's2', caption: { en: 'Two' } }], { doc: { title: { en: 'Alpha', pt: 'Alfa' } } }),
  ];
  const missing = missingCaptionsOf(chapters as never, ['pt', 'es']);
  // Language by language, in the order asked: pt first (only s2 lacks it), then es (the title and s2 lack it).
  assert.deepEqual(missing, [
    { routineId: 'a', stepId: 's2', field: 'caption', lang: 'pt' },
    { routineId: 'a', field: 'title', lang: 'es' },
    { routineId: 'a', stepId: 's2', field: 'caption', lang: 'es' },
  ]);

  // No doc.title at all: the routine's own title is used and nothing is flagged (nothing says which language it is in).
  const plain = chapter('b', [{ stepId: 's', caption: { en: 'x' } }], { description: 'About b' });
  assert.deepEqual(chapterTitle(plain as never, 'pt'), { text: 'Routine b', fallback: false, missing: false });
  assert.deepEqual(chapterIntro(plain as never, 'es'), { text: 'About b', fallback: false, missing: false });
  assert.equal(chapterIntro(chapter('c', []) as never, 'es'), undefined);
});

// --- the renderer -----------------------------------------------------------------------------------------------------------------

const model = (): never =>
  ({
    targetProfile: 'app',
    title: 'The <App> & "Co"',
    buildId: 'rev42',
    createdAt: '2026-11-04T12:00:00.000Z',
    chapters: [
      chapter('02-orders', [{ stepId: 'list', caption: { en: 'See the *list* of [orders] <b>now</b>', pt: 'Veja a lista' } }], { doc: { title: { en: 'Orders', pt: 'Pedidos' } } }),
      chapter('01-login', [{ stepId: 'user', caption: { en: 'Type your user name' } }, { stepId: 'go', caption: { en: 'Press <script>alert(1)</script>', es: 'Pulse Entrar' } }]),
    ],
  }) as never;

const firstBuild = { firstBuild: true, new: [], removed: [], changed: [], negligible: [], unchanged: 0 };

test('Markdown: plain text only, escaped; images are relative; chapters are ordered by routine id', () => {
  const files = renderManual({ model: model(), langs: ['en'], formats: ['md'], changes: firstBuild });
  assert.deepEqual(files.map((file) => file.relative), ['en/index.md', 'en/01-login.md', 'en/02-orders.md', 'en/figures-changed.md']);
  const orders = files.find((file) => file.relative === 'en/02-orders.md')!.data;
  assert.ok(orders.startsWith('# Orders\n'), orders);
  assert.ok(orders.includes('See the \\*list\\* of \\[orders\\] \\<b\\>now\\</b\\>'), orders);
  assert.ok(orders.includes('![See the \\*list\\* of \\[orders\\] \\<b\\>now\\</b\\>](../figures/02-orders/list.png)'), orders);
  assert.ok(orders.includes('[Back to contents](index.md)'));
  const index = files.find((file) => file.relative === 'en/index.md')!.data;
  assert.ok(index.indexOf('01-login') < index.indexOf('02-orders'), 'ordered by id');
  assert.ok(index.includes('Build: rev42'));
  assert.equal(escapeMarkdown('a\n\n  b'), 'a b');
});

test('HTML: one self-contained page under a CSP without scripts, and every text escaped', () => {
  const files = renderManual({ model: model(), langs: ['en', 'pt'], formats: ['html'], changes: firstBuild });
  const login = files.find((file) => file.relative === 'en/01-login.html')!.data;
  assert.ok(login.includes("Content-Security-Policy"));
  assert.ok(login.includes("default-src 'none'"));
  assert.ok(!/<script/i.test(login), 'no script element');
  assert.ok(!login.includes('alert(1)</script>'), 'the caption is escaped');
  assert.ok(login.includes('Press &lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(login.includes('alt="Press &lt;script&gt;alert(1)&lt;/script&gt;"'));
  assert.ok(login.includes('<img src="../figures/01-login/user.png"'));
  assert.ok(login.includes('width="640" height="400"'));
  // A manual is opened from disk and printed to PDF: a lazy image that has not loaded when the page is printed is a hole in the document.
  assert.ok(!/loading=/.test(login), 'images are not lazy');
  assert.ok(login.includes('<html lang="en">'));
  assert.ok(login.includes('<a href="../pt/01-login.html">Português</a>'), 'links to the same chapter in the other language');
  const index = files.find((file) => file.relative === 'en/index.html')!.data;
  assert.ok(index.includes('The &lt;App&gt; &amp; &quot;Co&quot;'), 'the title is escaped');
});

test('a language without text shows the one that exists, and says so in that language', () => {
  const files = renderManual({ model: model(), langs: ['es', 'pt'], formats: ['md', 'html'], changes: firstBuild });
  const es = files.find((file) => file.relative === 'es/01-login.md')!.data;
  assert.ok(es.includes('Type your user name'), 'only English exists for the first step');
  assert.ok(es.includes('todavía sin texto en Español; se muestra en English'), es);
  assert.ok(es.includes('Pulse Entrar'), 'the Spanish caption is shown as written');
  const ptOrders = files.find((file) => file.relative === 'pt/02-orders.md')!.data;
  assert.ok(ptOrders.startsWith('# Pedidos\n'));
  assert.ok(!ptOrders.includes('ainda sem texto'), 'nothing missing there');
  const html = files.find((file) => file.relative === 'es/01-login.html')!.data;
  assert.ok(html.includes('todavía sin texto en Español; se muestra en English'));
});

test('the list of figures to review: first build says there is nothing to compare, later builds list what moved', () => {
  const first = figuresChangedMarkdown(model(), firstBuild, 'en');
  assert.ok(first.includes('first build of this manual'), first);

  const changes = {
    firstBuild: false,
    previousBuildId: 'rev41',
    new: ['01-login/go'],
    removed: ['03-old/step'],
    changed: [
      { id: '02-orders/list', reason: 'visual' as const, changedCells: 128, totalCells: 1024, percent: 12.5 },
      { id: '01-login/user', reason: 'resized' as const },
    ],
    negligible: [],
    unchanged: 4,
  };
  const pt = figuresChangedMarkdown(model(), changes, 'pt');
  assert.ok(pt.startsWith('# Figuras para revisar'), pt);
  assert.ok(pt.includes('`02-orders/list` (figures/02-orders/list.png) — 12.5% da imagem mudou (128 de 1024 áreas)'), pt);
  assert.ok(pt.includes('a imagem tem outro tamanho'));
  assert.ok(pt.includes('`03-old/step`'));
  assert.ok(pt.includes('Iguais: 4'));
  assert.ok(pt.includes('rev41'));
});

// --- the store --------------------------------------------------------------------------------------------------------------------

test('a build removes only the files the previous manifest listed, keeps everything else, and writes the manifest last', async () => {
  const manifest = (files: string[], buildId: string) =>
    ({
      manualVersion: 1,
      targetProfile: 'app',
      title: 'App',
      buildId,
      createdAt: '2026-11-04T12:00:00.000Z',
      langs: ['en'],
      formats: ['md'],
      routines: [],
      figures: [],
      changes: { firstBuild: true, new: [], removed: [], changed: [], negligible: [], unchanged: 0 },
      missingCaptions: [],
      files,
    }) as never;

  const folder = targetFolder('app');
  assert.equal(await readManualManifest('app'), undefined);

  const first = manifest(['en/index.md', 'en/old.md', 'figures/old/x.png'], 'rev1');
  await writeManual('app', [{ relative: 'en/index.md', data: 'one' }, { relative: 'en/old.md', data: 'old' }, { relative: 'figures/old/x.png', data: Buffer.from('png') }], first, undefined);
  fs.writeFileSync(path.join(folder, 'README.txt'), 'written by a person');
  assert.equal((await readManualManifest('app'))?.buildId, 'rev1');

  const second = manifest(['en/index.md'], 'rev2');
  const removed = await writeManual('app', [{ relative: 'en/index.md', data: 'two' }], second, first);
  assert.deepEqual(removed.sort(), ['en/old.md', 'figures/old/x.png']);
  assert.equal(fs.readFileSync(path.join(folder, 'en', 'index.md'), 'utf8'), 'two');
  assert.ok(!fs.existsSync(path.join(folder, 'en', 'old.md')));
  assert.ok(!fs.existsSync(path.join(folder, 'figures', 'old')), 'a folder the removal emptied goes too');
  assert.equal(fs.readFileSync(path.join(folder, 'README.txt'), 'utf8'), 'written by a person', 'a file the manifest never listed is not touched');
  assert.equal((await readManualManifest('app'))?.buildId, 'rev2');
});

test('a file that would leave the target folder is refused, and a target id is checked', async () => {
  await assert.rejects(() => writeManual('app', [{ relative: '../escape.txt', data: 'x' }], { files: [] } as never, undefined), /escapes its folder/);
  assert.throws(() => targetFolder('../other'), /Invalid target/);
});

// --- the request ------------------------------------------------------------------------------------------------------------------

test('a build request defaults to English, Markdown and HTML, and refuses repeats and unknown languages', () => {
  const parsed = manualBuildBodySchema.parse({ targetProfile: 'app' });
  assert.deepEqual(parsed.langs, ['en']);
  assert.deepEqual(parsed.formats, ['md', 'html']);
  assert.ok(!manualBuildBodySchema.safeParse({ targetProfile: 'app', langs: ['en', 'en'] }).success);
  assert.ok(!manualBuildBodySchema.safeParse({ targetProfile: 'app', langs: ['fr'] }).success);
  assert.ok(!manualBuildBodySchema.safeParse({ targetProfile: 'app', formats: ['pdf'] }).success);
  assert.ok(!manualBuildBodySchema.safeParse({ targetProfile: 'app', extra: 1 }).success);
  assert.ok(!manualBuildBodySchema.safeParse({ targetProfile: 'app', routines: ['a'] }).success, 'the whole manual is built every time');
});

// --- the in-page script -----------------------------------------------------------------------------------------------------------

/** A just-enough DOM to run the highlight script: it keeps the elements it was asked to add. */
function fakePage(scroll = { x: 0, y: 0 }) {
  const added: Array<Record<string, any>> = [];
  const document = {
    querySelectorAll: (selector: string) => {
      assert.equal(selector, '[data-scrapforai-doc-highlight]');
      return added.filter((element) => element.parentNode);
    },
    createElement: () => {
      const element: Record<string, any> = { attributes: {} as Record<string, string>, style: {}, parentNode: null };
      element.setAttribute = (name: string, value: string) => { element.attributes[name] = value; };
      return element;
    },
    documentElement: {
      appendChild: (element: Record<string, any>) => {
        element.parentNode = { removeChild: (child: Record<string, any>) => { child.parentNode = null; } };
        added.push(element);
      },
    },
  };
  const window = { pageXOffset: scroll.x, pageYOffset: scroll.y };
  // The answer is copied out of the vm realm (its objects have another prototype, which deepEqual would see).
  const run = (args: unknown) => JSON.parse(JSON.stringify(vm.runInNewContext(`(${docHighlightSource})(${JSON.stringify(args)})`, { document, window, isFinite, Array }))) as { cleared: number; drawn: number };
  return { run, live: () => added.filter((element) => element.parentNode) };
}

test('doc-highlight draws one non-interactive box per valid rectangle, in document coordinates, and clear removes them all', () => {
  const page = fakePage({ x: 10, y: 200 });
  const drawn = page.run({ action: 'draw', rects: [{ x: 100, y: 50, width: 80, height: 30 }, { x: 0, y: 0, width: 0, height: 5 }, { x: 'a', y: 1, width: 1, height: 1 }, null] });
  assert.deepEqual(drawn, { cleared: 0, drawn: 1 });
  const [box] = page.live();
  assert.equal(box!.style.position, 'absolute');
  assert.equal(box!.style.left, '106px', 'x + scrollX - padding');
  assert.equal(box!.style.top, '246px', 'y + scrollY - padding');
  assert.equal(box!.style.width, '88px');
  assert.equal(box!.style.height, '38px');
  assert.equal(box!.style.pointerEvents, 'none', 'it can never take a click');
  assert.equal(box!.attributes['aria-hidden'], 'true');
  assert.equal(box!.attributes['data-scrapforai-doc-highlight'], '1');

  // Drawing again starts by clearing: a failed run cannot leave a border behind.
  assert.deepEqual(page.run({ action: 'draw', rects: [{ x: 1, y: 1, width: 5, height: 5 }, { x: 9, y: 9, width: 5, height: 5 }] }), { cleared: 1, drawn: 2 });
  assert.equal(page.live().length, 2);
  assert.deepEqual(page.run({ action: 'clear' }), { cleared: 2, drawn: 0 });
  assert.equal(page.live().length, 0);
  assert.deepEqual(page.run({}), { cleared: 0, drawn: 0 }, 'anything but draw only clears');
});

test('doc-highlight takes numbers, never a selector, and is pinned in the registry', () => {
  assert.ok(!/querySelector\(/.test(docHighlightSource), 'it looks nothing up in the page');
  const registered = TRUSTED_SCRIPTS.find((script) => script.id === 'doc-highlight')!;
  assert.equal(registered.sha256, sha256Of(docHighlightSource));
  assert.equal(fakePage().run({ action: 'draw', rects: Array.from({ length: 50 }, (_, i) => ({ x: i, y: i, width: 5, height: 5 })) }).drawn, 20, 'at most 20 boxes');
});
