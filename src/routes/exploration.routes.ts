import { Router } from 'express';
import type { ZodError } from 'zod';

import { env } from '../config/env.js';
import { explorationRequestSchema } from '../schemas/explorationRequest.schema.js';
import { redactSecrets } from '../security/redactSecrets.js';
import { TargetUrlNotAllowedError } from '../security/validateTargetUrl.js';
import { RequestResolutionError, resolveExplorationRequest } from '../runner/resolveRequest.js';
import { acquireInteractiveSlot } from '../runner/jobSlots.js';
import { runExploration } from '../runner/runExploration.js';
import { VaultError } from '../vault/credentials/credentialVault.js';

export const explorationRouter = Router();

function safeValidationDetails(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

explorationRouter.post('/run', async (req, res, next) => {
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

  if (parsed.data.credentials !== undefined) {
    if (!env.ALLOW_INLINE_CREDENTIALS) {
      res.status(400).json({
        error: {
          type: 'InlineCredentialsDisabled',
          message: 'Inline "credentials" are disabled on this server (ALLOW_INLINE_CREDENTIALS=false). Store the secrets in the vault and pass "credentialSet".',
        },
      });
      return;
    }

    // Names only, never values.
    req.log?.warn(
      { deprecated: 'inline-credentials', fields: Object.keys(parsed.data.credentials) },
      'Inline "credentials" are deprecated; store them in the vault (POST /v1/credentials/:id) and pass "credentialSet"',
    );
  }

  const slot = await acquireInteractiveSlot(parsed.data);
  if (!slot.ok) {
    res.status(slot.status).json({ error: { type: slot.type, message: slot.message } });
    return;
  }

  try {
    const result = await runExploration(await resolveExplorationRequest(parsed.data));
    res.status(result.status === 'passed' ? 200 : 500).json(result);
  } catch (error) {
    if (error instanceof RequestResolutionError || error instanceof VaultError) {
      res.status(error.status).json({ error: { type: error.name, message: error.message } });
      return;
    }

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
    slot.release();
  }
});
