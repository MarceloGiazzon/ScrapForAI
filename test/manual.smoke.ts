import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// T9.2 end to end (real Chromium, real HTTP API). A page whose button label the test can change, and two documented routines. The facts proved here:
//  - the highlight is IN the figure (the same page with and without it differs) and is gone afterwards (an assertCount on the overlay passes);
//  - a figure of a clicking step is taken BEFORE the click, one of an assertion AFTER the action (the result block is black: the means of the two differ);
//  - a second build of an unchanged application lists no changed figure; a changed label lists exactly the figures that show it;
//  - ALL OR NOTHING: a highlight that matches nothing fails the build and leaves the previous manual and its manifest as they were;
//  - a normal run of a documented routine is exactly what it always was (no `doc` in its steps).

const API_KEY = 'test-api-key-1234567890';
const site = { label: 'Save' };

function startSite(): Promise<{ server: http.Server; origin: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if ((req.url ?? '/').startsWith('/app')) {
        res.end(`<!doctype html><meta charset="utf-8"><title>Orders</title>
<style>
  body { font: 16px Arial, sans-serif; margin: 24px; background: #fff; color: #111; }
  input { font: inherit; padding: 6px; width: 220px; }
  button { font: inherit; padding: 8px 16px; }
  #result { display: none; margin-top: 24px; height: 200px; background: #000; color: #fff; padding: 8px; }
</style>
<h1>Orders</h1>
<p><label>Customer <input id="name" type="text"></label></p>
<p><button id="save">${site.label}</button></p>
<div id="result"></div>
<script>
  document.getElementById('save').onclick = function () {
    var r = document.getElementById('result');
    r.textContent = 'Saved ' + document.getElementById('name').value;
    r.style.display = 'block';
  };
</script>`);
      } else {
        res.end('<!doctype html><meta charset="utf-8"><title>About</title><style>body{font:16px Arial,sans-serif;margin:24px}</style><h1>About this application</h1><p>Nothing changes here.</p>');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

const fixture = await startSite();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-manual-smoke-'));
const manualRoot = path.join(dataDir, 'manual-out');
process.env.SCRAPFORAI_API_KEY = API_KEY;
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.MANUAL_OUTPUT_DIR = manualRoot;
process.env.ALLOWED_TARGET_ORIGINS = fixture.origin;
process.env.ALLOWED_RESOURCE_ORIGINS = fixture.origin;
process.env.MAX_PARALLEL_JOBS = '2';

const express = (await import('express')).default;
const { apiAuth } = await import('../src/security/apiAuth.js');
const { manualRouter } = await import('../src/routes/manual.routes.js');
const { saveTarget } = await import('../src/targets/targetStore.js');
const { saveRoutine, runLibraryRoutine } = await import('../src/library/routineService.js');
const { describeFigure, compareFigures, fromBase64 } = await import('../src/manual/figureHash.js');

let api: http.Server;
let apiUrl: string;

async function call(method: string, urlPath: string, body?: unknown, authorized = true) {
  const response = await fetch(`${apiUrl}${urlPath}`, {
    method,
    headers: { 'content-type': 'application/json', ...(authorized ? { authorization: `Bearer ${API_KEY}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, text, json };
}

async function build(body: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const started = await call('POST', '/v1/manual/builds', { targetProfile: 'app', ...body });
  assert.equal(started.status, 202, started.text);
  for (;;) {
    const state = (await call('GET', `/v1/manual/builds/${started.json.buildRunId}?wait=20`)).json;
    if (state.status !== 'running') return state;
  }
}

const profile = (id: string) => ({
  id, name: 'The Orders App', platform: 'generic' as const, environment: 'dev' as const, baseUrl: `${fixture.origin}/app`, credentialSets: [],
  noiseFilters: [], surfaces: {}, screens: [], flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
});

const text = (en: string, pt: string, es: string) => ({ en, pt, es });
const ordersSteps = (highlightSave = '#save') => [
  { id: 'size', action: 'setViewport', width: 640, height: 480 },
  { id: 'open', action: 'goto', url: '$targetUrl', doc: { caption: text('Open the orders page', 'Abra a página de pedidos', 'Abra la página de pedidos') } },
  { id: 'type-name', action: 'fill', selector: '#name', value: 'Acme', doc: { caption: text('Type the customer name', 'Digite o nome do cliente', 'Escriba el nombre del cliente'), highlight: '#name' } },
  { id: 'press-save', action: 'click', selector: '#save', doc: { caption: text('Press the button', 'Pressione o botão', 'Pulse el botón'), highlight: highlightSave } },
  { id: 'saved', action: 'assertTextContains', selector: '#result', text: 'Saved Acme', doc: { caption: text('The order is saved', 'O pedido foi salvo', 'El pedido se guardó') } },
  // The border drawn for the figures must be gone by now.
  { id: 'no-overlay', action: 'assertCount', selector: '[data-scrapforai-doc-highlight]', operator: '=', count: 0 },
];
// A highlight that is not there is waited for as long as the step's timeout: short here, so the failing build does not take half a minute.
const extrasSteps = (highlight?: string) => [
  { id: 'size', action: 'setViewport', width: 640, height: 480 },
  { id: 'open', action: 'goto', url: `${fixture.origin}/about`, ...(highlight ? { timeoutMs: 2000 } : {}), doc: { caption: { en: 'This page never changes' }, ...(highlight ? { highlight } : {}) } },
];

const manualFolder = path.join(manualRoot, 'app');
const read = (relative: string): string => fs.readFileSync(path.join(manualFolder, ...relative.split('/')), 'utf8');
const readPng = (relative: string): Buffer => fs.readFileSync(path.join(manualFolder, ...relative.split('/')));
const manifest = (): Record<string, any> => JSON.parse(read('manual.json'));
const figure = (id: string) => describeFigure(readPng(`figures/${id}.png`));
const meanLuminance = (id: string): number => {
  const grid = fromBase64(figure(id).fingerprint!)!;
  return grid.reduce((sum, value) => sum + value, 0) / grid.length;
};

before(async () => {
  await saveTarget(profile('app') as never);
  await saveTarget(profile('empty-app') as never);

  await saveRoutine('01-orders', {
    title: 'Orders', targetProfile: 'app', tags: ['doc'], steps: ordersSteps() as never,
    doc: { title: { en: 'Save an order', pt: 'Salvar um pedido', es: 'Guardar un pedido' }, intro: { en: 'How to save an order.', pt: 'Como salvar um pedido.', es: 'Cómo guardar un pedido.' } },
  } as never);
  // English only: the build must say so for the other languages.
  await saveRoutine('02-extras', { title: 'Extras', targetProfile: 'app', tags: ['doc'], steps: extrasSteps() as never } as never);
  // Not built: a draft, and a routine that is not documentation.
  await saveRoutine('03-draft', { title: 'Draft', targetProfile: 'app', tags: ['doc'], status: 'draft', steps: extrasSteps() as never } as never);
  await saveRoutine('04-smoke', { title: 'Smoke', targetProfile: 'app', tags: ['smoke'], steps: [{ id: 'open', action: 'goto', url: '$targetUrl' }] as never } as never);

  const app = express();
  app.use(express.json());
  app.use(apiAuth);
  app.use('/v1/manual', manualRouter);
  api = await new Promise<http.Server>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => api.close(resolve));
  await new Promise((resolve) => fixture.server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('starting a build needs the bearer token; an unknown target, one with nothing documented, and a bad body are refused up front', async () => {
  assert.equal((await call('POST', '/v1/manual/builds', { targetProfile: 'app' }, false)).status, 401);
  const ghost = await call('POST', '/v1/manual/builds', { targetProfile: 'ghost' });
  assert.equal(ghost.status, 404);
  assert.equal(ghost.json.error.type, 'TargetNotFound');
  const none = await call('POST', '/v1/manual/builds', { targetProfile: 'empty-app' });
  assert.equal(none.status, 404);
  assert.equal(none.json.error.type, 'NoDocRoutines');
  assert.equal((await call('POST', '/v1/manual/builds', { targetProfile: 'app', langs: ['fr'] })).status, 400);
  assert.equal((await call('GET', '/v1/manual/app')).status, 404, 'no manual yet');
});

test('the first build writes the manual: figures, Markdown and HTML in three languages, and says which captions are missing', async () => {
  const state = await build({ langs: ['en', 'pt', 'es'], buildId: 'rev-1' });
  assert.equal(state.status, 'completed', JSON.stringify(state, null, 2));
  assert.equal(state.exitCode, 0);
  assert.deepEqual(state.routines.map((chapter: any) => [chapter.routineId, chapter.outcome, chapter.figures]), [['01-orders', 'ok', 4], ['02-extras', 'ok', 1]]);
  assert.deepEqual(state.skipped.map((item: any) => item.routineId), ['03-draft'], 'a draft is listed, not built; a routine without the tag is not even mentioned');
  assert.equal(state.output.buildId, 'rev-1');
  assert.equal(state.output.figures.total, 5);
  assert.equal(state.output.changes.firstBuild, true);

  for (const id of ['01-orders/open', '01-orders/type-name', '01-orders/press-save', '01-orders/saved', '02-extras/open']) {
    assert.deepEqual([...readPng(`figures/${id}.png`).subarray(1, 4)], [0x50, 0x4e, 0x47], `${id} is a PNG`);
  }
  for (const lang of ['en', 'pt', 'es']) {
    for (const file of ['index.md', 'index.html', '01-orders.md', '01-orders.html', '02-extras.md', 'figures-changed.md']) {
      assert.ok(fs.existsSync(path.join(manualFolder, lang, file)), `${lang}/${file}`);
    }
  }
  assert.ok(read('pt/01-orders.md').startsWith('# Salvar um pedido\n'));
  assert.ok(read('pt/01-orders.md').includes('Pressione o botão'));
  assert.ok(read('pt/01-orders.md').includes('![Pressione o botão](../figures/01-orders/press-save.png)'));
  assert.ok(read('en/index.md').includes('Build: rev-1'));
  assert.ok(read('en/01-orders.html').includes("default-src 'none'") && !/<script/i.test(read('en/01-orders.html')));

  // 02-extras has an English caption only.
  assert.ok(read('es/02-extras.md').includes('This page never changes'));
  assert.ok(read('es/02-extras.md').includes('todavía sin texto en Español; se muestra en English'));
  assert.equal(state.output.missingCaptions, 2 * 1 /* es, pt: the caption */ + 0, 'one caption in two languages; the chapter has no doc.title so nothing else is flagged');

  const manual = (await call('GET', '/v1/manual/app')).json;
  assert.equal(manual.buildId, 'rev-1');
  assert.equal(manual.figures.length, 5);
  assert.equal(manual.folder, manualFolder);
  assert.deepEqual(manual.missingCaptions.map((item: any) => [item.routineId, item.stepId, item.lang]).sort(), [['02-extras', 'open', 'es'], ['02-extras', 'open', 'pt']]);
});

test('the highlight is in the figure, the click is photographed before it happens, and a normal run is unchanged', async () => {
  // Same page, empty field: the figure of "open" (after the goto) and of "type-name" (before the fill) differ only by the border drawn around #name.
  assert.equal(compareFigures(figure('01-orders/open'), figure('01-orders/type-name')).verdict, 'changed', 'the border is drawn');
  // Two figures of the same page with no highlight in two different runs are the same picture: nothing is left behind, and the render is stable.
  assert.notEqual(compareFigures(figure('01-orders/open'), figure('02-extras/open')).verdict, 'unchanged', 'different pages, to make the next check mean something');

  // "press-save" is taken BEFORE the click (the result block is not there yet); "saved" is an assertion, so it is taken AFTER (the black block is there).
  const before = meanLuminance('01-orders/press-save');
  const afterwards = meanLuminance('01-orders/saved');
  assert.ok(before - afterwards > 15, `the figure of the click (${before.toFixed(0)}) must be much lighter than the one after it (${afterwards.toFixed(0)})`);
  assert.ok(Math.abs(meanLuminance('01-orders/open') - before) < 3, 'before the click the page is the page it was');

  // A normal run of the same routine: no figure, no `doc` on any step, and the overlay assertion passes.
  const result = await runLibraryRoutine('01-orders', undefined, {});
  assert.equal(result.status, 'passed');
  assert.ok(result.steps.every((step) => step.doc === undefined), 'doc is inert metadata unless the run asks for figures');
  assert.ok(!result.evidence.screenshots.some((shot) => shot.name.startsWith('doc-')));
});

test('a second build of an unchanged application lists no changed figure', async () => {
  const first = manifest();
  const state = await build({ langs: ['en', 'pt', 'es'], buildId: 'rev-2' });
  assert.equal(state.status, 'completed', JSON.stringify(state));
  const changes = state.output.changes;
  assert.equal(changes.firstBuild, false);
  assert.equal(changes.previousBuildId, 'rev-1');
  assert.deepEqual([changes.changed, changes.new, changes.removed], [[], [], []], JSON.stringify(changes));
  assert.equal(changes.unchanged + changes.negligible.length, 5);
  assert.equal(manifest().buildId, 'rev-2');
  assert.notEqual(manifest().createdAt, first.createdAt);
  assert.ok(read('en/figures-changed.md').includes('## Changed (0)'));
});

test('a changed label lists exactly the figures that show it, and leaves the one that does not', async () => {
  site.label = 'Submit changes';
  const state = await build({ langs: ['en', 'pt', 'es'], buildId: 'rev-3' });
  assert.equal(state.status, 'completed', JSON.stringify(state));
  const changes = state.output.changes;
  assert.deepEqual(changes.changed.map((change: any) => change.id).sort(), ['01-orders/open', '01-orders/press-save', '01-orders/saved', '01-orders/type-name']);
  assert.ok(changes.changed.every((change: any) => change.reason === 'visual' && change.changedCells > 0));
  assert.deepEqual([changes.new, changes.removed], [[], []]);
  assert.equal(changes.unchanged + changes.negligible.length, 1, 'the page that does not show the button');
  assert.ok(!changes.changed.some((change: any) => change.id.startsWith('02-extras')));

  const en = read('en/figures-changed.md');
  assert.ok(en.includes('`01-orders/press-save` (figures/01-orders/press-save.png)'), en);
  assert.ok(en.includes('Build: rev-3 (← rev-2)'));
  assert.ok(read('pt/figures-changed.md').includes('Figuras para revisar'));
  site.label = 'Save';
});

test('ALL OR NOTHING: a highlight that matches nothing fails the build and leaves the previous manual untouched', async () => {
  const before = manifest();
  const beforeIndex = read('en/index.md');
  const beforeFigure = readPng('figures/02-extras/open.png');
  fs.writeFileSync(path.join(manualFolder, 'README.txt'), 'kept by a person');

  await saveRoutine('02-extras', { title: 'Extras', targetProfile: 'app', tags: ['doc'], steps: extrasSteps('#does-not-exist') as never } as never);
  const state = await build({ langs: ['en', 'pt', 'es'], buildId: 'rev-4' });
  assert.equal(state.status, 'failed');
  assert.equal(state.exitCode, 2);
  assert.equal(state.output, undefined, 'nothing was written');
  assert.deepEqual(state.routines.map((chapter: any) => [chapter.routineId, chapter.outcome]), [['01-orders', 'ok'], ['02-extras', 'failed']]);
  assert.ok(/doc\.highlight "#does-not-exist" matched no visible element/.test(state.routines[1].error), state.routines[1].error);
  assert.ok(/nothing was written/.test(state.reason));

  assert.deepEqual(manifest(), before, 'manual.json is the previous build\'s');
  assert.equal(read('en/index.md'), beforeIndex);
  assert.ok(readPng('figures/02-extras/open.png').equals(beforeFigure));
  assert.equal(read('README.txt'), 'kept by a person');
});

test('a fixed routine builds again; a chapter that disappears takes its files with it, and a person\'s file stays', async () => {
  await saveRoutine('02-extras', { title: 'Extras', targetProfile: 'app', tags: ['doc'], status: 'retired', steps: extrasSteps() as never } as never);
  const state = await build({ langs: ['en'], buildId: 'rev-5' });
  assert.equal(state.status, 'completed', JSON.stringify(state));
  assert.deepEqual(state.skipped.map((item: any) => item.routineId).sort(), ['02-extras', '03-draft']);
  assert.deepEqual(state.output.changes.removed, ['02-extras/open']);
  assert.ok(!fs.existsSync(path.join(manualFolder, 'figures', '02-extras')), 'the figure and its folder are gone');
  assert.ok(!fs.existsSync(path.join(manualFolder, 'en', '02-extras.md')));
  assert.ok(!fs.existsSync(path.join(manualFolder, 'pt')), 'a language nobody asks for any more goes too, once it is empty');
  assert.equal(read('README.txt'), 'kept by a person', 'a file the manifest never listed is not touched');
  assert.deepEqual(manifest().langs, ['en']);
});

test('two builds of one target cannot run at once', async () => {
  const first = await call('POST', '/v1/manual/builds', { targetProfile: 'app' });
  assert.equal(first.status, 202, first.text);
  const second = await call('POST', '/v1/manual/builds', { targetProfile: 'app' });
  assert.equal(second.status, 409);
  assert.equal(second.json.error.type, 'ManualBuildRunning');
  for (;;) {
    const state = (await call('GET', `/v1/manual/builds/${first.json.buildRunId}?wait=20`)).json;
    if (state.status !== 'running') break;
  }
});
