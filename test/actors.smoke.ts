import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// T6.4 end to end (real Chromium): two actors are two sessions. Cookies do not cross, each actor types only the vault values of ITS set,
// evidence is kept apart per actor (and merged, tagged, for whoever reads the run as a whole), and a run with no actors is exactly what it was.

const API_KEY = 'test-api-key-1234567890';
const ALICE_PASSWORD = 'S3NT1NEL-alice-password-41';
const BOB_PASSWORD = 'S3NT1NEL-bob-password-77';

function listen(handler: http.RequestListener): Promise<{ server: http.Server; origin: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

/** A tiny app with a server-side session: whoever posts the login form is who `/home` greets, and only that browser context holds the cookie. */
function app(hits: string[]): http.RequestListener {
  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture');
    const cookies = Object.fromEntries((req.headers.cookie ?? '').split(';').map((part) => part.trim().split('=')).filter((pair) => pair[0]));
    const who = cookies.sid || 'anonymous';
    hits.push(`${who} ${req.method} ${url.pathname}`);
    const html = (body: string) => {
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><title>fixture</title>${body}`);
    };
    if (req.method === 'POST' && url.pathname === '/login') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const user = new URLSearchParams(body).get('u') ?? 'nobody';
        res.writeHead(303, { 'set-cookie': `sid=${encodeURIComponent(user)}; Path=/; HttpOnly`, location: '/home' });
        res.end();
      });
      return;
    }
    if (url.pathname === '/logout') {
      res.writeHead(303, { 'set-cookie': 'sid=; Path=/; Max-Age=0', location: '/home' });
      res.end();
      return;
    }
    if (url.pathname === '/home') return html(`<h1 id="who">${who}</h1>`);
    if (url.pathname === '/boom') return html('<p id="ok">boom</p><script>console.error("boom-from-this-page-only")</script>');
    return html('<form method="post" action="/login"><input id="u" name="u"><input id="p" name="p" type="password"><button id="go" type="submit">Go</button></form>');
  };
}

test('actors: isolated sessions, per-actor credentials and evidence, and no change for a run without actors', async () => {
  const hits: string[] = [];
  const home = await listen(app(hits));
  const other = await listen(app([]));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-actors-smoke-'));

  process.env.SCRAPFORAI_API_KEY = API_KEY;
  process.env.SCRAPFORAI_DATA_DIR = dataDir;
  // .env may pin ARTIFACT_DIR; dotenv never overrides an existing variable, so this keeps evidence in the temp dir.
  process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
  process.env.ALLOW_EVALUATE = 'true'; // only to read innerWidth back out of a page
  process.env.SCRAPFORAI_VAULT_KEY = crypto.randomBytes(32).toString('base64');
  process.env.ALLOWED_TARGET_ORIGINS = `${home.origin},${other.origin}`;
  process.env.ALLOWED_RESOURCE_ORIGINS = `${home.origin},${other.origin}`;

  const express = (await import('express')).default;
  const { apiAuth } = await import('../src/security/apiAuth.js');
  const { explorationRouter } = await import('../src/routes/exploration.routes.js');
  const { saveCredentialSet } = await import('../src/vault/credentials/credentialVault.js');

  await saveCredentialSet('alice-set', { boundOrigins: [home.origin], values: { user: 'ana', pass: ALICE_PASSWORD }, tags: [] }, 'create');
  await saveCredentialSet('bob-set', { boundOrigins: [home.origin], values: { user: 'ben', pass: BOB_PASSWORD }, tags: [] }, 'create');

  const server = express();
  server.use(express.json());
  server.use(apiAuth);
  server.use('/v1/explorations', explorationRouter);
  const api = server.listen(0);
  await new Promise<void>((resolve) => api.once('listening', resolve));
  const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  const run = async (routine: object) => {
    const response = await fetch(`${apiUrl}/v1/explorations/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(routine),
    });
    const text = await response.text();
    return { status: response.status, text, json: JSON.parse(text) as Record<string, any> };
  };

  const login = (actor: string) => [
    { id: `${actor}-open`, actor, action: 'goto', url: '$targetUrl' },
    { id: `${actor}-user`, actor, action: 'fill', selector: '#u', valueFromCredential: 'user' },
    { id: `${actor}-pass`, actor, action: 'fill', selector: '#p', valueFromCredential: 'pass' },
    { id: `${actor}-go`, actor, action: 'click', selector: '#go', afterWaitFor: { urlContains: '/home' } },
  ];

  try {
    // 1. Two users at once. Alice and Bob each log in; main never does. Their sessions do not cross.
    const crossed = await run({
      targetUrl: `${home.origin}/`,
      actors: { alice: { credentialSet: 'alice-set' }, bob: { credentialSet: 'bob-set' } },
      steps: [
        ...login('alice'),
        ...login('bob'),
        { id: 'alice-sees', actor: 'alice', action: 'assertTextContains', selector: '#who', text: 'ana' },
        { id: 'bob-sees', actor: 'bob', action: 'assertTextContains', selector: '#who', text: 'ben' },
        // main is a third context: it shares no cookie with either of them.
        { id: 'main-open', action: 'goto', url: `${home.origin}/home` },
        { id: 'main-anon', action: 'assertTextContains', selector: '#who', text: 'anonymous' },
        // Both take a screenshot called "home": they must not overwrite each other.
        { id: 'alice-shot', actor: 'alice', action: 'screenshot', name: 'home' },
        { id: 'bob-shot', actor: 'bob', action: 'screenshot', name: 'home' },
      ],
      teardown: [{ id: 'bob-out', actor: 'bob', action: 'goto', url: `${home.origin}/logout` }],
    });
    assert.equal(crossed.status, 200, crossed.text);
    const result = crossed.json;
    assert.equal(result.status, 'passed');
    assert.deepEqual(Object.keys(result.actors), ['alice', 'bob', 'main'], 'actors appear in the order they first ran a step');
    assert.equal(result.actors.alice.credentialSet, 'alice-set');
    assert.equal(result.actors.main.credentialSet, undefined);
    assert.ok(result.steps.filter((step: any) => step.actor === 'alice').length >= 5, 'steps say who ran them');
    assert.equal(result.steps.find((step: any) => step.id === 'main-open').actor, undefined, 'a main step carries no actor');
    assert.equal(result.teardown[0].actor, 'bob');
    assert.equal(result.teardownStatus, 'passed');
    assert.ok(hits.includes('ben GET /logout'), "the teardown ran as bob's session (cookie of user ben)");
    assert.ok(hits.includes('anonymous GET /home'), 'main never held a session');

    const shots = result.evidence.screenshots as Array<{ name: string; path: string; actor: string }>;
    assert.equal(shots.length, 2);
    assert.deepEqual(shots.map((shot) => shot.name), ['home', 'home']);
    assert.deepEqual(shots.map((shot) => shot.actor).sort(), ['alice', 'bob']);
    assert.notEqual(shots[0]!.path, shots[1]!.path, 'one file per actor');
    for (const shot of shots) {
      assert.ok(fs.existsSync(path.join(process.env.ARTIFACT_DIR!, result.jobId, 'screenshots', path.basename(shot.path))), `${shot.path} exists`);
    }
    assert.equal(result.actors.alice.evidence.screenshots.length, 1);
    assert.equal(result.actors.bob.evidence.screenshots.length, 1);

    // No actor's password reaches any output.
    assert.ok(!crossed.text.includes(ALICE_PASSWORD) && !crossed.text.includes(BOB_PASSWORD));

    // 2. Evidence is separate: a console error on bob's page is bob's, and the merged view says so.
    const noisy = await run({
      targetUrl: `${home.origin}/`,
      actors: { alice: {}, bob: {} },
      steps: [
        { id: 'a', actor: 'alice', action: 'goto', url: `${home.origin}/home` },
        { id: 'b', actor: 'bob', action: 'goto', url: `${home.origin}/boom` },
        { id: 'done', actor: 'bob', action: 'assertVisible', selector: '#ok' },
      ],
    });
    assert.equal(noisy.json.status, 'passed', noisy.text);
    assert.deepEqual(Object.keys(noisy.json.actors), ['alice', 'bob'], 'no step used main, so no idle main context was opened');
    assert.equal(noisy.json.actors.alice.evidence.consoleErrors.length, 0, 'alice saw no console error');
    assert.equal(noisy.json.actors.bob.evidence.consoleErrors.length, 1);
    assert.match(noisy.json.actors.bob.evidence.consoleErrors[0].text, /boom-from-this-page-only/);
    assert.equal(noisy.json.evidence.consoleErrors.length, 1, 'the merged view still sees it');
    assert.equal(noisy.json.evidence.consoleErrors[0].actor, 'bob');

    // 3. No fallback to main's values: an actor without a credential set cannot type from the vault, and it says so.
    const noSet = await run({
      targetUrl: `${home.origin}/`,
      credentialSet: 'alice-set',
      actors: { guest: {} },
      steps: [
        { id: 'open', actor: 'guest', action: 'goto', url: '$targetUrl' },
        { id: 'pass', actor: 'guest', action: 'fill', selector: '#p', valueFromCredential: 'pass' },
      ],
    });
    assert.equal(noSet.json.status, 'failed');
    assert.match(noSet.json.error.message, /actor "guest"/);
    assert.ok(!noSet.text.includes(ALICE_PASSWORD), 'main\'s secret was not lent to the guest');

    // 4. An actor's set is bound to ITS origins: bob's page on the other (allowlisted) origin is refused.
    const wrongOrigin = await run({
      targetUrl: `${home.origin}/`,
      actors: { bob: { credentialSet: 'bob-set' } },
      steps: [
        { id: 'open', actor: 'bob', action: 'goto', url: `${other.origin}/` },
        { id: 'pass', actor: 'bob', action: 'fill', selector: '#p', valueFromCredential: 'pass' },
      ],
    });
    assert.equal(wrongOrigin.json.status, 'failed');
    assert.equal(wrongOrigin.json.error.type, 'CredentialOriginMismatch');
    assert.ok(!wrongOrigin.text.includes(BOB_PASSWORD));

    // 5. Viewport per actor, and the window of the right actor on resizeWindow.
    const sized = await run({
      targetUrl: `${home.origin}/`,
      actors: { phone: { viewport: { width: 400, height: 300 } } },
      steps: [
        { id: 'a', action: 'goto', url: `${home.origin}/home` },
        { id: 'b', actor: 'phone', action: 'goto', url: `${home.origin}/home` },
        { id: 'wide-main', action: 'evaluate', name: 'mainWidth', script: 'return window.innerWidth' },
        { id: 'wide-phone', actor: 'phone', action: 'evaluate', name: 'phoneWidth', script: 'return window.innerWidth' },
        // The window that moves is the phone's own. Main's page is the browser's FIRST page, which is the one a "first page target" lookup would pick.
        { id: 'resize', actor: 'phone', action: 'resizeWindow', width: 900, height: 700 },
        { id: 'outer-phone', actor: 'phone', action: 'evaluate', name: 'phoneOuter', script: 'return window.outerWidth' },
        { id: 'outer-main', action: 'evaluate', name: 'mainOuter', script: 'return window.outerWidth' },
      ],
    });
    assert.equal(sized.json.status, 'passed', sized.text);
    assert.equal(sized.json.extracted.phoneWidth, 400);
    assert.equal(sized.json.extracted.mainWidth, 1366);
    assert.equal(sized.json.extracted.phoneOuter, 900, 'the phone window was resized');
    assert.notEqual(sized.json.extracted.mainOuter, 900, "main's window was left alone");

    // 6. The validation is up front: an undeclared actor, "main" declared by hand, and more sessions of one account than the profile allows.
    const undeclared = await run({ targetUrl: `${home.origin}/`, steps: [{ actor: 'ghost', action: 'reload' }] });
    assert.equal(undeclared.status, 400);
    assert.match(undeclared.text, /actor \\?"ghost\\?" is not declared/);
    const declaresMain = await run({ targetUrl: `${home.origin}/`, actors: { main: {} }, steps: [{ action: 'reload' }] });
    assert.equal(declaresMain.status, 400);
    const twice = await run({
      targetUrl: `${home.origin}/`,
      actors: { a: { credentialSet: 'alice-set' }, b: { credentialSet: 'alice-set' } },
      steps: [{ actor: 'a', action: 'goto', url: '$targetUrl' }],
    });
    assert.equal(twice.status, 400);
    assert.equal(twice.json.error.type, 'TooManySessionsForCredential');

    // 7. A run without actors is what it always was: no `actors` block, no tag on a single step, screenshot or console line.
    const plain = await run({
      targetUrl: `${home.origin}/`,
      steps: [
        { id: 'open', action: 'goto', url: `${home.origin}/boom` },
        { id: 'shot', action: 'screenshot', name: 'plain' },
      ],
    });
    assert.equal(plain.json.status, 'passed', plain.text);
    assert.equal(plain.json.actors, undefined);
    assert.ok(plain.json.steps.every((step: any) => step.actor === undefined));
    assert.deepEqual(plain.json.evidence.screenshots.map((shot: any) => Object.keys(shot).sort()), [['name', 'path']]);
    assert.equal(plain.json.evidence.consoleErrors[0].actor, undefined);
    assert.ok(plain.json.evidence.screenshots[0].path.endsWith('/screenshots/plain.png'), 'main keeps the plain file name');
  } finally {
    await new Promise<void>((resolve) => api.close(() => resolve()));
    await new Promise<void>((resolve) => home.server.close(() => resolve()));
    await new Promise<void>((resolve) => other.server.close(() => resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
