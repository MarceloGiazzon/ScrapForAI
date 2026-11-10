// `npm run doctor` (first-use review, item 3): the decisions and the wording of the setup check. Pure, no I/O and no configuration import, so it is
// type-checked with the rest of `src/` and tested without a browser, a port or a .env. `scripts/doctor.ts` does the looking.
//
// Every problem names the CAUSE, the IMPACT and the NEXT command (the review's acceptance criterion). Nothing here ever receives or prints a
// secret: callers pass facts ("the key is the example"), never the key.

import { findExampleConfig, type ExampleConfigInput } from '../config/exampleConfig.js';

export type CheckLevel = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  id: string;
  level: CheckLevel;
  title: string;
  /** What was found, when the title is not enough. */
  detail?: string;
  /** What does not work because of it. */
  impact?: string;
  /** What to run or edit. A command a person runs on purpose: the doctor installs nothing and asks for no privileges. */
  next?: string;
}

/** ">=22.13.0" -> "22.13.0". Anything else (a caret range, a union) is not understood and returns undefined. */
export function parseMinNode(range: string | undefined): string | undefined {
  const match = /^\s*>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(range ?? '');
  return match ? `${match[1]}.${match[2] ?? '0'}.${match[3] ?? '0'}` : undefined;
}

function parts(version: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = version.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  return [major, minor, patch];
}

export function nodeAtLeast(current: string, minimum: string): boolean {
  const a = parts(current);
  const b = parts(minimum);
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! !== b[index]!) return a[index]! > b[index]!;
  }
  return true;
}

export function checkNode(current: string, enginesRange: string | undefined): CheckResult {
  const minimum = parseMinNode(enginesRange);
  const shown = current.replace(/^v/, '');
  if (!minimum) {
    return { id: 'node', level: 'ok', title: `Node.js ${shown}`, detail: 'package.json states no minimum this check understands.' };
  }
  if (nodeAtLeast(current, minimum)) {
    return { id: 'node', level: 'ok', title: `Node.js ${shown} (needs ${minimum} or newer)` };
  }
  return {
    id: 'node',
    level: 'fail',
    title: `Node.js ${shown} is older than the ${minimum} this project needs`,
    impact: 'npm install prints EBADENGINE warnings and the dependencies can fail in ways that look like ScrapForAI bugs.',
    next: 'Install Node.js 22 LTS or newer (https://nodejs.org, or your version manager: "nvm install 22"), open a new terminal, then run "npm ci" again.',
  };
}

/** Where git looks for hooks in this clone: our guard, someone else's hooks, git's default (no guard), or not a git clone at all. */
export type SecretGuardState = 'active' | 'other' | 'unset' | 'not-a-repo';

/**
 * The commit guard (.githooks + scripts/secret-scan.ts). A warning, not a failure: the server runs without it, but in a clone that can push to
 * a shared repository a missing guard lets a secret be committed.
 */
export function checkSecretGuard(state: SecretGuardState, otherPath?: string): CheckResult {
  if (state === 'not-a-repo') return { id: 'secret-guard', level: 'ok', title: 'Not a git clone: no commit guard needed' };
  if (state === 'active') return { id: 'secret-guard', level: 'ok', title: 'Commit guard active (pre-commit, commit-msg, pre-push check for secrets)' };
  return {
    id: 'secret-guard',
    level: 'warn',
    title: state === 'other' ? `Commit guard NOT active: git uses the hooks in "${otherPath ?? '?'}"` : 'Commit guard NOT active in this clone',
    impact: 'A password, API key or vault value can be committed and pushed to the public repository without any check.',
    next:
      state === 'other'
        ? 'Make your hooks call "npx tsx scripts/secret-scan.ts --staged" (pre-commit) and "--push" (pre-push), or run "git config core.hooksPath .githooks".'
        : 'Run "npm run hooks:install" (npm install does it too).',
  };
}

export interface ZodIssueLike {
  path: ReadonlyArray<PropertyKey>;
  message: string;
}

/** The configuration did not load: one line per variable, never the value that was rejected (zod's messages do not include it). */
export function checkConfigInvalid(issues: readonly ZodIssueLike[]): CheckResult {
  const lines = issues.slice(0, 10).map((issue) => `${issue.path.map(String).join('.') || '(env)'}: ${issue.message}`);
  return {
    id: 'config',
    level: 'fail',
    title: 'The configuration is not valid',
    detail: lines.join('\n'),
    impact: 'The server refuses to start (it would otherwise run with a setting you did not mean).',
    next: 'Fix the variables above in .env (every one is described in .env.example), then run "npm run doctor" again.',
  };
}

