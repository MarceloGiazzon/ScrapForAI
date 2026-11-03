import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';

import type { ZodError } from 'zod';

import { expandIncludes } from './includeExpander.js';
import { resolveJobFile } from '../evidence/locate.js';
import { resolveExplorationRequest } from '../runner/resolveRequest.js';
import { runExploration } from '../runner/runExploration.js';
import { explorationRequestSchema } from '../schemas/explorationRequest.schema.js';
import type { ExplorationResult } from '../schemas/explorationResult.schema.js';
import {
  type LibraryRoutine,
  type RoutineContent,
  routineContentSchema,
  type RoutineRunBody,
  type RoutineSaveBody,
} from '../schemas/libraryRoutine.schema.js';
import { acquireInteractiveSlot } from '../runner/jobSlots.js';
import { getTarget } from '../targets/targetStore.js';
import { listAllCredentialValues } from '../vault/credentials/credentialVault.js';
import { getRoutine, RoutineLibraryError, saveRoutineVersion } from './routineLibrary.js';
import { lintRoutineSteps } from './routineLint.js';

function zodDetails(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

async function readJobFile(jobId: string, name: 'request.json' | 'result.json'): Promise<unknown> {
  const file = resolveJobFile(jobId, name);
  if (!file || !existsSync(file)) {
    return undefined;
  }

  return JSON.parse(await fs.readFile(file, 'utf8'));
}

interface JobRequestFile {
  scenarioName?: string;
  targetProfile?: string;
  credentialSet?: string;
  options?: unknown;
  steps?: unknown;
  teardown?: unknown;
}

/** Copies the steps of a successful run that is still inside evidence retention. */
async function contentFromJob(body: RoutineSaveBody, jobId: string, allowFailedJob: boolean): Promise<Record<string, unknown>> {
  const result = (await readJobFile(jobId, 'result.json')) as Pick<ExplorationResult, 'status'> | undefined;
  const request = (await readJobFile(jobId, 'request.json')) as JobRequestFile | undefined;

  if (!result || !request?.steps) {
    throw new RoutineLibraryError(
      404,
      'JobRequestUnavailable',
      `The request of ${jobId} is not available: its evidence expired (ARTIFACT_RETENTION_HOURS) or it ran before routines existed. Re-run it, or pass steps directly.`,
    );
  }

  if (result.status !== 'passed' && !allowFailedJob) {
    throw new RoutineLibraryError(409, 'JobNotSuccessful', `${jobId} did not pass; only a run that worked can be saved as a routine`);
  }

  if (JSON.stringify([request.steps, request.teardown]).includes('[REDACTED]')) {
    throw new RoutineLibraryError(
      422,
      'RoutineContainsRedactedValues',
      `${jobId} used an inline secret as a literal step value. Move the secret to the credential vault, use valueFromCredential, and run it again before saving.`,
    );
  }

  return {
    title: body.title ?? request.scenarioName,
    targetProfile: body.targetProfile ?? request.targetProfile,
    credentialSet: body.credentialSet ?? request.credentialSet,
    options: body.options ?? request.options,
    steps: request.steps,
    teardown: request.teardown,
  };
}

/**
 * Validates, lints and stores a routine as a new immutable version (or reports it unchanged).
 * Validation is the same as for a run: the steps are parsed through explorationRequestSchema, so a
 * routine that could not run (duplicate step ids, evaluate disabled, ...) cannot be saved.
 */
export async function saveRoutine(
  id: string,
  body: RoutineSaveBody,
  options: { allowFailedJob?: boolean } = {},
): Promise<{ routine: LibraryRoutine; created: boolean }> {
  const fromJob = body.fromJobId === undefined ? {} : await contentFromJob(body, body.fromJobId, options.allowFailedJob === true);

  const candidate = {
    title: body.title,
    description: body.description,
    tags: body.tags,
    surface: body.surface,
    status: body.status,
    targetProfile: body.targetProfile,
    credentialSet: body.credentialSet,
    options: body.options,
    steps: body.steps,
    teardown: body.teardown,
    // From the job, but anything the caller passed explicitly wins (contentFromJob already applies that).
    ...Object.fromEntries(Object.entries(fromJob).filter(([, value]) => value !== undefined)),
  };

  const parsed = routineContentSchema.safeParse(Object.fromEntries(Object.entries(candidate).filter(([, value]) => value !== undefined)));
  if (!parsed.success) {
    throw new RoutineLibraryError(400, 'ValidationError', 'Invalid routine', zodDetails(parsed.error));
  }
  const content: RoutineContent = parsed.data;

  if (!(await getTarget(content.targetProfile))) {
    throw new RoutineLibraryError(400, 'TargetProfileNotFound', `Target profile "${content.targetProfile}" does not exist`);
  }

  const asRequest = explorationRequestSchema.safeParse({
    targetProfile: content.targetProfile,
    credentialSet: content.credentialSet,
    options: content.options,
    steps: content.steps,
    teardown: content.teardown,
  });
  if (!asRequest.success) {
    throw new RoutineLibraryError(400, 'ValidationError', 'Routine steps are not runnable', zodDetails(asRequest.error));
  }

  // Includes are checked now, not at the first run: cycles (this routine included, directly or not),
  // depth, a missing or retired routine, another target profile, or an invalid expanded result.
  await expandIncludes({ steps: content.steps, teardown: content.teardown }, { targetProfile: content.targetProfile, selfId: id });

  const issues = lintRoutineSteps([...content.steps, ...(content.teardown ?? [])], await listAllCredentialValues());
  if (issues.length > 0) {
    throw new RoutineLibraryError(422, 'RoutineLintError', 'Routine contains what looks like a secret', issues);
  }

  return saveRoutineVersion(id, content, body.createdBy);
}

/**
 * Runs a stored routine at a pinned version (default: current). `body` carries per-run inputs only;
 * the steps, target profile and options always come from the stored version.
 */
export async function runLibraryRoutine(
  id: string,
  version: number | undefined,
  body: RoutineRunBody,
  context: { suite?: { suiteRunId: string; variantKey: string } } = {},
): Promise<ExplorationResult> {
  const routine = await getRoutine(id, version);
  if (!routine) {
    throw new RoutineLibraryError(404, 'RoutineNotFound', version === undefined ? `Routine "${id}" does not exist` : `Routine "${id}" has no version ${version}`);
  }

  if (routine.status === 'retired') {
    throw new RoutineLibraryError(409, 'RoutineRetired', `Routine "${id}" v${routine.version} is retired`);
  }

  const request = explorationRequestSchema.parse({
    scenarioName: routine.title,
    buildId: body.buildId,
    targetProfile: body.targetProfile ?? routine.targetProfile,
    credentialSet: body.credentialSet ?? routine.credentialSet,
    variables: body.variables,
    caller: body.caller,
    options:
      body.retention || body.profile
        ? {
            ...(routine.options ?? explorationRequestSchema.shape.options.parse(undefined)),
            ...(body.retention ? { retention: body.retention } : {}),
            ...(body.profile ? { profile: body.profile } : {}),
          }
        : routine.options,
    steps: routine.steps,
    teardown: routine.teardown,
  });

  const resolved = await resolveExplorationRequest(request, { includeProfile: routine.targetProfile });
  resolved.routine = { id: routine.id, version: routine.version, sha256: routine.sha256 };
  if (context.suite) {
    resolved.suite = context.suite;
  }
  return runExploration(resolved);
}

/**
 * Like runLibraryRoutine, but takes an interactive slot first, the way the synchronous HTTP endpoints do:
 * no free slot is a 429 and a credential in use by another run is a 409. For flows that run one routine
 * on behalf of a caller (regression vault: run, confirm-green).
 */
export async function runRoutineInteractive(id: string, version: number | undefined, body: RoutineRunBody): Promise<ExplorationResult> {
  const routine = await getRoutine(id, version);
  if (!routine) {
    throw new RoutineLibraryError(404, 'RoutineNotFound', version === undefined ? `Routine "${id}" does not exist` : `Routine "${id}" has no version ${version}`);
  }

  const slot = await acquireInteractiveSlot({
    credentialSet: body.credentialSet ?? routine.credentialSet,
    targetProfile: body.targetProfile ?? routine.targetProfile,
  });
  if (!slot.ok) {
    throw new RoutineLibraryError(slot.status, slot.type, slot.message);
  }

  try {
    return await runLibraryRoutine(id, version, body);
  } finally {
    slot.release();
  }
}
