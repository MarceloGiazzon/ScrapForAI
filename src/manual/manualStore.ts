import fs from 'node:fs/promises';
import path from 'node:path';

import { manualDir } from '../config/paths.js';
import { type ManualManifest, manualManifestSchema } from '../schemas/manual.schema.js';
import { safeName } from '../schemas/explorationRequest.schema.js';
import { writeFileAtomic } from '../storage/atomicWrite.js';

/**
 * T9.2: where a manual lives and how a build is put there.
 *
 * `<MANUAL_OUTPUT_DIR>/<target>/` is OWNED by the build only as far as `manual.json` says: it lists every file the last build wrote. A new build writes its
 * files (each one atomically), writes `manual.json` LAST, and then removes the files the previous manifest listed that the new one does not -- never a
 * file the manifest does not list. So a README or a logo someone put in that folder survives, and a crash in the middle leaves the previous manifest
 * describing the previous build.
 */

export const MANIFEST_FILE = 'manual.json';

export function targetFolder(target: string): string {
  if (!safeName.safeParse(target).success) throw new Error('Invalid target profile id');
  return path.join(manualDir(), target);
}

export async function readManualManifest(target: string): Promise<ManualManifest | undefined> {
  try {
    return manualManifestSchema.parse(JSON.parse(await fs.readFile(path.join(targetFolder(target), MANIFEST_FILE), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export interface ManualFile {
  /** Path inside the target folder, forward slashes. */
  relative: string;
  data: string | Buffer;
}

/** Resolves a relative path inside the target folder, refusing anything that would leave it. */
function inside(root: string, relative: string): string {
  const destination = path.resolve(root, ...relative.split('/'));
  if (path.relative(root, destination).startsWith('..') || path.isAbsolute(path.relative(root, destination))) {
    throw new Error(`manual file escapes its folder: ${relative}`);
  }
  return destination;
}

/** Writes the files, then the manifest, then removes what the previous build wrote and this one did not. Returns the paths removed. */
export async function writeManual(target: string, files: readonly ManualFile[], manifest: ManualManifest, previous: ManualManifest | undefined): Promise<string[]> {
  const root = targetFolder(target);
  await fs.mkdir(root, { recursive: true });

  for (const file of files) {
    await writeFileAtomic(inside(root, file.relative), file.data);
  }
  await writeFileAtomic(path.join(root, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);

  const keep = new Set(manifest.files);
  const removed: string[] = [];
  for (const old of previous?.files ?? []) {
    if (keep.has(old)) continue;
    await fs.rm(inside(root, old), { force: true });
    removed.push(old);
  }
  // Folders the removal left empty (a chapter's figures, a language nobody asks for any more).
  for (const old of removed) {
    let folder = path.dirname(inside(root, old));
    while (folder !== root && folder.startsWith(root)) {
      const left = await fs.readdir(folder).catch(() => ['.']);
      if (left.length > 0) break;
      await fs.rmdir(folder).catch(() => undefined);
      folder = path.dirname(folder);
    }
  }
  return removed;
}
