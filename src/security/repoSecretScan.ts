import { SECRET_PATTERNS } from '../library/routineLint.js';

/**
 * What must never be COMMITTED (the repository is public). PURE: no I/O, no git, no configuration; `scripts/secret-scan.ts`
 * decides what to read (staged files, the commits of a push, the whole history) and this file decides what counts.
 *
 * Why it exists: GitHub's secret scanning and push protection say nothing about a plain password, because it has no provider format;
 * `test/samples-hygiene.test.ts` only looks at the tree, never at what is being committed. So the rules are, strongest first:
 *  - `known-value`: a value this installation really uses (every field of every credential-vault set, the secrets in `.env`). It cannot be
 *    allowed by any rule or file: if it matches, the commit stops. This is the rule that would have caught the leak.
 *  - `forbidden-file`: files that only ever hold secrets or runtime data (`.env`, keys, the data directory, the vault), even if `git add -f`.
 *  - `secret-field`: a literal assigned to a name that says "secret" (`loginPassword`, `apiKey`, `client_secret`, `TOKEN=`), unless the
 *    value is a placeholder (`<LOGIN_PASSWORD>`, `${VAR}`, `REDACTED`, `replace-with-...`).
 *  - `secret-shape`: the routine lint's shapes (API keys, GitHub/Slack/AWS tokens, JWT, private key blocks).
 * The last two can be allowed for one file with a written reason (`.secret-scan-allow.json`) or on one line with `secret-scan: allow`
 * (tests that build fake secrets on purpose). A finding NEVER carries the value: path, line, rule and a description only.
 */

export type SecretRule = 'known-value' | 'forbidden-file' | 'secret-field' | 'secret-shape';

export interface SecretFinding {
  path: string;
  /** 1-based; 0 for a finding about the file itself, or a commit message line when `path` is `(commit message)`. */
  line: number;
  rule: SecretRule;
  /** Never the value: which kind of secret, or which known secret by LABEL (`vault set "x" field "password"`). */
  detail: string;
  commit?: string;
}

export interface KnownSecret {
  /** What to call it in a finding. Never the value. */
  label: string;
  value: string;
}

export interface AllowEntry {
  /** A path glob (`*` one segment, `**` anything), relative to the repository root, forward slashes. */
  path: string;
  rules: Array<'secret-field' | 'secret-shape'>;
  reason: string;
}

export interface ScanContext {
  known: readonly KnownSecret[];
  allow: readonly AllowEntry[];
}

/** Known values shorter than this are not looked for as substrings: `admin` would match half the code base. */
export const MIN_KNOWN_LENGTH = 6;
/** A text this large is data, not something a person typed; it is skipped (and said so by the caller). */
export const MAX_SCAN_BYTES = 2_000_000;
const INLINE_ALLOW = /secret-scan:\s*allow\b/;

// --- files that must never be committed ---------------------------------------------------------------------------------------------------

const FORBIDDEN_FILES: Array<{ pattern: RegExp; detail: string }> = [
  { pattern: /(?:^|\/)\.env(?:\.(?!example$)[^/]+)?$/, detail: 'an environment file (.env holds the API key and the vault key)' },
  { pattern: /\.(?:key|pem|p12|pfx|jks|keystore)$/i, detail: 'a key or certificate file' },
  { pattern: /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/, detail: 'an SSH private key' },
  { pattern: /(?:^|\/)credentials\.enc\.json$/, detail: 'the encrypted credential vault' },
  { pattern: /^data\//, detail: 'the runtime data directory (vault, keys, users, evidence)' },
  { pattern: /(?:^|\/)local-api-key\.txt$/, detail: 'a local API key file' },
  { pattern: /(?:^|\/)team\/users\.json$/, detail: 'the team users file' },
];

export function forbiddenFile(path: string): string | undefined {
  return FORBIDDEN_FILES.find(({ pattern }) => pattern.test(path))?.detail;
}

// --- names that say "secret" ---------------------------------------------------------------------------------------------------------------

/**
 * The END of the name decides (`loginPassword`, `db_password`, `apiKey`, `GITHUB_TOKEN`), so `passwordSelector`, `tokenUrl` or
 * `maxTokens` are not secrets. Words are split on camelCase, `_`, `-`, `.` first.
 */
// `pass` is left out on purpose: `lastPass`, `firstPass` are the last/first PASSING run. `credential` too: `valueFromCredential` names a field.
const SECRET_LAST_WORDS = new Set(['password', 'passwd', 'passphrase', 'pwd', 'secret', 'token', 'apikey', 'privatekey', 'accesskey', 'secretkey', 'clientsecret']);

export function isSecretFieldName(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_.\-]+/)
    .filter(Boolean);
  if (words.length === 0) return false;
  const last = words[words.length - 1]!;
  const lastTwo = words.slice(-2).join('');
  return SECRET_LAST_WORDS.has(last) || SECRET_LAST_WORDS.has(lastTwo);
}

