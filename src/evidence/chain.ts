import fs from 'node:fs/promises';
import path from 'node:path';

import { pinnedEvidenceDir } from '../config/paths.js';
import { writeFileAtomic } from '../storage/atomicWrite.js';
import { type EvidenceManifest, MANIFEST_FILE, readManifest, verifyManifest } from './manifest.js';
import { checkSignature } from './signature.js';

/**
 * T2.6 chain of signed manifests. Every pinned manifest records its position and the sha256 of the
 * PREVIOUS manifest file, so removing or editing one in the middle breaks the next link, and a gap in
 * the sequence shows a removal even when the neighbours are untouched. A high-water mark
 * (<pinned>/chain.json) also catches removal of the most recent entries.
 *
 * Limits, stated plainly: an attacker who holds the private key, or who rewrites the whole directory AND
 * the high-water mark AND re-signs, is not stopped by this. It detects tampering and loss; it does not
 * make a compromised machine trustworthy.
 */

const HIGH_WATER_FILE = 'chain.json';

export interface ChainEntry {
  jobId: string;
  dir: string;
  manifest: EvidenceManifest;
  manifestSha256: string;
}

export type ChainProblemKind =
  | 'gap'
  | 'broken-link'
  | 'bad-first-link'
  | 'duplicate-sequence'
  | 'invalid-signature'
  | 'key-mismatch'
  | 'truncated'
  | 'unreadable-manifest'
  | 'files-modified';

export interface ChainProblem {
  kind: ChainProblemKind;
  jobId?: string;
  sequence?: number;
  detail: string;
}

export interface ChainVerification {
  ok: boolean;
  /** Pinned jobs found. */
  entries: number;
  /** In the chain (signed). */
  signed: number;
  /** Pinned before signing existed, or without a signature: listed, not trusted. */
  unsigned: string[];
  highestSequence: number;
  problems: ChainProblem[];
}

export async function readPinnedManifests(): Promise<{ entries: ChainEntry[]; unreadable: string[] }> {
  const root = pinnedEvidenceDir();
  const names = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const entries: ChainEntry[] = [];
  const unreadable: string[] = [];

  for (const entry of names.filter((item) => item.isDirectory() && !item.name.startsWith('.'))) {
    const dir = path.join(root, entry.name);
    try {
      const stored = await readManifest(dir);
      if (stored) {
        entries.push({ jobId: entry.name, dir, manifest: stored.manifest, manifestSha256: stored.sha256 });
      } else {
        unreadable.push(entry.name);
      }
    } catch {
      unreadable.push(entry.name);
    }
  }

  return { entries, unreadable };
}

/** The last signed manifest: what the next pin must link to. */
export async function chainHead(): Promise<{ sequence: number; manifestSha256: string } | undefined> {
  const { entries } = await readPinnedManifests();
  const chained = entries.filter((entry) => entry.manifest.chain).sort((a, b) => b.manifest.chain!.sequence - a.manifest.chain!.sequence);
  const head = chained[0];
  return head ? { sequence: head.manifest.chain!.sequence, manifestSha256: head.manifestSha256 } : undefined;
}

async function readHighWater(): Promise<number> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(pinnedEvidenceDir(), HIGH_WATER_FILE), 'utf8')) as { sequence?: unknown };
    return typeof parsed.sequence === 'number' ? parsed.sequence : 0;
  } catch {
    return 0;
  }
}

export async function recordHighWater(sequence: number): Promise<void> {
  if (sequence > (await readHighWater())) {
    await writeFileAtomic(path.join(pinnedEvidenceDir(), HIGH_WATER_FILE), `${JSON.stringify({ sequence })}\n`);
  }
}

export async function verifyChain(options: { publicKeyPem: string; deep?: boolean }): Promise<ChainVerification> {
  const { entries, unreadable } = await readPinnedManifests();
  const problems: ChainProblem[] = unreadable.map((jobId) => ({ kind: 'unreadable-manifest' as const, jobId, detail: `${jobId} has no readable ${MANIFEST_FILE}` }));
  const unsigned = entries.filter((entry) => !entry.manifest.chain || !entry.manifest.signature).map((entry) => entry.jobId).sort();
  const chained = entries
    .filter((entry) => entry.manifest.chain && entry.manifest.signature)
    .sort((a, b) => a.manifest.chain!.sequence - b.manifest.chain!.sequence);

  let previous: ChainEntry | undefined;
  for (const entry of chained) {
    const { sequence, previousManifestSha256 } = entry.manifest.chain!;
    const where = { jobId: entry.jobId, sequence };

    const signature = checkSignature(entry.manifest, options.publicKeyPem);
    if (signature.status === 'invalid') {
      problems.push({
        kind: signature.reason === 'key-mismatch' ? 'key-mismatch' : 'invalid-signature',
        ...where,
        detail: signature.reason === 'key-mismatch' ? `signed by key ${signature.keyId}, not the installation key` : `the signature of ${entry.jobId} does not verify (${signature.reason})`,
      });
    }

    if (!previous) {
      if (previousManifestSha256 !== null) {
        problems.push({ kind: 'bad-first-link', ...where, detail: `the first entry points to a previous manifest (${previousManifestSha256.slice(0, 12)}...) that is not here` });
      }
    } else {
      const expected = previous.manifest.chain!.sequence + 1;
      if (sequence === previous.manifest.chain!.sequence) {
        problems.push({ kind: 'duplicate-sequence', ...where, detail: `two manifests claim sequence ${sequence}` });
      } else if (sequence !== expected) {
        problems.push({ kind: 'gap', ...where, detail: `sequence ${expected}${sequence - 1 > expected ? `..${sequence - 1}` : ''} is missing between ${previous.jobId} and ${entry.jobId}` });
      } else if (previousManifestSha256 !== previous.manifestSha256) {
        problems.push({ kind: 'broken-link', ...where, detail: `${entry.jobId} does not match the manifest of ${previous.jobId} (edited after it was linked)` });
      }
    }

    if (options.deep) {
      const files = await verifyManifest(entry.dir, entry.manifest);
      if (!files.ok) {
        problems.push({ kind: 'files-modified', ...where, detail: `${files.problems.map((p) => `${p.path} ${p.problem}`).join(', ')}` });
      }
    }

    previous = entry;
  }

  const highestSequence = previous?.manifest.chain!.sequence ?? 0;
  const highWater = await readHighWater();
  if (highWater > highestSequence) {
    problems.push({ kind: 'truncated', sequence: highWater, detail: `sequence ${highWater} was recorded but the chain ends at ${highestSequence}: the most recent manifest(s) were removed` });
  }

  return { ok: problems.length === 0, entries: entries.length + unreadable.length, signed: chained.length, unsigned, highestSequence, problems };
}
