import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { Router } from 'express';

import { env } from '../config/env.js';
import { dataDir } from '../config/paths.js';
import { historyStats } from '../history/runHistoryStore.js';
import { activeSessionCount } from '../security/sessionStore.js';

export const statusRouter = Router();

async function directorySizeBytes(directory: string): Promise<number> {
  if (!existsSync(directory)) {
    return 0;
  }

  let total = 0;
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await directorySizeBytes(entryPath);
    } else {
      const stats = await fs.stat(entryPath).catch(() => undefined);
      total += stats?.size ?? 0;
    }
  }

  return total;
}

statusRouter.get('/', async (_req, res, next) => {
  try {
    const history = await historyStats();

    res.json({
      service: 'ScrapForAI',
      pid: process.pid,
      nodeVersion: process.version,
      platform: process.platform,
      uptimeSeconds: Math.round(process.uptime()),
      nodeEnv: env.NODE_ENV,
      host: env.HOST,
      port: env.PORT,
      browser: env.PLAYWRIGHT_BROWSER,

      // Surfaced prominently in the UI: this one is dangerous when true.
      allowEvaluate: env.ALLOW_EVALUATE,
      // True on the Light distribution (headless-shell only): headed runs are forced headless.
      forceHeadless: env.FORCE_HEADLESS,

      dataDir: dataDir(),
      artifactDir: env.ARTIFACT_DIR,
      artifactDiskBytes: await directorySizeBytes(env.ARTIFACT_DIR),
      artifactRetentionHours: env.ARTIFACT_RETENTION_HOURS,

      history,
      activeSessions: activeSessionCount(),
    });
  } catch (error) {
    next(error);
  }
});
