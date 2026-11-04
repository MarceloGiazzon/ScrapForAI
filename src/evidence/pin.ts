import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { env } from '../config/env.js';
import { pinnedEvidenceDir } from '../config/paths.js';
import { markRunPinned } from '../history/runHistoryStore.js';
import { createMutex } from '../storage/atomicWrite.js';
import { chainHead, recordHighWater } from './chain.js';
import { findJobDir, JOB_ID_PATTERN } from './locate.js';
import { signManifest } from './signature.js';
import { loadSigningKey } from './signingKey.js';
import {
  buildManifest,
  directorySizeBytes,
  type EvidenceManifest,
  readManifest,
  verifyManifest,
  writeManifest,
  type ManifestProblem,
} from './manifest.js';
import { readFileRetry } from '../storage/transientIo.js';

export class EvidenceError extends Error {
  constructor(
    readonly status: number,
    name: string,
    message: string,
    readonly details?: ManifestProblem[],
  ) {
    super(message);
    this.name = name;
  }
}

export interface PinRequest {
  reason: string;
  ref?: string;
  /** Keep trace.zip (the heaviest file). Default: discarded on pin. */
  keepTrace?: boolean;
}

export interface PinResult {
  jobId: string;
  alreadyPinned: boolean;
  pinnedAt: string;
  ref?: string;
  files: number;
  bytes: number;
  traceDiscarded: boolean;
  integrityBaseline: 'run' | 'pin';
  /** sha256 of the pinned manifest file: what evidence references (vault items, reports) quote. */
  manifestSha256: string;
}

// Pins are serialized so the quota check and the move cannot race each other.
const withLock = createMutex();

/** What the evidence is about, read from the run's own result.json. Missing fields are simply omitted. */
async function contextOf(dir: string): Promise<NonNullable<EvidenceManifest['context']>> {
  try {
    const result = JSON.parse(await readFileRetry(path.join(dir, 'result.json'), 'utf8')) as Record<string, any>;
    return {
      ...(typeof result.scenarioName === 'string' ? { scenarioName: result.scenarioName } : {}),
      ...(typeof result.targetUrl === 'string' ? { targetUrl: result.targetUrl } : {}),
      ...(typeof result.buildId === 'string' ? { buildId: result.buildId } : {}),
      ...(result.routine ? { routine: result.routine } : {}),
      ...(result.status === 'passed' || result.status === 'failed' ? { status: result.status } : {}),
    };
  } catch {
    return {};
  }
}

/** `trace.zip`, and (T6.4) the `trace.<actor>.zip` of every other actor of the run. */
const TRACE_FILE = /^trace(\.[A-Za-z0-9_-]+)?\.zip$/;

async function traceFiles(dir: string): Promise<string[]> {
  return (await fs.readdir(dir).catch(() => [] as string[])).filter((name) => TRACE_FILE.test(name));
}

function describe(manifest: EvidenceManifest, manifestSha256: string, bytes: number, alreadyPinned: boolean): PinResult {
  const pin = manifest.pin;
  return {
    jobId: manifest.jobId,
    alreadyPinned,
    pinnedAt: pin?.pinnedAt ?? manifest.createdAt,
    ...(pin?.ref === undefined ? {} : { ref: pin.ref }),
    files: manifest.files.length,
    bytes,
    traceDiscarded: pin?.traceDiscarded ?? false,
    integrityBaseline: pin?.integrityBaseline ?? 'run',
    manifestSha256,
  };
}

async function traceSize(dir: string): Promise<number> {
  let total = 0;
  for (const name of await traceFiles(dir)) total += (await fs.stat(path.join(dir, name)).catch(() => undefined))?.size ?? 0;
  return total;
}

/**
 * Moves a job's evidence into <dataDir>/evidence/pinned/<jobId>/, where nothing prunes it.
 *
 * Order matters, and each step can only refuse, never destroy:
 *   1. the run's own manifest must still verify (tampered evidence is not pinned);
 *   2. the quota is checked BEFORE anything is copied; over quota is a 409 and nothing is deleted;
 *   3. the copy is built in a hidden temp dir and renamed into place, so a half-pinned job is never
 *      visible; only after the copy verifies is the source removed.
 */
