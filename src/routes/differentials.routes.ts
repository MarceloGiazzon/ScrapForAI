import { Router, type Response } from 'express';

import {
  cancelDifferential,
  compareJobs,
  DIFFERENTIAL_ID_PATTERN,
  getDifferential,
  startDifferential,
  waitForDifferential,
} from '../differential/differentialService.js';
import { renderDifferentialMarkdown } from '../differential/render.js';
import { RequestResolutionError } from '../runner/resolutionError.js';
import { differentialCompareRequestSchema, differentialRequestSchema } from '../schemas/differential.schema.js';

/** /v1/differentials: the same routines against two target profiles, and what differs (T6.3). Asynchronous, like suites. */
export const differentialsRouter = Router();

/** Longest a single poll may block (same as suites: under typical client/proxy timeouts). */
const MAX_WAIT_SECONDS = 55;

function notFound(res: Response): void {
  res.status(404).json({ error: { type: 'DifferentialNotFound', message: 'Differential run not found' } });
}

function invalid(res: Response, message: string, issues: Array<{ path: Array<string | number | symbol>; message: string }>): void {
  res.status(400).json({
    error: { type: 'ValidationError', message, details: issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) },
  });
}

/** POST /v1/differentials: 202 + differentialId. Poll GET /v1/differentials/:id[?wait=N]. */
differentialsRouter.post('/', async (req, res, next) => {
  const parsed = differentialRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    invalid(res, 'Invalid differential request', parsed.error.issues);
    return;
  }

  try {
    const state = await startDifferential(parsed.data);
    res.status(202).location(`/v1/differentials/${state.differentialId}`).json({ differentialId: state.differentialId, status: state.status, labels: state.labels, counts: state.counts, ...(state.warnings ? { warnings: state.warnings } : {}) });
  } catch (error) {
    if (error instanceof RequestResolutionError) {
      res.status(error.status).json({ error: { type: error.name, message: error.message } });
      return;
    }
    next(error);
  }
});

/** POST /v1/differentials/compare: compare two runs whose evidence still exists. Nothing runs; answers 200. */
differentialsRouter.post('/compare', async (req, res, next) => {
  const parsed = differentialCompareRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    invalid(res, 'Invalid compare request', parsed.error.issues);
    return;
  }

  try {
    res.json(await compareJobs(parsed.data));
  } catch (error) {
    if (error instanceof RequestResolutionError) {
      res.status(error.status).json({ error: { type: error.name, message: error.message } });
      return;
    }
    next(error);
  }
});

differentialsRouter.get('/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!DIFFERENTIAL_ID_PATTERN.test(id)) {
      notFound(res);
      return;
    }

    const wait = Number.parseInt(String(req.query.wait ?? '0'), 10);
    const waitMs = Number.isFinite(wait) ? Math.min(Math.max(wait, 0), MAX_WAIT_SECONDS) * 1000 : 0;
    const state = waitMs > 0 ? await waitForDifferential(id, waitMs) : await getDifferential(id);
    if (!state) {
      notFound(res);
      return;
    }

    if (req.query.format === 'md') {
      res.type('text/markdown; charset=utf-8').send(renderDifferentialMarkdown(state));
      return;
    }
    res.json(state);
  } catch (error) {
    next(error);
  }
});

differentialsRouter.post('/:id/cancel', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const state = DIFFERENTIAL_ID_PATTERN.test(id) ? await cancelDifferential(id) : undefined;
    if (!state) {
      notFound(res);
      return;
    }
    res.json(state);
  } catch (error) {
    next(error);
  }
});
