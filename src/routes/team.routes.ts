import { Router, type Response } from 'express';
import { ZodError } from 'zod';

import { requireBearer } from '../security/apiAuth.js';
import { destroySessionsOf } from '../security/sessionStore.js';
import { readAudit, verifyAudit } from '../team/audit.js';
import {
  addKey,
  createKeyInputSchema,
  createUser,
  createUserInputSchema,
  deleteUser,
  getUser,
  listUsers,
  revokeKey,
  TeamError,
  updateUser,
  updateUserInputSchema,
  userIdSchema,
} from '../team/userStore.js';

/**
 * /v1/team (T10.1): the people who may use this server, their roles and their personal API keys; and /v1/audit, the log of what they did.
 *
 * Everything here is for admins. Reading is open to an admin's session; every WRITE needs an admin's key sent as a Bearer token (like the
 * credential vault), so a stolen browser session cannot mint itself a key. A key is returned ONCE, in the answer that creates it; nothing
 * afterwards (list, show, audit) can show it again, only its id.
 */
export const teamRouter = Router();
export const auditRouter = Router();

function known(res: Response, error: unknown): boolean {
  if (error instanceof TeamError) {
    res.status(error.status).json({ error: { type: error.name, message: error.message } });
    return true;
  }
  if (error instanceof ZodError) {
    // Paths and messages only: never an echo of what was submitted.
    res.status(400).json({ error: { type: 'ValidationError', message: 'Invalid request', details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) } });
    return true;
  }
  return false;
}

const idOf = (value: unknown): string | undefined => {
  const parsed = userIdSchema.safeParse(String(value));
  return parsed.success ? parsed.data : undefined;
};
const badId = (res: Response): void => void res.status(400).json({ error: { type: 'ValidationError', message: 'Invalid user id' } });
const noStore = (res: Response): void => void res.setHeader('Cache-Control', 'no-store');
const KEY_NOTICE = 'Copy this key now: it is shown only once and cannot be read again. Keep it out of routines, tickets and chat.';

teamRouter.get('/users', async (_req, res, next) => {
  try {
    res.json({ users: await listUsers() });
  } catch (error) {
    next(error);
  }
});

teamRouter.get('/users/:id', async (req, res, next) => {
  try {
    const id = idOf(req.params.id);
    if (!id) return badId(res);
    const user = await getUser(id);
    if (!user) {
      res.status(404).json({ error: { type: 'UserNotFound', message: `User "${id}" does not exist` } });
      return;
    }
    res.json(user);
  } catch (error) {
    next(error);
  }
});

teamRouter.post('/users', requireBearer, async (req, res, next) => {
  try {
    const input = createUserInputSchema.parse(req.body);
    const { user, key } = await createUser(input, req.principal?.userId ?? 'unknown');
    res.locals.auditDetail = { user: user.id, role: user.role };
    noStore(res);
    res.status(201).json({ user, key, notice: KEY_NOTICE });
  } catch (error) {
    if (!known(res, error)) next(error);
  }
});

teamRouter.patch('/users/:id', requireBearer, async (req, res, next) => {
  try {
    const id = idOf(req.params.id);
    if (!id) return badId(res);
    const input = updateUserInputSchema.parse(req.body);
    const user = await updateUser(id, input);
    // A disabled person is out now, not at the end of their session.
    if (input.disabled === true) destroySessionsOf(id);
    res.locals.auditDetail = {
      user: id,
      ...(input.role === undefined ? {} : { role: input.role }),
      ...(input.disabled === undefined ? {} : { disabled: input.disabled }),
    };
    res.json(user);
  } catch (error) {
    if (!known(res, error)) next(error);
  }
});

teamRouter.delete('/users/:id', requireBearer, async (req, res, next) => {
  try {
    const id = idOf(req.params.id);
    if (!id) return badId(res);
    await deleteUser(id);
    destroySessionsOf(id);
    res.locals.auditDetail = { user: id };
    res.json({ deleted: id });
  } catch (error) {
    if (!known(res, error)) next(error);
  }
});

teamRouter.post('/users/:id/keys', requireBearer, async (req, res, next) => {
  try {
    const id = idOf(req.params.id);
    if (!id) return badId(res);
    const input = createKeyInputSchema.parse(req.body ?? {});
    const { key, view } = await addKey(id, input);
    res.locals.auditDetail = { user: id, keyId: view.id };
    noStore(res);
    res.status(201).json({ key, keyId: view.id, view, notice: KEY_NOTICE });
  } catch (error) {
    if (!known(res, error)) next(error);
  }
});

teamRouter.delete('/users/:id/keys/:keyId', requireBearer, async (req, res, next) => {
  try {
    const id = idOf(req.params.id);
    if (!id) return badId(res);
    const view = await revokeKey(id, String(req.params.keyId));
    res.locals.auditDetail = { user: id, keyId: view.id };
    res.json(view);
  } catch (error) {
    if (!known(res, error)) next(error);
  }
});

// ---- audit

const positiveInt = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return typeof value === 'string' && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 && value.length <= 120 ? value : undefined);

/** Newest first. ?limit= (max 1000), ?before=<seq> to page back, ?user= ?method= ?area= ?event= ?since=<ISO time>. */
auditRouter.get('/', async (req, res, next) => {
  try {
    const { query } = req;
    const limit = positiveInt(query.limit);
    const before = positiveInt(query.before);
    const user = text(query.user);
    const method = text(query.method);
    const area = text(query.area);
    const event = text(query.event);
    const since = text(query.since);
    res.json(
      await readAudit({
        ...(limit === undefined ? {} : { limit }),
        ...(before === undefined ? {} : { before }),
        ...(user === undefined ? {} : { user }),
        ...(method === undefined ? {} : { method }),
        ...(area === undefined ? {} : { area }),
        ...(event === undefined ? {} : { event }),
        ...(since === undefined ? {} : { since }),
      }),
    );
  } catch (error) {
    next(error);
  }
});

/** Walks the hash chain. 200 with `ok: false` and the first problems when the log was edited or lines were removed from the middle. */
auditRouter.get('/verify', async (_req, res, next) => {
  try {
    res.json(await verifyAudit());
  } catch (error) {
    next(error);
  }
});