export function pinJob(jobId: string, request: PinRequest): Promise<PinResult> {
  return withLock(async () => {
    if (!JOB_ID_PATTERN.test(jobId)) {
      throw new EvidenceError(400, 'ValidationError', 'Invalid job id');
    }

    const located = findJobDir(jobId);
    if (!located) {
      throw new EvidenceError(404, 'EvidenceNotFound', `No evidence for ${jobId}: it expired (ARTIFACT_RETENTION_HOURS) or never existed`);
    }

    if (located.location === 'pinned') {
      const existing = await readManifest(located.dir);
      if (!existing) {
        throw new EvidenceError(500, 'EvidenceIntegrityError', `Pinned evidence of ${jobId} has no manifest`);
      }
      return describe(existing.manifest, existing.sha256, await directorySizeBytes(located.dir), true);
    }

    const original = await readManifest(located.dir);
    if (original) {
      const verification = await verifyManifest(located.dir, original.manifest);
      if (!verification.ok) {
        throw new EvidenceError(409, 'EvidenceIntegrityError', `Evidence of ${jobId} no longer matches its manifest; refusing to pin it`, verification.problems);
      }
    }

    const keepTrace = request.keepTrace === true;
    const dropTrace = !keepTrace && (await traceSize(located.dir)) > 0;
    const addedBytes = (await directorySizeBytes(located.dir)) - (dropTrace ? await traceSize(located.dir) : 0);

    const root = pinnedEvidenceDir();
    const quotaBytes = env.PINNED_EVIDENCE_MAX_MB * 1024 * 1024;
    const usedBytes = await directorySizeBytes(root);
    if (usedBytes + addedBytes > quotaBytes) {
      throw new EvidenceError(
        409,
        'PinnedQuotaExceeded',
        `Pinning ${jobId} needs ${addedBytes} bytes but only ${Math.max(quotaBytes - usedBytes, 0)} of the ${env.PINNED_EVIDENCE_MAX_MB} MB pinned quota remain. Pinned evidence is never deleted automatically; raise PINNED_EVIDENCE_MAX_MB or remove evidence by hand.`,
      );
    }

    await fs.mkdir(root, { recursive: true });
    const staging = path.join(root, `.${jobId}.${randomBytes(4).toString('hex')}.tmp`);
    const finalDir = path.join(root, jobId);

    try {
      await fs.cp(located.dir, staging, { recursive: true, errorOnExist: true });

      // Verify the copy against the original manifest BEFORE touching the source.
      if (original) {
        const copied = await verifyManifest(staging, original.manifest);
        if (!copied.ok) {
          throw new EvidenceError(500, 'EvidenceCopyError', `The copy of ${jobId} does not match its manifest; the original was left in place`, copied.problems);
        }
      }

      if (dropTrace) {
        for (const name of await traceFiles(staging)) await fs.rm(path.join(staging, name), { force: true });
      }

      const manifest = await buildManifest(staging, jobId, 'pinned', {
        pinnedAt: new Date().toISOString(),
        reason: request.reason,
        ...(request.ref === undefined ? {} : { ref: request.ref }),
        keepTrace,
        traceDiscarded: dropTrace,
        integrityBaseline: original ? 'run' : 'pin',
        ...(original ? { originalManifestSha256: original.sha256 } : {}),
      });
      await fs.rm(path.join(staging, 'manifest.json'), { force: true });

      // Sign it and link it to the previous signed manifest (T2.6). The pins are serialized, so the
      // head cannot change between reading it here and the rename below.
      const head = await chainHead();
      const sequence = (head?.sequence ?? 0) + 1;
      const key = await loadSigningKey();
      const signed = signManifest(
        {
          ...manifest,
          context: await contextOf(staging),
          chain: { sequence, previousManifestSha256: head?.manifestSha256 ?? null },
        },
        key.privateKeyPem,
        key.publicKeyPem,
      );
      await writeManifest(staging, signed as EvidenceManifest);

      await fs.rename(staging, finalDir);
      await recordHighWater(sequence).catch(() => undefined); // best effort: only used to detect truncation
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    await fs.rm(located.dir, { recursive: true, force: true });
    await markRunPinned(jobId, request.ref);

    const stored = await readManifest(finalDir);
    return describe(stored!.manifest, stored!.sha256, await directorySizeBytes(finalDir), false);
  });
}
