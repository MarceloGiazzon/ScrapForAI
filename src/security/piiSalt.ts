import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { dataDir } from '../config/paths.js';
import { restrictToCurrentUser } from '../storage/restrictFile.js';

/**
 * T7.8: the secret that keys the fingerprints of PII findings (piiDetectors.ts `fingerprintOf`). One per installation, `<dataDir>/pii-fingerprint.key`,
 * created on first use and restricted to the current user. It protects the findings, not the application: with it an attacker could test a guessed CPF
 * against a fingerprint, so it stays off the evidence (it is never in a manifest, an export or a report).
 */

let cached: { file: string; key: Buffer } | undefined;

export async function getPiiFingerprintKey(): Promise<Buffer> {
  const file = path.join(dataDir(), 'pii-fingerprint.key');
  if (cached?.file === file) return cached.key;

  let key: Buffer | undefined;
  try {
    const stored = Buffer.from((await fs.readFile(file, 'utf8')).trim(), 'hex');
    if (stored.length === 32) key = stored;
  } catch {
    // not created yet
  }
  if (!key) {
    key = randomBytes(32);
    await fs.mkdir(path.dirname(file), { recursive: true });
    try {
      // 'wx': if two runs start together, one creates it and the other reads that one back.
      await fs.writeFile(file, key.toString('hex'), { mode: 0o600, flag: 'wx' });
      await restrictToCurrentUser(file);
    } catch {
      const stored = Buffer.from((await fs.readFile(file, 'utf8')).trim(), 'hex');
      if (stored.length !== 32) throw new Error('pii-fingerprint.key exists but is not a 32-byte hex key');
      key = stored;
    }
  }
  cached = { file, key };
  return key;
}
