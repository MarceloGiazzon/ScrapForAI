import { Router, type Request, type Response } from 'express';

import { type CredentialSetMeta, credentialSetWriteSchema } from '../schemas/credentialSet.schema.js';
import { requireBearer } from '../security/apiAuth.js';
import { getUser } from '../team/userStore.js';
import {
  deleteCredentialSet,
  getCredentialSetMeta,
  listCredentialSets,
  saveCredentialSet,
  VaultError,
} from '../vault/credentials/credentialVault.js';

/**
 * /v1/credentials. Values are WRITE-ONLY: every response is built from metadata (id, origins,
 * field names, tags, timestamps). Writes require the bearer token, not just a UI session.
 */
export const credentialsRouter = Router();

function sendVaultError(res: Response, error: VaultError): void {
  res.status(error.status).json({ error: { type: error.name, message: error.message } });
}

/**
 * What a reader may see of a set. Everyone learns THAT it is restricted (so a person is not surprised by a refusal); the list of people is for
 * admins, like the rest of the team's membership.
 */
function viewFor(req: Request, meta: CredentialSetMeta): CredentialSetMeta {
  if (req.principal?.role === 'admin') return meta;
  const { allowedUsers: _hidden, ...visible } = meta;
  return visible;
}

credentialsRouter.get('/', async (req, res) => {
  try {
    res.json({ credentialSets: (await listCredentialSets()).map((meta) => viewFor(req, meta)) });
  } catch (error) {
    if (error instanceof VaultError) {
      sendVaultError(res, error);
      return;
    }
    throw error;
  }
});

credentialsRouter.get('/:id', async (req, res) => {
  try {
    const meta = await getCredentialSetMeta(String(req.params.id));
    if (!meta) {
      res.status(404).json({ error: { type: 'CredentialSetNotFound', message: 'Credential set does not exist' } });
      return;
    }
    res.json(viewFor(req, meta));
  } catch (error) {
    if (error instanceof VaultError) {
      sendVaultError(res, error);
      return;
    }
    throw error;
  }
});

function writeHandler(mode: 'create' | 'upsert') {
  return async (req: import('express').Request, res: Response): Promise<void> => {
    const parsed = credentialSetWriteSchema.safeParse(req.body);
    if (!parsed.success) {
      // Paths and messages only: Zod issues for this body never echo submitted values.
      res.status(400).json({
        error: {
          type: 'ValidationError',
          message: 'Invalid credential set',
          details: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        },
      });
      return;
    }

    // A typo in a user id would silently lock that person out of a set (or name nobody), so every id must be a person of the team.
    const named = parsed.data.allowedUsers ?? [];
    const unknown: string[] = [];
    for (const userId of named) {
      if (!(await getUser(userId))) unknown.push(userId);
    }
    if (unknown.length > 0) {
      res.status(400).json({ error: { type: 'UnknownUser', message: `allowedUsers names people who are not in the team: ${unknown.join(', ')}` } });
      return;
    }

    try {
      const meta = await saveCredentialSet(String(req.params.id), parsed.data, mode);
      // For the audit log: who may use the set changed (never a value). A count, not the names.
      res.locals.auditDetail = { set: String(req.params.id), access: parsed.data.allowedUsers === undefined ? 'unchanged' : parsed.data.allowedUsers === null ? 'open' : parsed.data.allowedUsers.length };
      res.status(mode === 'create' ? 201 : 200).json(viewFor(req, meta));
    } catch (error) {
      if (error instanceof VaultError) {
        sendVaultError(res, error);
        return;
      }
      throw error;
    }
  };
}

credentialsRouter.post('/:id', requireBearer, writeHandler('create'));
credentialsRouter.put('/:id', requireBearer, writeHandler('upsert'));

credentialsRouter.delete('/:id', requireBearer, async (req, res) => {
  try {
    if (!(await deleteCredentialSet(String(req.params.id)))) {
      res.status(404).json({ error: { type: 'CredentialSetNotFound', message: 'Credential set does not exist' } });
      return;
    }
    res.status(204).end();
  } catch (error) {
    if (error instanceof VaultError) {
      sendVaultError(res, error);
      return;
    }
    throw error;
  }
});
