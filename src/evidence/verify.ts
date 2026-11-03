import fs from 'node:fs/promises';
import path from 'node:path';

import { MANIFEST_FILE, readManifest, verifyManifest, type ManifestProblem } from './manifest.js';
import { checkSignature, type SignatureCheck } from './signature.js';

/**
 * Verifies an evidence folder (T2.6) with no server and no configuration: the folder, plus a public key
 * (given, or the `public-key.pem` that `evidence export` puts next to the manifest).
 *
 * `ok` means: every file matches its recorded sha256, nothing was added, and the manifest carries a valid
 * Ed25519 signature. It does not say the test was right (see signature.ts). When the key comes from the
 * bundle itself, the signature only proves the bundle is self-consistent; pass `expectedKeyId` (published
 * by the installation) to also prove who signed it.
 */

export const PUBLIC_KEY_FILE = 'public-key.pem';
/** Files `evidence export` adds next to the evidence. They are not evidence, so they are not "unexpected". */
const EXPORT_COMPANIONS = new Set([PUBLIC_KEY_FILE, 'README.txt']);

export interface EvidenceVerification {
  ok: boolean;
  jobId: string;
  manifestSha256: string;
  files: { ok: boolean; checked: number; problems: ManifestProblem[] };
  signature: SignatureCheck | { status: 'no-key' };
  keySource: 'argument' | 'bundle' | 'none';
  /** The key matched `expectedKeyId` (only when one was given). */
  keyTrusted?: boolean;
  chain: { sequence: number; previousManifestSha256: string | null } | null;
  /** Why `ok` is false, in words. */
  reasons: string[];
}

export class EvidenceVerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceVerifyError';
  }
}

export async function verifyEvidenceDir(dir: string, options: { publicKeyPem?: string; expectedKeyId?: string } = {}): Promise<EvidenceVerification> {
  let stored: Awaited<ReturnType<typeof readManifest>>;
  try {
    stored = await readManifest(dir);
  } catch (error) {
    throw new EvidenceVerifyError(`${path.join(dir, MANIFEST_FILE)} is not a valid evidence manifest: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  }
  if (!stored) {
    throw new EvidenceVerifyError(`${dir} has no ${MANIFEST_FILE}`);
  }

  const { manifest, sha256 } = stored;
  const checked = await verifyManifest(dir, manifest);
  const problems = checked.problems.filter((problem) => !(problem.problem === 'unexpected' && EXPORT_COMPANIONS.has(problem.path)));
  const files = { ok: problems.length === 0, checked: checked.checked, problems };

  let publicKeyPem = options.publicKeyPem;
  let keySource: EvidenceVerification['keySource'] = publicKeyPem ? 'argument' : 'none';
  if (!publicKeyPem) {
    publicKeyPem = await fs.readFile(path.join(dir, PUBLIC_KEY_FILE), 'utf8').catch(() => undefined);
    keySource = publicKeyPem ? 'bundle' : 'none';
  }

  const signature: EvidenceVerification['signature'] = publicKeyPem ? checkSignature(manifest, publicKeyPem) : { status: 'no-key' };
  const keyTrusted = options.expectedKeyId === undefined ? undefined : signature.status === 'valid' && signature.keyId === options.expectedKeyId;

  const reasons: string[] = [];
  for (const problem of files.problems) {
    reasons.push(`${problem.path}: ${problem.problem}`);
  }
  if (signature.status === 'unsigned') reasons.push('the manifest is not signed');
  if (signature.status === 'no-key') reasons.push(`no public key: give one, or include ${PUBLIC_KEY_FILE} in the folder`);
  if (signature.status === 'invalid') reasons.push(`the signature is invalid (${signature.reason})`);
  if (keyTrusted === false) reasons.push('the signing key is not the expected one');

  return {
    ok: reasons.length === 0,
    jobId: manifest.jobId,
    manifestSha256: sha256,
    files: { ok: files.ok, checked: files.checked, problems: files.problems },
    signature,
    keySource,
    ...(keyTrusted === undefined ? {} : { keyTrusted }),
    chain: manifest.chain ?? null,
    reasons,
  };
}
