import { Router } from 'express';
import { z } from 'zod';

import { flakyConfig, getRoutineFlakiness, listFlakiness } from '../metrics/flakyService.js';
import { getRoutinePerformance, listPerformance, listPerformanceAlerts } from '../metrics/perfService.js';
import { safeName } from '../schemas/explorationRequest.schema.js';

/** /v1/metrics (T3.4): performance series of library routines. Read-only. */
export const metricsRouter = Router();

metricsRouter.get('/routines', async (_req, res, next) => {
  try {
    res.json({ routines: await listPerformance() });
  } catch (error) {
    next(error);
  }
});

metricsRouter.get('/alerts', async (_req, res, next) => {
  try {
    const alerts = await listPerformanceAlerts();
    res.json({ count: alerts.length, alerts });
  } catch (error) {
    next(error);
  }
});

/** T3.5: flakiness. Suggestions only: moving a routine to or from `quarantined` is a PUT /v1/routines/:id by a person. */
metricsRouter.get('/flaky', async (_req, res, next) => {
  try {
    const routines = await listFlakiness();
    res.json({ count: routines.length, suggestions: routines.filter((item) => item.suggestion).length, thresholds: flakyConfig(), routines });
  } catch (error) {
    next(error);
  }
});

const flakyQuerySchema = z
  .object({ version: z.coerce.number().int().positive().optional(), profile: z.enum(['full', 'functional']).optional(), env: z.string().max(300).optional() })
  .strict();

metricsRouter.get('/flaky/:id', async (req, res, next) => {
  try {
    const id = safeName.safeParse(String(req.params.id));
    const query = flakyQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: { type: 'ValidationError', message: 'Invalid query', details: query.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) } });
      return;
    }
    const found = id.success ? await getRoutineFlakiness(id.data, query.data) : undefined;
    if (!found) {
      res.status(404).json({ error: { type: 'NoRunData', message: 'This routine has no recorded runs yet (a series is recorded for every run of a library routine)' } });
      return;
    }
    res.json(found);
  } catch (error) {
    next(error);
  }
});

const querySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).optional(),
    version: z.coerce.number().int().positive().optional(),
    profile: z.enum(['full', 'functional']).optional(),
    env: z.string().max(300).optional(),
  })
  .strict();

metricsRouter.get('/routines/:id', async (req, res, next) => {
  try {
    const id = safeName.safeParse(String(req.params.id));
    const query = querySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: { type: 'ValidationError', message: 'Invalid query', details: query.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) } });
      return;
    }
    const found = id.success ? await getRoutinePerformance(id.data, query.data) : undefined;
    if (!found) {
      res.status(404).json({ error: { type: 'NoPerformanceData', message: 'This routine has no recorded runs yet (a series is recorded for every run of a library routine)' } });
      return;
    }
    res.json(found);
  } catch (error) {
    next(error);
  }
});
