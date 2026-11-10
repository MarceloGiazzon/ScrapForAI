import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// T5.2 end to end (real Chromium). The same page and the same steps run under `full` and `functional`. The step outcomes must be
// identical (that is the acceptance criterion; the speed-up is measured separately and not promised), CSS must still decide what
// is visible, images must still fire onload (as a 1x1 picture), and a functional run keeps no screenshot and no trace.

const hits = new Map<string, number>();
const BIG_PNG = Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')]);

const site = await new Promise<{ server: http.Server; origin: string }>((resolve) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x').pathname;
    hits.set(url, (hits.get(url) ?? 0) + 1);
    switch (url) {
      case '/style.css':
        res.setHeader('content-type', 'text/css');
        return res.end('.gone{display:none} #styled{color:rgb(1,2,3)} @font-face{font-family:F;src:url(/font.woff2)} body{font-family:F,sans-serif}');
      case '/photo.png':
        res.setHeader('content-type', 'image/png');
        return res.end(BIG_PNG);
      case '/font.woff2':
        res.setHeader('content-type', 'font/woff2');
        return res.end(Buffer.alloc(10));
      case '/sound.wav':
        res.setHeader('content-type', 'audio/wav');
        return res.end(Buffer.alloc(100));
      case '/api/data':
        res.setHeader('content-type', 'application/json');
        return res.end('{"ok":true}');
      default:
        res.setHeader('content-type', 'text/html');
        return res.end(
          '<!doctype html><title>T</title><link rel="stylesheet" href="/style.css">' +
            '<h1 id="t">Hello</h1><p class="gone" id="hidden">never shown</p><p id="styled">styled</p>' +
            '<img id="pic" src="/photo.png" onload="document.body.dataset.loaded=\'1\'">' +
            '<audio preload="auto" src="/sound.wav"></audio><div id="out"></div>' +
            '<script>fetch("/api/data").then(function(r){return r.text()}).then(function(t){document.getElementById("out").textContent=t})</script>',
        );
    }
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-profile-smoke-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = site.origin;
process.env.ALLOWED_RESOURCE_ORIGINS = site.origin;

const { resolveExplorationRequest } = await import('../src/runner/resolveRequest.js');
const { runExploration } = await import('../src/runner/runExploration.js');
const { explorationRequestSchema } = await import('../src/schemas/explorationRequest.schema.js');

after(async () => {
  await new Promise<void>((resolve) => site.server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const STEPS = [
  { id: 'open', action: 'goto', url: `${site.origin}/` },
  { id: 'settle', action: 'waitForTimeout', timeoutMs: 600 },
  { id: 'title', action: 'assertVisible', selector: '#t' },
  { id: 'css-hides', action: 'assertHidden', selector: '#hidden' },
  { id: 'data', action: 'assertTextContains', selector: '#out', text: '"ok":true' },
  { id: 'loaded', action: 'extractAttribute', selector: 'body', attribute: 'data-loaded', name: 'loaded' },
  { id: 'shot', action: 'screenshot', name: 'page' },
  { id: 'wrong', action: 'assertVisible', selector: '#hidden', timeoutMs: 500 },
];

async function run(options: Record<string, unknown>) {
  hits.clear();
  const request = explorationRequestSchema.parse({ targetUrl: `${site.origin}/`, steps: STEPS, options });
  const result = await runExploration(await resolveExplorationRequest(request, { initiator: 'system' }));
  return { result, hits: new Map(hits) };
}

const outcome = (result: Awaited<ReturnType<typeof run>>['result']) => result.steps.map((step) => `${step.id}:${step.status}`);

test('same steps, same outcomes under full and functional; only the cost of images, media and fonts goes away', async () => {
  const full = await run({ screenshots: 'always', trace: true });
  const functional = await run({ profile: 'functional', screenshots: 'always', trace: true });

  assert.deepEqual(outcome(functional.result), outcome(full.result), 'no step changed its result');
  assert.deepEqual(outcome(full.result).slice(-2), ['shot:passed', 'wrong:failed'], 'the fixture really ends in the expected failure');
  assert.equal(full.result.extracted.loaded, '1');
  assert.equal(functional.result.extracted.loaded, '1', 'the stand-in image still fires onload');

  // the network
  assert.equal(full.hits.get('/photo.png'), 1);
  assert.ok(full.hits.has('/sound.wav'));
  assert.ok(!functional.hits.has('/photo.png'), 'the image was answered without the network');
  assert.ok(!functional.hits.has('/sound.wav') && !functional.hits.has('/font.woff2'));
  assert.ok(functional.hits.has('/style.css'), 'CSS is never stubbed');
  assert.ok(functional.hits.has('/api/data'), 'fetch/xhr are not resources: the application still talks to its server');

  // evidence
  const touched = new Set((functional.result.evidence.routing ?? []).map((entry) => entry.handledBy));
  assert.ok(touched.has('resource-policy:image'), 'the image stand-in is recorded');
  assert.ok([...touched].every((name) => ['resource-policy:image', 'resource-policy:media', 'resource-policy:font'].includes(name)), [...touched].join(', '));
  assert.ok((functional.result.evidence.routing ?? []).every((entry) => entry.action === 'fulfill'));
  assert.deepEqual(functional.result.evidence.networkFailures, full.result.evidence.networkFailures, 'stand-ins are not failures');

  assert.equal(functional.result.profile, 'functional');
  assert.equal(full.result.profile, undefined);
  assert.ok(full.result.evidence.screenshots.length > 0 && full.result.evidence.tracePath, 'full keeps what it was asked to keep');
  assert.deepEqual(functional.result.evidence.screenshots, [], 'functional: no screenshots even when asked, even the failure one');
  assert.equal(functional.result.evidence.tracePath, undefined, 'functional: no trace even when asked');
  assert.equal(full.result.evidence.routing, undefined, 'full with no policy leaves no routing evidence at all');
});

test('overrides: functional with an empty list stubs nothing; full with a list stubs just that', async () => {
  const none = await run({ profile: 'functional', resourcePolicy: { stub: [] } });
  assert.equal(none.hits.get('/photo.png'), 1);
  assert.equal(none.result.evidence.routing, undefined);
  assert.equal(none.result.evidence.screenshots.length, 0, 'but screenshots and trace stay off: that is the profile, not the stub list');

  const onlyImages = await run({ resourcePolicy: { stub: ['image'] } });
  assert.ok(!onlyImages.hits.has('/photo.png'));
  assert.ok(onlyImages.hits.has('/sound.wav'), 'media was not asked for');
  assert.equal(onlyImages.result.profile, undefined, 'a full run with a stub list is still a full run');
  assert.ok(onlyImages.result.evidence.screenshots.length > 0);
});

test('a saved routine runs as functional when asked (REST body / run_routine / suite), and as full otherwise', async () => {
  const { saveTarget } = await import('../src/targets/targetStore.js');
  const { saveRoutine, runLibraryRoutine } = await import('../src/library/routineService.js');
  await saveTarget({
    id: 'fixture', name: 'Fixture', platform: 'generic', environment: 'dev', baseUrl: `${site.origin}/`, credentialSets: [],
    noiseFilters: [], surfaces: {}, screens: [], flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  });
  await saveRoutine('home', {
    title: 'home',
    targetProfile: 'fixture',
    steps: [
      { id: 'open', action: 'goto', url: `${site.origin}/` },
      { id: 'settle', action: 'waitForTimeout', timeoutMs: 500 },
      { id: 'title', action: 'assertVisible', selector: '#t' },
      { id: 'shot', action: 'screenshot', name: 'page' },
    ] as never,
  });

  hits.clear();
  const functional = await runLibraryRoutine('home', undefined, { profile: 'functional' }, { initiator: 'system' });
  assert.equal(functional.status, 'passed', JSON.stringify(functional.error));
  assert.equal(functional.profile, 'functional');
  assert.equal(functional.evidence.screenshots.length, 0);
  assert.ok(!hits.has('/photo.png'));

  hits.clear();
  const full = await runLibraryRoutine('home', undefined, {}, { initiator: 'system' });
  assert.equal(full.profile, undefined);
  assert.ok(hits.has('/photo.png'));
  assert.ok(full.evidence.screenshots.length > 0);
});
