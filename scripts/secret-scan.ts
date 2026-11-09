/**
 * The commit guard (see src/security/repoSecretScan.ts for WHAT counts). Run by the git hooks in .githooks/ and by CI.
 *
 *   tsx scripts/secret-scan.ts --staged              pre-commit: the files as they are STAGED (the index, not the working copy)
 *   tsx scripts/secret-scan.ts --message-file <f>    commit-msg: the message being written
 *   tsx scripts/secret-scan.ts --push                pre-push: the added lines of every commit about to leave (refs on stdin, as git gives them)
 *   tsx scripts/secret-scan.ts --history [--all]     every commit reachable from HEAD (or from every ref): what CI runs
 *   tsx scripts/secret-scan.ts --tree                every tracked file as it is on disk now
 *
 * Exit 0 clean, 1 something must not be committed, 2 the check could not run. The hooks treat 2 like 1 (fail closed).
 * NOTHING here prints a value: a finding is path, line, rule and a label.
 *
 * Known values: every field of every credential-vault set of this machine and the secret-named entries of `.env`. When the vault exists
 * but cannot be read, the scan stops with 2 instead of running without its strongest rule; `SECRET_SCAN_NO_VAULT=1` runs without the
 * vault on purpose and says so on every run.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import { z } from 'zod';

import {
  type AllowEntry,
  formatFinding,
  isSecretFieldName,
  type KnownSecret,
  MAX_SCAN_BYTES,
  parseLogPatch,
  scanCommits,
  scanFile,
  scanMessage,
  type ScanContext,
  type SecretFinding,
} from '../src/security/repoSecretScan.js';

/** The repository being committed to: the one the hook runs in (normally this one; a temporary one in the tests). */
function repositoryRoot(): string {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? path.resolve(r.stdout.trim()) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}
const root = repositoryRoot();
const ZERO = /^0+$/;

function git(args: string[], input?: string): string {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, input });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || '').trim().split('\n')[0]}`);
  return r.stdout;
}

function gitBuffer(args: string[]): Buffer {
  const r = spawnSync('git', args, { cwd: root, maxBuffer: 1024 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed`);
  return r.stdout;
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

const allowFileSchema = z.object({
  entries: z.array(
    z.object({
      path: z.string().min(1),
      rules: z.array(z.enum(['secret-field', 'secret-shape'])).min(1),
      reason: z.string().min(10),
    }),
  ),
});

function loadAllow(): AllowEntry[] {
  const file = path.join(root, '.secret-scan-allow.json');
  if (!existsSync(file)) return [];
  return allowFileSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).entries;
}

const ENV_SECRETS = new Set(['SCRAPFORAI_API_KEY', 'SCRAPFORAI_VAULT_KEY']);

async function loadKnown(): Promise<KnownSecret[]> {
  const known: KnownSecret[] = [];
  const envFile = path.join(root, '.env');
  if (existsSync(envFile)) {
    const parsed = dotenv.parse(readFileSync(envFile));
    for (const [name, value] of Object.entries(parsed)) {
      if (value && (ENV_SECRETS.has(name) || isSecretFieldName(name))) known.push({ label: `the value of ${name} in .env`, value });
      // The data directory decides where the vault lives.
      if (name === 'SCRAPFORAI_DATA_DIR' && !process.env.SCRAPFORAI_DATA_DIR) process.env.SCRAPFORAI_DATA_DIR = value;
      if (name === 'SCRAPFORAI_VAULT_KEY' && !process.env.SCRAPFORAI_VAULT_KEY) process.env.SCRAPFORAI_VAULT_KEY = value;
    }
  }
  if (process.env.SECRET_SCAN_NO_VAULT === '1') {
    console.error('[secret-scan] SECRET_SCAN_NO_VAULT=1: the credential vault is NOT checked on this run');
    return known;
  }
  const { listCredentialValuesForScan } = await import('../src/vault/credentials/credentialVault.js');
  for (const { setId, field, value } of await listCredentialValuesForScan()) known.push({ label: `the vault value of set "${setId}" field "${field}"`, value });
  return known;
}

