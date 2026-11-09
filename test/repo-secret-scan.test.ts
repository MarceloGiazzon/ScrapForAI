import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkSecretGuard } from '../src/doctor/report.js';
import {
  allowedRules,
  forbiddenFile,
  formatFinding,
  isPlaceholderValue,
  isSecretFieldName,
  parseLogPatch,
  scanCommits,
  scanFile,
  scanMessage,
  type ScanContext,
} from '../src/security/repoSecretScan.js';

// The commit guard (2026-11-08): a real login + password sat in samples/ from the FIRST commit for four months, while GitHub's secret
// scanning was on. Every fake below is built so it is not a value of this machine; the e2e part uses its own vault in a temp dir.

const repoRoot = path.resolve(import.meta.dirname, '..');
const none: ScanContext = { known: [], allow: [] };
const fakePassword = ['Pw9', 'kd72', 'xQ'].join('!'); // what a person types, no recognisable shape

test('the shape of the 2026 leak is refused: a literal password under credentials in a sample', () => {
  const sample = JSON.stringify({ targetUrl: 'https://dev.example.com', credentials: { loginUser: 'jdoe', loginPassword: fakePassword } }, null, 2);
  const findings = scanFile('samples/report.sample.json', sample, none);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.rule, 'secret-field');
  assert.equal(findings[0]!.line, 5);
  assert.match(findings[0]!.detail, /loginPassword/);
  assert.ok(!formatFinding(findings[0]!).includes(fakePassword), 'a finding never carries the value');
});

test('placeholders are not secrets', () => {
  for (const v of ['<LOGIN_PASSWORD>', '${PW}', '$PW', 'REDACTED-PASSWORD', 'replace-with-a-long-random-key', 'test-password', 'changeme', '***', '', 'x'])
    assert.ok(isPlaceholderValue(v), v);
  for (const v of [fakePassword, 'hunter22hunter', 'S3cr3tValue']) assert.ok(!isPlaceholderValue(v), v);
  const sample = JSON.stringify({ credentials: { loginUser: '<LOGIN_USER>', loginPassword: '<LOGIN_PASSWORD>' } }, null, 2);
  assert.deepEqual(scanFile('samples/a.json', sample, none), []);
});

test('the END of the name decides whether it is a secret', () => {
  for (const n of ['loginPassword', 'db_password', 'apiKey', 'api_key', 'GITHUB_TOKEN', 'client_secret', 'clientSecret', 'privateKey', 'SCRAPFORAI_API_KEY', 'pwd'])
    assert.ok(isSecretFieldName(n), n);
  for (const n of ['passwordSelector', 'lastPass', 'tokenUrl', 'maxTokens', 'valueFromCredential', 'loginUser', 'secretScan', 'name'])
    assert.ok(!isSecretFieldName(n), n);
});

test('a value this machine uses is refused anywhere, even where fakes are allowed, and is never echoed', () => {
  const value = `vault-${randomBytes(6).toString('hex')}`;
  const ctx: ScanContext = {
    known: [{ label: 'the vault value of set "x" field "password"', value }],
    allow: [{ path: 'test/**/*.ts', rules: ['secret-field', 'secret-shape'], reason: 'fakes on purpose' }],
  };
  const findings = scanFile('test/deep/a.test.ts', `const v = 'abc${value}def'; // secret-scan: allow`, ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.rule, 'known-value');
  assert.match(findings[0]!.detail, /set "x" field "password"/);
  assert.ok(!formatFinding(findings[0]!).includes(value));
  // Too short to look for as a substring (it would match half the code base).
  assert.deepEqual(scanFile('a.ts', 'const role = "admin";', { known: [{ label: 'u', value: 'admin' }], allow: [] }), []);
});

test('files that only hold secrets are refused by name', () => {
  for (const p of ['.env', '.env.local', 'sub/.env.production', 'data/credentials.enc.json', 'signing/ed25519.key', 'cert.pem', 'id_ed25519', 'local-api-key.txt', 'credentials.enc.json'])
    assert.ok(forbiddenFile(p), p);
  for (const p of ['.env.example', 'src/data.ts', 'docs/env.md', 'test/key.test.ts']) assert.equal(forbiddenFile(p), undefined, p);
  assert.equal(scanFile('.env', 'NODE_ENV=development', none)[0]!.rule, 'forbidden-file');
});

