import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyTargetFailure } from '../src/runner/targetFailure.js';

// Texts are what Playwright 1.60 / Chromium really produce, call log included.
const refused = new Error(
  'page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:5173/?token=abc123\nCall log:\n  - navigating to "http://localhost:5173/?token=abc123", waiting until "domcontentloaded"\n',
);

test('a refused connection says the target is unreachable, names the origin and blames nobody inside ScrapForAI', () => {
  const failure = classifyTargetFailure(refused, { url: 'http://localhost:5173/?token=abc123', navigation: true });
  assert.ok(failure);
  assert.equal(failure.type, 'TargetUnreachable');
  assert.match(failure.message, /http:\/\/localhost:5173/);
  assert.match(failure.message, /nothing is listening/);
  assert.match(failure.message, /not a ScrapForAI failure/);
  assert.match(failure.message, /running/);
});

test('the message never carries the query, the call log or the raw Playwright text', () => {
  const failure = classifyTargetFailure(refused, { url: 'http://user:pw@localhost:5173/secret/path?token=abc123', navigation: true });
  assert.ok(failure);
  for (const leak of ['token', 'abc123', 'Call log', 'page.goto', 'secret/path', 'user', 'pw@']) {
    assert.ok(!failure.message.includes(leak), `leaked "${leak}": ${failure.message}`);
  }
});

test('DNS, timeouts and a dropped network are all "unreachable", each with its own reason', () => {
  const cases: Array<[string, RegExp]> = [
    ['net::ERR_NAME_NOT_RESOLVED', /host name could not be resolved/],
    ['net::ERR_CONNECTION_TIMED_OUT', /timed out/],
    ['net::ERR_ADDRESS_UNREACHABLE', /cannot be reached/],
    ['net::ERR_INTERNET_DISCONNECTED', /no network connection/],
    ['net::ERR_CONNECTION_RESET', /reset/],
    ['net::ERR_EMPTY_RESPONSE', /without answering/],
  ];
  for (const [code, reason] of cases) {
    const failure = classifyTargetFailure(new Error(`page.goto: ${code} at https://qa.example.com/`), { url: 'https://qa.example.com/', navigation: true });
    assert.equal(failure?.type, 'TargetUnreachable', code);
    assert.match(failure?.message ?? '', reason, code);
    assert.match(failure?.message ?? '', new RegExp(code.replace('net::', '')), 'the Chromium code stays, so a person can search for it');
  }
});

test('a certificate problem is its own type, with the fix that does not weaken the allowlist', () => {
  const failure = classifyTargetFailure(new Error('page.goto: net::ERR_CERT_AUTHORITY_INVALID at https://dev.example.com/'), { url: 'https://dev.example.com/', navigation: true });
  assert.equal(failure?.type, 'TargetTlsError');
  assert.match(failure?.message ?? '', /does not ignore certificate errors/);
  assert.equal(classifyTargetFailure(new Error('page.goto: net::ERR_SSL_PROTOCOL_ERROR at https://dev.example.com/'), { navigation: true })?.type, 'TargetTlsError');
});

test('a goto that runs out of time is a navigation timeout, with the limit', () => {
  const timeout = new Error('page.goto: Timeout 10000ms exceeded.\nCall log:\n  - navigating to "http://localhost:8100/", waiting until "domcontentloaded"');
  timeout.name = 'TimeoutError';
  const failure = classifyTargetFailure(timeout, { url: 'http://localhost:8100/', navigation: true });
  assert.equal(failure?.type, 'TargetNavigationTimeout');
  assert.match(failure?.message ?? '', /within 10000 ms/);
  assert.ok(!(failure?.message ?? '').includes('Call log'));
});

test('a timeout that is not a navigation (a click, a selector) is left alone', () => {
  const timeout = new Error('locator.click: Timeout 10000ms exceeded.');
  timeout.name = 'TimeoutError';
  assert.equal(classifyTargetFailure(timeout, { url: 'http://localhost:8100/', navigation: true }), undefined);
});

test('outside a navigation, a net:: code is not the target\'s business', () => {
  assert.equal(classifyTargetFailure(refused, { url: 'http://localhost:5173/', navigation: false }), undefined);
});

test('codes that are not "the target did not answer" (aborted by a redirect, blocked) are not reclassified', () => {
  for (const code of ['net::ERR_ABORTED', 'net::ERR_BLOCKED_BY_CLIENT', 'net::ERR_INVALID_URL']) {
    assert.equal(classifyTargetFailure(new Error(`page.goto: ${code} at http://localhost:5173/`), { url: 'http://localhost:5173/', navigation: true }), undefined, code);
  }
});

test('a browser that is not installed says what to run, without a stack or a path', () => {
  const missing = new Error(
    "browserType.launch: Executable doesn't exist at C:\\Users\\someone\\AppData\\Local\\ms-playwright\\chromium-1200\\chrome-win\\chrome.exe\n╔═════╗\n║ Looks like Playwright Test or Playwright was just installed or updated. ║\n║ Please run the following command to download new browsers: ║\n║     npx playwright install ║",
  );
  const failure = classifyTargetFailure(missing, { navigation: false });
  assert.equal(failure?.type, 'BrowserLaunchFailed');
  assert.match(failure?.message ?? '', /npx playwright install chromium/);
  assert.match(failure?.message ?? '', /npm run doctor/);
  assert.ok(!(failure?.message ?? '').includes('someone'), 'no user name from the path');
  assert.ok(!(failure?.message ?? '').includes('╔'));
});

test('missing system libraries on Linux point at install-deps, and say it needs sudo', () => {
  const failure = classifyTargetFailure(new Error('browserType.launch: Host system is missing dependencies to run browsers.\nPlease install them with: sudo npx playwright install-deps'), { navigation: false });
  assert.equal(failure?.type, 'BrowserLaunchFailed');
  assert.match(failure?.message ?? '', /install-deps/);
  assert.match(failure?.message ?? '', /sudo/);
});

test('anything else, and anything that is not an Error, is not classified', () => {
  assert.equal(classifyTargetFailure(new Error('Some assertion failed'), { navigation: true }), undefined);
  assert.equal(classifyTargetFailure('net::ERR_CONNECTION_REFUSED', { navigation: true }), undefined);
  assert.equal(classifyTargetFailure(undefined, { navigation: true }), undefined);
});

test('an address that is not a URL still classifies, just without "at <origin>"', () => {
  const failure = classifyTargetFailure(new Error('page.goto: net::ERR_CONNECTION_REFUSED'), { url: 'not a url', navigation: true });
  assert.equal(failure?.type, 'TargetUnreachable');
  assert.ok(!/ at not/.test(failure?.message ?? ''));
});