function scanStaged(ctx: ScanContext): SecretFinding[] {
  const names = git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']).split('\0').filter(Boolean);
  const out: SecretFinding[] = [];
  for (const name of names) {
    const buf = gitBuffer(['show', `:${name}`]);
    if (isBinary(buf)) {
      out.push(...scanFile(name, '', ctx).filter((f) => f.rule === 'forbidden-file'));
      continue;
    }
    if (buf.length > MAX_SCAN_BYTES) console.error(`[secret-scan] ${name}: larger than ${MAX_SCAN_BYTES} bytes, only its first part is checked`);
    out.push(...scanFile(name, buf.subarray(0, MAX_SCAN_BYTES).toString('utf8'), ctx));
  }
  return out;
}

function scanTree(ctx: ScanContext): SecretFinding[] {
  const names = git(['ls-files', '-z']).split('\0').filter(Boolean);
  const out: SecretFinding[] = [];
  for (const name of names) {
    const file = path.join(root, name);
    if (!existsSync(file)) continue;
    const buf = readFileSync(file);
    if (isBinary(buf)) {
      out.push(...scanFile(name, '', ctx).filter((f) => f.rule === 'forbidden-file'));
      continue;
    }
    out.push(...scanFile(name, buf.subarray(0, MAX_SCAN_BYTES).toString('utf8'), ctx));
  }
  return out;
}

const LOG_ARGS = ['log', '-p', '--unified=0', '--no-color', '--no-ext-diff', '--no-renames', '--format=%x00COMMIT %H%n%B%x00'];

function scanRange(revs: string[], ctx: ScanContext): SecretFinding[] {
  // -m with --first-parent would hide what a merge brought; plain log -p shows each commit's own change, which is what entered the history.
  return scanCommits(parseLogPatch(git([...LOG_ARGS, ...revs])), ctx);
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function scanPush(ctx: ScanContext): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const line of readStdin().split(/\r?\n/)) {
    const [, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!localSha || ZERO.test(localSha)) continue; // deleting a remote branch sends nothing
    // A new branch: everything not already on a remote. Otherwise: what the remote does not have yet.
    const revs = !remoteSha || ZERO.test(remoteSha) ? [localSha, '--not', '--remotes'] : [`${remoteSha}..${localSha}`];
    out.push(...scanRange(revs, ctx));
  }
  return out;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const mode = args.find((a) => ['--staged', '--push', '--history', '--tree', '--message-file'].includes(a));
  if (!mode) {
    console.error('usage: secret-scan --staged | --message-file <file> | --push | --history [--all] | --tree');
    return 2;
  }
  const ctx: ScanContext = { known: await loadKnown(), allow: loadAllow() };

  let findings: SecretFinding[];
  if (mode === '--staged') findings = scanStaged(ctx);
  else if (mode === '--tree') findings = scanTree(ctx);
  else if (mode === '--push') findings = scanPush(ctx);
  else if (mode === '--history') findings = scanRange(args.includes('--all') ? ['--all'] : ['HEAD'], ctx);
  else {
    const file = args[args.indexOf('--message-file') + 1];
    if (!file) return 2;
    // Git's comment lines (# Please enter the commit message...) are not part of the message.
    const message = readFileSync(path.resolve(file), 'utf8').split(/\r?\n/).filter((l) => !l.startsWith('#')).join('\n');
    findings = scanMessage('(new commit)', message, ctx).map((f) => ({ ...f, commit: undefined }));
  }

  if (findings.length === 0) return 0;
  console.error(`\n[secret-scan] STOPPED: ${findings.length} thing(s) that must not enter the repository (it is PUBLIC):\n`);
  for (const f of findings.slice(0, 100)) console.error(`  ${formatFinding(f)}`);
  if (findings.length > 100) console.error(`  ... and ${findings.length - 100} more`);
  console.error(`
What to do:
  - Take the value out. In samples/routines use a placeholder (<LOGIN_PASSWORD>) or the vault (credentialSet + valueFromCredential).
  - [known-value] is a value this machine really uses: it can not be allowed. Never commit it.
  - A fake secret a TEST needs: build it so it is not one literal, or mark that line "secret-scan: allow", or add the file to
    .secret-scan-allow.json with a reason (secret-field / secret-shape only).
  - If it was ALREADY pushed: rotate the secret first, then clean the history. Deleting it in a new commit does not unpublish it.
  - "git commit --no-verify" skips this check. Do not.
`);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`[secret-scan] could not run: ${error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error'}`);
    console.error('[secret-scan] the hook fails closed: fix the cause (npm install? the vault key?) and try again.');
    process.exit(2);
  },
);
