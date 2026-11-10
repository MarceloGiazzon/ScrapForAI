import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// Credentials screen in Chromium against the REAL server (CSP, session cookie, roles, the encrypted vault): an admin adds a set with an admin key
// typed on the page, the typed values reach the vault intact and appear NOWHERE else (page, storage, any reply, any URL, the audit log, disk);
// edits only the metadata, replaces the values, is told what a partial replacement needs, sees a webhook's set as managed, and deletes. A runner
// sees the list but not the form.

const ROOT_KEY = 'smoke-root-key-0123456789abcdef';
const VAULT_KEY = crypto.randomBytes(32).toString('base64');
const USER = 'qa.user@example.com';
const SECRET = 'Zq9!-sentinel-PW-4821';
const SECRET_2 = 'Mx7#-second-sentinel-6093';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-credentials-ui-smoke-'));
const repo = path.resolve(import.meta.dirname, '..');

// The test process reads the vault back to prove what was typed arrived: same data directory, same key.
process.env.SCRAPFORAI_API_KEY = ROOT_KEY;
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.SCRAPFORAI_VAULT_KEY = VAULT_KEY;
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
const env = {
  ...process.env,
  PORT: String(port),
  HOST: '127.0.0.1',
  NODE_ENV: 'development',
  LOG_LEVEL: 'silent',
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const auth = { authorization: `Bearer ${ROOT_KEY}` };

function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) hits.push(...filesContaining(full, needle));
    else if (fs.readFileSync(full).includes(needle)) hits.push(full);
  }
  return hits;
}

