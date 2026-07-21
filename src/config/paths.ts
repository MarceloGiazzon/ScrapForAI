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
