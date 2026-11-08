import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// T6.5 end to end (real Chromium). The fixture is a record with OPTIMISTIC LOCKING whose save is held open for 400 ms before it checks the version:
// two saves that really overlap both read version 1, and exactly one of them wins. The server counts the requests in flight, so "the branches ran at
// the same time" is measured on the SERVER, not assumed from the runner.

const API_KEY = 'test-api-key-1234567890';
const ALICE_PASSWORD = 'S3NT1NEL-alice-password-41';
const BOB_PASSWORD = 'S3NT1NEL-bob-password-77';
const HOLD_MS = 400;

function listen(handler: http.RequestListener): Promise<{ server: http.Server; origin: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

interface Fixture {
  version: number;
  saved: string[];
  inFlight: number;
  maxInFlight: number;
  apiHits: string[];
}

function app(state: Fixture): http.RequestListener {
  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture');
    const cookies = Object.fromEntries((req.headers.cookie ?? '').split(';').map((part) => part.trim().split('=')).filter((pair) => pair[0]));
    const who = cookies.sid || 'anonymous';
    const html = (body: string, status = 200) => {
      res.statusCode = status;
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><title>fixture</title>${body}`);
    };
    const readBody = (then: (body: URLSearchParams) => void) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => then(new URLSearchParams(body)));
    };

    if (req.method === 'POST' && url.pathname === '/login') {
      readBody((form) => {
        res.writeHead(303, { 'set-cookie': `sid=${encodeURIComponent(form.get('u') ?? 'nobody')}; Path=/; HttpOnly`, location: '/home' });
        res.end();
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/save') {
      // The save arrives, is held open, THEN checks the version it was shown. Overlapping saves both pass the old version in; the first to finish wins.
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      readBody((form) => {
        setTimeout(() => {
          state.inFlight -= 1;
          if (form.get('v') === String(state.version)) {
            state.version += 1;
            state.saved.push(form.get('note') ?? '');
            html('<p id="result">saved</p>');
          } else {
            html('<p id="result">conflict</p>', 409);
          }
        }, HOLD_MS);
      });
      return;
    }
    if (url.pathname === '/record') {
      return html(
        `<span id="n">42</span><form method="post" action="/save"><input type="hidden" name="v" value="${state.version}"><input id="note" name="note"><button id="save" type="submit">Save</button></form>`,
      );
    }
    if (url.pathname === '/api') {
      state.apiHits.push(who);
      res.setHeader('content-type', 'text/plain');
      return void res.end('ok');
    }
    if (url.pathname === '/fetch') {
      return html(`<button id="fetch" onclick="fetch('/api').then(function (r) { document.body.insertAdjacentHTML('beforeend', '<i id=&quot;status-' + r.status + '&quot;></i>'); })">Fetch</button>`);
    }
    if (url.pathname === '/logout') {
      res.writeHead(303, { 'set-cookie': 'sid=; Path=/; Max-Age=0', location: '/home' });
      res.end();
      return;
    }
    if (url.pathname === '/home') return html(`<h1 id="who">${who}</h1>`);
    return html('<form method="post" action="/login"><input id="u" name="u"><input id="p" name="p" type="password"><button id="go" type="submit">Go</button></form>');
  };
}

test('parallel: branches really overlap, the result does not depend on who finishes first, and each branch keeps its own session', async () => {
  const state: Fixture = { version: 1, saved: [], inFlight: 0, maxInFlight: 0, apiHits: [] };
  const reset = () => Object.assign(state, { version: 1, saved: [], inFlight: 0, maxInFlight: 0, apiHits: [] });
  const home = await listen(app(state));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-parallel-smoke-'));

  process.env.SCRAPFORAI_API_KEY = API_KEY;
  process.env.SCRAPFORAI_DATA_DIR = dataDir;
  // .env may pin ARTIFACT_DIR; dotenv never overrides an existing variable, so this keeps evidence in the temp dir.
  process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
  process.env.ALLOW_EVALUATE = 'false';
  process.env.SCRAPFORAI_VAULT_KEY = crypto.randomBytes(32).toString('base64');
  process.env.ALLOWED_TARGET_ORIGINS = home.origin;
  process.env.ALLOWED_RESOURCE_ORIGINS = home.origin;

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

  const target = `${home.origin}/`;
  const ids = (result: Record<string, any>) => (result.steps as Array<{ id?: string }>).map((step) => step.id);
  /** Both actors load the SAME record (version 1), then each presses save. */
  const prepare = [
    { id: 'a-open', actor: 'alice', action: 'goto', url: `${home.origin}/record` },
    { id: 'b-open', actor: 'bob', action: 'goto', url: `${home.origin}/record` },
    { id: 'a-note', actor: 'alice', action: 'fill', selector: '#note', value: 'from alice' },
    { id: 'b-note', actor: 'bob', action: 'fill', selector: '#note', value: 'from bob' },
  ];
  const aSave = [
    { id: 'a-save', actor: 'alice', action: 'click', selector: '#save' },
    { id: 'a-result', actor: 'alice', action: 'extractText', name: 'alice-result', selector: '#result' },
  ];
  const bSave = [
    { id: 'b-save', actor: 'bob', action: 'click', selector: '#save' },
    { id: 'b-result', actor: 'bob', action: 'extractText', name: 'bob-result', selector: '#result' },
  ];

  try {
    // 1. CONTROL: the same two saves one after the other. Never more than one request in flight; the second one still finds version 1 and ... wins nothing:
    //    alice's save moved the version, so bob's stale form conflicts. This is what the race below must differ from (in flight) and agree with (one winner).
    reset();
    const sequential = await run({ targetUrl: target, actors: { alice: {}, bob: {} }, steps: [...prepare, ...aSave, ...bSave] });
    assert.equal(sequential.json.status, 'passed', sequential.text);
    assert.equal(state.maxInFlight, 1, 'one after the other: never two saves in flight');
    assert.deepEqual(state.saved, ['from alice']);

    // 2. THE RACE: both saves are in flight together, so both pass the old version in and exactly one wins -- the lost update the lock exists to stop.
    reset();
    const raced = await run({
      targetUrl: target,
      actors: { alice: {}, bob: {} },
      steps: [...prepare, { id: 'race', action: 'parallel', label: 'both press save', branches: [aSave, bSave] }],
    });
    assert.equal(raced.json.status, 'passed', raced.text);
    assert.equal(state.maxInFlight, 2, 'the SERVER saw both saves in flight at once: the branches really overlapped');
    assert.equal(state.saved.length, 1, 'optimistic locking let exactly one save through');
    const outcomes = [raced.json.extracted['alice-result'], raced.json.extracted['bob-result']].sort();
    assert.deepEqual(outcomes, ['conflict', 'saved'], 'both branches wrote their extraction, merged into the run');

    // The result is laid out in a fixed order -- the block, then branch 0, then branch 1 -- whoever was first, and `index` is the position in the list.
    assert.deepEqual(ids(raced.json), ['a-open', 'b-open', 'a-note', 'b-note', 'race', 'a-save', 'a-result', 'b-save', 'b-result']);
    const steps = raced.json.steps as Array<Record<string, any>>;
    steps.forEach((step, position) => assert.equal(step.index, position, `steps[${position}].index`));
    const block = steps[4]!;
    assert.equal(block.action, 'parallel');
    assert.equal(block.label, 'both press save');
    assert.deepEqual(block.branches, [
      { actor: 'alice', status: 'passed', stepsRun: 2 },
      { actor: 'bob', status: 'passed', stepsRun: 2 },
    ]);
    assert.deepEqual(steps.map((step) => step.branch), [undefined, undefined, undefined, undefined, undefined, 0, 0, 1, 1]);
    assert.equal(steps[5]!.actor, 'alice');
    assert.equal(steps[7]!.actor, 'bob');
    // The times show the overlap: bob's save started before alice's finished.
    assert.ok(Date.parse(steps[7]!.startedAt) < Date.parse(steps[5]!.finishedAt), "bob's click started before alice's click finished");
    assert.equal(raced.json.actors.alice.stepsRun, 4, 'prepare (2) + the branch (2)');
    assert.equal(raced.json.failedStepIndex, undefined);

    // 3. The order of the result does not follow the speed: make branch 0 slow and branch 1 fast, and the other way round.
    reset();
    const slowFirst = await run({
      targetUrl: target,
      actors: { alice: {}, bob: {} },
      steps: [...prepare, { id: 'race', action: 'parallel', branches: [[{ ...aSave[0]!, delayMs: 700 }, aSave[1]!], bSave] }],
    });
    reset();
    const slowSecond = await run({
      targetUrl: target,
      actors: { alice: {}, bob: {} },
      steps: [...prepare, { id: 'race', action: 'parallel', branches: [aSave, [{ ...bSave[0]!, delayMs: 700 }, bSave[1]!]] }],
    });
    assert.equal(slowFirst.json.status, 'passed', slowFirst.text);
    assert.equal(slowSecond.json.status, 'passed', slowSecond.text);
    assert.deepEqual(ids(slowFirst.json), ids(slowSecond.json), 'same layout whichever branch was slow');
    assert.deepEqual(ids(slowFirst.json), ids(raced.json));

    // 4. A branch sees what the run extracted BEFORE the block, and never what a sibling extracts while it runs.
    const reads = await run({
      targetUrl: target,
      actors: { alice: {}, bob: {} },
      steps: [
        { id: 'a-open', actor: 'alice', action: 'goto', url: `${home.origin}/record` },
        { id: 'b-open', actor: 'bob', action: 'goto', url: `${home.origin}/record` },
        { id: 'before', actor: 'alice', action: 'extractText', name: 'before', selector: '#n' },
        {
          id: 'race',
          action: 'parallel',
          branches: [
            [{ id: 'a-reads-old', actor: 'alice', action: 'assertEquals', actual: { extracted: 'before' }, expected: { value: '42' } }],
            [{ id: 'b-extracts', actor: 'bob', action: 'extractText', name: 'bob-n', selector: '#n' }],
          ],
        },
        { id: 'after', actor: 'alice', action: 'assertEquals', actual: { extracted: 'bob-n' }, expected: { value: '42' } },
      ],
    });
    assert.equal(reads.json.status, 'passed', `a branch reads what came before the block; after it, everything is there\n${reads.text}`);

    const siblings = await run({
      targetUrl: target,
      actors: { alice: {}, bob: {} },
      steps: [
        { id: 'a-open', actor: 'alice', action: 'goto', url: `${home.origin}/record` },
        { id: 'b-open', actor: 'bob', action: 'goto', url: `${home.origin}/record` },
        {
          id: 'race',
          action: 'parallel',
          branches: [
            // alice looks at bob's extraction AFTER bob has surely made it (800 ms later): still not visible, because bob's branch is not merged yet.
            [{ id: 'a-peeks', actor: 'alice', delayMs: 800, action: 'assertEquals', actual: { extracted: 'bob-n' }, expected: { value: '42' } }],
            [{ id: 'b-extracts', actor: 'bob', action: 'extractText', name: 'bob-n', selector: '#n' }],
          ],
        },
      ],
    });
    assert.equal(siblings.json.status, 'failed');
    assert.equal(siblings.json.steps.find((step: any) => step.id === 'a-peeks').status, 'failed', 'a sibling branch\'s write is not visible while the block runs');
    assert.equal(siblings.json.steps.find((step: any) => step.id === 'b-extracts').status, 'passed');

    // 5. A failing branch stops at its own first failure; the others carry on to their end. The run's verdict is the first failure IN RESULT ORDER.
    const oneFails = await run({
      targetUrl: target,
      actors: { alice: {}, bob: {} },
      steps: [
        ...prepare,
        {
          id: 'race',
          action: 'parallel',
          branches: [
            [
              { id: 'a-1', actor: 'alice', action: 'assertVisible', selector: '#save' },
              { id: 'a-2', actor: 'alice', delayMs: 500, action: 'assertVisible', selector: '#note' },
              { id: 'a-3', actor: 'alice', action: 'assertVisible', selector: '#n' },
            ],
            [
              { id: 'b-1', actor: 'bob', action: 'assertVisible', selector: '#nothing-here', timeoutMs: 300 },
              { id: 'b-2', actor: 'bob', action: 'assertVisible', selector: '#save' },
            ],
          ],
        },
        { id: 'never', actor: 'alice', action: 'assertVisible', selector: '#save' },
      ],
      teardown: [{ id: 'cleanup', actor: 'bob', action: 'goto', url: `${home.origin}/logout` }],
    });
    assert.equal(oneFails.json.status, 'failed');
    const failIds = ids(oneFails.json);
    assert.deepEqual(failIds.slice(4), ['race', 'a-1', 'a-2', 'a-3', 'b-1'], "alice's branch ran to its end; bob's stopped at b-1; nothing after the block ran");
    assert.ok(!failIds.includes('never') && !failIds.includes('b-2'));
    const failed = oneFails.json.steps as Array<Record<string, any>>;
    assert.equal(oneFails.json.failedStepIndex, 8, 'the index of b-1');
    assert.equal(failed[oneFails.json.failedStepIndex].id, 'b-1');
    assert.equal(oneFails.json.error.type, failed[8]!.error.type);
    assert.equal(failed[4]!.status, 'failed', 'the block itself failed');
    assert.equal(failed[4]!.error.type, 'ParallelBranchFailed');
    assert.deepEqual(failed[4]!.branches, [
      { actor: 'alice', status: 'passed', stepsRun: 3 },
      { actor: 'bob', status: 'failed', stepsRun: 1 },
    ]);
    assert.equal(oneFails.json.teardownStatus, 'passed', 'the teardown still ran');
    assert.equal(oneFails.json.evidence.screenshots.filter((shot: any) => shot.name === 'failure').length, 1, "bob's failing page got its failure screenshot");

    // 6. Two failures: the one in the LOWER branch is the verdict, even though the other branch failed first in time.
    const bothFail = await run({
      targetUrl: target,
      actors: { alice: {}, bob: {} },
      steps: [
        ...prepare,
        {
          id: 'race',
          action: 'parallel',
          branches: [
            [{ id: 'a-slow-fail', actor: 'alice', action: 'waitForSelector', selector: '#nothing-a', state: 'visible', timeoutMs: 1500 }],
            [{ id: 'b-fast-fail', actor: 'bob', action: 'waitForSelector', selector: '#nothing-b', state: 'visible', timeoutMs: 200 }],
          ],
        },
      ],
    });
    assert.ok(Array.isArray(bothFail.json.steps), bothFail.text); // a run that failed answers 500 with its result
    assert.equal(bothFail.json.status, 'failed');
    const both =bothFail.json.steps as Array<Record<string, any>>;
    assert.equal(both[bothFail.json.failedStepIndex].id, 'a-slow-fail', 'branch 0 comes first in the result, whoever failed first');
    assert.ok(Date.parse(both.find((s) => s.id === 'b-fast-fail')!.finishedAt) < Date.parse(both.find((s) => s.id === 'a-slow-fail')!.finishedAt), 'bob really failed first');
    assert.equal(both.find((s) => s.id === 'race')!.error.message, '2 of 2 branches failed: 0 (alice), 1 (bob)');

    // 7. Each branch keeps its own session, vault values and faults. Both log in at once with their own set; alice breaks HER network only.
    reset();
    const login = (actor: string) => [
      { id: `${actor}-open`, actor, action: 'goto', url: '$targetUrl' },
      { id: `${actor}-user`, actor, action: 'fill', selector: '#u', valueFromCredential: 'user' },
      { id: `${actor}-pass`, actor, action: 'fill', selector: '#p', valueFromCredential: 'pass' },
      { id: `${actor}-go`, actor, action: 'click', selector: '#go', afterWaitFor: { urlContains: '/home' } },
    ];
    const sessions = await run({
      targetUrl: target,
      actors: { alice: { credentialSet: 'alice-set' }, bob: { credentialSet: 'bob-set' } },
      steps: [
        {
          id: 'both-log-in',
          action: 'parallel',
          branches: [
            [...login('alice'), { id: 'a-sees', actor: 'alice', action: 'assertTextContains', selector: '#who', text: 'ana' }],
            [...login('bob'), { id: 'b-sees', actor: 'bob', action: 'assertTextContains', selector: '#who', text: 'ben' }],
          ],
        },
        { id: 'a-fetch-page', actor: 'alice', action: 'goto', url: `${home.origin}/fetch` },
        { id: 'b-fetch-page', actor: 'bob', action: 'goto', url: `${home.origin}/fetch` },
        {
          id: 'fetches',
          action: 'parallel',
          branches: [
            [
              { id: 'a-break', actor: 'alice', action: 'injectFault', match: { urlContains: '/api' }, fault: { status: 503, body: 'down' } },
              { id: 'a-fetch', actor: 'alice', action: 'click', selector: '#fetch' },
              { id: 'a-out', actor: 'alice', action: 'waitForSelector', selector: '#status-503', state: 'attached', timeoutMs: 5000 },
            ],
            [
              { id: 'b-fetch', actor: 'bob', action: 'click', selector: '#fetch' },
              { id: 'b-out', actor: 'bob', action: 'waitForSelector', selector: '#status-200', state: 'attached', timeoutMs: 5000 },
            ],
          ],
        },
      ],
    });
    assert.equal(sessions.json.status, 'passed', sessions.text);
    assert.deepEqual(state.apiHits, ['ben'], "only bob's request reached the server (alice's was answered by the fault), and it carried bob's cookie");
    assert.ok(!sessions.text.includes(ALICE_PASSWORD) && !sessions.text.includes(BOB_PASSWORD), 'no password in any output');
    assert.equal(sessions.json.actors.alice.credentialSet, 'alice-set');
    const routing = sessions.json.evidence.routing as Array<{ actor?: string; handledBy: string }>;
    assert.ok(routing.some((item) => item.handledBy === 'fault' && item.actor === 'alice'), "the fault is alice's");
    assert.ok(!routing.some((item) => item.handledBy === 'fault' && item.actor === 'bob'));

    // 8. Refused up front, in plain words: one actor in two branches, a block inside a block, a block in a teardown.
    const twice = await run({
      targetUrl: target,
      actors: { alice: {} },
      steps: [{ action: 'parallel', branches: [[{ actor: 'alice', action: 'reload' }], [{ actor: 'alice', action: 'reload' }]] }],
    });
    assert.equal(twice.status, 400);
    assert.match(twice.text, /both run as actor/);
    const nested = await run({
      targetUrl: target,
      actors: { alice: {}, bob: {} },
      steps: [{ action: 'parallel', branches: [[{ action: 'parallel', branches: [[{ actor: 'alice', action: 'reload' }], [{ actor: 'bob', action: 'reload' }]] }], [{ action: 'reload' }]] }],
    });
    assert.equal(nested.status, 400);
    assert.match(nested.text, /cannot hold another one/);
    const inTeardown = await run({
      targetUrl: target,
      actors: { alice: {}, bob: {} },
      steps: [{ action: 'reload' }],
      teardown: [{ action: 'parallel', branches: [[{ actor: 'alice', action: 'reload' }], [{ actor: 'bob', action: 'reload' }]] }],
    });
    assert.equal(inTeardown.status, 400);
    assert.match(inTeardown.text, /not allowed in a teardown/);

    // 9. A run without a block is what it always was: no `branch`, no `branches` anywhere.
    const plain = await run({ targetUrl: target, steps: [{ id: 'open', action: 'goto', url: `${home.origin}/record` }, { id: 'n', action: 'extractText', name: 'n', selector: '#n' }] });
    assert.equal(plain.json.status, 'passed', plain.text);
    assert.ok(plain.json.steps.every((step: any) => step.branch === undefined && step.branches === undefined));

    // 10. BARRIER. Bob has 1.5 s of work before his save that alice does not (longer than the server holds a save, 400 ms), so without a meeting point alice's
    //     save is over before bob's starts: never two in flight. With a barrier both wait for the slower one and press save together: the SERVER sees both.
    const meet = (id: string, actor: string, name = 'go', extra: object = {}) => ({ id, actor, action: 'barrier', name, ...extra });
    const bobPrelude = { id: 'b-prelude', actor: 'bob', action: 'waitForTimeout', timeoutMs: 1500 };
    reset();
    const late = await run({ targetUrl: target, actors: { alice: {}, bob: {} }, steps: [...prepare, { id: 'race', action: 'parallel', branches: [aSave, [bobPrelude, ...bSave]] }] });
    assert.equal(late.json.status, 'passed', late.text);
    assert.equal(state.maxInFlight, 1, 'control, no barrier: alice saved long before bob started, so the saves never overlapped');

    reset();
    const met = await run({
      targetUrl: target,
      actors: { alice: {}, bob: {} },
      steps: [...prepare, { id: 'race', action: 'parallel', branches: [[meet('a-go', 'alice', 'go', { timeoutMs: 8000 }), ...aSave], [bobPrelude, meet('b-go', 'bob'), ...bSave]] }],
    });
    assert.equal(met.json.status, 'passed', met.text);
    assert.equal(state.maxInFlight, 2, 'with the barrier the SERVER saw both saves in flight at once, although bob was 1.5 s behind');
    assert.equal(state.saved.length, 1, 'both read the same version: exactly one save got through');
    assert.deepEqual([met.json.extracted['alice-result'], met.json.extracted['bob-result']].sort(), ['conflict', 'saved']);
    assert.deepEqual(ids(met.json), ['a-open', 'b-open', 'a-note', 'b-note', 'race', 'a-go', 'a-save', 'a-result', 'b-prelude', 'b-go', 'b-save', 'b-result']);
    const metSteps = met.json.steps as Array<Record<string, any>>;
    const stepNamed = (id: string) => metSteps.find((step) => step.id === id)!;
    assert.equal(stepNamed('a-go').action, 'barrier');
    assert.equal(stepNamed('a-go').status, 'passed');
    assert.ok(stepNamed('a-go').durationMs >= 1000, `alice waited for bob at the barrier (waited ${stepNamed('a-go').durationMs} ms)`);
    assert.ok(stepNamed('b-go').durationMs < 1000, `bob, the last to arrive, did not wait (${stepNamed('b-go').durationMs} ms)`);
    metSteps.forEach((step, position) => assert.equal(step.index, position, `steps[${position}].index`));

    // 11. Two barriers, met in order: the second one is a meeting of its own.
    reset();
    const twoMeetings = await run({
      targetUrl: target,
      actors: { alice: {}, bob: {} },
      steps: [
        ...prepare,
        {
          id: 'race',
          action: 'parallel',
          branches: [
            [meet('a-ready', 'alice', 'ready', { timeoutMs: 8000 }), ...aSave, meet('a-done', 'alice', 'done', { timeoutMs: 8000 })],
            [bobPrelude, meet('b-ready', 'bob', 'ready'), ...bSave, meet('b-done', 'bob', 'done')],
          ],
        },
      ],
    });
    assert.equal(twoMeetings.json.status, 'passed', twoMeetings.text);
    assert.equal(state.maxInFlight, 2);

    // 12. A branch that fails BEFORE the barrier does not leave the other one waiting out its timeout, and the other one never saves alone. The run's
    //     verdict is the real cause (bob's failed assertion, in the later branch), not the broken barrier that came first in the result.
    reset();
    const brokenBy = await run({
      targetUrl: target,
      actors: { alice: {}, bob: {} },
      steps: [
        ...prepare,
        {
          id: 'race',
          action: 'parallel',
          branches: [
            [meet('a-go', 'alice', 'go', { timeoutMs: 8000 }), ...aSave],
            [{ id: 'b-check', actor: 'bob', action: 'assertVisible', selector: '#nothing-here', timeoutMs: 300 }, meet('b-go', 'bob'), ...bSave],
          ],
        },
      ],
    });
    assert.equal(brokenBy.json.status, 'failed');
    const brokenSteps = brokenBy.json.steps as Array<Record<string, any>>;
    const aGo = brokenSteps.find((step) => step.id === 'a-go')!;
    assert.equal(aGo.status, 'failed');
    assert.equal(aGo.error.type, 'BarrierBrokenError');
    assert.match(aGo.error.message, /barrier "go" can no longer happen: branch 1 \(bob\) failed before reaching it/);
    assert.ok(aGo.durationMs < 4000, `alice was freed when bob failed, not after her 8 s timeout (${aGo.durationMs} ms)`);
    assert.equal(brokenSteps[brokenBy.json.failedStepIndex].id, 'b-check', 'the verdict is the cause (bob\'s assertion), not its consequence');
    assert.notEqual(brokenBy.json.error.type, 'BarrierBrokenError');
    assert.ok(!ids(brokenBy.json).includes('a-save') && !ids(brokenBy.json).includes('b-go'), 'neither branch went on past its failure');
    assert.deepEqual(state.saved, [], 'alice did not save alone');
    assert.equal(state.maxInFlight, 0);

    // 13. A timeout is its own error and names who it waited for; bob, arriving later, finds a meeting that cannot happen any more.
    reset();
    const timedOut = await run({
      targetUrl: target,
      actors: { alice: {}, bob: {} },
      steps: [
        ...prepare,
        { id: 'race', action: 'parallel', branches: [[meet('a-go', 'alice', 'go', { timeoutMs: 400 }), ...aSave], [bobPrelude, meet('b-go', 'bob'), ...bSave]] },
      ],
    });
    assert.equal(timedOut.json.status, 'failed');
    const timedSteps = timedOut.json.steps as Array<Record<string, any>>;
    const aWaited = timedSteps.find((step) => step.id === 'a-go')!;
    assert.equal(aWaited.error.type, 'BarrierTimeoutError');
    assert.match(aWaited.error.message, /barrier "go": still waiting for branch 1 \(bob\) after 400 ms/);
    const bLate = timedSteps.find((step) => step.id === 'b-go')!;
    assert.equal(bLate.error.type, 'BarrierBrokenError');
    assert.match(bLate.error.message, /branch 0 \(alice\) failed before reaching it/);
    assert.equal(timedSteps[timedOut.json.failedStepIndex].id, 'a-go', 'the timeout is the cause; the broken barrier is its consequence');
    assert.deepEqual(state.saved, []);

    // 14. Refused up front: a barrier outside a block, and branches that do not hold the same barriers.
    const alone = await run({ targetUrl: target, actors: { alice: {} }, steps: [{ actor: 'alice', action: 'barrier', name: 'go' }] });
    assert.equal(alone.status, 400);
    assert.match(alone.text, /only works inside a parallel branch/);
    const lopsided = await run({
      targetUrl: target,
      actors: { alice: {}, bob: {} },
      steps: [{ action: 'parallel', branches: [[{ actor: 'alice', action: 'barrier', name: 'go' }, { actor: 'alice', action: 'reload' }], [{ actor: 'bob', action: 'reload' }]] }],
    });
    assert.equal(lopsided.status, 400);
    assert.match(lopsided.text, /every branch must reach the same barriers in the same order/);
  } finally {
    await new Promise<void>((resolve) => api.close(() => resolve()));
    await new Promise<void>((resolve) => home.server.close(() => resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
