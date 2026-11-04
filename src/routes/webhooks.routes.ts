import { Router, type Response } from 'express';
import { ZodError } from 'zod';

import { getWebhookView, listWebhookViews, removeWebhook, saveWebhookDefinition, testWebhook, WebhookError } from '../integrations/webhookService.js';
import { requireBearer } from '../security/apiAuth.js';
import { webhookIdSchema } from '../schemas/webhook.schema.js';

/**
 * /v1/webhooks (T3.3). A webhook is a place this server SENDS data to, and its URL is a secret, so every write needs the bearer token
 * (a UI session is not enough) and no response ever carries the URL: only its origin.
 */
export const webhooksRouter = Router();

function known(res: Response, error: unknown): boolean {
  if (error instanceof WebhookError) {
    res.status(error.status).json({ error: { type: error.name, message: error.message } });
    return true;
  }
  if (error instanceof ZodError) {
    // Paths and messages only: a Zod issue for `url` could otherwise echo what was submitted.
    res.status(400).json({ error: { type: 'ValidationError', message: 'Invalid webhook', details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) } });
    return true;
  }
  return false;
}

const idOf = (value: unknown): string | undefined => {
  const parsed = webhookIdSchema.safeParse(String(value));
  return parsed.success ? parsed.data : undefined;
};
const notFound = (res: Response): void => void res.status(404).json({ error: { type: 'WebhookNotFound', message: 'Webhook not found' } });

webhooksRouter.get('/', async (_req, res, next) => {
  try {
    res.json({ webhooks: await listWebhookViews() });
  } catch (error) {
    next(error);
  }
});

webhooksRouter.get('/:id', async (req, res, next) => {
  try {
    const id = idOf(req.params.id);
    const found = id ? await getWebhookView(id) : undefined;
    if (!found) return notFound(res);
    res.json(found);
  } catch (error) {
    next(error);
  }
});

webhooksRouter.put('/:id', requireBearer, async (req, res, next) => {
  try {
    const id = idOf(req.params.id);
    if (!id) {
      res.status(400).json({ error: { type: 'ValidationError', message: 'Webhook id must match [a-zA-Z0-9_-]{1,64}' } });
      return;
    }
    const { view, created } = await saveWebhookDefinition(id, req.body);
    res.status(created ? 201 : 200).json(view);
  } catch (error) {
    if (!known(res, error)) next(error);
  }
});

webhooksRouter.delete('/:id', requireBearer, async (req, res, next) => {
  try {
    const id = idOf(req.params.id);
    if (!id || !(await removeWebhook(id))) return notFound(res);
    res.status(204).end();
  } catch (error) {
    if (!known(res, error)) next(error);
  }
});

/** POST /v1/webhooks/:id/test: send a harmless message now. The answer says whether it arrived (never the URL or the other side's reply). */
webhooksRouter.post('/:id/test', requireBearer, async (req, res, next) => {
  try {
    const id = idOf(req.params.id);
    const delivery = id ? await testWebhook(id) : undefined;
    if (!delivery) return notFound(res);
    res.status(delivery.status === 'sent' ? 200 : 502).json(delivery);
  } catch (error) {
    if (!known(res, error)) next(error);
  }
});