test('shapes, env-style assignments, inline and per-file allows', () => {
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlc2lnbmF0dXJl'].join('.');
  assert.equal(scanFile('docs/a.md', `token is ${jwt}`, none)[0]!.rule, 'secret-shape');
  assert.deepEqual(scanFile('docs/a.md', `token is ${jwt} <!-- secret-scan: allow -->`, none), []);
  assert.equal(scanFile('ops/run.ps1', `SCRAPFORAI_API_KEY=${fakePassword}abc`, none)[0]!.rule, 'secret-field');
  assert.deepEqual(scanFile('.env.example', 'SCRAPFORAI_API_KEY=replace-with-a-long-random-key', none), []);
  assert.equal(scanFile('deploy/x.yml', `  password: ${fakePassword}`, none)[0]!.rule, 'secret-field');
  assert.deepEqual(scanFile('docs/a.md', 'Use `SCRAPFORAI_API_KEY=` in the CLI\'s `.env`.', none), []);
  assert.ok(allowedRules('test/a/b.test.ts', [{ path: 'test/**/*.ts', rules: ['secret-shape'], reason: 'r'.repeat(10) }]).has('secret-shape'));
  assert.equal(allowedRules('src/b.ts', [{ path: 'test/**/*.ts', rules: ['secret-shape'], reason: 'r'.repeat(10) }]).size, 0);
});

test('a commit message is checked for known values and shapes, not for prose like "password: reset"', () => {
  const value = `msg-${randomBytes(6).toString('hex')}`;
  assert.deepEqual(scanMessage('c1', 'fix: password: "reset flow"', none), []);
  assert.equal(scanMessage('c1', `wip ${value}`, { known: [{ label: 'k', value }], allow: [] })[0]!.rule, 'known-value');
});

test('the log parser keeps only ADDED lines with their real numbers, and drops deleted files', () => {
  const patch = [
    '\u0000COMMIT aaaa1111',
    'add sample',
    '\u0000',
    'diff --git a/samples/s.json b/samples/s.json',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/samples/s.json',
    '@@ -0,0 +1,3 @@',
    '+{',
    `+  "loginPassword": "${fakePassword}"`,
    '+}',
    '\u0000COMMIT bbbb2222',
    'remove it',
    '\u0000',
    'diff --git a/samples/s.json b/samples/s.json',
    'deleted file mode 100644',
    '--- a/samples/s.json',
    '+++ /dev/null',
    '@@ -1,3 +0,0 @@',
    '-{',
    `-  "loginPassword": "${fakePassword}"`,
    '-}',
  ].join('\n');
  const commits = parseLogPatch(patch);
  assert.equal(commits.length, 2);
  assert.deepEqual(commits[0]!.files[0]!.added[1], { line: 2, text: `  "loginPassword": "${fakePassword}"` });
  assert.equal(commits[1]!.files.length, 0, 'a deletion is the fix, not the problem');
  const findings = scanCommits(commits, none);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.commit, 'aaaa1111', 'the commit that ADDED it is named, so a later deletion does not hide it');
});

test('doctor: the guard is a warning when it is not active', () => {
  assert.equal(checkSecretGuard('active').level, 'ok');
  assert.equal(checkSecretGuard('not-a-repo').level, 'ok');
  assert.equal(checkSecretGuard('unset').level, 'warn');
  assert.match(checkSecretGuard('other', '.husky').title, /\.husky/);
});

