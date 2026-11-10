import { Router, type Response } from 'express';
import { z, ZodError } from 'zod';

import { EvidenceError } from '../evidence/pin.js';
import { RoutineLibraryError } from '../library/routineLibrary.js';
import { RequestResolutionError } from '../runner/resolutionError.js';
import { addFromRunSchema, confirmGreenSchema, ITEM_ID_PATTERN, itemStatusSchema, itemTypeSchema, regressionItemWriteSchema } from '../schemas/regressionItem.schema.js';
import { requireBearer } from '../security/apiAuth.js';
import { TargetUrlNotAllowedError } from '../security/validateTargetUrl.js';
import { VaultError } from '../vault/credentials/credentialVault.js';
import { addFromRun, confirmGreen, runItem } from '../vault/regression/regressionFlows.js';
import { exportVault, getItem, listItems, saveItem, VaultItemError } from '../vault/regression/regressionVault.js';
import { orderByImpact } from '../vault/regression/impact.js';
import { initiatorOf } from '../team/initiator.js';

/** /v1/vault: the regression vault (T2). Writes that capture evidence need the bearer token. */
export const vaultRouter = Router();

function sendKnownError(res: Response, error: unknown): boolean {
  if (error instanceof VaultItemError || error instanceof RoutineLibraryError || error instanceof EvidenceError) {
    res.status(error.status).json({ error: { type: error.name, message: error.message, ...(error.details ? { details: error.details } : {}) } });
    return true;
  }

  if (error instanceof RequestResolutionError || error instanceof VaultError) {
    res.status(error.status).json({ error: { type: error.name, message: error.message } });
    return true;
  }

  if (error instanceof TargetUrlNotAllowedError) {
    res.status(400).json({ error: { type: error.name, message: error.message } });
    return true;
  }

  if (error instanceof ZodError) {
    res.status(400).json({
      error: { type: 'ValidationError', message: 'Invalid request', details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) },
    });
    return true;
  }

  return false;
}

function handler(fn: (req: import('express').Request, res: Response) => Promise<void>): import('express').RequestHandler {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (!sendKnownError(res, error)) next(error);
    }
  };
}

const list = (value: unknown): string[] | undefined => (typeof value === 'string' && value !== '' ? value.split(',') : undefined);

const filterSchema = z
  .object({
    status: z.array(itemStatusSchema).optional(),
    type: z.array(itemTypeSchema).optional(),
    tags: z.array(z.string().min(1)).optional(),
    surface: z.string().min(1).optional(),
  })
  .strict();

vaultRouter.get(
  '/',
  handler(async (req, res) => {
    const filter = filterSchema.parse({
      status: list(req.query.status),
      type: list(req.query.type),
      tags: list(req.query.tags),
      surface: typeof req.query.surface === 'string' ? req.query.surface : undefined,
    });
    res.json({ items: await listItems(filter) });
  }),
);

/** Deterministic snapshot for the ledger guard (T2.4): sorted ids, stable key order. */
vaultRouter.get(
  '/export',
  handler(async (_req, res) => {
    res.json(await exportVault());
  }),
);

/**
 * POST /v1/vault/plan: the order impact ordering WOULD use, with the reason for each position, without
 * running anything. Body: { changedFiles?, surfaces?, status?, type?, tags?, surface? }.
 */
vaultRouter.post(
  '/plan',
  handler(async (req, res) => {
    const body = filterSchema
      .extend({ changedFiles: z.array(z.string().min(1).max(500)).max(5000).optional(), surfaces: z.array(z.string().min(1)).max(100).optional() })
      .strict()
      .parse(req.body ?? {});

    const items = await listItems({ status: body.status ?? ['ACTIVE'], type: body.type, tags: body.tags, surface: body.surface });
    const ordered = await orderByImpact(items, { changedFiles: body.changedFiles, surfaces: body.surfaces });
    res.json({
      count: ordered.length,
      order: ordered.map((entry) => ({
        position: entry.position,
        id: entry.item.id,
        title: entry.item.title,
        surface: entry.item.surface,
        severity: entry.item.severity,
        routine: entry.item.routine,
        reasons: entry.reasons,
      })),
    });
  }),
);

vaultRouter.post(
  '/add-from-run',
  requireBearer,
  handler(async (req, res) => {
    const outcome = await addFromRun(addFromRunSchema.parse(req.body));
    res.status(201).json(outcome);
  }),
);

vaultRouter.get(
  '/:id',
  handler(async (req, res) => {
    const id = String(req.params.id);
    const item = ITEM_ID_PATTERN.test(id) ? await getItem(id) : undefined;
    if (!item) {
      res.status(404).json({ error: { type: 'ItemNotFound', message: `Item ${id} does not exist` } });
      return;
    }
    res.json(item);
  }),
);

vaultRouter.put(
  '/:id',
  requireBearer,
  handler(async (req, res) => {
    const id = String(req.params.id);
    if (!ITEM_ID_PATTERN.test(id)) {
      throw new VaultItemError(400, 'ValidationError', 'Item id must look like GX-12 or REG-209');
    }
    const { item, created } = await saveItem(id, regressionItemWriteSchema.parse(req.body));
    res.status(created ? 201 : 200).json(item);
  }),
);

/** Runs the item's pinned routine and records lastRun. Exit-code friendly: 200 passed, 500 failed (like /explorations/run). */
vaultRouter.post(
  '/:id/run',
  handler(async (req, res) => {
    const body = confirmGreenSchema.parse(req.body ?? {});
    const outcome = await runItem(String(req.params.id), body, initiatorOf(req.principal));
    res.status(outcome.result.status === 'passed' ? 200 : 500).json(outcome);
  }),
);

vaultRouter.post(
  '/:id/confirm-green',
  requireBearer,
  handler(async (req, res) => {
    const body = confirmGreenSchema.parse(req.body ?? {});
    const outcome = await confirmGreen(String(req.params.id), body, initiatorOf(req.principal));
    // A still-red routine is not an error of the API: 409 says "the item was NOT changed".
    res.status(outcome.confirmed ? 200 : 409).json(outcome.confirmed ? outcome : { error: { type: 'StillRed', message: 'The routine still fails; the item was not changed' }, ...outcome });
  }),
);
