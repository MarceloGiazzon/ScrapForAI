import { Router } from 'express';
import { z } from 'zod';

import { safeName } from '../schemas/explorationRequest.schema.js';
import { renderSummaryMarkdown } from '../summary/summaryAnalysis.js';
import { getSummary } from '../summary/summaryService.js';
import { getTarget } from '../targets/targetStore.js';

/**
 * /v1/summary (T9.3): the periodic summary a `summary` schedule sends, on demand, for a person to read before (or instead of) scheduling it.
 * Read-only; a session may call it. `?days=7&target=a,b&lang=en|pt|es&format=json|md`.
 */
export const summaryRouter = Router();

const querySchema = z
  .object({
    days: z.coerce.number().int().min(1).max(31).default(7),
    target: z
      .string()
      .transform((value) => value.split(',').map((item) => item.trim()).filter(Boolean))
      .pipe(z.array(safeName).min(1).max(50))
      .optional(),
    lang: z.enum(['en', 'pt', 'es']).default('en'),
    format: z.enum(['json', 'md']).default('json'),
  })
  .strict();

summaryRouter.get('/', async (req, res, next) => {
  try {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: { type: 'InvalidQuery', message: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'query'}: ${issue.message}`).join('; ') } });
      return;
    }
    const { days, target, lang, format } = parsed.data;
    for (const id of target ?? []) {
      if (!(await getTarget(id))) {
        res.status(404).json({ error: { type: 'TargetProfileNotFound', message: `Target profile "${id}" does not exist` } });
        return;
      }
    }
    const report = await getSummary({ days, ...(target ? { targets: target } : {}) });
    const markdown = renderSummaryMarkdown(report, lang);
    if (format === 'md') {
      res.type('text/markdown; charset=utf-8').send(markdown);
      return;
    }
    res.json({ ...report, markdown });
  } catch (error) {
    next(error);
  }
});
