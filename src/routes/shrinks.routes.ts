import { Router, type Response } from 'express';

import { RequestResolutionError } from '../runner/resolutionError.js';
import { shrinkRequestSchema } from '../schemas/shrink.schema.js';
import { cancelShrink, getShrink, SHRINK_ID_PATTERN, startShrink, waitForShrink } from '../shrink/shrinkService.js';

/** /v1/shrinks: find the smallest input that still fails (T5.6). Asynchronous, like suites. */
export const shrinksRouter = Router();

/** Longest a single poll may block (same as suites: under typical client/proxy timeouts). */
const MAX_WAIT_SECONDS = 55;

function notFound(res: Response): void {
  res.status(404).json({ error: { type: 'ShrinkNotFound', message: 'Shrink run not found' } });
}

/** POST /v1/shrinks: 202 + shrinkId. Poll GET /v1/shrinks/:id[?wait=N]. */
shrinksRouter.post('/', async (req, res, next) => {
  const parsed = shrinkRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        type: 'ValidationError',
        message: 'Invalid shrink request',
        details: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      },
    });
    return;
  }

  try {
    const state = await startShrink(parsed.data);
    res.status(202).location(`/v1/shrinks/${state.shrinkId}`).json({ shrinkId: state.shrinkId, status: state.status, routine: state.routine, maxShrinkRuns: parsed.data.maxShrinkRuns });
  } catch (error) {
    if (error instanceof RequestResolutionError) {
      res.status(error.status).json({ error: { type: error.name, message: error.message } });
      return;
    }
    next(error);
  }
});

shrinksRouter.get('/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!SHRINK_ID_PATTERN.test(id)) {
      notFound(res);
      return;
    }

    const wait = Number.parseInt(String(req.query.wait ?? '0'), 10);
    const waitMs = Number.isFinite(wait) ? Math.min(Math.max(wait, 0), MAX_WAIT_SECONDS) * 1000 : 0;
    const state = waitMs > 0 ? await waitForShrink(id, waitMs) : await getShrink(id);
    if (!state) {
      notFound(res);
      return;
    }
    res.json(state);
  } catch (error) {
    next(error);
  }
});

shrinksRouter.post('/:id/cancel', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const state = SHRINK_ID_PATTERN.test(id) ? await cancelShrink(id) : undefined;
    if (!state) {
      notFound(res);
      return;
    }
    res.json(state);
  } catch (error) {
    next(error);
  }
});
