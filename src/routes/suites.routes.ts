import { Router, type Response } from 'express';

import { RequestResolutionError } from '../runner/resolutionError.js';
import { suiteRequestSchema } from '../schemas/suiteRequest.schema.js';
import { cancelSuite, getSuite, listSuites, startSuite, SUITE_ID_PATTERN, waitForSuite } from '../orchestrator/suiteRunner.js';
import { sendReport } from './reportHandler.js';
import { RoutineLibraryError } from '../library/routineLibrary.js';

/** /v1/suites: asynchronous multi-routine runs (T1.6). */
export const suitesRouter = Router();

/** Longest a single poll may block. Kept well under typical client/proxy timeouts (MCP default: 120 s). */
const MAX_WAIT_SECONDS = 55;

function notFound(res: Response): void {
  res.status(404).json({ error: { type: 'SuiteNotFound', message: 'Suite run not found' } });
}

suitesRouter.post('/', async (req, res, next) => {
  const parsed = suiteRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        type: 'ValidationError',
        message: 'Invalid suite request',
        details: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      },
    });
    return;
  }

  try {
    const state = await startSuite(parsed.data);
    // 202: accepted, running in the background. Poll GET /v1/suites/:id (optionally ?wait=N).
    res.status(202).location(`/v1/suites/${state.suiteRunId}`).json({
      suiteRunId: state.suiteRunId,
      status: state.status,
      total: state.total,
      variants: state.variants.map((variant) => ({ variantKey: variant.variantKey, status: variant.status })),
    });
  } catch (error) {
    if (error instanceof RequestResolutionError || error instanceof RoutineLibraryError) {
      res.status(error.status).json({ error: { type: error.name, message: error.message } });
      return;
    }
    next(error);
  }
});

suitesRouter.get('/', async (req, res, next) => {
  try {
    const limit = Number.parseInt(String(req.query.limit ?? '50'), 10);
    res.json({ suites: await listSuites(Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50) });
  } catch (error) {
    next(error);
  }
});

/** GET /v1/suites/:id[?wait=N] — N seconds (max 55) to block until the suite ends; omit to answer at once. */
suitesRouter.get('/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!SUITE_ID_PATTERN.test(id)) {
      notFound(res);
      return;
    }

    const wait = Number.parseInt(String(req.query.wait ?? '0'), 10);
    const waitMs = Number.isFinite(wait) ? Math.min(Math.max(wait, 0), MAX_WAIT_SECONDS) * 1000 : 0;

    const state = waitMs > 0 ? await waitForSuite(id, waitMs) : await getSuite(id);
    if (!state) {
      notFound(res);
      return;
    }

    res.json(state);
  } catch (error) {
    next(error);
  }
});

/** GET /v1/suites/:id/report?format=html|pdf&lang=en|pt|es - report of a FINISHED suite (409 while it runs). */
suitesRouter.get('/:id/report', async (req, res, next) => {
  try {
    await sendReport(req, res, 'suite', String(req.params.id));
  } catch (error) {
    next(error);
  }
});

suitesRouter.post('/:id/cancel', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const state = SUITE_ID_PATTERN.test(id) ? await cancelSuite(id) : undefined;
    if (!state) {
      notFound(res);
      return;
    }

    res.json(state);
  } catch (error) {
    next(error);
  }
});
