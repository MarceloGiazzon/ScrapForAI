import fs from 'node:fs/promises';
import path from 'node:path';

import { signingDir } from '../config/paths.js';
import { restrictToCurrentUser } from '../storage/restrictFile.js';
import { generateSigningKeyPair, keyFingerprint } from './signature.js';

/**
 * The installation's signing key (T2.6): <dataDir>/signing/ed25519.key (private, owner-only) and
 * ed25519.pub. Generated on first use. Losing the private key does not invalidate old signatures (the
 * public key is in every export); replacing it starts a new keyId, and verifiers see both.
 */

export interface SigningKey {
  privateKeyPem: string;
  publicKeyPem: string;
  keyId: string;
}

let cached: { dir: string; key: SigningKey } | undefined;

async function readPair(dir: string): Promise<SigningKey | undefined> {
  try {
    const [privateKeyPem, publicKeyPem] = await Promise.all([
      fs.readFile(path.join(dir, 'ed25519.key'), 'utf8'),
      fs.readFile(path.join(dir, 'ed25519.pub'), 'utf8'),
    ]);
    return { privateKeyPem, publicKeyPem, keyId: keyFingerprint(publicKeyPem) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

export async function loadSigningKey(): Promise<SigningKey> {
  const dir = signingDir();
  if (cached?.dir === dir) {
    return cached.key;
  }

  let key = await readPair(dir);
  if (!key) {
    await fs.mkdir(dir, { recursive: true });
    const created = generateSigningKeyPair();
    try {
      // 'wx' on the private key first: if two processes race, exactly one wins and the loser re-reads.
      await fs.writeFile(path.join(dir, 'ed25519.key'), created.privateKeyPem, { flag: 'wx', mode: 0o600 });
      await restrictToCurrentUser(path.join(dir, 'ed25519.key'));
      await fs.writeFile(path.join(dir, 'ed25519.pub'), created.publicKeyPem, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
    key = await readPair(dir);
    if (!key) {
      throw new Error('The evidence signing key could not be created');
    }
  }

  cached = { dir, key };
  return key;
}

/** Only the public half, for exports and verification. Creates the pair if there is none yet. */
export async function loadPublicKey(): Promise<{ publicKeyPem: string; keyId: string }> {
  const { publicKeyPem, keyId } = await loadSigningKey();
  return { publicKeyPem, keyId };
}
