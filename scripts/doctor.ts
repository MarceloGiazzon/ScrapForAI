// npm run doctor — checks that this machine can run ScrapForAI and says what to do about each problem.
// Read-only: it installs nothing, asks for no privileges, writes no file and never prints the API key. The decisions and the wording live in
// src/doctor/report.ts (tested); this file only looks at the machine.
//
//   npm run doctor            human report, exit 1 when something must be fixed
//   npm run doctor -- --json  the same results as one JSON array on stdout (for CI)
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkConfigInvalid,
  checkExampleValues,
  checkExposure,
  checkNode,
  checkPort,
  checkSecretGuard,
  checkTarget,
  exitCodeFor,
  renderReport,
  type CheckResult,
  type PortState,
} from '../src/doctor/report.js';
import { EXAMPLE_TARGET_ORIGINS } from '../src/config/exampleConfig.js';
import { classifyTargetFailure } from '../src/runner/targetFailure.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const asJson = process.argv.includes('--json');
const results: CheckResult[] = [];

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').trim().slice(0, 200);
}

/** The reason a fetch failed, from the error code Node attaches (the message of a fetch error is just "fetch failed"). */
function describeFetchError(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } } | undefined)?.cause;
  const code = cause?.code ?? (error as { code?: string } | undefined)?.code;
  switch (code) {
    case 'ECONNREFUSED':
      return 'nothing is listening there (connection refused)';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'the host name could not be resolved (DNS)';
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return 'no answer before the connection timed out';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'CERT_HAS_EXPIRED':
      return `its HTTPS certificate is not trusted by this machine (${code}); ScrapForAI does not ignore certificate errors either`;
    default:
      if ((error as { name?: string } | undefined)?.name === 'TimeoutError') return 'no answer within 3 seconds';
      return code ? `could not connect (${code})` : 'could not connect';
  }
}

async function probePort(port: number): Promise<PortState> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return response.ok ? 'scrapforai' : 'other';
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    return code === 'ECONNREFUSED' ? 'free' : 'other';
  }
}

async function probeTarget(origin: string): Promise<{ status: number } | { error: string }> {
  try {
    // HEAD, no redirect followed: only "does something answer there". Any HTTP status counts as an answer.
    const response = await fetch(origin, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(3000) });
    return { status: response.status };
  } catch (error) {
    return { error: describeFetchError(error) };
  }
}

function nearestExistingDirectory(start: string): string {
  let current = start;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

async function main(): Promise<void> {
  // 1. Node
  const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { engines?: { node?: string } };
  results.push(checkNode(process.version, packageJson.engines?.node));

  // 1b. the commit guard (only in a git clone)
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' });
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') results.push(checkSecretGuard('not-a-repo'));
  else {
    const hooksPath = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    results.push(hooksPath === '.githooks' ? checkSecretGuard('active') : hooksPath ? checkSecretGuard('other', hooksPath) : checkSecretGuard('unset'));
  }

  // 2. .env (the variables may also come from the process environment, as in Docker, so a missing file is only fatal if the config then fails)
  const hasEnvFile = existsSync(path.join(root, '.env'));

  // 3. the configuration, loaded the way the server loads it (importing the module runs the same validation and throws the same errors)
  let env: typeof import('../src/config/env.js').env | undefined;
  try {
    env = (await import('../src/config/env.js')).env;
    results.push(
      hasEnvFile
        ? { id: 'env-file', level: 'ok', title: '.env found and valid' }
        : { id: 'env-file', level: 'warn', title: 'No .env file: the configuration comes from the environment variables of this process', next: 'For a local setup: copy .env.example to .env and edit it.' },
    );
  } catch (error) {
    const issues = (error as { issues?: Array<{ path: PropertyKey[]; message: string }> }).issues;
    if (!hasEnvFile) {
      results.push({
        id: 'env-file',
        level: 'fail',
        title: 'There is no .env file and the environment does not provide the required settings',
        impact: 'The server refuses to start without SCRAPFORAI_API_KEY and at least one ALLOWED_TARGET_ORIGINS entry.',
        next: 'Copy the template, then edit the two required lines:\n    cp .env.example .env            (PowerShell: Copy-Item .env.example .env)',
      });
    }
    results.push(
      issues
        ? checkConfigInvalid(issues)
        : { id: 'config', level: 'fail', title: 'The configuration could not be loaded', detail: firstLine(error instanceof Error ? error.message : String(error)) },
    );
  }

  if (env) {
    results.push(checkExampleValues(env));
    results.push(...checkExposure(env));

    // 4. the data directory is writable (nearest existing parent: the server creates the rest)
    const { dataDir } = await import('../src/config/paths.js');
    const data = dataDir();
    try {
      accessSync(nearestExistingDirectory(data), constants.W_OK);
      results.push({ id: 'data-dir', level: 'ok', title: `Data directory is writable (${data})` });
    } catch {
      results.push({
        id: 'data-dir',
        level: 'fail',
        title: `The data directory cannot be written (${data})`,
        impact: 'Runs cannot store evidence, history or the credential vault.',
        next: 'Fix the folder permissions, or point SCRAPFORAI_DATA_DIR in .env at a folder you can write.',
      });
    }

    // 5. the browser, started the way a run starts it (so a missing browser, a missing system library or a wrong channel shows up here)
    const { launchBrowser } = await import('../src/runner/playwrightContext.js');
    try {
      const browser = await Promise.race([
        launchBrowser(true),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('The browser did not start within 30 seconds')), 30_000).unref()),
      ]);
      // Do not wait for a slow close: the process exits at the end anyway.
      await Promise.race([browser.close().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 5000).unref())]);
      results.push({ id: 'browser', level: 'ok', title: `${env.PLAYWRIGHT_BROWSER} starts (headless)` });
    } catch (error) {
      const failure = classifyTargetFailure(error, { navigation: false });
      results.push({
        id: 'browser',
        level: 'fail',
        title: `The browser (${env.PLAYWRIGHT_BROWSER}) did not start`,
        detail: failure ? failure.message : firstLine(error instanceof Error ? error.message : String(error)),
        impact: 'No run or inspection can happen.',
        next: failure ? 'Follow the instruction above (it installs software, so run it yourself), then run "npm run doctor" again.' : 'Run "npx playwright install chromium", then "npm run doctor" again.',
      });
    }

    // 6. the port
    results.push(checkPort(env.PORT, await probePort(env.PORT), process.platform));

    // 7. the targets (a warning, not a failure: the application under test may not be started yet)
    const example = new Set<string>(EXAMPLE_TARGET_ORIGINS);
    for (const origin of env.ALLOWED_TARGET_ORIGINS) {
      if (example.has(origin)) continue;
      results.push(checkTarget(origin, await probeTarget(origin)));
    }
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderReport(results)}\n`);
  }
  // Explicit exit: a browser process that is slow to close must not keep the terminal waiting.
  process.exit(exitCodeFor(results));
}

main().catch((error: unknown) => {
  process.stderr.write(`doctor itself failed: ${error instanceof Error ? firstLine(error.message) : 'unknown error'}\n`);
  process.exit(2);
});
