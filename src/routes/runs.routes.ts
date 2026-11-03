import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { Router, type Response } from 'express';

import { env } from '../config/env.js';
import { sendReport } from './reportHandler.js';
import { exportEvidence } from '../evidence/export.js';
import { EvidenceError, pinJob } from '../evidence/pin.js';
import { checkSignature } from '../evidence/signature.js';
import { loadPublicKey } from '../evidence/signingKey.js';
import { findJobDir, resolveJobFile } from '../evidence/locate.js';
import { readManifest, verifyManifest } from '../evidence/manifest.js';
import { requireBearer } from '../security/apiAuth.js';
import { getRun, historyStats, listRuns, listScenarioNames } from '../history/runHistoryStore.js';
import { readFileRetry } from '../storage/transientIo.js';

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

    const resultPath = resolveJobFile(jobId, 'result.json');
    let detail: unknown;
    let evidenceAvailable = false;

    if (resultPath && existsSync(resultPath)) {
      evidenceAvailable = true;
      try {
        detail = JSON.parse(await readFileRetry(resultPath, 'utf8'));
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
 * GET /v1/runs/:jobId/manifest — the evidence manifest plus a fresh verification against the files
 * on disk. `location` says whether the job is still ephemeral/standard or pinned.
 */
runsRouter.get('/:jobId/manifest', async (req, res, next) => {
  try {
    const job = findJobDir(String(req.params.jobId));
    const stored = job ? await readManifest(job.dir).catch(() => undefined) : undefined;

    if (!job || !stored) {
      notFound(res, 'No manifest for this run (evidence expired, or it ran before manifests existed)');
      return;
    }

    res.json({
      location: job.location,
      manifestSha256: stored.sha256,
      manifest: stored.manifest,
      verification: await verifyManifest(job.dir, stored.manifest),
      // Only pinned evidence is signed; a run still in the artifact root reports 'unsigned'.
      signature: checkSignature(stored.manifest, (await loadPublicKey()).publicKeyPem),
    });
  } catch (error) {
    next(error);
  }
});

/** GET /v1/runs/:jobId/report?format=html|pdf&lang=en|pt|es - the homologation report of one run. */
runsRouter.get('/:jobId/report', async (req, res, next) => {
  try {
    await sendReport(req, res, 'run', String(req.params.jobId));
  } catch (error) {
    next(error);
  }
});

/**
 * GET /v1/runs/:jobId/export - the pinned evidence as a .zip (files + signed manifest + public key + README)
 * that anyone can verify offline with `scrapforai evidence verify`. 409 if the run is not pinned.
 */
runsRouter.get('/:jobId/export', async (req, res, next) => {
  try {
    const { zip, fileName, keyId } = await exportEvidence(String(req.params.jobId));
    res.setHeader('content-type', 'application/zip');
    res.setHeader('content-disposition', `attachment; filename="${fileName}"`);
    res.setHeader('x-scrapforai-key-id', keyId);
    res.send(zip);
  } catch (error) {
    if (error instanceof EvidenceError) {
      res.status(error.status).json({ error: { type: error.name, message: error.message, ...(error.details ? { details: error.details } : {}) } });
      return;
    }
    next(error);
  }
});

/**
 * POST /v1/runs/:jobId/pin { reason, ref?, keepTrace? } — moves the run's evidence into the pinned
 * store, where no retention prune can reach it. Needs the bearer token: pinned evidence is never
 * deleted automatically, so a UI session must not be able to fill the pinned quota.
 */
runsRouter.post('/:jobId/pin', requireBearer, async (req, res, next) => {
  try {
    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    const ref = typeof body.ref === 'string' && body.ref.trim() !== '' ? body.ref.trim() : undefined;

    if (reason === '' || reason.length > 500 || (ref !== undefined && ref.length > 200) || (body.keepTrace !== undefined && typeof body.keepTrace !== 'boolean')) {
      badRequest(res, 'Body must be { reason: string (1-500), ref?: string (max 200), keepTrace?: boolean }');
      return;
    }

    res.json(await pinJob(String(req.params.jobId), { reason, ref, keepTrace: body.keepTrace === true }));
  } catch (error) {
    if (error instanceof EvidenceError) {
      res.status(error.status).json({ error: { type: error.name, message: error.message, ...(error.details ? { details: error.details } : {}) } });
      return;
    }
    next(error);
  }
});

/**
 * GET /v1/runs/:jobId/artifacts/<relative path> — serves one evidence file.
 *
 * Two independent guards:
 *   1. resolveJobFile() rejects anything escaping the job's own directory, in the artifact root or the
 *      pinned store (path.relative based).
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

    const absolutePath = resolveJobFile(jobId, relativePath);
    if (!absolutePath || !existsSync(absolutePath)) {
      notFound(res, 'Artifact not found or expired');
      return;
    }

    res.sendFile(absolutePath);
  } catch (error) {
    next(error);
  }
});
