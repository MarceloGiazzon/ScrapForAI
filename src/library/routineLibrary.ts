import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { routineLibraryDir } from '../config/paths.js';
import { safeName } from '../schemas/explorationRequest.schema.js';
import { type LibraryRoutine, libraryRoutineSchema, type RoutineContent, routineContentSchema } from '../schemas/libraryRoutine.schema.js';
import { createMutex, writeFileAtomic } from '../storage/atomicWrite.js';
import { canonicalize } from '../util/canonicalJson.js';

/**
 * T1.3 routine library on disk:
 *
 *   <libraryDir>/<routineId>/v<N>.json     immutable, one per distinct content
 *   <libraryDir>/<routineId>/current.json  { "version": N } pointer to the latest version
 *
 * One file per entity, so the directory can live in a git repository and be reviewed in PRs.
 */

export class RoutineLibraryError extends Error {
  constructor(
    readonly status: number,
    name: string,
    message: string,
    readonly details?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = name;
  }
}

export interface RoutineSummary {
  id: string;
  version: number;
  title: string;
  status: LibraryRoutine['status'];
  tags: string[];
  surface?: string;
  targetProfile: string;
  sha256: string;
  createdAt: string;
}

const withLock = createMutex();

/** Digest of the canonical (key-sorted) JSON of the routine id plus its author content. */
export function routineDigest(id: string, content: RoutineContent): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize({ id, ...content })))
    .digest('hex');
}

function assertId(id: string): void {
  if (!safeName.safeParse(id).success) {
    throw new RoutineLibraryError(400, 'ValidationError', 'Routine id must match [a-zA-Z0-9_-]{1,80}');
  }
}

function routineDir(id: string): string {
  assertId(id);
  return path.join(routineLibraryDir(), id);
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function currentVersion(dir: string): Promise<number | undefined> {
  const pointer = (await readJson(path.join(dir, 'current.json'))) as { version?: unknown } | undefined;
  return typeof pointer?.version === 'number' ? pointer.version : undefined;
}

async function readVersion(id: string, dir: string, version: number): Promise<LibraryRoutine | undefined> {
  const raw = await readJson(path.join(dir, `v${version}.json`));
  if (raw === undefined) {
    return undefined;
  }

  const routine = libraryRoutineSchema.parse(raw);
  const { id: storedId, version: storedVersion, sha256, createdBy: _createdBy, createdAt: _createdAt, ...content } = routine;

  // Versions are immutable. A file edited by hand (or corrupted) no longer matches its digest.
  if (storedId !== id || storedVersion !== version || routineDigest(id, routineContentSchema.parse(content)) !== sha256) {
    throw new RoutineLibraryError(500, 'RoutineIntegrityError', `Routine "${id}" v${version} does not match its recorded sha256 (edited or corrupted)`);
  }

  return routine;
}

/** The requested version, or the current one when `version` is omitted. */
export async function getRoutine(id: string, version?: number): Promise<LibraryRoutine | undefined> {
  const dir = routineDir(id);
  const wanted = version ?? (await currentVersion(dir));
  return wanted === undefined ? undefined : readVersion(id, dir, wanted);
}

export async function listRoutines(): Promise<RoutineSummary[]> {
  const entries = await fs.readdir(routineLibraryDir(), { withFileTypes: true }).catch(() => []);
  const summaries: RoutineSummary[] = [];

  for (const entry of entries.filter((item) => item.isDirectory() && safeName.safeParse(item.name).success)) {
    const routine = await getRoutine(entry.name).catch(() => undefined);
    if (routine) {
      summaries.push({
        id: routine.id,
        version: routine.version,
        title: routine.title,
        status: routine.status,
        tags: routine.tags,
        ...(routine.surface === undefined ? {} : { surface: routine.surface }),
        targetProfile: routine.targetProfile,
        sha256: routine.sha256,
        createdAt: routine.createdAt,
      });
    }
  }

  return summaries.sort((a, b) => a.id.localeCompare(b.id));
}

export async function listVersions(id: string): Promise<number[]> {
  const files = await fs.readdir(routineDir(id)).catch(() => [] as string[]);
  return files
    .map((name) => /^v(\d+)\.json$/.exec(name)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

/**
 * Stores `content` as the next version, unless it is identical to the current one (same digest),
 * in which case nothing is written and the current routine is returned with `created: false`.
 * The caller validates and lints first; this layer only guarantees immutability and numbering.
 */
export function saveRoutineVersion(
  id: string,
  content: RoutineContent,
  createdBy?: string,
): Promise<{ routine: LibraryRoutine; created: boolean }> {
  const dir = routineDir(id);

  return withLock(async () => {
    const sha256 = routineDigest(id, content);
    const existing = await getRoutine(id);

    if (existing && existing.sha256 === sha256) {
      return { routine: existing, created: false };
    }

    const versions = await listVersions(id);
    const version = (versions.at(-1) ?? 0) + 1;
    const routine: LibraryRoutine = libraryRoutineSchema.parse({
      ...content,
      id,
      version,
      sha256,
      ...(createdBy === undefined ? {} : { createdBy }),
      createdAt: new Date().toISOString(),
    });

    await fs.mkdir(dir, { recursive: true });
    // 'wx': a version file is never overwritten, even if the pointer and the directory disagree.
    await fs.writeFile(path.join(dir, `v${version}.json`), `${JSON.stringify(routine, null, 2)}\n`, { flag: 'wx' });
    await writeFileAtomic(path.join(dir, 'current.json'), `${JSON.stringify({ version })}\n`);

    return { routine, created: true };
  });
}
