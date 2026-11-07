import fs from 'node:fs/promises';
import path from 'node:path';

import { env } from '../config/env.js';
import { readManifest } from '../evidence/manifest.js';

const SAFE_FILENAME_PATTERN = /[^a-zA-Z0-9_-]+/g;

export interface ArtifactStore {
  jobId: string;
  rootDir: string;
  screenshotsDir: string;
  relativeRoot: string;
  screenshotPath(name: string): { absolutePath: string; relativePath: string; safeName: string };
  /** `trace.zip`, or (T6.4) `trace.<actor>.zip` for an actor other than main. */
  tracePath(actor?: string): { absolutePath: string; relativePath: string };
  resultPath(): { absolutePath: string; relativePath: string };
  /** Sanitized copy of the request (no credential values), so a good run can be saved as a routine. */
  requestPath(): { absolutePath: string; relativePath: string };
}

export function safeFileName(name: string, fallback = 'artifact'): string {
  const cleaned = name.trim().replace(SAFE_FILENAME_PATTERN, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return cleaned || fallback;
}

/** Job ids are generated as job_<nanoid>; this is the only shape accepted from callers. */
export const JOB_ID_PATTERN = /^job_[A-Za-z0-9_-]{1,64}$/;

/**
 * The name of the folder that holds a job's evidence: the job id itself. Every reader looks a run up by the id the run reported
 * (`findJobDir`), so the folder MUST be called exactly that. It used to go through `safeFileName`, which strips hyphens from both
 * ends, and `nanoid` draws from A-Za-z0-9_- : about one job id in 64 ends in a hyphen, so its folder was `job_abc` while the run
 * said `job_abc-`, and the evidence "was not found" a moment after the run finished (the intermittent full-smoke failure).
 * A job id already has a file-system-safe shape, so it is kept as it is; anything else is cleaned as before.
 */
export function jobDirName(jobId: string): string {
  return JOB_ID_PATTERN.test(jobId) ? jobId : safeFileName(jobId, 'job');
}

function relativeArtifactPath(...parts: string[]): string {
  return path.posix.join('artifacts', ...parts);
}

/**
 * True when `candidate` is `root` itself or lies inside it.
 *
 * Uses path.relative rather than startsWith: "/app/artifacts-evil".startsWith("/app/artifacts")
 * is true, which is exactly the bug this avoids.
 */
export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Resolves a caller-supplied relative path against the artifact root, refusing anything
 * that escapes it. Returns undefined when the path is not contained.
 */
export function resolveArtifactPath(relativePath: string): string | undefined {
  const artifactsRoot = path.resolve(env.ARTIFACT_DIR);
  const absolute = path.resolve(artifactsRoot, relativePath);
  return isPathInside(artifactsRoot, absolute) ? absolute : undefined;
}

export async function createArtifactStore(jobId: string): Promise<ArtifactStore> {
  const safeJobId = jobDirName(jobId);
  const rootDir = path.resolve(env.ARTIFACT_DIR, safeJobId);
  const artifactsRoot = path.resolve(env.ARTIFACT_DIR);

  if (!isPathInside(artifactsRoot, rootDir)) {
    throw new Error('Invalid artifact path');
  }

  await pruneExpiredArtifacts(artifactsRoot);

  const screenshotsDir = path.join(rootDir, 'screenshots');
  await fs.mkdir(screenshotsDir, { recursive: true });

  return {
    jobId: safeJobId,
    rootDir,
    screenshotsDir,
    relativeRoot: relativeArtifactPath(safeJobId),
    screenshotPath(name: string) {
      const safeName = safeFileName(name, 'screenshot');
      return {
        absolutePath: path.join(screenshotsDir, `${safeName}.png`),
        relativePath: relativeArtifactPath(safeJobId, 'screenshots', `${safeName}.png`),
        safeName,
      };
    },
    tracePath(actor?: string) {
      const file = actor === undefined ? 'trace.zip' : `trace.${safeFileName(actor, 'actor')}.zip`;
      return {
        absolutePath: path.join(rootDir, file),
        relativePath: relativeArtifactPath(safeJobId, file),
      };
    },
    resultPath() {
      return {
        absolutePath: path.join(rootDir, 'result.json'),
        relativePath: relativeArtifactPath(safeJobId, 'result.json'),
      };
    },
    requestPath() {
      return {
        absolutePath: path.join(rootDir, 'request.json'),
        relativePath: relativeArtifactPath(safeJobId, 'request.json'),
      };
    },
  };
}

export async function saveJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Removes expired evidence from the artifact root. Retention is per class (T1.5), read from each
 * job's manifest: standard = STANDARD_RETENTION_DAYS, anything else (including no manifest, as for
 * runs recorded before classes existed) = ARTIFACT_RETENTION_HOURS.
 *
 * Pinned evidence is never touched: it lives outside this root, and a job whose manifest says
 * "pinned" is skipped even if one is ever found here. `now` is injectable so tests can move the clock.
 */
export async function pruneExpiredArtifacts(artifactsRoot: string, now = Date.now()): Promise<void> {
  const ephemeralMs = env.ARTIFACT_RETENTION_HOURS * 60 * 60 * 1000;
  const standardMs = env.STANDARD_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  await fs.mkdir(artifactsRoot, { recursive: true });
  const entries = await fs.readdir(artifactsRoot, { withFileTypes: true }).catch(() => []);

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const entryPath = path.join(artifactsRoot, entry.name);
        const stats = await fs.stat(entryPath).catch(() => undefined);
        if (!stats) {
          return;
        }

        // An unreadable manifest must not make evidence disappear sooner or later than its class says.
        const retention = (await readManifest(entryPath).catch(() => undefined))?.manifest.retention;
        if (retention === 'pinned') {
          return;
        }

        const retentionMs = retention === 'standard' ? standardMs : ephemeralMs;
        if (stats.mtimeMs < now - retentionMs) {
          await fs.rm(entryPath, { recursive: true, force: true });
        }
      }),
  );
}
