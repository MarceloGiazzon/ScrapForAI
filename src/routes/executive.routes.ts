import { Router } from 'express';
import { z } from 'zod';

import { getExecutive } from '../executive/executiveService.js';
import { safeName } from '../schemas/explorationRequest.schema.js';
import { getTarget } from '../targets/targetStore.js';

/**
 * /v1/executive (T9.4): the executive overview behind the web console's Executive screen. Read-only; a session may call it.
 * `?days=30&weeks=8&target=a,b`.
 */
export const executiveRouter = Router();

const querySchema = z
  .object({
    days: z.coerce.number().int().min(1).max(90).default(30),
    weeks: z.coerce.number().int().min(4).max(26).default(8),
    target: z
      .string()
      .transform((value) => value.split(',').map((item) => item.trim()).filter(Boolean))
      .pipe(z.array(safeName).min(1).max(50))
      .optional(),
  })
  .strict();

executiveRouter.get('/', async (req, res, next) => {
  try {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: { type: 'InvalidQuery', message: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'query'}: ${issue.message}`).join('; ') } });
      return;
    }
    const { days, weeks, target } = parsed.data;
    for (const id of target ?? []) {
      if (!(await getTarget(id))) {
        res.status(404).json({ error: { type: 'TargetProfileNotFound', message: `Target profile "${id}" does not exist` } });
        return;
      }
    }
    res.json(await getExecutive({ days, weeks, ...(target ? { targets: target } : {}) }));
  } catch (error) {
    next(error);
  }
});
