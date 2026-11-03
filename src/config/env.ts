import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import { z } from 'zod';

import { artifactsDir } from './paths.js';

// Resolve .env relative to this file's own location (src/config/env.ts -> project root),
// not process.cwd(). Callers of this process (an MCP client spawning the server, a task
// runner, systemd, etc.) don't reliably set cwd to the project root, and process.cwd()
// silently resolving to the wrong directory is exactly the kind of "edited .env, nothing
// happened" symptom this project has already hit once.
const dotEnvPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');
// quiet: dotenv >= 17 prints a banner on stdout, which would corrupt `scrapforai --json` and the MCP stdio stream.
dotenv.config({ path: dotEnvPath, quiet: true });

const integerFromEnv = z.coerce.number().int().positive();

const booleanFromEnv = z
  .union([z.boolean(), z.string()])
  .default(false)
  .transform((value) => {
    if (typeof value === 'boolean') {
      return value;
    }

    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  });

// Same parsing as booleanFromEnv, but absent means true (for opt-out flags kept on for compatibility).
const booleanFromEnvDefaultTrue = z
  .union([z.boolean(), z.string()])
  .default(true)
  .transform((value) => (typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())));

const originListFromEnv = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().url()).transform((origins) => origins.map((origin) => new URL(origin).origin)));

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: integerFromEnv.default(3000),
  // Loopback by default: a bare-metal start must not expose the browser-automation engine
  // to the LAN. Docker overrides this to 0.0.0.0 (the host-side bind is already restricted
  // to 127.0.0.1 in docker-compose.yml).
  HOST: z.string().min(1).default('127.0.0.1'),
  SCRAPFORAI_API_KEY: z.string().min(16, 'SCRAPFORAI_API_KEY must be at least 16 characters'),
  ALLOWED_TARGET_ORIGINS: originListFromEnv.refine((origins) => origins.length > 0, {
    message: 'ALLOWED_TARGET_ORIGINS must contain at least one origin',
  }),
  ALLOWED_RESOURCE_ORIGINS: originListFromEnv,
  CORS_ALLOWED_ORIGINS: originListFromEnv,
  MAX_STEPS_PER_JOB: integerFromEnv.default(50),
  JOB_TIMEOUT_MS: integerFromEnv.default(60000),
  STEP_TIMEOUT_MS: integerFromEnv.default(10000),
  MAX_REQUEST_BODY_SIZE: z.string().min(1).default('1mb'),
  MAX_PARALLEL_JOBS: integerFromEnv.default(2),
  // Slots suites/scheduled runs may not take, so ad-hoc requests are not locked out by a long suite.
  // Capped at MAX_PARALLEL_JOBS - 1 (a suite always has at least one slot). 0 disables the reservation.
  INTERACTIVE_RESERVED_SLOTS: z.coerce.number().int().min(0).default(1),
  MAX_DOM_SNAPSHOT_CHARS: integerFromEnv.default(20000),
  ALLOW_EVALUATE: booleanFromEnv,
  MAX_EVALUATE_SCRIPT_CHARS: integerFromEnv.default(4000),
  MAX_EVALUATE_RESULT_CHARS: integerFromEnv.default(20000),
  EVALUATE_TIMEOUT_MS: integerFromEnv.default(5000),
  MAX_WATCH_DURATION_MS: integerFromEnv.default(30000),
  MIN_WATCH_INTERVAL_MS: integerFromEnv.default(100),
  MAX_WATCH_SAMPLES: integerFromEnv.default(200),
  ARTIFACT_RETENTION_HOURS: integerFromEnv.default(4),

  // --- Evidence retention classes (T1.5) ---
  // ephemeral (default): ARTIFACT_RETENTION_HOURS. standard: this many days. pinned: never removed.
  STANDARD_RETENTION_DAYS: integerFromEnv.default(30),
  // Cap on pinned evidence. Past it, new pins are refused (409); pinned evidence is never deleted.
  PINNED_EVIDENCE_MAX_MB: integerFromEnv.default(2048),

  // --- Credential vault (T1.2) ---
  // Optional 32-byte AES key, base64. Validated here so a malformed key fails at startup; the
  // vault itself reads process.env lazily. When unset, a key file is generated in the data dir.
  SCRAPFORAI_VAULT_KEY: z
    .string()
    .optional()
    .refine((value) => value === undefined || value.trim() === '' || Buffer.from(value.trim(), 'base64').length === 32, {
      message: 'SCRAPFORAI_VAULT_KEY must be 32 bytes encoded as base64',
    }),
  // Deprecated compatibility switch: accept literal `credentials` in the REST request body.
  // Set to false to force every secret through the vault (credentialSet).
  ALLOW_INLINE_CREDENTIALS: booleanFromEnvDefaultTrue,

  // --- Regression vault (T2.1) --- read lazily by config/paths.ts; declared here for documentation.
  REGRESSION_VAULT_DIR: z.string().min(1).optional(),

  // --- Routine library (T1.3) --- read lazily by config/paths.ts; declared here for documentation.
  ROUTINE_LIBRARY_DIR: z.string().min(1).optional(),

  // --- Run history index (separate retention from evidence above) ---
  HISTORY_RETENTION_DAYS: integerFromEnv.default(90),
  HISTORY_MAX_RUNS: integerFromEnv.default(5000),

  // --- Web UI ---
  UI_ENABLED: booleanFromEnv,
  SESSION_TTL_MINUTES: integerFromEnv.default(480),

  // Optional: resolved after parsing (see below) so the default can be platform-aware.
  ARTIFACT_DIR: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PLAYWRIGHT_BROWSER: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
  // Optional Playwright launch channel for the chromium browser type: 'chrome' or 'msedge'
  // launch the REAL installed browser instead of the bundled Chrome-for-Testing build. Google
  // rejects the bundled build at the OAuth sign-in screen ("this browser or app may not be
  // secure"); a real browser has a genuine UA + Sec-CH-UA pair that the bundled build cannot
  // fake consistently. Empty = the default bundled browser.
  PLAYWRIGHT_CHANNEL: z.enum(['chrome', 'msedge', 'chrome-beta', 'chrome-dev', 'chrome-canary', 'msedge-beta', 'msedge-dev']).optional(),

  // When true, every run is forced headless regardless of the request's options.headless.
  // The "Light" distribution sets this because it bundles only the headless-shell Chromium,
  // not the full browser a headed (headless:false) run would need. Default false: the full
  // distribution honors the per-request headless flag.
  FORCE_HEADLESS: booleanFromEnv,
});

