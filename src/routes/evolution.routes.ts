import { Router, type Response } from 'express';
import { z } from 'zod';

import { renderChangesMarkdown } from '../evolution/compare.js';
import {
  diffBuilds,
  getExpectedChanges,
  MAX_NARRATIVE_CHARS,
  queryTimeline,
  saveExpectedChanges,
  writeChanges,
} from '../evolution/evolutionService.js';
import { cancelSnapshotRun, getSnapshotRun, startSnapshot, waitForSnapshotRun } from '../evolution/snapshotRunner.js';
import { listSnapshots } from '../evolution/snapshotStore.js';
import { RequestResolutionError } from '../runner/resolutionError.js';
import { SNAPSHOT_ID_PATTERN, snapshotBodySchema } from '../schemas/evolution.schema.js';
import { expectedChangesSchema } from '../schemas/expectedChanges.schema.js';
import { buildIdSchema, safeName } from '../schemas/explorationRequest.schema.js';

/**
 * /v1/evolution: system-evolution snapshots (T4.4). A snapshot logs in through the vault (credential sets by name) and writes
 * a value-free inventory per catalogue screen, so, like suites and permission matrices, a UI session may start one.
 */
export const evolutionRouter = Router();

const MAX_WAIT_SECONDS = 55;

function knownError(res: Response, error: unknown): boolean {
  if (error instanceof RequestResolutionError) {
    res.status(error.status).json({ error: { type: error.name, message: error.message } });
    return true;
  }
  return false;
}

function notFound(res: Response): void {
  res.status(404).json({ error: { type: 'SnapshotRunNotFound', message: 'Snapshot run not found' } });
}

/** POST /v1/evolution/snapshots — 202 with a snapshotId; poll GET /v1/evolution/snapshots/:id?wait=N. */
evolutionRouter.post('/snapshots', async (req, res, next) => {
  const parsed = snapshotBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: {
        type: 'ValidationError',
        message: 'Invalid snapshot request',
        details: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
      },
    });
    return;
  }

  try {
    const state = await startSnapshot(parsed.data);
    res.status(202).location(`/v1/evolution/snapshots/${state.snapshotId}`).json({
      snapshotId: state.snapshotId,
      targetProfile: state.targetProfile,
      status: state.status,
      screens: state.screens.length,
      sessions: state.sessions,
    });
  } catch (error) {
    if (!knownError(res, error)) next(error);
  }
});

evolutionRouter.get('/snapshots/:snapshotId', async (req, res, next) => {
  try {
    const snapshotId = String(req.params.snapshotId);
    if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) {
      notFound(res);
      return;
    }
    const wait = Number.parseInt(String(req.query.wait ?? '0'), 10);
    const waitMs = Number.isFinite(wait) ? Math.min(Math.max(wait, 0), MAX_WAIT_SECONDS) * 1000 : 0;
    const state = waitMs > 0 ? await waitForSnapshotRun(snapshotId, waitMs) : await getSnapshotRun(snapshotId);
    if (!state) {
      notFound(res);
      return;
    }
    res.json(state);
  } catch (error) {
    next(error);
  }
});

evolutionRouter.post('/snapshots/:snapshotId/cancel', async (req, res, next) => {
  try {
    const snapshotId = String(req.params.snapshotId);
    const state = SNAPSHOT_ID_PATTERN.test(snapshotId) ? await cancelSnapshotRun(snapshotId) : undefined;
    if (!state) {
      notFound(res);
      return;
    }
    res.json(state);
  } catch (error) {
    next(error);
  }
});

/** GET /v1/evolution/:target — the snapshots stored for a target profile, oldest first. */
evolutionRouter.get('/:target', async (req, res, next) => {
  try {
    const target = String(req.params.target);
    if (!safeName.safeParse(target).success) {
      res.status(400).json({ error: { type: 'ValidationError', message: 'Invalid target profile id' } });
      return;
    }
    res.json({ targetProfile: target, snapshots: await listSnapshots(target) });
  } catch (error) {
    next(error);
  }
});

