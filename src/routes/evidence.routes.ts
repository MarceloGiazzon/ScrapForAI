import { Router } from 'express';

import { verifyChain } from '../evidence/chain.js';
import { loadPublicKey } from '../evidence/signingKey.js';

/** /v1/evidence: the signing key and the integrity of the whole chain of pinned evidence (T2.6). */
export const evidenceRouter = Router();

/** The public half of the installation key and its id: what a third party needs to verify exports. */
evidenceRouter.get('/public-key', async (_req, res, next) => {
  try {
    const { publicKeyPem, keyId } = await loadPublicKey();
    res.json({ alg: 'Ed25519', keyId, publicKeyPem });
  } catch (error) {
    next(error);
  }
});

/** GET /v1/evidence/chain[?deep=1] - walks every signed manifest; `deep` also re-hashes every evidence file. */
evidenceRouter.get('/chain', async (req, res, next) => {
  try {
    const { publicKeyPem, keyId } = await loadPublicKey();
    const deep = req.query.deep === '1' || req.query.deep === 'true';
    res.json({ keyId, deep, ...(await verifyChain({ publicKeyPem, deep })) });
  } catch (error) {
    next(error);
  }
});