const parsedEnv = envSchema.parse(process.env);

// ARTIFACT_DIR is resolved after parsing so its default can depend on the platform.
// Zod defaults are evaluated when the schema is constructed, which is too early here.
export const env = {
  ...parsedEnv,
  ARTIFACT_DIR: parsedEnv.ARTIFACT_DIR ?? artifactsDir(),
};

export type AppEnv = typeof env;

function readLiveDotEnv(): Record<string, string> {
  if (!existsSync(dotEnvPath)) {
    return {};
  }

  return dotenv.parse(readFileSync(dotEnvPath));
}

export function getLiveAllowedOrigins(key: 'ALLOWED_TARGET_ORIGINS' | 'ALLOWED_RESOURCE_ORIGINS'): string[] {
  // Union the hot-reloadable .env file value with the value the server was launched with
  // in process.env (e.g. a task runner / harness that injects an allowlisted origin via the
  // environment instead of editing .env). The previous `liveValue ?? process.env[key]` made
  // the process.env branch dead code: .env almost always defines the key, so `liveValue` was
  // always set and a launcher-injected origin was silently dropped -- every such target then
  // failed validateTargetUrl at the first navigation. Merge both sources and de-dupe.
  const liveValue = readLiveDotEnv()[key] ?? '';
  const procValue = process.env[key] ?? '';
  const combined = [liveValue, procValue].filter((value) => value.length > 0).join(',');

  return Array.from(new Set(originListFromEnv.parse(combined)));
}
