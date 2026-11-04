import { Router, type Response } from 'express';

import { cancelManualBuild, getManual, getManualBuild, MANUAL_BUILD_ID, startManualBuild, waitForManualBuild } from '../manual/manualService.js';
import { RequestResolutionError } from '../runner/resolutionError.js';
import { safeName } from '../schemas/explorationRequest.schema.js';
import { manualBuildBodySchema } from '../schemas/manual.schema.js';
import { requireBearer } from '../security/apiAuth.js';

/**
 * /v1/manual: the living manual (T9.2). Building one starts browsers and writes files into MANUAL_OUTPUT_DIR, so starting and cancelling a build need the
 * bearer token (like a schedule); reading what a build wrote does not. Asynchronous, like suites.
 */
export const manualRouter = Router();

/** Longest a single poll may block (same as suites: under typical client/proxy timeouts). */
const MAX_WAIT_SECONDS = 55;

function knownError(res: Response, error: unknown): boolean {
  if (error instanceof RequestResolutionError) {
    res.status(error.status).json({ error: { type: error.name, message: error.message } });
    return true;
  }
  return false;
}

/** POST /v1/manual/builds: 202 + buildRunId. Poll GET /v1/manual/builds/:id[?wait=N]. */
manualRouter.post('/builds', requireBearer, async (req, res, next) => {
  const parsed = manualBuildBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: {
        type: 'ValidationError',
        message: 'Invalid manual build request',
        details: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
      },
    });
    return;
  }

  try {
    const state = await startManualBuild(parsed.data);
    res
      .status(202)
      .location(`/v1/manual/builds/${state.buildRunId}`)
      .json({ buildRunId: state.buildRunId, targetProfile: state.targetProfile, status: state.status, routines: state.routines.length, skipped: state.skipped });
  } catch (error) {
    if (!knownError(res, error)) next(error);
  }
});

manualRouter.get('/builds/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!MANUAL_BUILD_ID.test(id)) {
      res.status(404).json({ error: { type: 'ManualBuildNotFound', message: 'Manual build not found' } });
      return;
    }
    const wait = Number.parseInt(String(req.query.wait ?? '0'), 10);
    const waitMs = Number.isFinite(wait) ? Math.min(Math.max(wait, 0), MAX_WAIT_SECONDS) * 1000 : 0;
    const state = waitMs > 0 ? await waitForManualBuild(id, waitMs) : await getManualBuild(id);
    if (!state) {
      res.status(404).json({ error: { type: 'ManualBuildNotFound', message: 'Manual build not found' } });
      return;
    }
    res.json(state);
  } catch (error) {
    next(error);
  }
});

manualRouter.post('/builds/:id/cancel', requireBearer, async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const state = MANUAL_BUILD_ID.test(id) ? await cancelManualBuild(id) : undefined;
    if (!state) {
      res.status(404).json({ error: { type: 'ManualBuildNotFound', message: 'Manual build not found' } });
      return;
    }
    res.json(state);
  } catch (error) {
    next(error);
  }
});

/** GET /v1/manual/:target: the manifest the last build wrote (build, figures, what changed, missing captions) and the folder it is in. */
manualRouter.get('/:target', async (req, res, next) => {
  try {
    const target = String(req.params.target);
    if (!safeName.safeParse(target).success) {
      res.status(404).json({ error: { type: 'ManualNotFound', message: 'No manual for this target profile' } });
      return;
    }
    const manual = await getManual(target);
    if (!manual) {
      res.status(404).json({ error: { type: 'ManualNotFound', message: `No manual has been built for "${target}" yet (scrapforai manual build ${target})` } });
      return;
    }
    res.json(manual);
  } catch (error) {
    next(error);
  }
});
