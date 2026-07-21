import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { Router, type Response } from 'express';

import { resolveArtifactPath } from '../artifacts/artifactStore.js';
import { env } from '../config/env.js';
import { getRun, historyStats, listRuns, listScenarioNames } from '../history/runHistoryStore.js';

export const runsRouter = Router();

const ALLOWED_ARTIFACT_EXTENSIONS = new Set(['.png', '.json', '.zip', '.txt']);

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: { type: 'ValidationError', message, details: [] } });
}

function notFound(res: Response, message: string): void {
  res.status(404).json({ error: { type: 'NotFound', message } });
}

function parseIntegerParam(value: unknown, fallback: number): number {
  if (typeof value !== 'string') {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseStatusParam(value: unknown): 'passed' | 'failed' | undefined {
  return value === 'passed' || value === 'failed' ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** GET /v1/runs — paginated, filterable list of past runs. */
runsRouter.get('/', async (req, res, next) => {
  try {
    const result = await listRuns({
      status: parseStatusParam(req.query.status),
      scenario: optionalString(req.query.scenario),
      since: optionalString(req.query.since),
      until: optionalString(req.query.until),
      q: optionalString(req.query.q),
      limit: parseIntegerParam(req.query.limit, 50),
      offset: parseIntegerParam(req.query.offset, 0),
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

/** GET /v1/runs/stats — aggregate counters for the dashboard header. */
runsRouter.get('/stats', async (_req, res, next) => {
  try {
    res.json(await historyStats());
  } catch (error) {
    next(error);
  }
});

/** GET /v1/runs/scenarios — distinct scenario names for the filter dropdown. */
runsRouter.get('/scenarios', async (_req, res, next) => {
  try {
    res.json({ scenarios: await listScenarioNames() });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /v1/runs/:jobId — summary plus the full result.json when evidence still exists.
 *
 * evidenceAvailable is computed from the filesystem at read time rather than stored on the
 * summary, so it cannot go stale when the artifact pruner runs.
 */
runsRouter.get('/:jobId', async (req, res, next) => {
  try {
    const jobId = req.params.jobId;
    const summary = await getRun(jobId);

    if (!summary) {
      notFound(res, 'Run not found');
      return;
    }

    const resultPath = resolveArtifactPath(path.join(jobId, 'result.json'));
    let detail: unknown;
    let evidenceAvailable = false;

    if (resultPath && existsSync(resultPath)) {
      evidenceAvailable = true;
      try {
        detail = JSON.parse(await fs.readFile(resultPath, 'utf8'));
      } catch {
        evidenceAvailable = false;
      }
    }

    res.json({
      summary,
      evidenceAvailable,
      evidenceRetentionHours: env.ARTIFACT_RETENTION_HOURS,
      detail,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /v1/runs/:jobId/artifacts/<relative path> — serves one evidence file.
 *
 * Two independent guards:
 *   1. resolveArtifactPath() rejects anything escaping ARTIFACT_DIR (path.relative based).
 *   2. An extension allowlist, so an unexpected file type can never be served inline.
 */
runsRouter.get('/:jobId/artifacts/{*artifactPath}', async (req, res, next) => {
  try {
    const jobId = req.params.jobId;

    const rawSegments = (req.params as Record<string, unknown>).artifactPath;
    const segments = Array.isArray(rawSegments) ? rawSegments : [rawSegments];
    const relativePath = segments.filter((segment): segment is string => typeof segment === 'string').join('/');

    if (!relativePath) {
      badRequest(res, 'Artifact path is required');
      return;
    }

    const extension = path.extname(relativePath).toLowerCase();
    if (!ALLOWED_ARTIFACT_EXTENSIONS.has(extension)) {
      badRequest(res, `Artifact type "${extension}" is not served`);
      return;
    }

    const absolutePath = resolveArtifactPath(path.join(jobId, relativePath));
    if (!absolutePath || !existsSync(absolutePath)) {
      notFound(res, 'Artifact not found or expired');
      return;
    }

    res.sendFile(absolutePath);
  } catch (error) {
    next(error);
  }
});
