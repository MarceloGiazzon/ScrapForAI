import { Router } from 'express';

import { safeName } from '../schemas/explorationRequest.schema.js';
import { targetProfileSchema } from '../schemas/targetProfile.schema.js';
import { requireBearer } from '../security/apiAuth.js';
import { TargetUrlNotAllowedError } from '../security/validateTargetUrl.js';
import { getTarget, listTargets, saveTarget } from '../targets/targetStore.js';

export const targetsRouter = Router();

targetsRouter.get('/', async (_req, res) => {
  res.json({ targets: await listTargets() });
});

targetsRouter.get('/:id', async (req, res) => {
  const id = String(req.params.id);
  if (!safeName.safeParse(id).success) {
    res.status(400).json({ error: { type: 'ValidationError', message: 'Invalid target profile id', details: [] } });
    return;
  }

  const profile = await getTarget(id);
  if (!profile) {
    res.status(404).json({ error: { type: 'TargetProfileNotFound', message: `Target profile "${id}" does not exist` } });
    return;
  }

  res.json(profile);
});

targetsRouter.put('/:id', requireBearer, async (req, res) => {
  const id = String(req.params.id);
  if (!safeName.safeParse(id).success) {
    res.status(400).json({ error: { type: 'ValidationError', message: 'Invalid target profile id', details: [] } });
    return;
  }

  const body = typeof req.body === 'object' && req.body !== null ? (req.body as Record<string, unknown>) : {};
  if (body.id !== undefined && body.id !== id) {
    res.status(400).json({
      error: { type: 'ValidationError', message: 'Body id does not match the URL id', details: [{ path: 'id', message: 'must equal the URL id' }] },
    });
    return;
  }

  const parsed = targetProfileSchema.safeParse({ ...body, id });
  if (!parsed.success) {
    res.status(400).json({
      error: {
        type: 'ValidationError',
        message: 'Invalid target profile',
        details: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      },
    });
    return;
  }

  try {
    res.json(await saveTarget(parsed.data));
  } catch (error) {
    if (error instanceof TargetUrlNotAllowedError) {
      res.status(400).json({ error: { type: error.name, message: `baseUrl is outside the allowlist: ${error.message}` } });
      return;
    }
    throw error;
  }
});
