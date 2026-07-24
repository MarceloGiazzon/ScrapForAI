import fs from 'node:fs/promises';
import path from 'node:path';

import { env } from '../config/env.js';

const SAFE_FILENAME_PATTERN = /[^a-zA-Z0-9_-]+/g;

export interface ArtifactStore {
  jobId: string;
  rootDir: string;
  screenshotsDir: string;
  relativeRoot: string;
  screenshotPath(name: string): { absolutePath: string; relativePath: string; safeName: string };
  tracePath(): { absolutePath: string; relativePath: string };
  resultPath(): { absolutePath: string; relativePath: string };
}

export function safeFileName(name: string, fallback = 'artifact'): string {
  const cleaned = name.trim().replace(SAFE_FILENAME_PATTERN, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return cleaned || fallback;
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
  const safeJobId = safeFileName(jobId, 'job');
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
    tracePath() {
      return {
        absolutePath: path.join(rootDir, 'trace.zip'),
        relativePath: relativeArtifactPath(safeJobId, 'trace.zip'),
      };
    },
    resultPath() {
      return {
        absolutePath: path.join(rootDir, 'result.json'),
        relativePath: relativeArtifactPath(safeJobId, 'result.json'),
      };
    },
  };
}

export async function saveJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function pruneExpiredArtifacts(artifactsRoot: string): Promise<void> {
  const retentionMs = env.ARTIFACT_RETENTION_HOURS * 60 * 60 * 1000;
  const expiresBefore = Date.now() - retentionMs;

  await fs.mkdir(artifactsRoot, { recursive: true });
  const entries = await fs.readdir(artifactsRoot, { withFileTypes: true }).catch(() => []);

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const entryPath = path.join(artifactsRoot, entry.name);
        const stats = await fs.stat(entryPath).catch(() => undefined);

        if (stats && stats.mtimeMs < expiresBefore) {
          await fs.rm(entryPath, { recursive: true, force: true });
        }
      }),
  );
}
