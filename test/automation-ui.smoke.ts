import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// Automation screen (schedules and webhooks) in Chromium against the REAL server (CSP, session cookie, roles, the encrypted vault, the validation of the
// schedule and webhook stores): an admin adds a webhook with an admin key typed on the page, the typed address reaches the vault intact and appears
// NOWHERE else (page, storage, any reply, any URL, the audit log, disk), sends a test message to a real local receiver, adds schedules of four kinds,
// edits, disables, is shown the server's refusals (a cron that can never fire, run-now with the scheduler off, deleting a webhook a schedule uses), and
// deletes. A runner sees the lists but not the forms.

const ROOT_KEY = 'smoke-root-key-0123456789abcdef';
const VAULT_KEY = crypto.randomBytes(32).toString('base64');
const HOOK_SECRET = 'whk-sentinel-7Q2x9-4821';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-automation-ui-smoke-'));
const repo = path.resolve(import.meta.dirname, '..');

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
const receiverPort = await freePort();
const base = `http://127.0.0.1:${port}`;
const receiverOrigin = `http://127.0.0.1:${receiverPort}`;
const HOOK_URL = `${receiverOrigin}/hook/${HOOK_SECRET}`;
process.env.ALLOWED_NOTIFY_ORIGINS = receiverOrigin;
const env = {
  ...process.env,
  PORT: String(port),
  HOST: '127.0.0.1',
  NODE_ENV: 'development',
  LOG_LEVEL: 'silent',
  SCHEDULER_ENABLED: 'false',
  UI_ENABLED: 'true',
};

const received: Array<{ method: string; url: string; body: string }> = [];
const receiver = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    received.push({ method: req.method ?? '', url: req.url ?? '', body });
    res.writeHead(200).end('ok');
  });
});
await new Promise<void>((resolve) => receiver.listen(receiverPort, '127.0.0.1', resolve));

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
  receiver.close();
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const auth = { authorization: `Bearer ${ROOT_KEY}`, 'content-type': 'application/json' };
const api = async (method: string, route: string, body?: unknown) => {
  const response = await fetch(`${base}${route}`, { method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
};

function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) hits.push(...filesContaining(full, needle));
    else if (fs.readFileSync(full).includes(needle)) hits.push(full);
  }
  return hits;
}

