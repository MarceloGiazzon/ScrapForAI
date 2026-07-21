import { Router } from 'express';
import type { ZodError } from 'zod';

import { env } from '../config/env.js';
import { explorationRequestSchema } from '../schemas/explorationRequest.schema.js';
import { redactSecrets } from '../security/redactSecrets.js';
import { TargetUrlNotAllowedError } from '../security/validateTargetUrl.js';
import { runExploration } from '../runner/runExploration.js';

export const explorationRouter = Router();

let activeJobs = 0;

function safeValidationDetails(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

explorationRouter.post('/run', async (req, res, next) => {
  if (activeJobs >= env.MAX_PARALLEL_JOBS) {
    res.status(429).json({
      error: {
        type: 'TooManyRequests',
        message: 'Too many exploration jobs are already running',
      },
    });
    return;
  }

  const parsed = explorationRequestSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: {
        type: 'ValidationError',
        message: 'Invalid exploration request',
        details: safeValidationDetails(parsed.error),
      },
    });
    return;
  }

  activeJobs += 1;
  try {
    const result = await runExploration(parsed.data);
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
    activeJobs -= 1;
  }
});