test('the hooks are versioned and call the guard; package.json installs them', () => {
  const hooks = path.join(repoRoot, '.githooks');
  assert.match(readFileSync(path.join(hooks, 'pre-commit'), 'utf8'), /secret-scan\.ts" --staged/);
  assert.match(readFileSync(path.join(hooks, 'commit-msg'), 'utf8'), /--message-file/);
  assert.match(readFileSync(path.join(hooks, 'pre-push'), 'utf8'), /secret-scan\.ts" --push/);
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.match(pkg.scripts.prepare!, /install-hooks\.mjs/);
  const ci = readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /fetch-depth: 0/);
  assert.match(ci, /secret-scan\.ts --history --all/);
});

// --- end to end: a throwaway repository, its own vault, the real script ------------------------------------------------------------------------

const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const script = path.join(repoRoot, 'scripts', 'secret-scan.ts');

test('end to end: staged files, a known vault value, a commit message and a push are stopped; the value is never printed', async () => {
  assert.ok(existsSync(tsxCli));
  const dir = mkdtempSync(path.join(tmpdir(), 'sfa-secret-scan-'));
  const repo = path.join(dir, 'repo');
  const data = path.join(dir, 'data');
  const remote = path.join(dir, 'remote.git');
  mkdirSync(repo);
  mkdirSync(data);
  const vaultKey = randomBytes(32).toString('base64');
  const vaultValue = `Vv-${randomBytes(8).toString('hex')}`;
  const savedEnv = { dir: process.env.SCRAPFORAI_DATA_DIR, key: process.env.SCRAPFORAI_VAULT_KEY };
  // The vault module loads the server configuration; CI has no .env (the child process inherits these too).
  process.env.SCRAPFORAI_API_KEY ??= `test-${randomBytes(12).toString('hex')}`;
  process.env.ALLOWED_TARGET_ORIGINS ??= 'https://dev.example.com';
  try {
    process.env.SCRAPFORAI_DATA_DIR = data;
    process.env.SCRAPFORAI_VAULT_KEY = vaultKey;
    const { saveCredentialSet } = await import('../src/vault/credentials/credentialVault.js');
    await saveCredentialSet('e2e-set', { boundOrigins: ['https://dev.example.com'], values: { user: 'someone', password: vaultValue }, tags: [] }, 'create');

    const env = { ...process.env, SCRAPFORAI_DATA_DIR: data, SCRAPFORAI_VAULT_KEY: vaultKey, SECRET_SCAN_NO_VAULT: '' };
    const git = (...args: string[]) => {
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.hooksPath=/dev/null-nohooks', ...args], { cwd: repo, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout;
    };
    const scan = (args: string[], input?: string) => spawnSync(process.execPath, [tsxCli, script, ...args], { cwd: repo, env, encoding: 'utf8', input });

    git('init', '-q', '-b', 'main');
    writeFileSync(path.join(repo, 'README.md'), '# ok\n');
    git('add', '.');
    assert.equal(scan(['--staged']).status, 0, 'a clean commit passes');
    git('commit', '-q', '-m', 'init');
    spawnSync('git', ['init', '-q', '--bare', remote]);
    git('remote', 'add', 'origin', remote);
    git('push', '-q', 'origin', 'main');

    // 1. the 2026 leak, staged
    writeFileSync(path.join(repo, 'sample.json'), JSON.stringify({ credentials: { loginUser: 'jdoe', loginPassword: fakePassword } }, null, 2));
    git('add', 'sample.json');
    let r = scan(['--staged']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /sample\.json:4 +\[secret-field\]/);
    assert.ok(!r.stderr.includes(fakePassword));
    git('rm', '-q', '--cached', 'sample.json');

    // 2. a vault value in an innocent-looking file that no name or shape rule would flag
    writeFileSync(path.join(repo, 'notes.txt'), `call him, it is ${vaultValue} now\n`);
    git('add', 'notes.txt');
    r = scan(['--staged']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /\[known-value\] contains the vault value of set "e2e-set" field "password"/);
    assert.ok(!r.stderr.includes(vaultValue) && !r.stdout.includes(vaultValue));

    // 3. a .env forced in
    writeFileSync(path.join(repo, '.env'), 'NODE_ENV=x\n');
    git('add', '-f', '.env');
    assert.match(scan(['--staged']).stderr, /\.env +\[forbidden-file\]/);

    // 4. the message
    const msg = path.join(dir, 'MSG');
    writeFileSync(msg, `wip ${vaultValue}\n# comment lines are not the message\n`);
    assert.equal(scan(['--message-file', msg]).status, 1);

    // 5. the push: committed WITHOUT the hooks (as --no-verify would), then deleted in a later commit. The push still stops.
    git('commit', '-q', '-m', 'oops');
    git('rm', '-q', 'notes.txt', '.env');
    git('commit', '-q', '-m', 'remove it again');
    const local = git('rev-parse', 'HEAD').trim();
    const remoteSha = git('rev-parse', 'origin/main').trim();
    r = scan(['--push'], `refs/heads/main ${local} refs/heads/main ${remoteSha}\n`);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /notes\.txt:1 +\[known-value\]/);
    assert.ok(!r.stderr.includes(vaultValue));

    // 6. the vault exists but cannot be read: the scan fails closed instead of running without its strongest rule
    r = spawnSync(process.execPath, [tsxCli, script, '--staged'], { cwd: repo, env: { ...env, SCRAPFORAI_VAULT_KEY: '' }, encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /could not run/);
  } finally {
    if (savedEnv.dir === undefined) delete process.env.SCRAPFORAI_DATA_DIR;
    else process.env.SCRAPFORAI_DATA_DIR = savedEnv.dir;
    if (savedEnv.key === undefined) delete process.env.SCRAPFORAI_VAULT_KEY;
    else process.env.SCRAPFORAI_VAULT_KEY = savedEnv.key;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a clone whose hooks cannot run refuses the commit (fails closed)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sfa-hook-closed-'));
  try {
    const g = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: dir, encoding: 'utf8' });
    g('init', '-q');
    g('config', 'core.hooksPath', path.join(repoRoot, '.githooks').replace(/\\/g, '/'));
    writeFileSync(path.join(dir, 'a.txt'), 'x\n');
    g('add', '.');
    const r = g('commit', '-q', '-m', 'x');
    assert.notEqual(r.status, 0, 'no node_modules in that clone: the guard cannot run, so nothing is committed');
    assert.match(r.stderr, /node_modules is missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