const refSchema = z.string().min(1).max(120);
const diffQuerySchema = z.object({ from: refSchema.optional(), to: refSchema.optional(), format: z.enum(['json', 'md']).default('json') });
const timelineQuerySchema = z.object({
  screen: z.string().regex(/^[a-zA-Z0-9_-]{1,52}$/).optional(),
  key: z.string().min(1).max(200).optional(),
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/, 'since: YYYY-MM-DD').optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
const changesBodySchema = z
  .object({ from: refSchema.optional(), to: refSchema.optional(), narrative: z.string().max(MAX_NARRATIVE_CHARS).optional() })
  .strict();

function badRequest(res: Response, message: string, issues: Array<{ path: PropertyKey[]; message: string }>): void {
  res.status(400).json({
    error: { type: 'ValidationError', message, details: issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })) },
  });
}

const validTarget = (res: Response, target: string): boolean => {
  if (safeName.safeParse(target).success) return true;
  res.status(400).json({ error: { type: 'ValidationError', message: 'Invalid target profile id' } });
  return false;
};

/** GET /v1/evolution/:target/diff[?from=&to=&format=md] - what changed between two builds (default: the last two). */
evolutionRouter.get('/:target/diff', async (req, res, next) => {
  const target = String(req.params.target);
  if (!validTarget(res, target)) return;
  const query = diffQuerySchema.safeParse(req.query);
  if (!query.success) return badRequest(res, 'Invalid query', query.error.issues);
  try {
    const { diff } = await diffBuilds(target, query.data.from, query.data.to);
    if (query.data.format === 'md') res.type('text/markdown').send(renderChangesMarkdown(diff, target));
    else res.json({ targetProfile: target, ...diff, markdown: renderChangesMarkdown(diff, target) });
  } catch (error) {
    if (!knownError(res, error)) next(error);
  }
});

/** POST /v1/evolution/:target/changes - writes CHANGES.md next to the newer snapshot (and commits it); `narrative` is an agent's text, labelled as such. */
evolutionRouter.post('/:target/changes', async (req, res, next) => {
  const target = String(req.params.target);
  if (!validTarget(res, target)) return;
  const body = changesBodySchema.safeParse(req.body ?? {});
  if (!body.success) return badRequest(res, 'Invalid body', body.error.issues);
  try {
    const written = await writeChanges(target, body.data);
    res.json({ targetProfile: target, file: written.file, git: written.git, counts: written.diff.counts, classified: written.diff.classified });
  } catch (error) {
    if (!knownError(res, error)) next(error);
  }
});

/** GET /v1/evolution/:target/timeline[?screen=&key=&since=&limit=] - when each control appeared, changed or went away. */
evolutionRouter.get('/:target/timeline', async (req, res, next) => {
  const target = String(req.params.target);
  if (!validTarget(res, target)) return;
  const query = timelineQuerySchema.safeParse(req.query);
  if (!query.success) return badRequest(res, 'Invalid query', query.error.issues);
  try {
    res.json(await queryTimeline(target, query.data));
  } catch (error) {
    if (!knownError(res, error)) next(error);
  }
});

/** GET|PUT /v1/evolution/:target/expected/:buildId - the changes a build declares it contains (T4.7). */
evolutionRouter.get('/:target/expected/:buildId', async (req, res, next) => {
  const target = String(req.params.target);
  const buildId = buildIdSchema.safeParse(String(req.params.buildId));
  if (!validTarget(res, target)) return;
  if (!buildId.success) return badRequest(res, 'Invalid build id', buildId.error.issues);
  try {
    const declared = await getExpectedChanges(target, buildId.data);
    if (!declared) {
      res.status(404).json({ error: { type: 'ExpectedChangesNotFound', message: `Build "${buildId.data}" has declared no expected changes` } });
      return;
    }
    res.json(declared);
  } catch (error) {
    next(error);
  }
});

evolutionRouter.put('/:target/expected/:buildId', async (req, res, next) => {
  const target = String(req.params.target);
  if (!validTarget(res, target)) return;
  const parsed = expectedChangesSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Invalid expected changes', parsed.error.issues);
  if (parsed.data.buildId !== String(req.params.buildId)) {
    res.status(400).json({ error: { type: 'ValidationError', message: 'The buildId in the body must match the one in the URL' } });
    return;
  }
  try {
    const saved = await saveExpectedChanges(target, parsed.data);
    res.json({ ...saved.stored, git: saved.git });
  } catch (error) {
    if (!knownError(res, error)) next(error);
  }
});
