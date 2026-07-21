import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Router } from 'express';

import { env, getLiveAllowedOrigins } from '../config/env.js';
import { hasValidBearerToken } from '../security/apiAuth.js';

export const configRouter = Router();

const dotEnvPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');

/**
 * Fields a cookie session may NOT change. Each one is a security boundary:
 *   - SCRAPFORAI_API_KEY      : the credential itself
 *   - ALLOWED_*_ORIGINS       : the SSRF allowlist
 *   - ALLOW_EVALUATE          : arbitrary in-page JavaScript execution
 *   - HOST                    : network exposure
 *
 * Changing any of these requires presenting the bearer API key on the request, so a
 * hijacked UI session alone cannot escalate.
 */
const LOCKED_FIELDS = new Set([
  'SCRAPFORAI_API_KEY',
  'ALLOWED_TARGET_ORIGINS',
  'ALLOWED_RESOURCE_ORIGINS',
  'ALLOW_EVALUATE',
  'HOST',
]);

/** Fields that take effect only after a restart (see plan §1.2). */
const RESTART_REQUIRED_FIELDS = new Set([
  'NODE_ENV',
  'PORT',
  'HOST',
  'SCRAPFORAI_API_KEY',
  'CORS_ALLOWED_ORIGINS',
  'MAX_STEPS_PER_JOB',
  'JOB_TIMEOUT_MS',
  'STEP_TIMEOUT_MS',
  'MAX_REQUEST_BODY_SIZE',
  'MAX_PARALLEL_JOBS',
  'MAX_DOM_SNAPSHOT_CHARS',
  'ALLOW_EVALUATE',
  'MAX_EVALUATE_SCRIPT_CHARS',
  'MAX_EVALUATE_RESULT_CHARS',
  'EVALUATE_TIMEOUT_MS',
  'MAX_WATCH_DURATION_MS',
  'MIN_WATCH_INTERVAL_MS',
  'MAX_WATCH_SAMPLES',
  'ARTIFACT_RETENTION_HOURS',
  'ARTIFACT_DIR',
  'LOG_LEVEL',
  'PLAYWRIGHT_BROWSER',
  'HISTORY_RETENTION_DAYS',
  'HISTORY_MAX_RUNS',
  'UI_ENABLED',
  'SESSION_TTL_MINUTES',
]);