test('an admin manages credential sets from the Credentials screen; the typed values go to the vault and nowhere else', async () => {
  const { resolveCredentialSet } = await import('../src/vault/credentials/credentialVault.js');
  /** What the vault really holds. Reading records `lastUsedAt` in the background, so wait before the next change by the server. */
  const valuesOf = async (id: string) => {
    const set = await resolveCredentialSet(id, 'system');
    await sleep(500);
    return set?.values;
  };

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const problems: string[] = [];
    const watch = (page: import('playwright').Page) => {
      page.on('console', (message) => {
        // A 401/403/409 the test provokes on purpose is logged by the browser as a console error; a CSP violation or script error is not allowed.
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
    const replies: string[] = [];
    const requests: Array<{ method: string; url: string; bearer: boolean; body: string }> = [];
    page.on('request', async (request) => {
      const headers = await request.allHeaders();
      requests.push({ method: request.method(), url: request.url(), bearer: (headers['authorization'] ?? '').startsWith('Bearer '), body: request.postData() ?? '' });
    });
    page.on('response', async (response) => {
      try {
        if (response.url().includes('/v1/')) replies.push(await response.text());
      } catch {
        // a reply cut short by a navigation
      }
    });

    await signIn(page, ROOT_KEY);
    await page.goto(`${base}/ui/credentials.html`);
    await page.locator('#cred-admin:not(.hidden)').waitFor();
    assert.match((await page.locator('#cred-me').textContent()) ?? '', /Signed in as root \(admin\)/);
    await page.locator('#cred-summary', { hasText: 'No credential set yet' }).waitFor();
    assert.match((await page.locator('header.topbar nav a.active').textContent()) ?? '', /Credentials/);

    // The form: a preset gives the two field names; the values are password inputs.
    await page.locator('#cred-id').fill('qa-admin');
    await page.locator('#cred-origins').fill('https://dev.example.com/some/path\nhttps://dev.example.com');
    await page.locator('#cred-preset-login').click();
    const valueInputs = page.locator('#cred-fields .field-row input[aria-label="Field value"]');
    assert.equal(await valueInputs.count(), 2);
    assert.equal(await valueInputs.first().getAttribute('type'), 'password');
    assert.equal(await valueInputs.first().getAttribute('autocomplete'), 'new-password');
    await valueInputs.nth(0).fill(USER);
    await valueInputs.nth(1).fill(SECRET);
    await page.locator('#cred-tags').fill('dev, admin');
    await page.locator('#cred-notes').fill('QA admin <b>bold</b>');

    // No key typed: nothing is saved with the session alone, and what was typed stays so it can be corrected.
    await page.locator('#cred-save').click();
    assert.match((await page.locator('#cred-error').textContent()) ?? '', /Type an admin API key above first/);
    assert.equal(await valueInputs.nth(1).inputValue(), SECRET);
    assert.equal(((await (await fetch(`${base}/v1/credentials`, { headers: auth })).json()) as { credentialSets: unknown[] }).credentialSets.length, 0);

    // A wrong key: an error on the page, not a bounce to the sign-in form; the key is forgotten.
    await page.locator('#admin-key').fill('not-a-real-key-0000000000');
    await page.locator('#key-form button[type=submit]').click();
    await page.locator('#cred-save').click();
    await page.locator('#cred-error', { hasText: /key was not accepted/ }).waitFor();
    assert.match(page.url(), /credentials\.html/);
    assert.match((await page.locator('#key-state').textContent()) ?? '', /No key/);

    // The right key: saved, and the typed values leave the page at once.
    await page.locator('#admin-key').fill(ROOT_KEY);
    await page.locator('#key-form button[type=submit]').click();
    assert.equal(await page.locator('#admin-key').inputValue(), '', 'the typed key leaves the input');
    await page.locator('#cred-save').click();
    await page.locator('#cred-done:not(.hidden)', { hasText: 'Saved qa-admin' }).waitFor();

    const row = page.locator('#cred-rows tr', { hasText: 'qa-admin' });
    await row.waitFor();
    const rowText = (await row.textContent()) ?? '';
    assert.match(rowText, /https:\/\/dev\.example\.com(?!\/)/, 'the origin is normalised (no path) and listed once');
    assert.equal(await row.locator('td').nth(1).locator('div').count(), 1);
    assert.deepEqual(await row.locator('.badge').allTextContents(), ['password', 'username'], 'field NAMES only');
    assert.match(rowText, /dev, admin/);
    assert.match(rowText, /QA admin <b>bold<\/b>/, 'notes are text, never markup');
    assert.equal(await page.locator('#cred-rows b').count(), 0);
    assert.match(rowText, /never/, 'last used');

    const inputsNow = await page.evaluate(() => [...document.querySelectorAll('input, textarea')].map((input) => (input as HTMLInputElement).value).join('|'));
    assert.ok(!inputsNow.includes(SECRET) && !inputsNow.includes(USER) && !inputsNow.includes(ROOT_KEY), 'nothing typed is left in any input');
    const pageText = await page.evaluate(() => document.documentElement.outerHTML + document.body.innerText);
    assert.ok(!pageText.includes(SECRET) && !pageText.includes(USER) && !pageText.includes(ROOT_KEY), 'nothing typed is in the page');
    const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie]));
    assert.ok(!stored.includes(SECRET) && !stored.includes(USER) && !stored.includes(ROOT_KEY), 'nothing typed in browser storage');

    // What the browser sent and received: the secret went only in the body of the save requests (the wrong key's attempt, which the server refused,
    // and the accepted one), each with the typed key as a Bearer token, and it came back in no reply and no URL.
    const posts = requests.filter((request) => request.method === 'POST' && request.url.endsWith('/v1/credentials/qa-admin'));
    assert.equal(posts.length, 2, 'the refused attempt and the accepted one; the attempt with no key at all sent nothing');
    assert.ok(posts.every((post) => post.bearer && post.body.includes(SECRET)), 'a change carries the typed key');
    assert.equal(requests.filter((request) => request.url.includes(SECRET) || request.url.includes(encodeURIComponent(SECRET))).length, 0, 'no secret in any URL');
    assert.equal(requests.filter((request) => request.body.includes(SECRET)).length, 2, 'the secret is in no other request');
    assert.ok(replies.length > 0 && replies.every((reply) => !reply.includes(SECRET) && !reply.includes(USER)), 'no reply returns a value');

    // The vault holds exactly what was typed; the API answers metadata only; nothing readable is on disk.
    assert.deepEqual(await valuesOf('qa-admin'), { username: USER, password: SECRET });
    const meta = (await (await fetch(`${base}/v1/credentials/qa-admin`, { headers: auth })).json()) as Record<string, unknown>;
    assert.deepEqual(meta.boundOrigins, ['https://dev.example.com']);
    assert.deepEqual(meta.fields, ['password', 'username']);
    assert.ok(!JSON.stringify(meta).includes(SECRET));
    assert.deepEqual(filesContaining(dataDir, SECRET), [], 'the secret is not readable in any file under the data directory');
    assert.deepEqual(filesContaining(dataDir, USER), []);

    // The audit log says who changed it, never what.
    const audit = (await (await fetch(`${base}/v1/audit?area=credentials`, { headers: auth })).json()) as { entries: Array<{ method?: string; path?: string; actor?: { via: string } }> };
    const entry = audit.entries.find((candidate) => candidate.method === 'POST' && candidate.path === '/v1/credentials/qa-admin');
    assert.ok(entry && entry.actor?.via === 'bearer', 'the change is in the audit log as made with the key');
    assert.ok(!JSON.stringify(audit).includes(SECRET));

    // The same id again is refused up front.
    await page.locator('#cred-id').fill('qa-admin');
    await page.locator('#cred-origins').fill('https://dev.example.com');
    await page.locator('#cred-fields input[aria-label="Field name"]').first().fill('username');
    await page.locator('#cred-fields input[aria-label="Field value"]').first().fill('whatever');
    await page.locator('#cred-save').click();
    assert.match((await page.locator('#cred-error').textContent()) ?? '', /already exists/);
    assert.equal(requests.filter((request) => request.body.includes('whatever')).length, 0, 'nothing was sent');
    await page.reload();
    await page.locator('#cred-admin:not(.hidden)').waitFor();
    await row.waitFor();

    // ---- edit: only the metadata, the stored values are kept
    await page.locator('#admin-key').fill(ROOT_KEY);
    await page.locator('#key-form button[type=submit]').click();
    await row.getByRole('button', { name: 'Edit' }).click();
    assert.equal(await page.locator('#cred-form-title').textContent(), 'Edit qa-admin');
    assert.equal(await page.locator('#cred-id').evaluate((input) => (input as HTMLInputElement).readOnly), true);
    assert.equal(await page.locator('#cred-origins').inputValue(), 'https://dev.example.com');
    assert.equal(await page.locator('#cred-tags').inputValue(), 'dev, admin');
    const names = page.locator('#cred-fields input[aria-label="Field name"]');
    assert.deepEqual(await names.evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)), ['password', 'username']);
    const editValues = page.locator('#cred-fields input[aria-label="Field value"]');
    assert.deepEqual(await editValues.evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)), ['', ''], 'no value is ever shown');
    assert.match((await editValues.first().getAttribute('placeholder')) ?? '', /not shown/);

    await page.locator('#cred-tags').fill('dev, admin, nightly');
    await page.locator('#cred-save').click();
    await page.locator('#cred-done:not(.hidden)', { hasText: 'stored values were kept' }).waitFor();
    assert.match((await row.textContent()) ?? '', /dev, admin, nightly/);
    assert.deepEqual(await valuesOf('qa-admin'), { username: USER, password: SECRET }, 'the values are untouched');

    // Changing one value needs all of them; adding a field with no value is refused: nothing is sent.
    const sentBefore = requests.filter((request) => request.method === 'PUT').length;
    await row.getByRole('button', { name: 'Edit' }).click();
    await page.locator('#cred-fields input[aria-label="Field value"]').first().fill(SECRET_2); // password only
    await page.locator('#cred-save').click();
    assert.match((await page.locator('#cred-error').textContent()) ?? '', /Field "password" has no value|Field "username" has no value/);
    await page.locator('#cred-cancel').click();
    await row.getByRole('button', { name: 'Edit' }).click();
    await page.locator('#cred-add-field').click();
    await page.locator('#cred-fields input[aria-label="Field name"]').last().fill('token');
    await page.locator('#cred-save').click();
    assert.match((await page.locator('#cred-error').textContent()) ?? '', /means replacing the values/);
    assert.equal(requests.filter((request) => request.method === 'PUT').length, sentBefore, 'neither attempt reached the server');
    await page.locator('#cred-cancel').click();
    assert.equal(await page.locator('#cred-form-title').textContent(), 'Add a credential set');
    assert.equal(await page.locator('#cred-id').inputValue(), '');

    // All values typed again: replaced together.
    await row.getByRole('button', { name: 'Edit' }).click();
    const replacement = page.locator('#cred-fields input[aria-label="Field value"]');
    await replacement.nth(0).fill(SECRET_2); // password
    await replacement.nth(1).fill('qa-two'); // username
    await page.locator('#cred-show').check();
    assert.equal(await replacement.first().getAttribute('type'), 'text', '"Show what I type" shows it');
    await page.locator('#cred-show').uncheck();
    assert.equal(await replacement.first().getAttribute('type'), 'password');
    await page.locator('#cred-save').click();
    await page.locator('#cred-done:not(.hidden)', { hasText: 'values were replaced' }).waitFor();
    assert.deepEqual(await valuesOf('qa-admin'), { username: 'qa-two', password: SECRET_2 });
    assert.deepEqual(filesContaining(dataDir, SECRET_2), []);
    assert.ok(replies.every((reply) => !reply.includes(SECRET_2)));

    // ---- who may use it: a list of people of the team, set from the form
    const teamMember = await fetch(`${base}/v1/team/users`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'ben', name: 'Ben', role: 'runner' }) });
    assert.equal(teamMember.status, 201);
    const accessOf = async (id: string) => {
      const read = (await (await fetch(`${base}/v1/credentials/${id}`, { headers: auth })).json()) as { restricted: boolean; allowedUsers?: string[] };
      return { restricted: read.restricted, allowedUsers: read.allowedUsers };
    };
    assert.deepEqual(await accessOf('qa-admin'), { restricted: false, allowedUsers: undefined }, 'a set made before the feature is open');
    assert.match((await row.textContent()) ?? '', /everyone who can run/);

    await page.locator('#admin-key').fill(ROOT_KEY);
    await page.locator('#key-form button[type=submit]').click();
    await row.getByRole('button', { name: 'Edit' }).click();
    assert.equal(await page.locator('#cred-access').inputValue(), 'open');
    assert.equal(await page.locator('#cred-users').isVisible(), false, 'the people field only appears when the set is restricted');
    await page.locator('#cred-access').selectOption('list');
    assert.equal(await page.locator('#cred-users').isVisible(), true);
    await page.locator('#cred-users').fill('ben, nobody');
    await page.locator('#cred-save').click();
    await page.locator('#cred-error', { hasText: /not in the team: nobody/ }).waitFor();
    assert.deepEqual(await accessOf('qa-admin'), { restricted: false, allowedUsers: undefined }, 'a typo changed nothing');

    await page.locator('#cred-users').fill('ben');
    await page.locator('#cred-save').click();
    await page.locator('#cred-done:not(.hidden)', { hasText: 'stored values were kept' }).waitFor();
    assert.deepEqual(await accessOf('qa-admin'), { restricted: true, allowedUsers: ['ben'] });
    assert.deepEqual(await row.locator('td').nth(3).locator('.badge').allTextContents(), ['ben']);
    assert.deepEqual(await valuesOf('qa-admin'), { username: 'qa-two', password: SECRET_2 }, 'changing who may use it does not touch the values');

    // Editing again shows the list; an edit that changes only a note keeps it (the form sends the list it shows).
    await row.getByRole('button', { name: 'Edit' }).click();
    assert.equal(await page.locator('#cred-access').inputValue(), 'list');
    assert.equal(await page.locator('#cred-users').inputValue(), 'ben');
    await page.locator('#cred-notes').fill('still restricted');
    await page.locator('#cred-save').click();
    await page.locator('#cred-done:not(.hidden)', { hasText: 'stored values were kept' }).waitFor();
    assert.deepEqual(await accessOf('qa-admin'), { restricted: true, allowedUsers: ['ben'] });

    // An empty list is "admins only"; choosing Everyone removes the restriction (an explicit null: leaving the list out would keep it).
    await row.getByRole('button', { name: 'Edit' }).click();
    await page.locator('#cred-users').fill('');
    await page.locator('#cred-save').click();
    await page.locator('#cred-done:not(.hidden)', { hasText: 'stored values were kept' }).waitFor();
    assert.deepEqual(await accessOf('qa-admin'), { restricted: true, allowedUsers: [] });
    assert.deepEqual(await row.locator('td').nth(3).locator('.badge').allTextContents(), ['admins only']);
    await row.getByRole('button', { name: 'Edit' }).click();
    await page.locator('#cred-access').selectOption('open');
    await page.locator('#cred-save').click();
    await page.locator('#cred-done:not(.hidden)', { hasText: 'stored values were kept' }).waitFor();
    assert.deepEqual(await accessOf('qa-admin'), { restricted: false, allowedUsers: undefined });
    assert.match((await row.textContent()) ?? '', /everyone who can run/);
    assert.deepEqual(await valuesOf('qa-admin'), { username: 'qa-two', password: SECRET_2 });

    // ---- a set a webhook owns is listed but cannot be edited or deleted here
    const managed = await fetch(`${base}/v1/credentials/webhook-demo`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ boundOrigins: ['https://hooks.example.com'], values: { url: 'https://hooks.example.com/services/T000/B000/xyz' }, tags: ['webhook'] }),
    });
    assert.equal(managed.status, 200);
    const restrictedSet = await fetch(`${base}/v1/credentials/locked-demo`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ boundOrigins: ['https://dev.example.com'], values: { username: 'locked-user', password: 'locked-pass-8842' }, tags: [], allowedUsers: ['ben'] }),
    });
    assert.equal(restrictedSet.status, 200);
    await page.reload();
    await page.locator('#cred-admin:not(.hidden)').waitFor();
    const managedRow = page.locator('#cred-rows tr', { hasText: 'webhook-demo' });
    await managedRow.waitFor();
    assert.match((await managedRow.textContent()) ?? '', /managed by a webhook/);
    assert.equal(await managedRow.getByRole('button').count(), 0);
    assert.equal(await page.locator('#cred-rows tr', { hasText: 'qa-admin' }).getByRole('button').count(), 2);
    assert.deepEqual(await page.locator('#cred-rows tr', { hasText: 'locked-demo' }).locator('td').nth(3).locator('.badge').allTextContents(), ['ben'], 'an admin sees who');

    // ---- delete
    await page.locator('#admin-key').fill(ROOT_KEY);
    await page.locator('#key-form button[type=submit]').click();
    page.once('dialog', (dialog) => void dialog.dismiss());
    await page.locator('#cred-rows tr', { hasText: 'qa-admin' }).getByRole('button', { name: 'Delete' }).click();
    assert.equal((await fetch(`${base}/v1/credentials/qa-admin`, { headers: auth })).status, 200, 'a dismissed confirmation deletes nothing');
    page.once('dialog', (dialog) => void dialog.accept());
    await page.locator('#cred-rows tr', { hasText: 'qa-admin' }).getByRole('button', { name: 'Delete' }).click();
    await page.locator('#cred-rows tr', { hasText: 'qa-admin' }).waitFor({ state: 'detached' });
    await page.locator('#cred-done', { hasText: 'Deleted qa-admin' }).waitFor();
    assert.equal((await fetch(`${base}/v1/credentials/qa-admin`, { headers: auth })).status, 404);

    // ---- a runner sees which sets exist, but no form and no buttons
    const person = await fetch(`${base}/v1/team/users`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'ana', name: 'Ana', role: 'runner' }),
    });
    const anaKey = ((await person.json()) as { key: string }).key;
    const runnerPage = await browser.newPage();
    watch(runnerPage);
    await signIn(runnerPage, anaKey);
    await runnerPage.goto(`${base}/ui/credentials.html`);
    await runnerPage.locator('#cred-banner .warn-banner').waitFor();
    assert.match((await runnerPage.locator('#cred-banner').textContent()) ?? '', /for admins/);
    assert.match((await runnerPage.locator('#cred-me').textContent()) ?? '', /Signed in as ana \(runner\)/);
    await runnerPage.locator('#cred-rows tr', { hasText: 'webhook-demo' }).waitFor();
    const lockedRow = runnerPage.locator('#cred-rows tr', { hasText: 'locked-demo' });
    assert.deepEqual(await lockedRow.locator('td').nth(3).locator('.badge').allTextContents(), ['restricted'], 'a runner learns THAT it is restricted');
    assert.ok(!((await lockedRow.textContent()) ?? '').includes('ben'), 'but not who may use it');
    assert.equal(await runnerPage.locator('#cred-admin.hidden').count(), 1);
    assert.equal(await runnerPage.locator('#cred-rows button').count(), 0);
    await runnerPage.close();

    assert.deepEqual(problems, [], 'no CSP violation or script error');
  } finally {
    await browser.close();
  }
});
