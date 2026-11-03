import fs from 'node:fs/promises';
import path from 'node:path';

import { EvidenceError } from './pin.js';
import { findJobDir, JOB_ID_PATTERN } from './locate.js';
import { MANIFEST_FILE, readManifest, verifyManifest } from './manifest.js';
import { checkSignature } from './signature.js';
import { loadPublicKey } from './signingKey.js';
import { PUBLIC_KEY_FILE } from './verify.js';
import { createZip, type ZipEntry } from './zip.js';
import { readFileRetry } from '../storage/transientIo.js';

const README = (keyId: string, jobId: string): string => `ScrapForAI evidence export: ${jobId}

Contents: the evidence files, manifest.json (sha256 of every file, signed with Ed25519) and ${PUBLIC_KEY_FILE}.
Signing key id (sha256 of the public key): ${keyId}

Verify (no server needed):   scrapforai evidence verify <this folder> [--expected-key-id ${keyId}]

What a valid result proves: these files are byte-for-byte what the installation that owns that key recorded, and that
installation signed this manifest. What it does NOT prove: that the test was correct, or that the application under
test was what it claims. To trust WHO signed it, compare the key id with one you obtained from the owner through
another channel; a public key that travels with the files only proves the bundle is self-consistent.
`;

/**
 * Builds the .zip of a PINNED job (T2.6): evidence + signed manifest + public key + README. Refuses
 * evidence that is not pinned (an unsigned export would be a screenshot collection, not proof) or that no
 * longer verifies (never hand out something already known to be damaged).
 */
export async function exportEvidence(jobId: string): Promise<{ zip: Buffer; fileName: string; keyId: string }> {
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new EvidenceError(400, 'ValidationError', 'Invalid job id');
  }

  const located = findJobDir(jobId);
  if (!located) {
    throw new EvidenceError(404, 'EvidenceNotFound', `No evidence for ${jobId}: it expired or never existed`);
  }
  if (located.location !== 'pinned') {
    throw new EvidenceError(409, 'NotPinned', `${jobId} is not pinned. Pin it first (POST /v1/runs/${jobId}/pin): only pinned evidence is signed and kept.`);
  }

  const stored = await readManifest(located.dir);
  const { publicKeyPem, keyId } = await loadPublicKey();
  if (!stored || checkSignature(stored.manifest, publicKeyPem).status !== 'valid') {
    throw new EvidenceError(409, 'NotSigned', `${jobId} has no valid signature from this installation's key (pinned before signing existed, or the key changed)`);
  }

  const files = await verifyManifest(located.dir, stored.manifest);
  if (!files.ok) {
    throw new EvidenceError(409, 'EvidenceIntegrityError', `The files of ${jobId} no longer match their manifest; refusing to export`, files.problems);
  }

  const entries: ZipEntry[] = [];
  for (const file of stored.manifest.files) {
    entries.push({ name: file.path, data: await readFileRetry(path.join(located.dir, file.path)) });
  }
  entries.push(
    { name: MANIFEST_FILE, data: await readFileRetry(path.join(located.dir, MANIFEST_FILE)) },
    { name: PUBLIC_KEY_FILE, data: Buffer.from(publicKeyPem, 'utf8') },
    { name: 'README.txt', data: Buffer.from(README(keyId, jobId), 'utf8') },
  );

  return { zip: createZip(entries), fileName: `${jobId}.evidence.zip`, keyId };
}