test('an admin manages schedules and webhooks from the Automation screen; the webhook address goes to the vault and nowhere else', async () => {
  const { resolveCredentialSet } = await import('../src/vault/credentials/credentialVault.js');
  const urlOfWebhook = async (id: string) => {
    const set = await resolveCredentialSet(`webhook-${id}`);
    await sleep(500); // reading records lastUsedAt in the background
    return set?.values.url;
  };

  // Something to schedule: a target profile and a routine of the library.
  assert.equal((await api('PUT', '/v1/targets/shop', { name: 'Shop', platform: 'generic', environment: 'dev', baseUrl: 'https://dev.example.com', credentialSets: [], noiseFilters: [] })).status, 200);
  const saved = await api('PUT', '/v1/routines/smoke-r', { title: 'Smoke', status: 'active', targetProfile: 'shop', steps: [{ id: 'open', action: 'goto', url: 'https://dev.example.com/' }] });
  assert.equal(saved.status, 201, JSON.stringify(saved.json));

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
    const useKey = async (page: import('playwright').Page, key: string) => {
      await page.locator('#admin-key').fill(key);
      await page.locator('#key-form button[type=submit]').click();
    };

    const page = await browser.newPage();
    watch(page);
    page.on('dialog', (dialog) => void dialog.accept());
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
    await page.goto(`${base}/ui/automation.html`);
    await page.locator('#auto-admin:not(.hidden)').waitFor();
    assert.match((await page.locator('#auto-me').textContent()) ?? '', /Signed in as root \(admin\)/);
    assert.match((await page.locator('header.topbar nav a.active').textContent()) ?? '', /Automation/);
    await page.locator('#sch-summary', { hasText: 'No schedule yet' }).waitFor();
    assert.match((await page.locator('#sch-summary').textContent()) ?? '', /scheduler is NOT running/, 'the page says nothing will fire on its own');
    await page.locator('#wh-summary', { hasText: 'No webhook yet' }).waitFor();
    assert.match((await page.locator('#sch-notify').textContent()) ?? '', /No webhook yet/);

    // ---- a webhook
    await page.locator('#wh-id').fill('team-qa');
    await page.locator('#wh-preset').selectOption('slack');
    await page.locator('#wh-lang').selectOption('pt');
    await page.locator('#wh-summary-on').check();
    await page.locator('#wh-summary-at').fill('09:30');
    await page.locator('#wh-notes').fill('QA <b>channel</b>');
    assert.equal(await page.locator('#wh-url').getAttribute('type'), 'password');
    assert.equal(await page.locator('#wh-url').getAttribute('autocomplete'), 'new-password');
    await page.locator('#wh-url').fill(HOOK_URL);

    // No key typed: nothing is saved with the session alone, and what was typed stays so it can be corrected.
    await page.locator('#wh-save').click();
    assert.match((await page.locator('#wh-error').textContent()) ?? '', /Type an admin API key above first/);
    assert.equal(await page.locator('#wh-url').inputValue(), HOOK_URL);
    assert.equal(((await api('GET', '/v1/webhooks')).json as { webhooks: unknown[] }).webhooks.length, 0);

    // A wrong key: an error on the page, not a bounce to the sign-in form; the key is forgotten.
    await useKey(page, 'not-a-real-key-0000000000');
    await page.locator('#wh-save').click();
    await page.locator('#wh-error', { hasText: /key was not accepted/ }).waitFor();
    assert.match(page.url(), /automation\.html/);
    assert.match((await page.locator('#key-state').textContent()) ?? '', /No key/);

    // The right key: saved, and the typed address leaves the page at once.
    await useKey(page, ROOT_KEY);
    assert.equal(await page.locator('#admin-key').inputValue(), '', 'the typed key leaves the input');
    await page.locator('#wh-save').click();
    await page.locator('#wh-done:not(.hidden)', { hasText: 'Saved team-qa' }).waitFor();
    assert.equal(await page.locator('#wh-url').inputValue(), '', 'the address leaves the input');

    const hookRow = page.locator('#wh-rows tr', { hasText: 'team-qa' });
    await hookRow.waitFor();
    const hookText = (await hookRow.textContent()) ?? '';
    assert.ok(hookText.includes(receiverOrigin), 'only the ORIGIN of the address is shown');
    assert.ok(!hookText.includes('/hook/') && !hookText.includes(HOOK_SECRET));
    assert.match(hookText, /Slack/);
    assert.match(hookText, /daily summary 09:30/);
    assert.match(hookText, /QA <b>channel<\/b>/, 'notes are text, never markup');
    assert.equal(await page.locator('#wh-rows b').count(), 0);
    assert.equal(await hookRow.locator('.badge.failed').count(), 0, 'the origin is allowed (ALLOWED_NOTIFY_ORIGINS), so no warning');

    const pageText = await page.evaluate(() => document.documentElement.outerHTML + document.body.innerText + [...document.querySelectorAll('input, textarea')].map((input) => (input as HTMLInputElement).value).join('|'));
    assert.ok(!pageText.includes(HOOK_SECRET) && !pageText.includes(ROOT_KEY), 'nothing typed is left in the page');
    const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie]));
    assert.ok(!stored.includes(HOOK_SECRET) && !stored.includes(ROOT_KEY));
    const puts = requests.filter((request) => request.method === 'PUT' && request.url.endsWith('/v1/webhooks/team-qa'));
    assert.equal(puts.length, 2, 'the refused attempt (wrong key) and the accepted one; the attempt with no key sent nothing');
    assert.ok(puts.every((put) => put.bearer && put.body.includes(HOOK_SECRET)), 'a change carries the typed key');
    assert.equal(requests.filter((request) => request.url.includes(HOOK_SECRET) || request.url.includes(encodeURIComponent(HOOK_SECRET))).length, 0, 'no address in any URL');
    assert.equal(requests.filter((request) => request.body.includes(HOOK_SECRET)).length, 2, 'the address is in no other request');
    assert.ok(replies.length > 0 && replies.every((reply) => !reply.includes(HOOK_SECRET)), 'no reply returns the address');
    assert.equal(await urlOfWebhook('team-qa'), HOOK_URL, 'the vault holds exactly what was typed');
    assert.deepEqual(filesContaining(dataDir, HOOK_SECRET).filter((file) => !file.endsWith('credentials.enc.json')), [], 'the address is readable in no file but the encrypted vault');
    assert.deepEqual(filesContaining(dataDir, HOOK_SECRET).filter((file) => file.endsWith('credentials.enc.json')), [], 'and not even there: it is encrypted');

    // A test message really reaches the receiver, and the delivery is shown.
    await hookRow.getByRole('button', { name: 'Send a test' }).click();
    await page.locator('#wh-done:not(.hidden)', { hasText: 'Sent a test message' }).waitFor();
    assert.ok(received.some((item) => item.method === 'POST' && item.url === `/hook/${HOOK_SECRET}`), 'the receiver got the test message');
    await hookRow.locator('.badge.passed', { hasText: 'sent' }).waitFor();

    // ---- schedules of four kinds
    await page.locator('#sch-id').fill('nightly-vault');
    await page.locator('#sch-kind').selectOption('vault');
    assert.equal(await page.locator('#sch-kind-vault').isVisible(), true);
    assert.equal(await page.locator('#sch-kind-routine').isVisible(), false);
    await page.locator('#sch-preset-nightly').click();
    assert.equal(await page.locator('#sch-cron').inputValue(), '0 2 * * *');
    await page.locator('#sch-notify input[value="team-qa"]').check();
    await page.locator('#sch-save').click();
    await page.locator('#sch-done:not(.hidden)', { hasText: 'Saved nightly-vault' }).waitFor();
    assert.match((await page.locator('#sch-done').textContent()) ?? '', /scheduler is not running/);
    const nightly = page.locator('#sch-rows tr', { hasText: 'nightly-vault' });
    await nightly.waitFor();
    const nightlyText = (await nightly.textContent()) ?? '';
    assert.match(nightlyText, /Regression vault/);
    assert.match(nightlyText, /0 2 \* \* \*/);
    assert.match(nightlyText, /enabled/);
    assert.match(nightlyText, /team-qa/);
    assert.deepEqual(((await api('GET', '/v1/schedules/nightly-vault')).json as { schedule: Record<string, unknown> }).schedule, {
      id: 'nightly-vault', cron: '0 2 * * *', timezone: 'America/Montevideo', target: { kind: 'vault' }, enabled: true, overlap: 'skip', jitterSeconds: 0, notify: ['team-qa'], retries: 1,
    });

    await page.locator('#sch-id').fill('routine-sched');
    await page.locator('#sch-kind').selectOption('routine');
    await page.locator('#sch-routine').selectOption('smoke-r');
    await page.locator('#sch-runprofile').selectOption('functional');
    await page.locator('#sch-cron').fill('*/30 * * * *');
    await page.locator('#sch-retries').selectOption('0');
    await page.locator('#sch-jitter').fill('45');
    await page.locator('#sch-save').click();
    await page.locator('#sch-done:not(.hidden)', { hasText: 'Saved routine-sched' }).waitFor();
    const routineSchedule = ((await api('GET', '/v1/schedules/routine-sched')).json as { schedule: { target: Record<string, unknown>; retries: number; jitterSeconds: number; notify: string[] } }).schedule;
    assert.deepEqual(routineSchedule.target, { kind: 'routine', routineId: 'smoke-r', profile: 'functional' }, 'blank optional fields are not sent');
    assert.equal(routineSchedule.retries, 0);
    assert.equal(routineSchedule.jitterSeconds, 45);
    assert.deepEqual(routineSchedule.notify, []);

    await page.locator('#sch-id').fill('weekly-summary');
    await page.locator('#sch-kind').selectOption('summary');
    await page.locator('#sch-sum-days').fill('14');
    await page.locator('#sch-sum-lang').selectOption('es');
    await page.locator('#sch-sum-file').uncheck();
    await page.locator('#sch-preset-monday').click();
    await page.locator('#sch-notify input[value="team-qa"]').check();
    await page.locator('#sch-save').click();
    await page.locator('#sch-done:not(.hidden)', { hasText: 'Saved weekly-summary' }).waitFor();
    assert.deepEqual(((await api('GET', '/v1/schedules/weekly-summary')).json as { schedule: { target: unknown } }).schedule.target, { kind: 'summary', periodDays: 14, lang: 'es', file: false });

    await page.locator('#sch-id').fill('snapshot-shop');
    await page.locator('#sch-kind').selectOption('evolutionSnapshot');
    await page.locator('#sch-snap-target').selectOption('shop');
    await page.locator('#sch-snap-build').fill('nightly-build');
    await page.locator('#sch-cron').fill('0 3 * * SUN');
    await page.locator('#sch-save').click();
    await page.locator('#sch-done:not(.hidden)', { hasText: 'Saved snapshot-shop' }).waitFor();
    assert.deepEqual(((await api('GET', '/v1/schedules/snapshot-shop')).json as { schedule: { target: unknown } }).schedule.target, { kind: 'evolutionSnapshot', targetProfile: 'shop', buildId: 'nightly-build' });
    assert.equal(await page.locator('#sch-rows tr').count(), 4);

    // The same id again is refused up front, and a form error sends nothing.
    await sleep(400); // the request log is filled asynchronously (allHeaders): let the last save settle before counting
    const sentBefore = requests.filter((request) => request.method === 'PUT').length;
    await page.locator('#sch-id').fill('nightly-vault');
    await page.locator('#sch-kind').selectOption('vault');
    await page.locator('#sch-cron').fill('0 5 * * *');
    await page.locator('#sch-save').click();
    assert.match((await page.locator('#sch-error').textContent()) ?? '', /already exists/);
    await page.locator('#sch-id').fill('bad-days');
    await page.locator('#sch-kind').selectOption('summary');
    await page.locator('#sch-sum-days').fill('99');
    await page.locator('#sch-save').click();
    // The browser's own validation (max=31) stops this one before the page's code runs; either way nothing is sent.
    assert.equal(await page.locator('#sch-sum-days').evaluate((input) => (input as HTMLInputElement).validity.rangeOverflow), true);
    await sleep(400);
    assert.equal(requests.filter((request) => request.method === 'PUT').length, sentBefore, 'neither attempt reached the server');

    // ---- edit: the form is filled from the stored definition
    await page.reload();
    await page.locator('#auto-admin:not(.hidden)').waitFor();
    await useKey(page, ROOT_KEY);
    await nightly.waitFor();
    await nightly.getByRole('button', { name: 'Edit' }).click();
    assert.equal(await page.locator('#sch-form-title').textContent(), 'Edit nightly-vault');
    assert.equal(await page.locator('#sch-id').evaluate((input) => (input as HTMLInputElement).readOnly), true);
    assert.equal(await page.locator('#sch-kind').inputValue(), 'vault');
    assert.equal(await page.locator('#sch-cron').inputValue(), '0 2 * * *');
    assert.equal(await page.locator('#sch-notify input[value="team-qa"]').isChecked(), true);
    await page.locator('#sch-cron').fill('0 0 31 2 *');
    await page.locator('#sch-save').click();
    await page.locator('#sch-error:not(.hidden)').waitFor();
    assert.ok(((await page.locator('#sch-error').textContent()) ?? '').length > 10, 'the server says why a cron that can never fire is refused');
    assert.equal(((await api('GET', '/v1/schedules/nightly-vault')).json as { schedule: { cron: string } }).schedule.cron, '0 2 * * *', 'the refused change did not apply');
    await page.locator('#sch-preset-weekdays').click();
    await page.locator('#sch-save').click();
    await page.locator('#sch-done:not(.hidden)', { hasText: 'Saved nightly-vault' }).waitFor();
    assert.equal(((await api('GET', '/v1/schedules/nightly-vault')).json as { schedule: { cron: string } }).schedule.cron, '0 8 * * MON-FRI');
    assert.equal(await page.locator('#sch-form-title').textContent(), 'Add a schedule', 'the form is back to adding');

    // ---- disable and enable: the stored definition is resent whole (no id in the body)
    const summaryRow = page.locator('#sch-rows tr', { hasText: 'weekly-summary' });
    await summaryRow.getByRole('button', { name: 'Disable' }).click();
    await page.locator('#sch-done:not(.hidden)', { hasText: 'weekly-summary is now disabled' }).waitFor();
    const disabled = ((await api('GET', '/v1/schedules/weekly-summary')).json as { schedule: Record<string, unknown>; next: string[] });
    assert.equal(disabled.schedule.enabled, false);
    assert.deepEqual(disabled.next, []);
    assert.deepEqual((disabled.schedule.target as { periodDays: number }).periodDays, 14, 'everything else is as it was');
    await summaryRow.getByRole('button', { name: 'Enable' }).click();
    await page.locator('#sch-done:not(.hidden)', { hasText: 'weekly-summary is now enabled' }).waitFor();
    assert.equal(((await api('GET', '/v1/schedules/weekly-summary')).json as { schedule: { enabled: boolean } }).schedule.enabled, true);

    // ---- run now needs the scheduler: the server's refusal is shown
    await nightly.getByRole('button', { name: 'Run now' }).click();
    await page.locator('#sch-error:not(.hidden)', { hasText: /SCHEDULER_ENABLED/ }).waitFor();

    // ---- a webhook a schedule tells cannot be deleted
    await hookRow.getByRole('button', { name: 'Delete' }).click();
    await page.locator('#wh-error:not(.hidden)').waitFor();
    assert.equal((await api('GET', '/v1/webhooks/team-qa')).status, 200, 'the webhook is still there');

    // ---- a runner sees the lists, not the forms
    const created = await api('POST', '/v1/team/users', { id: 'rita', name: 'Rita Runner', role: 'runner' });
    assert.equal(created.status, 201);
    const runnerKey = (created.json as { key: string }).key;
    const runnerPage = await browser.newPage();
    watch(runnerPage);
    await signIn(runnerPage, runnerKey);
    await runnerPage.goto(`${base}/ui/automation.html`);
    await runnerPage.locator('#auto-banner .warn-banner').waitFor();
    assert.equal(await runnerPage.locator('#auto-admin').isHidden(), true);
    await runnerPage.locator('#sch-rows tr', { hasText: 'nightly-vault' }).waitFor();
    await runnerPage.locator('#wh-rows tr', { hasText: 'team-qa' }).waitFor();
    assert.equal(await runnerPage.getByRole('button', { name: 'Delete' }).count(), 0);
    assert.equal(await runnerPage.getByRole('button', { name: 'Edit' }).count(), 0);
    const runnerSees = await runnerPage.evaluate(() => document.documentElement.outerHTML);
    assert.ok(!runnerSees.includes(HOOK_SECRET), 'a runner never sees the address either');
    await runnerPage.close();

    // ---- delete: schedules first, then the webhook, which takes its address out of the vault
    for (const id of ['nightly-vault', 'routine-sched', 'weekly-summary', 'snapshot-shop']) {
      await page.locator('#sch-rows tr', { hasText: id }).getByRole('button', { name: 'Delete' }).click();
      await page.locator('#sch-done:not(.hidden)', { hasText: `Deleted ${id}` }).waitFor();
    }
    await page.locator('#sch-summary', { hasText: 'No schedule yet' }).waitFor();
    await page.locator('#wh-rows tr', { hasText: 'team-qa' }).getByRole('button', { name: 'Delete' }).click();
    await page.locator('#wh-done:not(.hidden)', { hasText: 'Deleted team-qa' }).waitFor();
    await page.locator('#wh-summary', { hasText: 'No webhook yet' }).waitFor();
    assert.equal(await urlOfWebhook('team-qa'), undefined, 'the address is gone from the vault');

    // ---- the audit log says who changed what, never the address
    const audit = ((await api('GET', '/v1/audit?area=webhooks')).json as { entries: Array<{ method?: string; path?: string; actor?: { via: string } }> });
    const entry = audit.entries.find((candidate) => candidate.method === 'PUT' && candidate.path === '/v1/webhooks/team-qa');
    assert.ok(entry && entry.actor?.via === 'bearer', 'the change is in the audit log as made with the key');
    assert.ok(!JSON.stringify(audit).includes(HOOK_SECRET));
    assert.deepEqual(problems, [], 'no CSP violation, script error or unexpected console error');
  } finally {
    await browser.close();
  }
});
