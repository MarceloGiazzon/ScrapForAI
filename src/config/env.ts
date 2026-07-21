import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import { z } from 'zod';

// Resolve .env relative to this file's own location (src/config/env.ts -> project root),
// not process.cwd(). Callers of this process (an MCP client spawning the server, a task
// runner, systemd, etc.) don't reliably set cwd to the project root, and process.cwd()
// silently resolving to the wrong directory is exactly the kind of "edited .env, nothing
// happened" symptom this project has already hit once.
const dotEnvPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');
dotenv.config({ path: dotEnvPath });

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

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: integerFromEnv.default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
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
  MAX_DOM_SNAPSHOT_CHARS: integerFromEnv.default(20000),
  ALLOW_EVALUATE: booleanFromEnv,
  MAX_EVALUATE_SCRIPT_CHARS: integerFromEnv.default(4000),
  MAX_EVALUATE_RESULT_CHARS: integerFromEnv.default(20000),
  EVALUATE_TIMEOUT_MS: integerFromEnv.default(5000),
  MAX_WATCH_DURATION_MS: integerFromEnv.default(30000),
  MIN_WATCH_INTERVAL_MS: integerFromEnv.default(100),
  MAX_WATCH_SAMPLES: integerFromEnv.default(200),
  ARTIFACT_RETENTION_HOURS: integerFromEnv.default(4),
  ARTIFACT_DIR: z.string().min(1).default('/app/artifacts'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PLAYWRIGHT_BROWSER: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
});

export const env = envSchema.parse(process.env);

export type AppEnv = typeof env;

function readLiveDotEnv(): Record<string, string> {
  if (!existsSync(dotEnvPath)) {
    return {};
  }

  return dotenv.parse(readFileSync(dotEnvPath));
}

export function getLiveAllowedOrigins(key: 'ALLOWED_TARGET_ORIGINS' | 'ALLOWED_RESOURCE_ORIGINS'): string[] {
  const liveValue = readLiveDotEnv()[key];

  return originListFromEnv.parse(liveValue ?? process.env[key] ?? '');
}
