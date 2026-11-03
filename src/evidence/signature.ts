import crypto from 'node:crypto';

import { canonicalJson } from '../util/canonicalJson.js';

/**
 * Ed25519 signing of evidence manifests (T2.6). Pure functions, no configuration or file access, so a
 * third party can verify an exported evidence folder with nothing but the public key.
 *
 * What a valid signature proves: this installation's key signed exactly this manifest, which lists the
 * sha256 of every evidence file. It does NOT prove the test was correct, or that the application was
 * what it claims to be; and anyone holding the private key can sign anything.
 */

export interface ManifestSignature {
  alg: 'Ed25519';
  /** sha256 (hex) of the DER-encoded public key. */
  keyId: string;
  /** base64 */
  value: string;
}

/** Everything of a manifest except its signature. */
type Signable = Record<string, unknown> & { signature?: unknown };

export function keyFingerprint(publicKeyPem: string): string {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

export function generateSigningKeyPair(): { privateKeyPem: string; publicKeyPem: string; keyId: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { privateKeyPem, publicKeyPem, keyId: keyFingerprint(publicKeyPem) };
}

/** The exact bytes that are signed: canonical JSON of the manifest without its `signature` member. */
export function signedBytes(manifest: Signable): Buffer {
  const { signature: _signature, ...rest } = manifest;
  return Buffer.from(canonicalJson(rest), 'utf8');
}

export function signManifest<T extends Signable>(manifest: T, privateKeyPem: string, publicKeyPem: string): T & { signature: ManifestSignature } {
  const value = crypto.sign(null, signedBytes(manifest), crypto.createPrivateKey(privateKeyPem)).toString('base64');
  return { ...manifest, signature: { alg: 'Ed25519', keyId: keyFingerprint(publicKeyPem), value } };
}

export type SignatureCheck =
  | { status: 'valid'; keyId: string }
  | { status: 'unsigned' }
  | { status: 'invalid'; reason: 'bad-signature' | 'key-mismatch' | 'malformed'; keyId?: string };

/** Checks the signature against `publicKeyPem`. A manifest signed by a DIFFERENT key is `key-mismatch`, not valid. */
export function checkSignature(manifest: Signable, publicKeyPem: string): SignatureCheck {
  const signature = manifest.signature as Partial<ManifestSignature> | undefined;
  if (signature === undefined) {
    return { status: 'unsigned' };
  }

  if (signature.alg !== 'Ed25519' || typeof signature.keyId !== 'string' || typeof signature.value !== 'string') {
    return { status: 'invalid', reason: 'malformed' };
  }

  try {
    if (keyFingerprint(publicKeyPem) !== signature.keyId) {
      return { status: 'invalid', reason: 'key-mismatch', keyId: signature.keyId };
    }

    const ok = crypto.verify(null, signedBytes(manifest), crypto.createPublicKey(publicKeyPem), Buffer.from(signature.value, 'base64'));
    return ok ? { status: 'valid', keyId: signature.keyId } : { status: 'invalid', reason: 'bad-signature', keyId: signature.keyId };
  } catch {
    return { status: 'invalid', reason: 'malformed', keyId: signature.keyId };
  }
}
