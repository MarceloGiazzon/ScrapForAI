import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// T6.6 end to end (real Chromium): the four concurrency templates are filled in, saved in the routine library next to the login template, and RUN against
// a fixture application that behaves like the thing each one tests. For every scenario there is a control with the defect switched on, and the template must turn
// red at the step that names that defect: a template that stays green on a broken application would be worth nothing.
//   * edit      : optimistic locking whose save is held 400 ms (so two saves in flight really overlap); `lock: false` lets both saves through (a lost update)
//   * double    : a unique code checked when the row is inserted; `unique: false` inserts both
//   * session   : the newest login wins and ends the older session; `singleSession: false` lets both live
//   * approval  : a request reaches the approver's inbox, the approver approves it, the requester sees the state
// The SERVER counts the saves in flight, so "the branches overlapped" is measured here and not assumed from the runner.

const API_KEY = 'test-api-key-1234567890';
const USER_A = 'tpl-user-a-7f3k';
const PASSWORD_A = 'S3NT1NEL-tpl-a-pw-81';
const USER_B = 'tpl-user-b-9q2m';
const PASSWORD_B = 'S3NT1NEL-tpl-b-pw-42';
const HOLD_MS = 400;

interface World {
  lock: boolean;
  unique: boolean;
  singleSession: boolean;
  version: number;
  saves: string[];
  codes: string[];
  requests: Array<{ id: number; subject: string; owner: string; status: string }>;
  inFlight: number;
  maxInFlight: number;
  logouts: number;
  logins: number;
  sessions: Map<string, string>;
  newest: Map<string, string>;
}

const fresh = (): World => ({
  lock: true, unique: true, singleSession: true, version: 1, saves: [], codes: [], requests: [], inFlight: 0, maxInFlight: 0, logouts: 0, logins: 0,
  sessions: new Map(), newest: new Map(),
});

function listen(handler: http.RequestListener): Promise<{ server: http.Server; origin: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

const escapeHtml = (text: string): string => text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);

