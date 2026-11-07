import { statSync } from 'node:fs';
import path from 'node:path';

import { isPathInside, JOB_ID_PATTERN } from '../artifacts/artifactStore.js';
import { env } from '../config/env.js';
import { pinnedEvidenceDir } from '../config/paths.js';
import { TRANSIENT_FS_ERRORS } from '../storage/transientIo.js';

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms: number): void => void Atomics.wait(sleepCell, 0, 0, ms);

/**
 * Is there a directory at `dir`? `existsSync` answers false for ANY error, so a transient EPERM/EBUSY from
 * Windows (antivirus, indexer) made a job that was just written look like "evidence not found" with no trace.
 * Only ENOENT/ENOTDIR mean absent; a transient code is retried for a few milliseconds (printing `[fs]`, like
 * `retryTransient`), and any other failure is logged and then counts as absent.
 */
export function directoryExists(dir: string, label: string = path.basename(dir)): boolean {
  const attempts = 6;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return statSync(dir).isDirectory();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return false;
      }
      if (code !== undefined && TRANSIENT_FS_ERRORS.has(code) && attempt < attempts) {
        process.stderr.write(`[fs] ${code} on the folder of ${label}, retry ${attempt}/${attempts - 1}\n`);
        sleepSync(15 * attempt);
        continue;
      }
      process.stderr.write(`[evidence] could not check the folder of ${label}: ${code ?? (error instanceof Error ? error.message : String(error))}\n`);
      return false;
    }
  }
}

// The pattern lives next to the code that names the folder (artifactStore), so the two can never disagree; re-exported for callers.
export { JOB_ID_PATTERN };

export type EvidenceLocation = 'artifacts' | 'pinned';

export interface JobDir {
  dir: string;
  location: EvidenceLocation;
}

/**
 * Where a job's evidence lives right now: the pinned store wins (a pinned job has been moved out of
 * the artifact root), otherwise the ephemeral/standard artifact root. Undefined if neither has it.
 */
export function findJobDir(jobId: string): JobDir | undefined {
  if (!JOB_ID_PATTERN.test(jobId)) {
    return undefined;
  }

  const candidates: JobDir[] = [
    { dir: path.resolve(pinnedEvidenceDir(), jobId), location: 'pinned' },
    { dir: path.resolve(env.ARTIFACT_DIR, jobId), location: 'artifacts' },
  ];

  return candidates.find(({ dir, location }) => {
    const root = location === 'pinned' ? pinnedEvidenceDir() : env.ARTIFACT_DIR;
    return isPathInside(root, dir) && directoryExists(dir, jobId);
  });
}

/**
 * Resolves a file inside a job's evidence, wherever it lives. Returns undefined when the job is
 * unknown or the relative path escapes the job directory.
 */
export function resolveJobFile(jobId: string, relativePath: string): string | undefined {
  const job = findJobDir(jobId);
  if (!job) {
    return undefined;
  }

  const absolute = path.resolve(job.dir, relativePath);
  return isPathInside(job.dir, absolute) ? absolute : undefined;
}
