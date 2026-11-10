import { Router, type Response } from 'express';

import { cancelMatrixRun, listMatrixRuns, MATRIX_RUN_ID_PATTERN, startMatrixRun, waitForMatrixRun, getMatrixRun } from '../permissions/matrixRunner.js';
import { getMatrix, listMatrices, saveMatrix } from '../permissions/matrixStore.js';
import { RequestResolutionError } from '../runner/resolutionError.js';
import { safeName } from '../schemas/explorationRequest.schema.js';
import { matrixRunBodySchema, permissionMatrixSchema } from '../schemas/permissionMatrix.schema.js';
import { initiatorOf } from '../team/initiator.js';

/**
 * /v1/permissions: permission matrices (T6.1). A definition holds no secret (roles are credential-set NAMES), so,
 * like routines, a UI session may save and run one; the credential values stay in the vault.
 */
export const permissionsRouter = Router();

const MAX_WAIT_SECONDS = 55;

function validationError(res: Response, message: string, issues: Array<{ path: PropertyKey[]; message: string }>): void {
  res.status(400).json({
    error: { type: 'ValidationError', message, details: issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })) },
  });
}

function knownError(res: Response, error: unknown): boolean {
  if (error instanceof RequestResolutionError) {
    res.status(error.status).json({ error: { type: error.name, message: error.message } });
    return true;
  }
  return false;
}

function runNotFound(res: Response): void {
  res.status(404).json({ error: { type: 'MatrixRunNotFound', message: 'Permission matrix run not found' } });
}

permissionsRouter.get('/', async (_req, res, next) => {
  try {
    res.json({ matrices: await listMatrices() });
  } catch (error) {
    next(error);
  }
});

/** GET /v1/permissions/runs[?matrixId=x&limit=N] */
permissionsRouter.get('/runs', async (req, res, next) => {
  try {
    const limit = Number.parseInt(String(req.query.limit ?? '50'), 10);
    const matrixId = typeof req.query.matrixId === 'string' && safeName.safeParse(req.query.matrixId).success ? req.query.matrixId : undefined;
    res.json({ runs: await listMatrixRuns({ ...(matrixId ? { matrixId } : {}), limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50 }) });
  } catch (error) {
    next(error);
  }
});

/** GET /v1/permissions/runs/:runId[?wait=N] — N seconds (max 55) to block until the run ends. */
permissionsRouter.get('/runs/:runId', async (req, res, next) => {
  try {
    const runId = String(req.params.runId);
    if (!MATRIX_RUN_ID_PATTERN.test(runId)) {
      runNotFound(res);
      return;
    }
    const wait = Number.parseInt(String(req.query.wait ?? '0'), 10);
    const waitMs = Number.isFinite(wait) ? Math.min(Math.max(wait, 0), MAX_WAIT_SECONDS) * 1000 : 0;
    const state = waitMs > 0 ? await waitForMatrixRun(runId, waitMs) : await getMatrixRun(runId);
    if (!state) {
      runNotFound(res);
      return;
    }
    res.json(state);
  } catch (error) {
    next(error);
  }
});

permissionsRouter.post('/runs/:runId/cancel', async (req, res, next) => {
  try {
    const runId = String(req.params.runId);
    const state = MATRIX_RUN_ID_PATTERN.test(runId) ? await cancelMatrixRun(runId) : undefined;
    if (!state) {
      runNotFound(res);
      return;
    }
    res.json(state);
  } catch (error) {
    next(error);
  }
});

permissionsRouter.get('/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!safeName.safeParse(id).success) {
      validationError(res, 'Invalid matrix id', []);
      return;
    }
    const stored = await getMatrix(id);
    if (!stored) {
      res.status(404).json({ error: { type: 'PermissionMatrixNotFound', message: `Permission matrix "${id}" does not exist` } });
      return;
    }
    res.json(stored);
  } catch (error) {
    next(error);
  }
});

/** PUT /v1/permissions/:id — store (or replace) a definition. 201 when new, 200 when replaced or unchanged. */
permissionsRouter.put('/:id', async (req, res, next) => {
  const id = String(req.params.id);
  if (!safeName.safeParse(id).success) {
    validationError(res, 'Invalid matrix id', []);
    return;
  }
  const parsed = permissionMatrixSchema.safeParse(req.body);
  if (!parsed.success) {
    validationError(res, 'Invalid permission matrix', parsed.error.issues);
    return;
  }

  try {
    const existed = (await getMatrix(id)) !== undefined;
    const { stored, changed } = await saveMatrix(id, parsed.data);
    res.status(existed ? 200 : 201).json({ changed, ...stored });
  } catch (error) {
    if (!knownError(res, error)) next(error);
  }
});

/** POST /v1/permissions/:id/run — 202 with a runId; poll GET /v1/permissions/runs/:runId?wait=N. */
permissionsRouter.post('/:id/run', async (req, res, next) => {
  const id = String(req.params.id);
  if (!safeName.safeParse(id).success) {
    validationError(res, 'Invalid matrix id', []);
    return;
  }
  const parsed = matrixRunBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    validationError(res, 'Invalid run body', parsed.error.issues);
    return;
  }

  try {
    const state = await startMatrixRun(id, parsed.data, initiatorOf(req.principal));
    res.status(202).location(`/v1/permissions/runs/${state.runId}`).json({
      runId: state.runId,
      matrixId: state.matrixId,
      status: state.status,
      cells: state.cells.length,
      sessions: state.sessions,
      ...(state.comparedTo ? { comparedTo: state.comparedTo } : {}),
    });
  } catch (error) {
    if (!knownError(res, error)) next(error);
  }
});
