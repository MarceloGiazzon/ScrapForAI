import { Router } from 'express';
import type { ZodError } from 'zod';

import { env } from '../config/env.js';
import { inspectDom } from '../runner/inspectDom.js';
import { domInspectionRequestSchema } from '../schemas/domInspectionRequest.schema.js';
import { redactSecrets } from '../security/redactSecrets.js';
import { TargetUrlNotAllowedError } from '../security/validateTargetUrl.js';

export const domInspectionRouter = Router();

let activeInspectionJobs = 0;

function safeValidationDetails(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

domInspectionRouter.post('/', async (req, res, next) => {
  if (activeInspectionJobs >= env.MAX_PARALLEL_JOBS) {
    res.status(429).json({
      error: {
        type: 'TooManyRequests',
        message: 'Too many DOM inspection jobs are already running',
      },
    });
    return;
  }

  const parsed = domInspectionRequestSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: {
        type: 'ValidationError',
        message: 'Invalid DOM inspection request',
        details: safeValidationDetails(parsed.error),
      },
    });
    return;
  }

  activeInspectionJobs += 1;
  try {
    const result = await inspectDom(parsed.data);
    res.status(result.status === 'passed' ? 200 : 500).json(result);
  } catch (error) {
    if (error instanceof TargetUrlNotAllowedError) {
      res.status(400).json({
        error: {
          type: error.name,
          message: error.message,
        },
      });
      return;
    }

    next(redactSecrets(error));
  } finally {
    activeInspectionJobs -= 1;
  }
});
