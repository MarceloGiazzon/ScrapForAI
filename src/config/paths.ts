import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolves writable locations for config and data.
 *
 * IMPORTANT: every export here is a FUNCTION, not a constant. This module is imported by
 * config/env.ts, so its module body executes BEFORE dotenv.config() has run. Reading
 * process.env at module scope would therefore miss values defined in .env. Reading it
 * lazily inside a function is correct because callers run after dotenv has loaded.
 */

const APP_DIR_NAME = 'ScrapForAI';

/**
 * Base directory for all mutable state (config, history, artifacts, logs).
 *
 * Resolution order:
 *   1. SCRAPFORAI_DATA_DIR   — explicit override (used by Docker and the installer)
 *   2. %LOCALAPPDATA%\ScrapForAI          on Windows
 *   3. $XDG_DATA_HOME/scrapforai          on Linux/macOS when set
 *   4. ~/.local/share/scrapforai          fallback
 */
export function dataDir(): string {
  const override = process.env.SCRAPFORAI_DATA_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (localAppData) {
      return path.join(localAppData, APP_DIR_NAME);
    }
    return path.join(os.homedir(), 'AppData', 'Local', APP_DIR_NAME);
  }

  const xdgDataHome = process.env.XDG_DATA_HOME?.trim();
  if (xdgDataHome) {
    return path.join(xdgDataHome, 'scrapforai');
  }

  return path.join(os.homedir(), '.local', 'share', 'scrapforai');
}

/** Evidence: screenshots, traces, per-job result.json. Short retention. */
export function artifactsDir(): string {
  return path.join(dataDir(), 'artifacts');
}

/** Run index (runs.jsonl). Long retention. */
export function historyDir(): string {
  return path.join(dataDir(), 'history');
}

/** Pinned evidence (T1.5): <dataDir>/evidence/pinned/<jobId>/. Outside the artifact root, so no prune can reach it. */
export function pinnedEvidenceDir(): string {
  return path.join(dataDir(), 'evidence', 'pinned');
}

/**
 * Regression vault (T2.1): one <ITEM-ID>.json per item. REGRESSION_VAULT_DIR may point into a git repository
 * (e.g. the one that owns the ledger) so items are reviewed in pull requests.
 */
export function regressionVaultDir(): string {
  const override = process.env.REGRESSION_VAULT_DIR?.trim();
  return override ? path.resolve(override) : path.join(dataDir(), 'regression-vault');
}

/** Suite run states (T1.6): <dataDir>/suites/<suiteRunId>.json. */
export function suitesDir(): string {
  return path.join(dataDir(), 'suites');
}

/** Ed25519 key pair that signs pinned evidence manifests (T2.6): ed25519.key (private) + ed25519.pub. */
export function signingDir(): string {
  return path.join(dataDir(), 'signing');
}

/** Target profiles: one <id>.json per profile (T1.1). */
export function targetsDir(): string {
  return path.join(dataDir(), 'targets');
}

/**
 * Routine library (T1.3): <id>/v<N>.json + current.json. ROUTINE_LIBRARY_DIR may point into a git
 * repository so routines are reviewed in PRs like code.
 */
export function routineLibraryDir(): string {
  const override = process.env.ROUTINE_LIBRARY_DIR?.trim();
  return override ? path.resolve(override) : path.join(dataDir(), 'library');
}

/** Encrypted credential vault (T1.2). Never exported by the API. */
export function credentialVaultFile(): string {
  return path.join(dataDir(), 'credentials.enc.json');
}

/** Vault key, used only when SCRAPFORAI_VAULT_KEY is not set (T1.2). */
export function vaultKeyFile(): string {
  return path.join(dataDir(), 'vault.key');
}

export function logsDir(): string {
  return path.join(dataDir(), 'logs');
}

/**
 * Static UI assets, shipped with the code rather than stored as user data.
 *
 * Resolves to <projectRoot>/public from BOTH layouts, because the relative depth is the
 * same in each:
 *   src/config/paths.ts   -> ../../public
 *   dist/config/paths.js  -> ../../public
 *
 * fileURLToPath is required rather than new URL(...).pathname: on Windows the latter yields
 * a leading-slash drive path ("/D:/..."), and it leaves percent-encoding intact, so an
 * install path containing a space would resolve to a "%20" directory that does not exist.
 * config/env.ts resolves .env the same way.
 */
export function publicDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
}
