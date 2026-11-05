import { Router, type Response } from 'express';
import { ZodError } from 'zod';

import { getIntegrationView, IntegrationError, listIntegrationViews, removeIntegration, saveIntegrationDefinition, testIntegration } from '../integrations/integrationService.js';
import { integrationIdSchema } from '../schemas/integration.schema.js';
import { requireBearer } from '../security/apiAuth.js';

/**
 * /v1/integrations (T9.1). An integration is a place this server SENDS bug reports to, and its token is a secret: every write needs the bearer token
 * (a UI session is not enough) and no response ever carries the token, only whether there is one.
 */
export const integrationsRouter = Router();

function known(res: Response, error: unknown): boolean {
  if (error instanceof IntegrationError) {
    res.status(error.status).json({ error: { type: error.name, message: error.message } });
    return true;
  }
  if (error instanceof ZodError) {
    // Paths and messages only: a Zod issue for `token` could otherwise echo what was submitted.
    res.status(400).json({ error: { type: 'ValidationError', message: 'Invalid integration', details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) } });
    return true;
  }
  return false;
}

const idOf = (value: unknown): string | undefined => {
  const parsed = integrationIdSchema.safeParse(String(value));
  return parsed.success ? parsed.data : undefined;
};
const notFound = (res: Response): void => void res.status(404).json({ error: { type: 'IntegrationNotFound', message: 'Integration not found' } });

integrationsRouter.get('/', async (_req, res, next) => {
  try {
    res.json({ integrations: await listIntegrationViews() });
  } catch (error) {
    next(error);
  }
});

integrationsRouter.get('/:id', async (req, res, next) => {
  try {
    const id = idOf(req.params.id);
    const found = id ? await getIntegrationView(id) : undefined;
    if (!found) return notFound(res);
    res.json(found);
  } catch (error) {
    next(error);
  }
});

integrationsRouter.put('/:id', requireBearer, async (req, res, next) => {
  try {
    const id = idOf(req.params.id);
    if (!id) {
      res.status(400).json({ error: { type: 'ValidationError', message: 'Integration id must match [a-zA-Z0-9_-]{1,60}' } });
      return;
    }
    const { view, created } = await saveIntegrationDefinition(id, req.body);
    res.status(created ? 201 : 200).json(view);
  } catch (error) {
    if (!known(res, error)) next(error);
  }
});

integrationsRouter.delete('/:id', requireBearer, async (req, res, next) => {
  try {
    const id = idOf(req.params.id);
    if (!id || !(await removeIntegration(id))) return notFound(res);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

/** POST /v1/integrations/:id/test: can the stored token see the repository? Creates nothing. 200 ok, 502 not. */
integrationsRouter.post('/:id/test', requireBearer, async (req, res, next) => {
  try {
    const id = idOf(req.params.id);
    const check = id ? await testIntegration(id) : undefined;
    if (!check) return notFound(res);
    res.status(check.ok ? 200 : 502).json(check);
  } catch (error) {
    next(error);
  }
});
