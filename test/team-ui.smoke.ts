import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// T10.1 Team screen in Chromium against the REAL server (CSP, session cookie, roles): an admin signs in with the installation key, adds a person
// with an admin key typed on the page, sees the key once, changes a role, revokes a key, reads the audit log and verifies its chain; a runner who
// opens the screen is told it is for admins. The key never reaches storage.

const ROOT_KEY = 'smoke-root-key-0123456789abcdef';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-team-ui-smoke-'));
const repo = path.resolve(import.meta.dirname, '..');

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  PORT: String(port),
  HOST: '127.0.0.1',
  NODE_ENV: 'development',
  LOG_LEVEL: 'silent',
  SCRAPFORAI_API_KEY: ROOT_KEY,
  SCRAPFORAI_DATA_DIR: dataDir,
  ARTIFACT_DIR: path.join(dataDir, 'artifacts'),
  ALLOWED_TARGET_ORIGINS: 'https://dev.example.com',
  SCHEDULER_ENABLED: 'false',
  UI_ENABLED: 'true',
};

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

test('an admin manages people and keys from the Team screen; a runner is told it is for admins', async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const problems: string[] = [];
    const watch = (page: import('playwright').Page) => {
      page.on('console', (message) => {
        // A 401/403 the test provokes on purpose is logged by the browser as a console error; a CSP violation or script error is not allowed.
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

    // ---- admin
    const page = await browser.newPage();
    watch(page);
    await signIn(page, ROOT_KEY);
    await page.goto(`${base}/ui/team.html`);
    await page.locator('#team-admin:not(.hidden)').waitFor();
    assert.match((await page.locator('#team-me').textContent()) ?? '', /Signed in as root \(admin\)/);
    assert.match((await page.locator('#team-summary').textContent()) ?? '', /No personal users yet/);
    assert.match((await page.locator('header.topbar nav a.active').textContent()) ?? '', /Team/);

    // No key typed: nothing is changed with the session alone.
    await page.locator('#add-id').fill('ana');
    await page.locator('#add-name').fill('Ana <b>Runner</b>');
    await page.locator('#add-role').selectOption('runner');
    await page.locator('#add-form button').click();
    assert.match((await page.locator('#team-error').textContent()) ?? '', /Type an admin API key above first/);
    assert.equal((await (await fetch(`${base}/v1/team/users`, { headers: { authorization: `Bearer ${ROOT_KEY}` } })).json() as { users: unknown[] }).users.length, 0);

    // A wrong key: an error on the page, not a bounce to the sign-in form.
    await page.locator('#admin-key').fill('not-a-real-key-0000000000');
    await page.locator('#key-form button[type=submit]').click();
    await page.locator('#add-form button').click();
    await page.locator('#team-error', { hasText: /key was not accepted/ }).waitFor();
    assert.match(page.url(), /team\.html/);
    assert.match((await page.locator('#key-state').textContent()) ?? '', /No key/, 'a rejected key is forgotten');

    // The right key: the person is created and the key is shown once.
    await page.locator('#admin-key').fill(ROOT_KEY);
    await page.locator('#key-form button[type=submit]').click();
    assert.equal(await page.locator('#admin-key').inputValue(), '', 'the typed key leaves the input');
    await page.locator('#add-form button').click();
    await page.locator('#new-key-card:not(.hidden)').waitFor();
    const anaKey = await page.locator('#new-key-value').inputValue();
    assert.match(anaKey, /^sfa_[0-9a-f]{12}_/);
    const row = page.locator('#people tr', { hasText: 'ana' });
    assert.match((await row.textContent()) ?? '', /Ana <b>Runner<\/b>/, 'a name is text, never markup');
    assert.equal(await page.locator('#people b').count(), 0);
    assert.equal(await row.locator('select').inputValue(), 'runner');
    assert.match((await row.textContent()) ?? '', /1 active/);

    await page.locator('#new-key-done').click();
    assert.equal(await page.locator('#new-key-value').inputValue(), '', 'the key is cleared from the page once hidden');
    assert.ok(!(await page.content()).includes(anaKey), 'the key is nowhere in the page after it is hidden');
    const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie]));
    assert.ok(!stored.includes(anaKey) && !stored.includes(ROOT_KEY), 'no key in browser storage');

    // A second key, then revoked.
    await row.getByRole('button', { name: 'Keys' }).click();
    await page.locator('#person-detail input[type=text]').fill('laptop');
    await page.locator('#person-detail select').selectOption('30');
    await page.locator('#person-detail button', { hasText: 'Create key' }).click();
    await page.locator('#new-key-card:not(.hidden)').waitFor();
    const laptopKey = await page.locator('#new-key-value').inputValue();
    assert.notEqual(laptopKey, anaKey);
    await page.locator('#new-key-done').click();
    const keyRow = page.locator('#person-detail tbody tr', { hasText: 'laptop' });
    await keyRow.waitFor();
    assert.match((await keyRow.textContent()) ?? '', /expires/);
    page.once('dialog', (dialog) => void dialog.accept());
    await keyRow.getByRole('button', { name: 'Revoke' }).click();
    await page.locator('#person-detail tbody tr', { hasText: 'laptop' }).getByText('revoked').first().waitFor();
    const laptopCheck = await fetch(`${base}/v1/auth/me`, { headers: { authorization: `Bearer ${laptopKey}` } });
    assert.equal(laptopCheck.status, 401, 'the revoked key stops working');
    const anaCheck = await fetch(`${base}/v1/auth/me`, { headers: { authorization: `Bearer ${anaKey}` } });
    assert.equal(anaCheck.status, 200, 'the other key still works');

    // ---- a runner opens the screen: told it is for admins, sees no people and no log
    const runnerPage = await browser.newPage();
    watch(runnerPage);
    await signIn(runnerPage, anaKey);
    await runnerPage.goto(`${base}/ui/team.html`);
    await runnerPage.locator('#team-banner .warn-banner').waitFor();
    assert.match((await runnerPage.locator('#team-banner').textContent()) ?? '', /for admins/);
    assert.match((await runnerPage.locator('#team-me').textContent()) ?? '', /Signed in as ana \(runner\)/);
    assert.equal(await runnerPage.locator('#people tr').count(), 0);
    assert.equal(await runnerPage.locator('#team-admin.hidden').count(), 1);
    await runnerPage.close();

    // ---- back as admin: change the role, disable, audit
    await page.locator('#admin-key').fill(ROOT_KEY);
    await page.locator('#key-form button[type=submit]').click();
    await page.locator('#people tr', { hasText: 'ana' }).locator('select').selectOption('viewer');
    await page.locator('#people tr', { hasText: 'ana' }).locator('td select', { hasText: 'viewer' }).waitFor();
    await page.waitForFunction(() => document.querySelector('#audit-rows') !== null);
    const me = await fetch(`${base}/v1/auth/me`, { headers: { authorization: `Bearer ${anaKey}` } });
    assert.equal(((await me.json()) as { user: { role: string } }).user.role, 'viewer', 'the role change reached the server');

    page.once('dialog', (dialog) => void dialog.accept());
    await page.locator('#people tr', { hasText: 'ana' }).getByRole('button', { name: 'Disable' }).click();
    await page.locator('#people tr', { hasText: 'ana' }).getByText('disabled', { exact: true }).waitFor();
    assert.equal((await fetch(`${base}/v1/auth/me`, { headers: { authorization: `Bearer ${anaKey}` } })).status, 401, 'a disabled person is out at once');

    await page.locator('#audit-search').click();
    await page.locator('#audit-rows tr', { hasText: 'POST /v1/team/users' }).first().waitFor();
    const log = (await page.locator('#audit-rows').textContent()) ?? '';
    assert.match(log, /root \(admin, bearer\)/, 'the changes were made with the typed key, not the session');
    assert.match(log, /PATCH \/v1\/team\/users\/ana/);
    assert.match(log, /auth\.login/);
    assert.ok(!log.includes(anaKey) && !log.includes(ROOT_KEY), 'no key in the log');

    await page.locator('#audit-user').fill('nobody');
    await page.locator('#audit-search').click();
    await page.locator('#audit-count', { hasText: 'Nothing recorded' }).waitFor();

    await page.locator('#audit-verify').click();
    await page.locator('#audit-verdict', { hasText: 'chain intact' }).waitFor();

    // Delete: the row goes away.
    page.once('dialog', (dialog) => void dialog.accept());
    await page.locator('#people tr', { hasText: 'ana' }).getByRole('button', { name: 'Delete' }).click();
    await page.locator('#people tr', { hasText: 'ana' }).waitFor({ state: 'detached' });

    assert.deepEqual(problems, [], 'no CSP violation or script error');
  } finally {
    await browser.close();
  }
});
