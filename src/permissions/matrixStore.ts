import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { permissionsDir } from '../config/paths.js';
import { expandIncludes } from '../library/includeExpander.js';
import { RequestResolutionError } from '../runner/resolutionError.js';
import { safeName } from '../schemas/explorationRequest.schema.js';
import { type PermissionMatrix, type StoredMatrix, storedMatrixSchema } from '../schemas/permissionMatrix.schema.js';
import { type TargetProfile } from '../schemas/targetProfile.schema.js';
import { validateTargetUrl } from '../security/validateTargetUrl.js';
import { createMutex, writeFileAtomic } from '../storage/atomicWrite.js';
import { getTarget } from '../targets/targetStore.js';
import { CatalogError, LOGIN_INCLUDE_ID, materializeMatrix, resolveProbeUrl } from './matrixLogic.js';

/** T6.1: stored permission-matrix definitions, one <dataDir>/permissions/matrices/<id>.json each. */

export class PermissionMatrixError extends RequestResolutionError {}

const withLock = createMutex();

export function matricesDir(): string {
  return path.join(permissionsDir(), 'matrices');
}

function matrixFile(id: string): string {
  if (!safeName.safeParse(id).success) {
    throw new PermissionMatrixError(400, 'ValidationError', 'Matrix id must match [a-zA-Z0-9_-]{1,80}');
  }
  return path.join(matricesDir(), `${id}.json`);
}

export function matrixSha256(matrix: PermissionMatrix): string {
  return crypto.createHash('sha256').update(JSON.stringify(matrix)).digest('hex');
}

export interface ResolvedMatrixContext {
  profile: TargetProfile;
  /** The matrix as it runs: the stored one plus the probes generated from the screen catalogue (T6.2). */
  matrix: PermissionMatrix;
  loginRoutine: string;
  loginStepCount: number;
}

/**
 * Everything a matrix needs that lives elsewhere, checked the same way at save and at run: the profile exists,
 * every role is a credential set that profile allows, the login routine and every action routine resolve on that
 * profile (not retired), and every probe URL is inside the allowlist. A matrix can never widen what a run may touch.
 */
export async function resolveMatrixContext(stored: PermissionMatrix): Promise<ResolvedMatrixContext> {
  const profile = await getTarget(stored.targetProfile);
  if (!profile) {
    throw new PermissionMatrixError(404, 'TargetProfileNotFound', `Target profile "${stored.targetProfile}" does not exist`);
  }

  let matrix: PermissionMatrix;
  try {
    matrix = materializeMatrix(stored, profile);
  } catch (error) {
    if (error instanceof CatalogError) throw new PermissionMatrixError(400, 'ScreenCatalogError', error.message);
    throw error;
  }

  const notAllowed = matrix.roles.filter((role) => !profile.credentialSets.includes(role));
  if (notAllowed.length > 0) {
    throw new PermissionMatrixError(
      403,
      'CredentialSetNotAllowed',
      `Role(s) ${notAllowed.map((role) => `"${role}"`).join(', ')} are not credential sets of target profile "${profile.id}" (add them to its credentialSets)`,
    );
  }

  const loginRoutine = matrix.loginRoutine ?? profile.loginRoutine;
  if (!loginRoutine) {
    throw new PermissionMatrixError(
      400,
      'LoginRoutineRequired',
      'A permission matrix needs a login routine (loginRoutine, or the target profile\'s loginRoutine) that fills its fields with valueFromCredential',
    );
  }

  for (const probe of matrix.probes) {
    if (probe.kind !== 'action') {
      try {
        validateTargetUrl(resolveProbeUrl(probe.url, profile.baseUrl));
      } catch (error) {
        throw new PermissionMatrixError(400, 'TargetUrlNotAllowed', `Probe "${probe.id}": ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // Throws IncludeError (404 missing, 409 retired or another profile...) with a precise message.
  const login = await expandIncludes(
    { steps: [{ id: LOGIN_INCLUDE_ID, action: 'include', routineId: loginRoutine, ...(matrix.loginRoutineVersion ? { version: matrix.loginRoutineVersion } : {}) }] },
    { targetProfile: profile.id },
  );
  for (const probe of matrix.probes) {
    if (probe.kind === 'action') {
      await expandIncludes(
        { steps: [{ id: 'action', action: 'include', routineId: probe.routineId, ...(probe.version ? { version: probe.version } : {}) }] },
        { targetProfile: profile.id },
      );
    }
  }

  return { profile, matrix, loginRoutine, loginStepCount: login.steps.length };
}

export async function getMatrix(id: string): Promise<StoredMatrix | undefined> {
  try {
    return storedMatrixSchema.parse(JSON.parse(await fs.readFile(matrixFile(id), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function listMatrices(): Promise<StoredMatrix[]> {
  const files = await fs.readdir(matricesDir()).catch(() => [] as string[]);
  const out: StoredMatrix[] = [];
  for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
    const stored = await getMatrix(file.slice(0, -'.json'.length)).catch(() => undefined);
    if (stored) out.push(stored);
  }
  return out;
}

export async function saveMatrix(id: string, matrix: PermissionMatrix): Promise<{ stored: StoredMatrix; changed: boolean }> {
  const file = matrixFile(id);
  await resolveMatrixContext(matrix);

  const sha256 = matrixSha256(matrix);
  const existing = await getMatrix(id);
  if (existing?.sha256 === sha256) {
    return { stored: existing, changed: false };
  }

  const stored: StoredMatrix = { id, updatedAt: new Date().toISOString(), sha256, matrix };
  await withLock(() => writeFileAtomic(file, `${JSON.stringify(stored, null, 2)}\n`));
  return { stored, changed: true };
}
