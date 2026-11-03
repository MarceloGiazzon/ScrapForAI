import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { systemEvolutionDir } from '../config/paths.js';
import { safeName } from '../schemas/explorationRequest.schema.js';
import { type SnapshotManifest, snapshotManifestSchema } from '../schemas/evolution.schema.js';
import { buildOfFolder } from './snapshotPlan.js';

/** T4.4: where snapshots live and how they are written: a folder per build, assembled aside and renamed into place. */

const execFileAsync = promisify(execFile);

export const MANIFEST_FILE = 'snapshot.json';
export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

export function targetFolder(target: string): string {
  if (!safeName.safeParse(target).success) throw new Error('Invalid target profile id');
  return path.join(systemEvolutionDir(), target);
}

export interface SnapshotListing {
  folder: string; // `<target>/<date>_<build>`
  name: string;
  buildId: string;
  createdAt: string;
  complete: boolean;
  screens: number;
  notCaptured: number;
}

export async function readManifest(target: string, name: string): Promise<SnapshotManifest | undefined> {
  try {
    return snapshotManifestSchema.parse(JSON.parse(await fs.readFile(path.join(targetFolder(target), name, MANIFEST_FILE), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Snapshots of a target, oldest first (the folder name starts with the date; the manifest breaks ties within a day). */
export async function listSnapshots(target: string): Promise<SnapshotListing[]> {
  const entries = await fs.readdir(targetFolder(target), { withFileTypes: true }).catch(() => []);
  const out: SnapshotListing[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || buildOfFolder(entry.name) === undefined) continue;
    const manifest = await readManifest(target, entry.name).catch(() => undefined);
    if (!manifest) continue;
    out.push({
      folder: `${target}/${entry.name}`,
      name: entry.name,
      buildId: manifest.buildId,
      createdAt: manifest.createdAt,
      complete: manifest.complete,
      screens: manifest.screens.length,
      notCaptured: manifest.notCaptured.length,
    });
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

/** The existing snapshot of this exact build, if any (the idempotency check). */
export async function findSnapshotOfBuild(target: string, buildId: string): Promise<SnapshotListing | undefined> {
  return (await listSnapshots(target)).find((snapshot) => snapshot.buildId === buildId);
}

export interface SnapshotFile {
  /** Path inside the snapshot folder, forward slashes. */
  relative: string;
  data: string | Buffer;
}

/**
 * Writes a snapshot atomically: files go to a hidden temp folder next to the target, then it is renamed into place, so
 * a crash never leaves a half-written snapshot that looks real. `replace` names folders removed once the new one is in.
 */
export async function writeSnapshotFolder(target: string, name: string, files: SnapshotFile[], replace: string[] = []): Promise<void> {
  const root = targetFolder(target);
  await fs.mkdir(root, { recursive: true });
  const temp = path.join(root, `.tmp-${process.pid}-${Date.now()}`);
  try {
    for (const file of files) {
      const destination = path.join(temp, ...file.relative.split('/'));
      if (path.relative(temp, destination).startsWith('..')) throw new Error(`snapshot file escapes its folder: ${file.relative}`);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, file.data);
    }
    for (const old of replace) await fs.rm(path.join(root, old), { recursive: true, force: true });
    await fs.rm(path.join(root, name), { recursive: true, force: true });
    await fs.rename(temp, path.join(root, name));
  } catch (error) {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export interface GitOutcome {
  repository: boolean;
  committed: boolean;
  commit?: string;
  note?: string;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], { timeout: 30_000, windowsHide: true });
  return stdout.trim();
}

/**
 * When the evolution directory is inside a git work tree, commits the target's folder (and only it) with the build in
 * the message. Plain `child_process`, no dependency. A git problem is reported, never thrown: the snapshot is already
 * on disk and a failed commit must not look like a failed capture.
 */
export async function commitSnapshot(target: string, message: string): Promise<GitOutcome> {
  const root = systemEvolutionDir();
  try {
    if ((await git(root, ['rev-parse', '--is-inside-work-tree'])) !== 'true') return { repository: false, committed: false };
  } catch {
    return { repository: false, committed: false };
  }

  try {
    await git(root, ['add', '-A', '--', target]);
    const staged = await git(root, ['diff', '--cached', '--name-only', '--', target]);
    if (!staged) return { repository: true, committed: false, note: 'nothing to commit' };
    await git(root, ['commit', '-m', message, '--', target]);
    return { repository: true, committed: true, commit: await git(root, ['rev-parse', '--short', 'HEAD']) };
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
    return { repository: true, committed: false, note: `git commit failed: ${detail}`.slice(0, 300) };
  }
}
