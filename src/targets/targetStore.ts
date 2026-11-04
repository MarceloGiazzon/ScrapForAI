import fs from 'node:fs/promises';
import path from 'node:path';

import { targetsDir } from '../config/paths.js';
import { safeName } from '../schemas/explorationRequest.schema.js';
import { type TargetProfile, targetProfileSchema } from '../schemas/targetProfile.schema.js';
import { policyProblems } from '../security/piiPolicy.js';
import { validateTargetUrl } from '../security/validateTargetUrl.js';
import { createMutex, writeFileAtomic } from '../storage/atomicWrite.js';

export class InvalidTargetProfileIdError extends Error {
  constructor() {
    super('Target profile id must match [a-zA-Z0-9_-]{1,80}');
    this.name = 'InvalidTargetProfileId';
  }
}

const withLock = createMutex();

function profilePath(id: string): string {
  // The id becomes a file name, so it is validated here and not only at the HTTP edge.
  if (!safeName.safeParse(id).success) {
    throw new InvalidTargetProfileIdError();
  }

  return path.join(targetsDir(), `${id}.json`);
}

export async function getTarget(id: string): Promise<TargetProfile | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(profilePath(id), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }

  return targetProfileSchema.parse(JSON.parse(raw));
}

export async function listTargets(): Promise<TargetProfile[]> {
  const entries = await fs.readdir(targetsDir()).catch(() => [] as string[]);
  const profiles: TargetProfile[] = [];

  for (const entry of entries.filter((name) => name.endsWith('.json')).sort()) {
    const profile = await getTarget(entry.slice(0, -'.json'.length)).catch(() => undefined);
    if (profile) {
      profiles.push(profile);
    }
  }

  return profiles;
}

/**
 * Validates and stores a profile. A profile can never widen the allowlist: baseUrl goes through
 * validateTargetUrl, so an origin outside ALLOWED_TARGET_ORIGINS throws TargetUrlNotAllowed and
 * nothing is written.
 */
export class PiiPolicyError extends Error {
  constructor(readonly details: Array<{ path: string; message: string }>) {
    super(`Invalid PII policy: ${details.map((d) => `${d.path}: ${d.message}`).join('; ')}`);
    this.name = 'PiiPolicyError';
  }
}

export async function saveTarget(profile: TargetProfile): Promise<TargetProfile> {
  const parsed = targetProfileSchema.parse(profile);
  validateTargetUrl(parsed.baseUrl);
  // T7.9: checks that depend on today's date (a suppression already expired, or too far ahead) cannot be in the schema: a stored profile must keep loading.
  const problems = parsed.pii ? policyProblems(parsed.pii) : [];
  if (problems.length > 0) throw new PiiPolicyError(problems);
  const file = profilePath(parsed.id);

  await withLock(() => writeFileAtomic(file, `${JSON.stringify(parsed, null, 2)}\n`));
  return parsed;
}
