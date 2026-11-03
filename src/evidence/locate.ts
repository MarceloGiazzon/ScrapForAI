import { existsSync } from 'node:fs';
import path from 'node:path';

import { isPathInside } from '../artifacts/artifactStore.js';
import { env } from '../config/env.js';
import { pinnedEvidenceDir } from '../config/paths.js';

/** Job ids are generated as job_<nanoid>; this is the only shape accepted from callers. */
export const JOB_ID_PATTERN = /^job_[A-Za-z0-9_-]{1,64}$/;

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
    return isPathInside(root, dir) && existsSync(dir);
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