/** Values that stand for a secret instead of being one. */
export function isPlaceholderValue(value: string): boolean {
  const v = value.trim();
  if (v.length < 4) return true;
  if (/^<[^<>]+>$/.test(v)) return true;
  if (/^\$\{?[A-Za-z_][\w.]*\}?$/.test(v) || /^\$\(|^\{\{|\}\}$/.test(v) || v.startsWith('%') && v.endsWith('%')) return true;
  if (/redacted|placeholder|replace[-_ ]?(?:with|me)|change[-_ ]?me|your[-_ ]|example|dummy|not[-_ ]?a[-_ ]?secret/i.test(v)) return true;
  if (/^(?:x+|\*+|\.+|-+|null|undefined|none|true|false)$/i.test(v)) return true;
  if (/^process\.env\./.test(v)) return true;
  // Fakes that announce themselves (`test-password`, `wrong-key`, `fake-token`): a real value of this machine is still caught by known-value.
  if (/^(?:test|fake|wrong|bad|invalid|sample|demo|bogus|mock|stub|other|another|secret|password|token)(?:$|[-_ .0-9])/i.test(v)) return true;
  return false;
}

// Backticks are not quotes here: in Markdown they are code spans, and a template literal with a secret in it is rare enough.
// `"name": "value"`, `name: 'value'`, `name = "value"`, `name="value"` (JSON, JS/TS, YAML, PowerShell, HTML attributes).
const QUOTED_ASSIGNMENT = /["']?([A-Za-z_$][\w$.-]{0,80})["']?\s*[:=]\s*(["'])((?:(?!\2)[^\\\n]|\\.){0,400})\2/g;
// `NAME=value` / `export NAME=value` / `$env:NAME = value` unquoted, at the start of a line (env files, shell, ini).
const BARE_ASSIGNMENT = /^\s*(?:export\s+|\$env:|set\s+)?([A-Za-z_][\w.-]{0,80})\s*=\s*([^\s"'`#;]+)\s*(?:[#;].*)?$/;
// YAML `name: value` without quotes.
const YAML_BARE = /^\s*-?\s*([A-Za-z_][\w.-]{0,80}):\s+([^\s"'`#{[&*!|>][^#]*?)\s*(?:#.*)?$/;
const BARE_FILES = /(?:^|\/)(?:\.env[^/]*|[^/]+\.(?:env|sh|bash|ps1|psm1|bat|cmd|ini|properties|conf|cfg|toml)|Dockerfile[^/]*)$/i;
const YAML_FILES = /\.ya?ml$/i;

// --- scanning -----------------------------------------------------------------------------------------------------------------------------

function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      out += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

export function allowedRules(path: string, allow: readonly AllowEntry[]): Set<string> {
  const rules = new Set<string>();
  for (const entry of allow) if (globToRegExp(entry.path).test(path)) for (const r of entry.rules) rules.add(r);
  return rules;
}

/** Lines of a text, each with its 1-based number. A caller with a diff passes only the ADDED lines with their real numbers. */
export interface ScanLine {
  line: number;
  text: string;
}

export function linesOf(text: string): ScanLine[] {
  return text.split(/\r?\n/).map((t, i) => ({ line: i + 1, text: t }));
}

function knownIn(text: string, known: readonly KnownSecret[]): KnownSecret | undefined {
  return known.find((k) => k.value.length >= MIN_KNOWN_LENGTH && text.includes(k.value));
}

/** `REPLACE_PAGE_URL_TOKEN` is the NAME of a placeholder in a template (the pack's answers file), not a token. */
function isTemplateKey(name: string): boolean {
  return /^REPLACE_/.test(name) || /_URL_TOKEN$/.test(name);
}

function fieldProblem(path: string, text: string): string | undefined {
  for (const m of text.matchAll(QUOTED_ASSIGNMENT)) {
    const [, name, , value] = m;
    if (isSecretFieldName(name!) && !isTemplateKey(name!) && !isPlaceholderValue(value!)) return `a literal value assigned to "${name}"`;
  }
  const bare = BARE_FILES.test(path) ? BARE_ASSIGNMENT.exec(text) : YAML_FILES.test(path) ? YAML_BARE.exec(text) : null;
  if (bare && isSecretFieldName(bare[1]!) && !isTemplateKey(bare[1]!) && !isPlaceholderValue(bare[2]!)) return `a literal value assigned to "${bare[1]}"`;
  return undefined;
}

/**
 * Scans the given lines of one file. `lines` are the whole file (pre-commit, tree) or the added lines of a diff (push, history):
 * what is NOT being added is not this commit's fault.
 */
export function scanLines(path: string, lines: readonly ScanLine[], ctx: ScanContext): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const allowed = allowedRules(path, ctx.allow);
  for (const { line, text } of lines) {
    const known = knownIn(text, ctx.known);
    if (known) {
      findings.push({ path, line, rule: 'known-value', detail: `contains ${known.label}` });
      continue;
    }
    if (INLINE_ALLOW.test(text)) continue;
    if (!allowed.has('secret-shape')) {
      const shape = SECRET_PATTERNS.find(({ pattern }) => pattern.test(text));
      if (shape) {
        findings.push({ path, line, rule: 'secret-shape', detail: `looks like ${shape.name}` });
        continue;
      }
    }
    if (!allowed.has('secret-field')) {
      const field = fieldProblem(path, text);
      if (field) findings.push({ path, line, rule: 'secret-field', detail: field });
    }
  }
  return findings;
}

/** A whole file: its name first (a forbidden file is one finding, its content is not read), then its lines. */
export function scanFile(path: string, text: string, ctx: ScanContext): SecretFinding[] {
  const forbidden = forbiddenFile(path);
  if (forbidden) return [{ path, line: 0, rule: 'forbidden-file', detail: `${forbidden} must never be committed` }];
  return scanLines(path, linesOf(text), ctx);
}

/** A commit message can carry a secret too (pasted into the subject); only known values and shapes are checked there. */
export function scanMessage(commit: string, message: string, ctx: ScanContext): SecretFinding[] {
  return scanLines('(commit message)', linesOf(message), { known: ctx.known, allow: [{ path: '(commit message)', rules: ['secret-field'], reason: 'prose' }] }).map((f) => ({ ...f, commit }));
}

// --- unified diffs (git log -p --unified=0) ---------------------------------------------------------------------------------------------------

export interface DiffCommit {
  commit: string;
  message: string;
  files: Array<{ path: string; added: ScanLine[]; binary: boolean }>;
}

/**
 * Parses `git log -p --unified=0 --no-color --no-ext-diff --format=%x00COMMIT %H%n%B%x00` output into commits with their ADDED lines.
 * A deleted file has path `/dev/null` on the `+++` side and is dropped (deleting a secret is the fix, not the problem).
 */
export function parseLogPatch(output: string): DiffCommit[] {
  const commits: DiffCommit[] = [];
  const chunks = output.split('\u0000COMMIT ');
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const headerEnd = chunk.indexOf('\u0000');
    if (headerEnd < 0) continue;
    const header = chunk.slice(0, headerEnd);
    const newline = header.indexOf('\n');
    const commit = (newline < 0 ? header : header.slice(0, newline)).trim();
    const message = newline < 0 ? '' : header.slice(newline + 1);
    const current: DiffCommit = { commit, message, files: [] };
    let file: DiffCommit['files'][number] | undefined;
    let nextLine = 0;
    for (const raw of chunk.slice(headerEnd + 1).split('\n')) {
      const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (text.startsWith('diff --git ')) {
        file = undefined;
        const m = / b\/(.+)$/.exec(text);
        if (m) {
          file = { path: unquote(m[1]!), added: [], binary: false };
          current.files.push(file);
        }
      } else if (text.startsWith('+++ ')) {
        if (!file) continue;
        const target = text.slice(4);
        if (target === '/dev/null') {
          current.files.pop();
          file = undefined;
        } else if (target.startsWith('b/')) file.path = unquote(target.slice(2));
      } else if (text.startsWith('Binary files ') && file) file.binary = true;
      else if (text.startsWith('@@')) {
        const m = /\+(\d+)/.exec(text);
        nextLine = m ? Number(m[1]) : 0;
      } else if (file && text.startsWith('+') && !text.startsWith('+++')) {
        file.added.push({ line: nextLine, text: text.slice(1) });
        nextLine++;
      }
    }
    commits.push(current);
  }
  return commits;
}

function unquote(p: string): string {
  return p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;
}

/** Every finding of a parsed log, commit messages included. */
export function scanCommits(commits: readonly DiffCommit[], ctx: ScanContext): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const c of commits) {
    out.push(...scanMessage(c.commit, c.message, ctx));
    for (const f of c.files) {
      const forbidden = forbiddenFile(f.path);
      if (forbidden) {
        out.push({ path: f.path, line: 0, rule: 'forbidden-file', detail: `${forbidden} must never be committed`, commit: c.commit });
        continue;
      }
      if (f.binary) continue;
      out.push(...scanLines(f.path, f.added, ctx).map((x) => ({ ...x, commit: c.commit })));
    }
  }
  return out;
}

export function formatFinding(f: SecretFinding): string {
  const where = f.line > 0 ? `${f.path}:${f.line}` : f.path;
  return `${f.commit ? `${f.commit.slice(0, 10)} ` : ''}${where}  [${f.rule}] ${f.detail}`;
}