/** Every writable key, with UI metadata. Keep in sync with envSchema in config/env.ts. */
const EDITABLE_FIELDS: Array<{
  key: string;
  group: 'safety' | 'limits' | 'runtime' | 'history';
  type: 'string' | 'number' | 'boolean' | 'originList' | 'enum';
  options?: string[];
  help: string;
}> = [
  { key: 'ALLOWED_TARGET_ORIGINS', group: 'safety', type: 'originList', help: 'Origins the runner may navigate to. This is the SSRF allowlist.' },
  { key: 'ALLOWED_RESOURCE_ORIGINS', group: 'safety', type: 'originList', help: 'Extra origins pages may load sub-resources from.' },
  { key: 'ALLOW_EVALUATE', group: 'safety', type: 'boolean', help: 'DANGER: allows arbitrary in-page JavaScript. Keep false unless local and trusted.' },
  { key: 'CORS_ALLOWED_ORIGINS', group: 'safety', type: 'originList', help: 'Browser origins permitted to call this API.' },
  { key: 'HOST', group: 'safety', type: 'string', help: 'Listen address. 127.0.0.1 keeps the service off the network.' },

  { key: 'MAX_STEPS_PER_JOB', group: 'limits', type: 'number', help: 'Maximum steps in a single routine.' },
  { key: 'JOB_TIMEOUT_MS', group: 'limits', type: 'number', help: 'Hard timeout for a whole job.' },
  { key: 'STEP_TIMEOUT_MS', group: 'limits', type: 'number', help: 'Default timeout for one step.' },
  { key: 'MAX_PARALLEL_JOBS', group: 'limits', type: 'number', help: 'Concurrent explorations allowed.' },
  { key: 'MAX_DOM_SNAPSHOT_CHARS', group: 'limits', type: 'number', help: 'Cap on captured DOM text.' },
  { key: 'MAX_REQUEST_BODY_SIZE', group: 'limits', type: 'string', help: 'Express body limit, e.g. 1mb.' },

  { key: 'PORT', group: 'runtime', type: 'number', help: 'HTTP port.' },
  { key: 'LOG_LEVEL', group: 'runtime', type: 'enum', options: ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'], help: 'Log verbosity.' },
  { key: 'PLAYWRIGHT_BROWSER', group: 'runtime', type: 'enum', options: ['chromium', 'firefox', 'webkit'], help: 'Browser engine.' },
  { key: 'SESSION_TTL_MINUTES', group: 'runtime', type: 'number', help: 'UI session lifetime.' },

  { key: 'ARTIFACT_RETENTION_HOURS', group: 'history', type: 'number', help: 'How long screenshots and traces are kept.' },
  { key: 'HISTORY_RETENTION_DAYS', group: 'history', type: 'number', help: 'How long the run index is kept.' },
  { key: 'HISTORY_MAX_RUNS', group: 'history', type: 'number', help: 'Hard cap on indexed runs.' },
];

const EDITABLE_KEYS = new Set(EDITABLE_FIELDS.map((field) => field.key));

/**
 * Rewrites .env in place, preserving comments, ordering and unknown keys.
 * Keys not already present are appended.
 */
function upsertEnvLines(content: string, updates: Record<string, string>): string {
  const remaining = new Map(Object.entries(updates));

  const lines = content.split(/\r?\n/).map((line) => {
    const match = line.match(/^(\s*)([A-Za-z0-9_]+)=(.*)$/);
    if (!match) {
      return line;
    }

    const key = match[2] ?? '';
    if (!remaining.has(key)) {
      return line;
    }

    const value = remaining.get(key) ?? '';
    remaining.delete(key);
    return `${match[1] ?? ''}${key}=${value}`;
  });

  if (remaining.size > 0) {
    lines.push('');
    for (const [key, value] of remaining) {
      lines.push(`${key}=${value}`);
    }
  }

  return lines.join('\n');
}

function currentValueFor(key: string): string {
  const value = (env as unknown as Record<string, unknown>)[key];

  if (Array.isArray(value)) {
    return value.join(',');
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return value === undefined || value === null ? '' : String(value);
}

/** GET /v1/config — effective configuration. Secrets are never returned. */
configRouter.get('/', (_req, res) => {
  res.json({
    fields: EDITABLE_FIELDS.map((field) => ({
      ...field,
      value: currentValueFor(field.key),
      locked: LOCKED_FIELDS.has(field.key),
      restartRequired: RESTART_REQUIRED_FIELDS.has(field.key),
    })),
    // Masked, never the real value.
    apiKeyConfigured: env.SCRAPFORAI_API_KEY.length >= 16,
    envFilePath: dotEnvPath,
    envFileWritable: existsSync(dotEnvPath),
    liveAllowedTargetOrigins: getLiveAllowedOrigins('ALLOWED_TARGET_ORIGINS'),
    liveAllowedResourceOrigins: getLiveAllowedOrigins('ALLOWED_RESOURCE_ORIGINS'),
  });
});

/** PUT /v1/config — writes .env. Body: { updates: { KEY: "value", ... } } */
configRouter.put('/', async (req, res, next) => {
  try {
    const updates = req.body?.updates;

    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      res.status(400).json({ error: { type: 'ValidationError', message: 'Body must be { updates: object }', details: [] } });
      return;
    }

    const entries = Object.entries(updates as Record<string, unknown>);
    const rejected: Array<{ key: string; reason: string }> = [];
    const accepted: Record<string, string> = {};

    const privileged = hasValidBearerToken(req);

    for (const [key, rawValue] of entries) {
      if (!EDITABLE_KEYS.has(key)) {
        rejected.push({ key, reason: 'Not an editable field' });
        continue;
      }

      if (LOCKED_FIELDS.has(key) && !privileged) {
        rejected.push({ key, reason: 'This field requires the API key (send it as a Bearer token)' });
        continue;
      }

      if (typeof rawValue !== 'string' && typeof rawValue !== 'number' && typeof rawValue !== 'boolean') {
        rejected.push({ key, reason: 'Value must be a string, number or boolean' });
        continue;
      }

      const value = String(rawValue).trim();

      // Reject anything that would break out of a single .env line.
      if (/[\r\n]/.test(value)) {
        rejected.push({ key, reason: 'Value must not contain newlines' });
        continue;
      }

      accepted[key] = value;
    }

    if (rejected.length > 0) {
      res.status(400).json({
        error: { type: 'ValidationError', message: 'Some fields were rejected', details: rejected.map((item) => ({ path: item.key, message: item.reason })) },
      });
      return;
    }

    if (!existsSync(dotEnvPath)) {
      res.status(500).json({ error: { type: 'ConfigError', message: `.env not found at ${dotEnvPath}` } });
      return;
    }

    const original = await fs.readFile(dotEnvPath, 'utf8');
    const updated = upsertEnvLines(original, accepted);

    // Back up before overwriting, so a bad edit is always recoverable.
    await fs.writeFile(`${dotEnvPath}.bak`, original, 'utf8');
    await fs.writeFile(dotEnvPath, updated, 'utf8');

    const changedKeys = Object.keys(accepted);
    res.json({
      ok: true,
      updated: changedKeys,
      restartRequired: changedKeys.some((key) => RESTART_REQUIRED_FIELDS.has(key)),
      note: 'Allowlist changes apply immediately. Other fields apply after a restart.',
    });
  } catch (error) {
    next(error);
  }
});
