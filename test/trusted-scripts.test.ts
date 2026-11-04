import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// T7.1: the registry of scripts this project injects into target pages: pinned hashes, the boot check, and the runner's limits. No browser.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-trusted-test-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';

const { TRUSTED_SCRIPTS, TrustedScriptIntegrityError, sha256Of, verifyTrustedScripts } = await import('../src/runner/trusted/registry.js');
const { runTrustedScript, TrustedScriptError } = await import('../src/runner/trusted/runTrusted.js');
const { axeBundle } = await import('../src/runner/trusted/scripts/axe.js');

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const good = { id: 'demo', source: '(function () { return function () { return 1; }; })()', timeoutMs: 200, maxOutputChars: 50 };
const pinned = { ...good, sha256: sha256Of(good.source) };

test('every registered script matches its pinned sha256 (the server would not start otherwise)', () => {
  assert.doesNotThrow(() => verifyTrustedScripts());
  assert.ok(TRUSTED_SCRIPTS.length >= 3);
  for (const script of TRUSTED_SCRIPTS) assert.match(script.sha256, /^[0-9a-f]{64}$/, script.id);
});

test('a source that changed without a new pin is refused, naming the script', () => {
  const edited = { ...pinned, source: pinned.source.replace('return 1', 'return 2') };
  assert.doesNotThrow(() => verifyTrustedScripts([pinned]));
  assert.throws(() => verifyTrustedScripts([edited as never]), (error: unknown) => {
    assert.ok(error instanceof TrustedScriptIntegrityError);
    assert.equal(error.scriptId, 'demo');
    assert.match(error.message, /Review the change, then pin the new hash/);
    return true;
  });
  assert.throws(() => verifyTrustedScripts([{ ...pinned, sha256: 'PIN' }]), TrustedScriptIntegrityError);
});

test('a duplicated id is refused', () => {
  assert.throws(() => verifyTrustedScripts([pinned, pinned]), /registered twice/);
});

test('the boot check runs before anything else in start(), so a bad build never listens', () => {
  const server = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'server.ts'), 'utf8');
  const start = server.slice(server.indexOf('async function start()'));
  assert.ok(start.indexOf('verifyTrustedScripts()') > 0);
  assert.ok(start.indexOf('verifyTrustedScripts()') < start.indexOf('initRunHistory()'));
  assert.ok(start.indexOf('verifyTrustedScripts()') < start.indexOf('app.listen'));
});

test('the sources are plain data to the runner: no template syntax that could be confused with injection, and only the known families exist', () => {
  for (const script of TRUSTED_SCRIPTS) {
    // The vendored axe-core bundle (T7.4) is third-party code pinned by hash as a whole; the rule applies to OUR part of that script.
    const own = script.id === 'a11y-axe' ? script.source.replace(axeBundle, '') : script.source;
    assert.ok(!own.includes('${'), `${script.id} must not contain template placeholders`);
    // pii-surfaces (T7.8) is the ONE script that reads storage, by design (the PII hunt). It is still checked for everything else and for any WRITE to storage.
    const forbidden =
      script.id === 'pii-surfaces'
        ? /\beval\s*\(|new Function|document\.write|innerHTML\s*=|fetch\s*\(|XMLHttpRequest|document\.cookie|setItem|removeItem|\.clear\s*\(/
        : /\beval\s*\(|new Function|document\.write|innerHTML\s*=|fetch\s*\(|XMLHttpRequest|localStorage|sessionStorage|document\.cookie/;
    assert.ok(!forbidden.test(own), `${script.id} reads and writes nothing it should not`);
  }
  assert.deepEqual(TRUSTED_SCRIPTS.map((script) => script.id).sort(), ['a11y-axe', 'keyboard-active', 'keyboard-candidates', 'keyboard-style', 'pii-surfaces']);
});

/** A frame whose evaluate records the expression and answers with `answer`. */
function frameAnswering(answer: () => Promise<unknown> | unknown, seen: string[] = []) {
  return { evaluate: async (expression: string) => { seen.push(expression); return answer(); } } as never;
}

test('the runner sends the fixed source plus the arguments as a JSON literal: an argument can only be data', async () => {
  const seen: string[] = [];
  const evil = '"); throw new Error("pwned"); ("';
  const out = await runTrustedScript(frameAnswering(() => ({ ok: true }), seen), 'keyboard-style', { path: evil }, {});
  assert.deepEqual(out, { ok: true });
  assert.equal(seen.length, 1);
  assert.ok(seen[0]!.startsWith('(('), 'the registered source is what is sent');
  assert.ok(seen[0]!.endsWith(`)(${JSON.stringify({ path: evil })})`), 'the argument is one JSON string literal');
});

test('the runner masks known secrets in the answer', async () => {
  const out = await runTrustedScript(frameAnswering(() => ({ name: 'Hello s3cr3t-value world', password: 'x' })), 'keyboard-active', {}, { knownSecrets: ['s3cr3t-value'] });
  assert.deepEqual(out, { name: 'Hello [REDACTED] world', password: '[REDACTED]' });
});

test('a script that does not answer in time is abandoned with an error naming it', async () => {
  await assert.rejects(
    () => runTrustedScript(frameAnswering(() => new Promise(() => undefined)), 'keyboard-active', {}, { definition: pinned }),
    (error: unknown) => error instanceof TrustedScriptError && /demo.*did not answer within 200 ms/.test(error.message),
  );
});

test('an answer over the limit is an error, never a silent cut', async () => {
  await assert.rejects(
    () => runTrustedScript(frameAnswering(() => ({ text: 'x'.repeat(200) })), 'keyboard-active', {}, { definition: pinned }),
    /answer is \d+ characters, over its limit of 50/,
  );
});

test('an error inside the page is reported as a trusted-script error with one line', async () => {
  await assert.rejects(
    () => runTrustedScript(frameAnswering(() => { throw new Error('boom\n    at somewhere'); }), 'keyboard-active', {}, {}),
    (error: unknown) => error instanceof TrustedScriptError && error.message === 'Trusted script "keyboard-active": boom',
  );
});
