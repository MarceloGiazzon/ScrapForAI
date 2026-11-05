import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// T10.2 end to end (real Chromium). The GeneXus pack is INSTALLED the way a company would install it -- planPack fills the templates from an answers
// file, then every item is saved through the real API (profile first, then the login, then the screens) -- and the screen templates are RUN against a
// fixture that behaves like a GeneXus application: a GAM login with a gate, a Work With whose grid is loaded by an XHR, a Transaction form that inserts and a
// list that deletes, and a Prompt that opens in an iframe and fills the form. For each scenario there is a control with the defect switched on, and the
// template must turn red at the step that names it: a template that stays green on a broken screen is worth nothing.

const API_KEY = 'test-api-key-1234567890';
const USER = 'gx-test-user-7f3k';
const PASSWORD = 'S3NT1NEL-gx-pw-81';

interface World {
  customers: Array<{ code: string; name: string }>;
  inserts: string[];
  ignoreFilter: boolean;
  duplicateOnInsert: boolean;
  leakOnInsert: boolean;
  promptBroken: boolean;
  logins: number;
  logouts: number;
}
const fresh = (): World => ({
  customers: [
    { code: 'G1', name: 'Globex Inc' },
    { code: 'A1', name: 'ACME Corp' },
  ],
  inserts: [],
  ignoreFilter: false,
  duplicateOnInsert: false,
  leakOnInsert: false,
  promptBroken: false,
  logins: 0,
  logouts: 0,
});
const world = fresh();
const sessions = new Set<string>();

const listen = (handler: http.RequestListener): Promise<{ server: http.Server; origin: string }> =>
  new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });

const GRID_SCRIPT = `
function rows(list, withDelete, withSelect) {
  var body = '';
  list.forEach(function (c, i) {
    var n = ('000' + (i + 1)).slice(-4);
    body += '<tr class="gx-row"><td><span id="span_vNAME_' + n + '">' + c.name + '</span></td>' +
      (withDelete ? '<td><span id="vDELETE_' + n + '" onclick="askDelete(\\'' + c.code + '\\')">Delete</span></td>' : '') +
      (withSelect ? '<td><a class="select" id="vSELECT_' + n + '" onclick="pick(\\'' + c.name + '\\')">Select</a></td>' : '') + '</tr>';
  });
  document.getElementById('GridContainerTbl').innerHTML = body;
}
function search(withDelete, withSelect) {
  return fetch('/api/customers?q=' + encodeURIComponent(document.getElementById('vFILTER').value))
    .then(function (r) { return r.json(); }).then(function (list) { rows(list, withDelete, withSelect); });
}`;

