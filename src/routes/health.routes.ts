import { Router } from 'express';

import { getHealth } from '../health/healthService.js';

/** /v1/health (T3.7): the state of every target profile in one read. Read-only; a session (the web console) may call it. */
export const healthRouter = Router();

healthRouter.get('/', async (req, res, next) => {
  try {
    const report = await getHealth();
    const only = typeof req.query.target === 'string' ? req.query.target : undefined;
    if (only === undefined) {
      res.json(report);
      return;
    }
    const target = report.targets.find((item) => item.id === only);
    if (!target) {
      res.status(404).json({ error: { type: 'TargetNotFound', message: 'No target profile, routine or schedule refers to this target' } });
      return;
    }
    res.json({ ...report, targets: [target], totals: { targets: 1, red: 0, yellow: 0, green: 0, empty: 0, [target.status]: 1 } });
  } catch (error) {
    next(error);
  }
});