function app(world: World): http.RequestListener {
  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture');
    const cookies = Object.fromEntries((req.headers.cookie ?? '').split(';').map((part) => part.trim().split('=')).filter((pair) => pair[0]));
    const token = cookies.sid ?? '';
    const user = (() => {
      const owner = world.sessions.get(token);
      if (!owner) return undefined;
      // The single-session policy of GeneXus conventions section 2: the newest login of a user ends the older session.
      return world.singleSession && world.newest.get(owner) !== token ? undefined : owner;
    })();

    const send = (body: string, status = 200) => {
      res.statusCode = status;
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><title>fixture</title>${body}`);
    };
    const redirect = (to: string, extra: Record<string, string> = {}) => {
      res.writeHead(302, { location: to, ...extra });
      res.end();
    };
    const readForm = (then: (form: URLSearchParams) => void) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => then(new URLSearchParams(body)));
    };
    /** The protected pages: no live session, back to the login page. */
    const guarded = (then: (who: string) => void) => (user ? then(user) : redirect('/wblogin'));
    /** A write that takes HOLD_MS, so two of them really are in flight together (and the check happens AFTER the wait). */
    const held = (then: () => void) => {
      world.inFlight += 1;
      world.maxInFlight = Math.max(world.maxInFlight, world.inFlight);
      setTimeout(() => {
        world.inFlight -= 1;
        then();
      }, HOLD_MS);
    };
    const filter = (q: string) => `<form method="get"><input id="filter" name="q" value="${escapeHtml(q)}"></form>`;
    const q = url.searchParams.get('q') ?? '';

    if (url.pathname === '/') return redirect(user ? '/app/hwbwkw01' : '/wblogin');

    if (url.pathname === '/wblogin' && req.method === 'POST') {
      return readForm((form) => {
        const name = form.get('u') ?? '';
        const expected = name === USER_A ? PASSWORD_A : name === USER_B ? PASSWORD_B : undefined;
        if (expected === undefined || form.get('p') !== expected) return redirect('/wblogin');
        world.logins += 1;
        const session = crypto.randomUUID();
        world.sessions.set(session, name);
        world.newest.set(name, session);
        redirect('/app/hwbwkw01', { 'set-cookie': `sid=${session}; Path=/; HttpOnly` });
      });
    }
    if (url.pathname === '/wblogin') {
      return send(
        '<form id="f" method="post" action="/wblogin"><input id="vUSER" name="u"><input id="vUSRPSWING" name="p" type="password">' +
          '<span onclick="BTNENTER()">Confirm</span></form><script>function BTNENTER(){document.getElementById("f").submit()}</script>',
      );
    }
    if (url.pathname === '/logout') {
      world.logouts += 1;
      return redirect('/wblogin', { 'set-cookie': 'sid=; Path=/; Max-Age=0' });
    }
    if (url.pathname === '/app/hwbwkw01') return guarded(() => send('<h1 id="home">Home</h1>'));

    // ---- simultaneous edit
    if (url.pathname === '/record' && req.method === 'POST') {
      return guarded(() =>
        readForm((form) =>
          held(() => {
            // Checked after the wait: two saves in flight both carry the version they were shown, and the first to land moves it.
            if (!world.lock || form.get('v') === String(world.version)) {
              world.version += 1;
              world.saves.push(form.get('note') ?? '');
              send('<p id="message">saved</p>');
            } else {
              send('<p id="message">conflict</p>', 409);
            }
          }),
        ),
      );
    }
    if (url.pathname === '/record') {
      return guarded(() =>
        send(`<span id="version">${world.version}</span><form method="post" action="/record"><input type="hidden" name="v" value="${world.version}"><input id="note" name="note"><button id="save" type="submit">Save</button></form>`),
      );
    }

    // ---- double submit
    if (url.pathname === '/new' && req.method === 'POST') {
      return guarded(() =>
        readForm((form) =>
          held(() => {
            const code = form.get('code') ?? '';
            if (world.unique && world.codes.includes(code)) return send('<p id="message">already exists</p>', 409);
            world.codes.push(code);
            send('<p id="message">created</p>');
          }),
        ),
      );
    }
    if (url.pathname === '/new') return guarded(() => send('<form method="post" action="/new"><input id="code" name="code"><button id="create" type="submit">Create</button></form>'));
    if (url.pathname === '/list') {
      return guarded(() => send(`${filter(q)}<table>${world.codes.filter((code) => code.includes(q)).map((code) => `<tr class="row"><td>${escapeHtml(code)}</td></tr>`).join('')}</table>`));
    }

    // ---- approval
    if (url.pathname === '/request' && req.method === 'POST') {
      return guarded((who) =>
        readForm((form) => {
          world.requests.push({ id: world.requests.length + 1, subject: form.get('subject') ?? '', owner: who, status: 'Pending' });
          send('<p id="message">sent</p>');
        }),
      );
    }
    if (url.pathname === '/request') return guarded(() => send('<form method="post" action="/request"><input id="subject" name="subject"><button id="send" type="submit">Send</button></form>'));
    if (url.pathname === '/inbox') {
      return guarded((who) => {
        if (who !== USER_B) return send('<p>not an approver</p>', 403);
        const rows = world.requests.filter((request) => request.status === 'Pending' && request.subject.includes(q));
        send(`${filter(q)}${rows.map((request) => `<a class="item" href="/review?id=${request.id}">${escapeHtml(request.subject)}</a>`).join('')}`);
      });
    }
    if (url.pathname === '/review') {
      return guarded(() => send(`<form method="post" action="/approve"><input type="hidden" name="id" value="${escapeHtml(url.searchParams.get('id') ?? '')}"><button id="approve" type="submit">Approve</button></form>`));
    }
    if (url.pathname === '/approve' && req.method === 'POST') {
      return guarded((who) =>
        readForm((form) => {
          const request = world.requests.find((item) => String(item.id) === form.get('id'));
          if (who !== USER_B || !request) return send('<p id="message">refused</p>', 403);
          request.status = 'Approved';
          send('<p id="message">approved</p>');
        }),
      );
    }
    if (url.pathname === '/mine') {
      return guarded((who) => {
        const rows = world.requests.filter((request) => request.owner === who && request.subject.includes(q));
        send(`${filter(q)}<table>${rows.map((request) => `<tr><td>${escapeHtml(request.subject)}</td><td class="status">${request.status}</td></tr>`).join('')}</table>`);
      });
    }
    send('<p>not found</p>', 404);
  };
}

const world = fresh();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-concurrency-smoke-'));
const templatesDir = path.resolve(import.meta.dirname, '..', 'templates', 'routines');
let fixture: { server: http.Server; origin: string };
let api: http.Server;
let call: (method: string, urlPath: string, body?: unknown) => Promise<{ status: number; text: string; json: Record<string, any> }>;

/** What each placeholder stands for in the fixture. `common` is shared; the scenario adds the pages it uses. */
function filled(file: string, specific: Record<string, string>): Record<string, any> {
  const origin = fixture.origin;
  const common: Record<string, string> = {
    TARGET_PROFILE: 'fixture', CREDENTIAL_SET: 'user-a', CREDENTIAL_SET_B: 'user-b', SURFACE: 'concurrency',
    POST_LOGIN_URL_TOKEN: 'hwbwkw01', LOGOUT_URL: `${origin}/logout`, LOGIN_URL_TOKEN: 'wblogin',
    ...specific,
  };
  const raw = fs.readFileSync(path.join(templatesDir, file), 'utf8').replace(/REPLACE_([A-Z0-9_]+)/g, (_match, key: string) => {
    const value = common[key];
    if (value === undefined) throw new Error(`no value for REPLACE_${key} in ${file}`);
    return value.startsWith('/') ? `${origin}${value}` : value;
  });
  // The README says: run it once, and when it passes make it active. The smoke saves it as active so it can be run by id.
  return { ...JSON.parse(raw), status: 'active' };
}

before(async () => {
  fixture = await listen(app(world));
  process.env.SCRAPFORAI_API_KEY = API_KEY;
  process.env.SCRAPFORAI_DATA_DIR = dataDir;
  // .env may pin ARTIFACT_DIR; dotenv never overrides an existing variable, so this keeps evidence in the temp dir.
  process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
  process.env.SCRAPFORAI_VAULT_KEY = crypto.randomBytes(32).toString('base64');
  process.env.ALLOWED_TARGET_ORIGINS = fixture.origin;
  process.env.ALLOWED_RESOURCE_ORIGINS = fixture.origin;
  process.env.ALLOW_EVALUATE = 'false';
  process.env.MAX_STEPS_PER_JOB = '50';

  const express = (await import('express')).default;
  const { apiAuth } = await import('../src/security/apiAuth.js');
  const { routinesRouter } = await import('../src/routes/routines.routes.js');
  const { saveTarget } = await import('../src/targets/targetStore.js');
  const { saveCredentialSet } = await import('../src/vault/credentials/credentialVault.js');

  // A plain profile: the login is included by the templates themselves, as the README tells. Two sessions of ONE credential need maxSessionsPerCredential >= 2.
  await saveTarget({
    id: 'fixture', name: 'Fixture', platform: 'generic', environment: 'dev', baseUrl: `${fixture.origin}/`,
    credentialSets: ['user-a', 'user-b'], noiseFilters: [], surfaces: {}, screens: [],
    flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 2 },
  });
  await saveCredentialSet('user-a', { boundOrigins: [fixture.origin], values: { loginUser: USER_A, loginPassword: PASSWORD_A }, tags: [] }, 'create');
  await saveCredentialSet('user-b', { boundOrigins: [fixture.origin], values: { loginUser: USER_B, loginPassword: PASSWORD_B }, tags: [] }, 'create');

  const server = express();
  server.use(express.json());
  server.use(apiAuth);
  server.use('/v1/routines', routinesRouter);
  api = server.listen(0);
  await new Promise<void>((resolve) => api.once('listening', resolve));
  const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  call = async (method, urlPath, body) => {
    const response = await fetch(`${apiUrl}${urlPath}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, json: JSON.parse(text) as Record<string, any> };
  };

  // The login template, filled and saved as `login` v1: the templates include exactly that.
  const login = await call('PUT', '/v1/routines/login', filled('gx-login.routine.json', {}));
  assert.ok(login.status === 200 || login.status === 201, login.text);
});