export function checkExampleValues(config: ExampleConfigInput): CheckResult {
  const problems = findExampleConfig(config);
  if (problems.length === 0) {
    return { id: 'example-values', level: 'ok', title: 'The API key and the target origins are your own (not the .env.example values)' };
  }
  return {
    id: 'example-values',
    level: 'fail',
    title: 'The configuration still has values copied from .env.example',
    detail: problems.map((problem) => problem.message).join('\n'),
    impact: 'The server refuses to start: a key everyone can read is no key, and nothing real is allowlisted.',
    next: problems.map((problem) => problem.fix).join('\n    '),
  };
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** What the configuration exposes. Warnings, never failures: it is the person's decision (Docker and a team server bind 0.0.0.0 on purpose). */
export function checkExposure(config: { HOST: string; ALLOW_EVALUATE: boolean; TRUST_PROXY: number }): CheckResult[] {
  const results: CheckResult[] = [];
  if (!LOOPBACK.has(config.HOST.trim().toLowerCase())) {
    results.push({
      id: 'host',
      level: 'warn',
      title: `HOST=${config.HOST}: the API is reachable from other machines, not only this one`,
      impact: 'The API drives a real browser and its only guard is the API key.',
      next: 'If that is not intended, set HOST=127.0.0.1 in .env. Behind a TLS proxy (docs/TEAM-SERVER.md) it is expected.',
    });
  } else {
    results.push({ id: 'host', level: 'ok', title: `HOST=${config.HOST}: only this machine can reach the API` });
  }
  if (config.ALLOW_EVALUATE) {
    results.push({
      id: 'evaluate',
      level: 'warn',
      title: 'ALLOW_EVALUATE=true: evaluate/watch steps run arbitrary JavaScript in the pages',
      impact: 'Anyone who can call the API can run code in the browser session, with whatever is logged in there.',
      next: 'Set ALLOW_EVALUATE=false in .env unless this is a local, trusted machine.',
    });
  }
  return results;
}

export type PortState = 'free' | 'scrapforai' | 'other';

export function checkPort(port: number, state: PortState, platform: string): CheckResult {
  if (state === 'free') return { id: 'port', level: 'ok', title: `Port ${port} is free` };
  if (state === 'scrapforai') {
    return { id: 'port', level: 'ok', title: `Port ${port}: ScrapForAI is already running here (/health answered)`, detail: 'No need to start another one.' };
  }
  const who = platform === 'win32' ? `netstat -ano | findstr :${port}` : `lsof -i :${port}`;
  return {
    id: 'port',
    level: 'fail',
    title: `Port ${port} is taken by something that is not ScrapForAI`,
    impact: 'The server cannot start (EADDRINUSE).',
    next: `Find it with "${who}" and stop it, or choose another port: set PORT=<free port> in .env.`,
  };
}

/** A target that does not answer is a warning: it may simply not be started yet. */
export function checkTarget(origin: string, outcome: { status: number } | { error: string }): CheckResult {
  if ('status' in outcome) {
    return { id: `target:${origin}`, level: 'ok', title: `${origin} answers (HTTP ${outcome.status})` };
  }
  return {
    id: `target:${origin}`,
    level: 'warn',
    title: `${origin} is not answering: ${outcome.error}`,
    impact: 'Any run against it fails with TargetUnreachable until it is up.',
    next: 'Start the application under test (or ignore this if it is not meant to be up right now).',
  };
}

export function exitCodeFor(results: readonly CheckResult[]): 0 | 1 {
  return results.some((result) => result.level === 'fail') ? 1 : 0;
}

const MARK: Record<CheckLevel, string> = { ok: '✔', warn: '⚠', fail: '✖' };

export function renderReport(results: readonly CheckResult[]): string {
  const lines: string[] = ['ScrapForAI doctor', ''];
  for (const result of results) {
    lines.push(`${MARK[result.level]} ${result.title}`);
    if (result.level !== 'ok') {
      if (result.detail) lines.push(...result.detail.split('\n').map((line) => `    ${line}`));
      if (result.impact) lines.push(`    Impact: ${result.impact}`);
      if (result.next) lines.push(`    Next:   ${result.next}`);
    } else if (result.detail) {
      lines.push(`    ${result.detail}`);
    }
  }
  const fails = results.filter((result) => result.level === 'fail').length;
  const warns = results.filter((result) => result.level === 'warn').length;
  lines.push('');
  if (fails > 0) {
    lines.push(`${fails} problem${fails === 1 ? '' : 's'} to fix${warns > 0 ? `, ${warns} warning${warns === 1 ? '' : 's'}` : ''}. Fix them and run "npm run doctor" again.`);
  } else if (warns > 0) {
    lines.push(`Ready to start, with ${warns} warning${warns === 1 ? '' : 's'}: npm run dev`);
  } else {
    lines.push('Everything checks out. Start the server: npm run dev');
  }
  return lines.join('\n');
}
