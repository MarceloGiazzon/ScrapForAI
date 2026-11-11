import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// Tables screen in Chromium against the REAL server (CSP, session cookie, roles, the immutable table library): a runner adds a table, saving the same
// content again makes no version, an edit makes version 2, an old version can be opened and downloaded, a malformed CSV and a cell shaped like a secret are
// refused with the server's reason and store nothing, and a viewer can read but not save.

const ROOT_KEY = 'smoke-root-key-0123456789abcdef';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-tables-ui-smoke-'));
const repo = path.resolve(import.meta.dirname, '..');

process.env.SCRAPFORAI_API_KEY = ROOT_KEY;
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'development', LOG_LEVEL: 'silent', SCHEDULER_ENABLED: 'false', UI_ENABLED: 'true' };

let child: ChildProcess;

before(async () => {
  child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout?.on('data', (chunk) => (output += chunk));
  child.stderr?.on('data', (chunk) => (output += chunk));
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`the server exited early:\n${output}`);
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the server did not start:\n${output}`);
});

after(async () => {
  child?.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const auth = { authorization: `Bearer ${ROOT_KEY}`, 'content-type': 'application/json' };
const api = async (method: string, route: string, body?: unknown) => {
  const response = await fetch(`${base}${route}`, { method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const CSV_V1 = 'qty,price,total\n1,10.00,10.00\n2,10.00,20.00\n999,10.00,9990.00\n1000,10.00,10000.00\n';
const CSV_V2 = `${CSV_V1}1001,10.00,10010.00\n`;

test('a runner manages tables from the Tables screen: versions, an old version, refusals; a viewer only reads', async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const problems: string[] = [];
    const watch = (page: import('playwright').Page) => {
      page.on('console', (message) => {
        // A 4xx the test provokes on purpose is logged by the browser as a console error; a CSP violation or script error is not allowed.
        if (message.type() === 'error' && !message.text().includes('Failed to load resource')) problems.push(message.text());
      });
      page.on('pageerror', (error) => problems.push(error.message));
    };
    const signIn = async (page: import('playwright').Page, key: string) => {
      await page.goto(`${base}/ui/login.html`);
      await page.locator('#api-key').fill(key);
      await page.locator('#login-form button[type=submit], #login-form button').first().click();
      await page.waitForURL(/index\.html/);
    };
    const keyOf = async (id: string, role: string): Promise<string> => {
      const created = await api('POST', '/v1/team/users', { id, name: `${id} test`, role });
      assert.equal(created.status, 201, JSON.stringify(created.json));
      return (created.json as { key: string }).key;
    };

    // ---- a runner (a session is enough: test data is not a secret)
    const runnerKey = await keyOf('rita', 'runner');
    const page = await browser.newPage();
    watch(page);
    const requests: Array<{ method: string; url: string; bearer: boolean }> = [];
    page.on('request', async (request) => requests.push({ method: request.method(), url: request.url(), bearer: ((await request.allHeaders())['authorization'] ?? '').startsWith('Bearer ') }));
    await signIn(page, runnerKey);
    await page.goto(`${base}/ui/tables.html`);
    await page.locator('#tab-editor:not(.hidden)').waitFor();
    assert.match((await page.locator('#tab-me').textContent()) ?? '', /Signed in as rita \(runner\)/);
    assert.match((await page.locator('header.topbar nav a.active').textContent()) ?? '', /Tables/);
    await page.locator('#tab-summary', { hasText: 'No table yet' }).waitFor();

    // The example fills the form; a first save is version 1.
    await page.locator('#tab-id').fill('order-totals');
    await page.locator('#tab-title').fill('Order <b>totals</b>');
    await page.locator('#tab-sample').click();
    await page.locator('#tab-csv').fill(CSV_V1);
    await page.locator('#tab-save').click();
    await page.locator('#tab-done:not(.hidden)', { hasText: 'Saved order-totals as version 1' }).waitFor();
    const row = page.locator('#tab-rows tr', { hasText: 'order-totals' });
    await row.waitFor();
    const rowText = (await row.textContent()) ?? '';
    assert.match(rowText, /v1/);
    assert.deepEqual(await row.locator('.badge').allTextContents(), ['qty', 'price', 'total']);
    assert.match(rowText, /Order <b>totals<\/b>/, 'the title is text, never markup');
    assert.equal(await page.locator('#tab-rows b').count(), 0);
    assert.equal(await row.locator('td').nth(4).textContent(), '4');
    // The form is now "editing" that table: id locked, the version picker and the download link are there.
    assert.equal(await page.locator('#tab-id').evaluate((input) => (input as HTMLInputElement).readOnly), true);
    assert.match((await page.locator('#tab-form-title').textContent()) ?? '', /Edit order-totals \(opened v1\)/);
    assert.deepEqual(await page.locator('#tab-version option').allTextContents(), ['v1 (current)']);
    assert.match((await page.locator('#tab-download').getAttribute('href')) ?? '', /\/v1\/tables\/order-totals\?version=1&format=csv/);

    // The same content again: no new version, and the page says so.
    await page.locator('#tab-save').click();
    await page.locator('#tab-done:not(.hidden)', { hasText: 'nothing was stored' }).waitFor();
    assert.deepEqual((await api('GET', '/v1/tables/order-totals')).json.versions, [1]);

    // An edit is version 2; line ends and a final newline are not content.
    await page.locator('#tab-csv').fill(CSV_V2.replaceAll('\n', '\r\n'));
    await page.locator('#tab-save').click();
    await page.locator('#tab-done:not(.hidden)', { hasText: 'Saved order-totals as version 2' }).waitFor();
    // The message appears as soon as the server answers; the list and the version picker are re-read right after (loadTables, then open). Wait for
    // the state, not only for the message: asserting at once read the old picker whenever the machine was busy (it failed 2 of 3 runs on the commit before this one too).
    await page.locator('#tab-version option', { hasText: 'v2 (current)' }).waitFor({ state: 'attached' });
    await row.locator('td', { hasText: /^5$/ }).waitFor();
    assert.deepEqual(await page.locator('#tab-version option').allTextContents(), ['v2 (current)', 'v1']);
    assert.equal(await row.locator('td').nth(4).textContent(), '5');
    assert.match((await row.textContent()) ?? '', /v2/);

    // An old version can be opened; it is shown as it was, and saving it would be a NEW version with that content.
    await page.locator('#tab-version').selectOption('1');
    await page.locator('#tab-form-title', { hasText: 'opened v1' }).waitFor();
    assert.equal((await page.locator('#tab-csv').inputValue()).replaceAll('\r\n', '\n'), CSV_V1);
    assert.match((await page.locator('#tab-download').getAttribute('href')) ?? '', /version=1&format=csv/);
    assert.equal((await page.request.get(`${base}${await page.locator('#tab-download').getAttribute('href')}`)).status(), 200);

    // A malformed CSV and a cell shaped like a secret are refused with the server's reason, and store nothing.
    await page.locator('#tab-cancel').click();
    assert.equal(await page.locator('#tab-form-title').textContent(), 'Add a table');
    await page.locator('#tab-id').fill('broken');
    await page.locator('#tab-csv').fill('a,b\n1,2,3\n');
    await page.locator('#tab-save').click();
    await page.locator('#tab-error:not(.hidden)').waitFor();
    assert.match((await page.locator('#tab-error').textContent()) ?? '', /line 2/i, 'the server names the line');
    assert.equal((await api('GET', '/v1/tables/broken')).status, 404);

    const SECRETISH = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456ghi789jkl';
    await page.locator('#tab-csv').fill(`user,token\nana,${SECRETISH}\n`);
    await page.locator('#tab-save').click();
    await page.locator('#tab-error:not(.hidden)').waitFor();
    assert.ok(!((await page.locator('#tab-error').textContent()) ?? '').includes(SECRETISH), 'the refused cell is not echoed');
    assert.equal((await api('GET', '/v1/tables/broken')).status, 404);

    // The same id as an existing table is refused up front, with nothing sent.
    await sleep(400); // the request log is filled asynchronously (allHeaders): let the last save settle before counting
    const putsBefore = requests.filter((request) => request.method === 'PUT').length;
    await page.locator('#tab-id').fill('order-totals');
    await page.locator('#tab-csv').fill('x\n1\n');
    await page.locator('#tab-save').click();
    assert.match((await page.locator('#tab-error').textContent()) ?? '', /already exists/);
    await sleep(400);
    assert.equal(requests.filter((request) => request.method === 'PUT').length, putsBefore);
    assert.ok(requests.filter((request) => request.method === 'PUT').every((request) => !request.bearer), 'saving a table uses the session, not an admin key');

    // ---- a viewer reads, never saves
    const viewerKey = await keyOf('vic', 'viewer');
    const viewerPage = await browser.newPage();
    watch(viewerPage);
    await signIn(viewerPage, viewerKey);
    await viewerPage.goto(`${base}/ui/tables.html`);
    await viewerPage.locator('#tab-banner .warn-banner').waitFor();
    await viewerPage.locator('#tab-rows tr', { hasText: 'order-totals' }).getByRole('button', { name: 'View' }).click();
    await viewerPage.locator('#tab-form-title', { hasText: 'View order-totals' }).waitFor();
    assert.equal((await viewerPage.locator('#tab-csv').inputValue()).replaceAll('\r\n', '\n'), CSV_V2);
    assert.equal(await viewerPage.locator('#tab-csv').evaluate((area) => (area as HTMLTextAreaElement).readOnly), true);
    assert.equal(await viewerPage.locator('#tab-save').isHidden(), true);
    await viewerPage.close();
    // ...and the server agrees: the viewer's session cannot PUT.
    assert.equal((await fetch(`${base}/v1/tables/by-viewer`, { method: 'PUT', headers: { authorization: `Bearer ${viewerKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ csv: 'a\n1\n' }) })).status, 403);

    assert.deepEqual(problems, [], 'no CSP violation, script error or unexpected console error');
  } finally {
    await browser.close();
  }
});