after(() => {
  api?.close();
  fixture?.server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const reset = (changes: Partial<World> = {}) => Object.assign(world, fresh(), changes);

/** Saves the template as a routine and runs it. A run that fails answers HTTP 500 with the result in the body, so the status code is not asserted. */
async function runTemplate(file: string, specific: Record<string, string>): Promise<Record<string, any>> {
  const id = file.replace('.routine.json', '');
  const saved = await call('PUT', `/v1/routines/${id}`, filled(file, specific));
  assert.ok(saved.status === 200 || saved.status === 201, saved.text);
  const run = await call('POST', `/v1/routines/${id}/run`, {});
  return run.json;
}

const failedAt = (result: Record<string, any>): string | undefined => (result.steps as Array<{ id?: string }>)[result.failedStepIndex as number]?.id;

const EDIT = {
  PAGE_URL: '/record', FIELD_SELECTOR: '#note', COUNTER_SELECTOR: '#version', TRIGGER_SELECTOR: '#save', MESSAGE_SELECTOR: '#message',
};
const DOUBLE = {
  PAGE_URL: '/new', FIELD_SELECTOR: '#code', TRIGGER_SELECTOR: '#create', MESSAGE_SELECTOR: '#message', LIST_URL: '/list', SEARCH_SELECTOR: '#filter', ROW_SELECTOR: 'tr.row',
};
const SESSION = { PAGE_URL: '/app/hwbwkw01', PAGE_URL_TOKEN: 'hwbwkw01', MAIN_SELECTOR: '#home' };
const APPROVAL = {
  PAGE_URL: '/request', FIELD_SELECTOR: '#subject', TRIGGER_SELECTOR: '#send', MESSAGE_SELECTOR: '#message', INBOX_URL: '/inbox', SEARCH_SELECTOR: '#filter',
  ITEM_SELECTOR: 'a.item', APPROVE_SELECTOR: '#approve', STATUS_URL: '/mine', STATUS_SELECTOR: 'td.status', APPROVED_TEXT: 'Approved',
};

test('simultaneous edit: one save wins, the other is told, and the counter moved by exactly one; without the lock the template turns red', async () => {
  reset();
  const good = await runTemplate('concurrency-simultaneous-edit.routine.json', EDIT);
  assert.equal(good.status, 'passed', JSON.stringify(good.steps?.filter((step: any) => step.status !== 'passed')));
  assert.equal(world.maxInFlight, 2, 'the SERVER saw both saves in flight at once: the template really races');
  assert.equal(world.saves.length, 1, 'optimistic locking let exactly one save through');
  assert.deepEqual([good.extracted.outcome_first, good.extracted.outcome_second].sort(), ['conflict', 'saved'], 'each user kept what the page told them');
  assert.equal(Number(good.extracted.counter_after), Number(good.extracted.counter_first) + 1);
  assert.deepEqual(Object.keys(good.actors).sort(), ['first', 'second'], 'main was never opened');
  assert.equal(world.logouts, 2, 'the teardown of the included login logged each actor out');
  assert.equal(good.teardownStatus, 'passed');

  // The control: no lock, so both saves are accepted (a lost update) and the counter moves by two.
  reset({ lock: false });
  const lost = await runTemplate('concurrency-simultaneous-edit.routine.json', EDIT);
  assert.equal(lost.status, 'failed', 'a lost update must turn the template red');
  assert.equal(failedAt(lost), 'exactly-one-saved');
  assert.match(String(lost.error?.message ?? lost.error), /difference 1/);
  assert.equal(world.saves.length, 2);
  assert.equal(world.logouts, 2, 'the teardown still ran on the failing run');
});

test('double submit: the same value from two sessions leaves exactly one row; without the unique check the template turns red', async () => {
  reset();
  const good = await runTemplate('concurrency-double-submit.routine.json', DOUBLE);
  assert.equal(good.status, 'passed', JSON.stringify(good.steps?.filter((step: any) => step.status !== 'passed')));
  assert.equal(world.maxInFlight, 2, 'both submits were in flight together');
  assert.equal(world.codes.length, 1, 'one row');
  assert.deepEqual([good.extracted.outcome_first, good.extracted.outcome_second].sort(), ['already exists', 'created']);
  assert.equal(good.parameters.values.code, world.codes[0], 'the unique value the run generated is the one that was stored');

  reset({ unique: false });
  const duplicated = await runTemplate('concurrency-double-submit.routine.json', DOUBLE);
  assert.equal(duplicated.status, 'failed', 'two rows must turn the template red');
  assert.equal(failedAt(duplicated), 'exactly-one-record');
  assert.equal(world.codes.length, 2);
  assert.equal(world.codes[0], world.codes[1]);
});

test('single session: the same user logs in twice, the older session ends, the newest stays; if both live the template turns red', async () => {
  reset();
  const good = await runTemplate('concurrency-single-session.routine.json', SESSION);
  assert.equal(good.status, 'passed', JSON.stringify(good.steps?.filter((step: any) => step.status !== 'passed')));
  assert.equal(world.logins, 2, 'the same user logged in twice');
  assert.deepEqual(Object.keys(good.actors).sort(), ['first', 'second']);
  assert.equal(good.actors.first.credentialSet, good.actors.second.credentialSet, 'one credential, two sessions');

  // The control: the application lets both sessions live, so the first one is never sent back to the login.
  reset({ singleSession: false });
  const both = await runTemplate('concurrency-single-session.routine.json', SESSION);
  assert.equal(both.status, 'failed');
  assert.equal(failedAt(both), 'first-ended');
});

test('approval flow: the request reaches the approver and the decision comes back to the requester', async () => {
  reset();
  const good = await runTemplate('concurrency-approval-flow.routine.json', APPROVAL);
  assert.equal(good.status, 'passed', JSON.stringify(good.steps?.filter((step: any) => step.status !== 'passed')));
  assert.equal(world.requests.length, 1);
  assert.equal(world.requests[0]!.status, 'Approved');
  assert.equal(world.requests[0]!.owner, USER_A, 'the requester is the first user');
  assert.equal(world.requests[0]!.subject, good.parameters.values.subject);
  assert.deepEqual(Object.keys(good.actors).sort(), ['approver', 'requester']);
  assert.equal(world.logouts, 2);
});

test('no run leaked a vault value into its result', async () => {
  reset();
  const result = await runTemplate('concurrency-simultaneous-edit.routine.json', EDIT);
  const text = JSON.stringify(result);
  for (const secret of [PASSWORD_A, PASSWORD_B, USER_A, USER_B]) assert.ok(!text.includes(secret), 'a vault value reached the result');
});
