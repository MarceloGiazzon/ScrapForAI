import crypto from 'node:crypto';

/**
 * T10.1 personal API keys: `sfa_<keyId>_<secret>`.
 *  - `keyId` (12 hex chars) is public: it names the key in lists, in the audit log and when revoking. It is how a key is FOUND.
 *  - `secret` is 256 random bits. The server keeps only the SHA-256 of the whole key: with that much entropy a salted slow hash adds
 *    nothing, and a fast one lets a request be checked without a delay an attacker could measure. The key is shown ONCE, when it is made.
 */
const KEY_PATTERN = /^sfa_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

export interface GeneratedKey {
  /** The only time this exists in clear. */
  key: string;
  keyId: string;
  hash: string;
}

export const hashKey = (key: string): string => crypto.createHash('sha256').update(key, 'utf8').digest('hex');

export function generateKey(): GeneratedKey {
  const keyId = crypto.randomBytes(6).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64url');
  const key = `sfa_${keyId}_${secret}`;
  return { key, keyId, hash: hashKey(key) };
}

/** The key id inside a personal key, or undefined when the text is not shaped like one (then it may still be the installation's own key). */
export function parseKeyId(token: string): string | undefined {
  return KEY_PATTERN.exec(token)?.[1];
}

export function hashesMatch(stored: string, candidate: string): boolean {
  const left = Buffer.from(stored, 'hex');
  const right = Buffer.from(candidate, 'hex');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}
