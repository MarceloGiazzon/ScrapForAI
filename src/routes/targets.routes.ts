import { Router, type Request } from 'express';

import { safeName } from '../schemas/explorationRequest.schema.js';
import { targetProfileSchema } from '../schemas/targetProfile.schema.js';
import { requireBearer } from '../security/apiAuth.js';
import { TargetUrlNotAllowedError } from '../security/validateTargetUrl.js';
import { getTarget, listTargets, PiiPolicyError, saveTarget } from '../targets/targetStore.js';
import type { TargetProfile } from '../schemas/targetProfile.schema.js';
import { getUser } from '../team/userStore.js';

export const targetsRouter = Router();

/**
 * What a reader gets: everyone learns THAT a profile is restricted (`restricted`), only an admin learns WHO may use it (the team's membership is
 * not for every viewer). The stored profile is untouched; this is only the view.
 */
function viewFor(req: Request, profile: TargetProfile): Omit<TargetProfile, 'allowedUsers'> & { allowedUsers?: string[]; restricted: boolean } {
  const restricted = profile.allowedUsers !== undefined;
  if (req.principal?.role === 'admin') return { ...profile, restricted };
  const { allowedUsers: _hidden, ...visible } = profile;
  return { ...visible, restricted };
}

targetsRouter.get('/', async (req, res) => {
  res.json({ targets: (await listTargets()).map((profile) => viewFor(req, profile)) });
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

  res.json(viewFor(req, profile));
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

  // The profile is replaced as a whole, so a PUT that only fixes a URL must never open a restricted profile: an OMITTED `allowedUsers` keeps the stored
  // list, `null` removes it, a list sets it (an empty one means admins only).
  const stored = await getTarget(id).catch(() => undefined);
  const allowedUsers = body.allowedUsers === undefined ? stored?.allowedUsers : (body.allowedUsers ?? undefined);

  const parsed = targetProfileSchema.safeParse({ ...body, id, allowedUsers });
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

  // A typo in a user id would silently lock that person out (or name nobody), so every id must be a person of the team.
  const people = [...new Set(parsed.data.allowedUsers ?? [])];
  const unknown: string[] = [];
  for (const userId of people) {
    if (!(await getUser(userId))) unknown.push(userId);
  }
  if (unknown.length > 0) {
    res.status(400).json({ error: { type: 'UnknownUser', message: `allowedUsers names people who are not in the team: ${unknown.join(', ')}` } });
    return;
  }
  const profile: TargetProfile = { ...parsed.data, ...(parsed.data.allowedUsers === undefined ? {} : { allowedUsers: people }) };

  try {
    const saved = await saveTarget(profile);
    // For the audit log: who may use the profile changed (a count, not the names).
    res.locals.auditDetail = { target: id, access: body.allowedUsers === undefined ? 'unchanged' : body.allowedUsers === null ? 'open' : people.length };
    res.json(viewFor(req, saved));
  } catch (error) {
    if (error instanceof PiiPolicyError) {
      res.status(400).json({ error: { type: 'ValidationError', message: 'Invalid PII policy', details: error.details } });
      return;
    }
    if (error instanceof TargetUrlNotAllowedError) {
      res.status(400).json({ error: { type: error.name, message: `baseUrl is outside the allowlist: ${error.message}` } });
      return;
    }
    throw error;
  }
});