function app(): http.RequestListener {
  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture');
    const cookies = Object.fromEntries((req.headers.cookie ?? '').split(';').map((part) => part.trim().split('=')).filter((pair) => pair[0]));
    const signedIn = sessions.has(cookies.sid ?? '');
    const send = (body: string, status = 200, type = 'text/html') => {
      res.writeHead(status, { 'content-type': type });
      res.end(type === 'text/html' ? `<!doctype html><title>fixture</title>${body}` : body);
    };
    const redirect = (to: string, extra: Record<string, string> = {}) => {
      res.writeHead(302, { location: to, ...extra });
      res.end();
    };
    const readBody = (then: (text: string) => void) => {
      let text = '';
      req.on('data', (chunk) => (text += chunk));
      req.on('end', () => then(text));
    };
    const page = (body: string) => (signedIn ? send(body) : redirect('/wblogin'));

    if (url.pathname === '/') return redirect(signedIn ? '/app/hhome' : '/wblogin');
    if (url.pathname === '/wblogin' && req.method === 'POST') {
      return readBody((text) => {
        const form = new URLSearchParams(text);
        if (form.get('u') !== USER || form.get('p') !== PASSWORD) return redirect('/wblogin');
        world.logins += 1;
        const sid = crypto.randomUUID();
        sessions.add(sid);
        redirect('/app/hhome', { 'set-cookie': `sid=${sid}; Path=/; HttpOnly` });
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
      sessions.delete(cookies.sid ?? '');
      return redirect('/wblogin', { 'set-cookie': 'sid=; Path=/; Max-Age=0' });
    }
    if (url.pathname === '/app/hhome') return page('<h1 id="home">Home</h1><span id="span_vVERSION">rev-4521</span>');

    // ---- the data API the pages call with fetch (a request the page makes, so waitForQuiet has something to wait for)
    if (url.pathname === '/api/customers' && req.method === 'GET') {
      if (!signedIn) return send('[]', 401, 'application/json');
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const all = world.ignoreFilter ? [...world.customers] : world.customers.filter((c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q));
      return setTimeout(() => send(JSON.stringify(all), 200, 'application/json'), 150);
    }
    if (url.pathname === '/api/customers' && req.method === 'POST') {
      return readBody((text) => {
        const { code } = JSON.parse(text) as { code: string };
        world.customers.push({ code, name: code });
        if (world.duplicateOnInsert) world.customers.push({ code, name: code });
        world.inserts.push(code);
        if (world.leakOnInsert) {
          return send('java.lang.NullPointerException\n\tat com.acme.erp.CustomerBC.save(CustomerBC.java:212)', 500, 'text/plain');
        }
        send('Record created', 200, 'text/plain');
      });
    }
    const del = /^\/api\/customers\/(.+)$/.exec(url.pathname);
    if (del && req.method === 'DELETE') {
      const index = world.customers.findIndex((c) => c.code === decodeURIComponent(del[1]!));
      if (index >= 0) world.customers.splice(index, 1);
      return send('deleted', 200, 'text/plain');
    }

    // ---- Work With
    if (url.pathname === '/app/hcustomers') {
      return page(`<input id="vFILTER"><span id="BTNSEARCH" onclick="search(true,false)">Search</span>
<span id="BTNCONFIRMDEL" style="display:none" onclick="doDelete()">Confirm</span><table id="GridContainerTbl"></table>
<script>${GRID_SCRIPT}
var pending = null;
document.getElementById('vFILTER').addEventListener('keydown', function (e) { if (e.key === 'Enter') search(true, false); });
function askDelete(code) { pending = code; document.getElementById('BTNCONFIRMDEL').style.display = 'inline'; }
function doDelete() { fetch('/api/customers/' + encodeURIComponent(pending), { method: 'DELETE' }).then(function () { document.getElementById('BTNCONFIRMDEL').style.display = 'none'; return search(true, false); }); }
</script>`);
    }

    // ---- Transaction (insert mode)
    if (url.pathname === '/app/hcustomer') {
      return page(`<input id="vCODE"><span id="BTNSAVE" onclick="save()">Confirm</span><p id="span_MESSAGE" style="display:none"></p>
<script>
function save() {
  fetch('/api/customers', { method: 'POST', body: JSON.stringify({ code: document.getElementById('vCODE').value }) })
    .then(function (r) { return r.text(); })
    .then(function (text) { var m = document.getElementById('span_MESSAGE'); m.textContent = text; m.style.display = 'block'; });
}
</script>`);
    }

    // ---- Prompt: a form whose lookup button opens a layer with an iframe
    if (url.pathname === '/app/horder') {
      return page(`<span id="vPROMPT" onclick="openPrompt()">...</span> <span id="span_vNAME"></span><div id="host"></div>
<script>function openPrompt() { document.getElementById('host').innerHTML = '<div id="popup"><iframe src="/app/hprompt" width="400" height="300"></iframe></div>'; }</script>`);
    }
    if (url.pathname === '/app/hprompt') {
      return page(`<input id="vFILTER"><span id="BTNSEARCH" onclick="search(false,true)">Search</span><table id="GridContainerTbl"></table>
<script>${GRID_SCRIPT}
function pick(name) {
  ${'__BROKEN__' /* replaced below */}
}
</script>`.replace('__BROKEN__', world.promptBroken ? '/* the application forgot to send the value back */ parent.document.getElementById("popup").remove();' : 'parent.document.getElementById("span_vNAME").textContent = name; parent.document.getElementById("popup").remove();'));
    }

    send('not found', 404);
  };
}

let fixture: { server: http.Server; origin: string };
let api: http.Server;
let call: (method: string, urlPath: string, body?: unknown) => Promise<{ status: number; text: string; json: Record<string, any> }>;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-gxpack-smoke-'));

before(async () => {
  fixture = await listen(app());
  process.env.SCRAPFORAI_API_KEY = API_KEY;
  process.env.SCRAPFORAI_DATA_DIR = dataDir;
  process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
  process.env.SCRAPFORAI_VAULT_KEY = crypto.randomBytes(32).toString('base64');
  process.env.ALLOWED_TARGET_ORIGINS = fixture.origin;
  process.env.ALLOWED_RESOURCE_ORIGINS = fixture.origin;
  process.env.ALLOW_EVALUATE = 'false';
  process.env.MAX_STEPS_PER_JOB = '50';

  const express = (await import('express')).default;
  const { apiAuth } = await import('../src/security/apiAuth.js');
  const { routinesRouter } = await import('../src/routes/routines.routes.js');
  const { targetsRouter } = await import('../src/routes/targets.routes.js');
  const { saveCredentialSet } = await import('../src/vault/credentials/credentialVault.js');
  await saveCredentialSet('gx-user', { boundOrigins: [fixture.origin], values: { loginUser: USER, loginPassword: PASSWORD }, tags: [] }, 'create');

  const server = express();
  server.use(express.json());
  server.use(apiAuth);
  server.use('/v1/routines', routinesRouter);
  server.use('/v1/targets', targetsRouter);
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
});

after(async () => {
  api?.close();
  fixture?.server.closeAllConnections();
  await new Promise<void>((resolve) => fixture?.server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const reset = (changes: Partial<World> = {}) => {
  Object.assign(world, fresh(), changes);
};
const failedAt = (result: Record<string, any>): string | undefined => (result.steps as Array<{ id?: string }>)[result.failedStepIndex as number]?.id;
const run = async (id: string): Promise<Record<string, any>> => (await call('POST', `/v1/routines/${id}/run`, {})).json;

test('the pack installs from an answers file: profile first, then the login, then the screens; nothing is sent while something is missing', async () => {
  const { loadTemplates, parseAnswers, planPack } = await import('../src/pack/genexusPack.js');
  const { targetProfileSchema } = await import('../src/schemas/targetProfile.schema.js');
  const { mcpSaveRoutineSchema } = await import('../src/schemas/libraryRoutine.schema.js');
  const o = fixture.origin;
  const answers = {
    target: { template: 'genexus-dev', id: 'gx-app' },
    routines: ['login', 'smoke-page', 'work-with-search', 'transaction-insert', 'prompt-select'],
    values: {
      REPLACE_APP_NAME: 'Fixture ERP', REPLACE_BASE_URL: `${o}/`, REPLACE_CREDENTIAL_SET: 'gx-user', REPLACE_POST_LOGIN_URL_TOKEN: 'hhome',
      REPLACE_BUILD_PAGE_URL: `${o}/app/hhome`, REPLACE_BUILD_SELECTOR: '#span_vVERSION', REPLACE_HOME_URL: `${o}/app/hhome`, REPLACE_LOGOUT_URL: `${o}/logout`,
      REPLACE_SURFACE: 'customers',
      // the pages
      REPLACE_LIST_URL: `${o}/app/hcustomers`, REPLACE_PAGE_URL_TOKEN: 'hcustomers', REPLACE_MAIN_SELECTOR: '#vFILTER',
      REPLACE_SEARCH_SELECTOR: '#vFILTER', REPLACE_SEARCH_BUTTON_SELECTOR: '#BTNSEARCH', REPLACE_ROW_SELECTOR: 'table#GridContainerTbl tr.gx-row',
      REPLACE_FIRST_ROW_TEXT_SELECTOR: '#span_vNAME_0001', REPLACE_SEARCH_TEXT: 'ACME',
      REPLACE_FIELD_SELECTOR: '#vCODE', REPLACE_TRIGGER_SELECTOR: '#BTNSAVE', REPLACE_MESSAGE_SELECTOR: '#span_MESSAGE',
      REPLACE_DELETE_SELECTOR: '#vDELETE_0001', REPLACE_CONFIRM_DELETE_SELECTOR: '#BTNCONFIRMDEL',
      REPLACE_PROMPT_BUTTON_SELECTOR: '#vPROMPT', REPLACE_PROMPT_URL_TOKEN: 'hprompt', REPLACE_PROMPT_FILTER_SELECTOR: '#vFILTER',
      REPLACE_PROMPT_SEARCH_SELECTOR: '#BTNSEARCH', REPLACE_PROMPT_ROW_SELECTOR: 'table#GridContainerTbl tr.gx-row', REPLACE_PROMPT_PICK_SELECTOR: '#vSELECT_0001',
      REPLACE_RESULT_SELECTOR: '#span_vNAME', REPLACE_EXPECTED_TEXT: 'ACME Corp',
    },
    // the same placeholder means a different page in each routine
    routineValues: {
      'smoke-page': { REPLACE_PAGE_URL: `${o}/app/hcustomers` },
      'transaction-insert': { REPLACE_PAGE_URL: `${o}/app/hcustomer` },
      'prompt-select': { REPLACE_PAGE_URL: `${o}/app/horder` },
    },
  };

  const parsed = parseAnswers(answers);
  assert.deepEqual(parsed.problems, []);
  const templates = await loadTemplates(path.resolve(import.meta.dirname, '..', 'templates'));
  const validate = (item: { kind: string; id: string; body: Record<string, unknown> }) => {
    const result = item.kind === 'target' ? targetProfileSchema.safeParse({ ...item.body, id: item.id }) : mcpSaveRoutineSchema.safeParse({ id: item.id, ...item.body });
    return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  };

  // An answer left out: nothing to send, and the message names it.
  const { REPLACE_SEARCH_TEXT: _left, ...missingOne } = answers.values;
  const incomplete = planPack({ ...parsed.answers!, values: missingOne }, templates, validate as never);
  assert.ok(incomplete.problems.some((problem) => /REPLACE_SEARCH_TEXT/.test(problem)), incomplete.problems.join('\n'));

  const plan = planPack(parsed.answers!, templates, validate as never);
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.items.map((item) => item.path), [
    '/v1/targets/gx-app', '/v1/routines/login', '/v1/routines/smoke-page', '/v1/routines/work-with-search', '/v1/routines/transaction-insert', '/v1/routines/prompt-select',
  ]);

  for (const item of plan.items) {
    // The README says: run each once, and when it passes make it active. The smoke saves them active so they can be run by id.
    const body = item.kind === 'routine' ? { ...item.body, status: 'active' } : item.body;
    const saved = await call('PUT', item.path, body);
    assert.ok(saved.status === 200 || saved.status === 201, `${item.path}: ${saved.text}`);
    // The conventions are applied when a routine is saved: nothing the pack ships may produce an error, and a warning would be noise on day one.
    const lint = saved.json.lint as { findings?: Array<{ rule: string }> } | undefined;
    assert.deepEqual(lint?.findings ?? [], [], `${item.path} saved with convention findings`);
  }
});

test('the login routine of the pack logs in through the GAM form, passes the gate and logs out', async () => {
  reset();
  const result = await run('login');
  assert.equal(result.status, 'passed', JSON.stringify(result.steps?.filter((step: any) => step.status !== 'passed')));
  assert.equal(world.logins, 1);
  assert.equal(world.logouts, 1, 'the teardown released the session');
});

test('smoke page: reaches the page, is not bounced to the login', async () => {
  reset();
  const result = await run('smoke-page');
  assert.equal(result.status, 'passed', JSON.stringify(result.steps?.filter((step: any) => step.status !== 'passed')));
});

test('Work With: the grid shows rows with the value searched; a filter that is ignored turns the template red at the row check', async () => {
  reset();
  const good = await run('work-with-search');
  assert.equal(good.status, 'passed', JSON.stringify(good.steps?.filter((step: any) => step.status !== 'passed')));
  assert.equal(world.logouts, 1);

  reset({ ignoreFilter: true });
  const broken = await run('work-with-search');
  assert.equal(broken.status, 'failed');
  assert.equal(failedAt(broken), 'row-has-value');
});

test('Transaction: inserts a generated code, finds exactly one row and deletes it afterwards; a duplicate or a leaked stack trace turns it red, and the cleanup still runs', async () => {
  reset();
  const good = await run('transaction-insert');
  assert.equal(good.status, 'passed', JSON.stringify(good.steps?.filter((step: any) => step.status !== 'passed')));
  const code = good.parameters.values.code as string;
  assert.deepEqual(world.inserts, [code], 'the generated code is the one that was inserted');
  assert.equal(good.extracted.outcome, 'Record created');
  assert.equal(world.customers.some((customer) => customer.code === code), false, 'the teardown deleted what the run created');
  assert.equal(good.teardownStatus, 'passed');
  assert.equal(world.customers.length, 2, 'the data is as it was');

  reset({ duplicateOnInsert: true });
  const duplicated = await run('transaction-insert');
  assert.equal(duplicated.status, 'failed');
  assert.equal(failedAt(duplicated), 'exactly-one');

  reset({ leakOnInsert: true });
  const leaked = await run('transaction-insert');
  assert.equal(leaked.status, 'failed');
  assert.equal(failedAt(leaked), 'no-leak');
  assert.match(String(leaked.error?.message ?? ''), /exception|stackTrace/i);
  const leakedCode = leaked.parameters.values.code as string;
  assert.equal(world.customers.some((customer) => customer.code === leakedCode), false, 'the teardown ran after the failure and removed the record');
});

test('Prompt: opens in the iframe, filters, picks, and the form shows the pick; a prompt that forgets to send it back turns the template red', async () => {
  reset();
  const good = await run('prompt-select');
  assert.equal(good.status, 'passed', JSON.stringify(good.steps?.filter((step: any) => step.status !== 'passed')));

  reset({ promptBroken: true });
  const broken = await run('prompt-select');
  assert.equal(broken.status, 'failed');
  assert.equal(failedAt(broken), 'form-shows-pick');
});
