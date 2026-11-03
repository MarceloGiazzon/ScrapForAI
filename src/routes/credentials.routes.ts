import { Router, type Response } from 'express';

import { credentialSetWriteSchema } from '../schemas/credentialSet.schema.js';
import { requireBearer } from '../security/apiAuth.js';
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

credentialsRouter.get('/', async (_req, res) => {
  try {
    res.json({ credentialSets: await listCredentialSets() });
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
    res.json(meta);
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

    try {
      const meta = await saveCredentialSet(String(req.params.id), parsed.data, mode);
      res.status(mode === 'create' ? 201 : 200).json(meta);
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
