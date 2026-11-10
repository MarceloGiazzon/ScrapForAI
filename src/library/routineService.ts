import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';

import type { ZodError } from 'zod';

import { sanitizeParameterName } from '../schemas/parameters.schema.js';
import { mapLeaves } from '../schemas/stepTree.js';
import { expandIncludes } from './includeExpander.js';
import { resolveJobFile } from '../evidence/locate.js';
import { RequestResolutionError, resolveExplorationRequest } from '../runner/resolveRequest.js';
import { loadTableRef, tableRefsOf } from '../tables/resolveTables.js';
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
import { recordRunMetrics } from '../metrics/perfRecorder.js';
import type { Initiator } from '../team/initiator.js';
import { getRoutine, RoutineLibraryError, saveRoutineVersion } from './routineLibrary.js';
import { type ConventionLintResult, lintConventions } from './conventionLint.js';
import { lintParameters, lintRoutineDoc, lintRoutineSteps } from './routineLint.js';

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
  actors?: unknown;
  options?: unknown;
  parameters?: unknown;
  parameterValues?: Record<string, string>;
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

  const pinned = request.parameterValues ? pinParameterValues(request, request.parameterValues, jobId) : undefined;

  return {
    title: body.title ?? request.scenarioName,
    targetProfile: body.targetProfile ?? request.targetProfile,
    credentialSet: body.credentialSet ?? request.credentialSet,
    actors: body.actors ?? request.actors,
    options: body.options ?? request.options,
    parameters: body.parameters ?? pinned?.parameters ?? request.parameters,
    steps: pinned?.steps ?? request.steps,
    teardown: pinned?.teardown ?? request.teardown,
  };
}

/**
 * T5.6: a run forced to exact parameter values (a shrunk failure) is saved with those values FIXED: each declared parameter becomes a
 * single case, and an inline generator becomes the literal it produced. A parameter that belongs to an included routine cannot be pinned
 * here (it lives in that routine), so the run is refused rather than saved with its values silently back to random.
 */
function pinParameterValues(request: JobRequestFile, values: Record<string, string>, jobId: string): { parameters?: unknown; steps: unknown; teardown?: unknown } {
  const declared = Array.isArray(request.parameters) ? (request.parameters as Array<{ name: string }>) : [];
  const remaining = new Set(Object.keys(values));
  for (const parameter of declared) remaining.delete(parameter.name);

  // mapLeaves also reaches the steps inside a `parallel` block (T6.5); `slot` is "s3" at the top level, as before.
  const rewrite = (steps: unknown): unknown =>
    Array.isArray(steps)
      ? mapLeaves(steps as Array<Record<string, unknown>>, (step, slot) => {
          if (step.valueFromGenerator === undefined) return step;
          const name = sanitizeParameterName(`gen_${typeof step.id === 'string' ? step.id : slot}`);
          const value = values[name];
          if (value === undefined) return step;
          remaining.delete(name);
          const { valueFromGenerator: _generator, ...rest } = step;
          return { ...rest, value };
        })
      : steps;
  const steps = rewrite(request.steps);
  const teardown = request.teardown === undefined ? undefined : rewrite(request.teardown);

  if (remaining.size > 0) {
    throw new RoutineLibraryError(
      422,
      'ParametersNotPinnable',
      `${jobId} was run with fixed values for ${[...remaining].join(', ')}, which belong to an included routine (or to a generator in teardown/another phase) and cannot be pinned into this routine. Save the included routine's scenario instead.`,
    );
  }

  return {
    parameters: declared.map((parameter) => ({ name: parameter.name, cases: [values[parameter.name] ?? ''] })),
    steps,
    ...(teardown === undefined ? {} : { teardown }),
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
): Promise<{ routine: LibraryRoutine; created: boolean; lint: ConventionLintResult }> {
  const fromJob = body.fromJobId === undefined ? {} : await contentFromJob(body, body.fromJobId, options.allowFailedJob === true);

  const candidate = {
    title: body.title,
    description: body.description,
    tags: body.tags,
    surface: body.surface,
    status: body.status,
    targetProfile: body.targetProfile,
    credentialSet: body.credentialSet,
    actors: body.actors,
    options: body.options,
    parameters: body.parameters,
    lintSuppress: body.lintSuppress,
    doc: body.doc,
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

  const profile = await getTarget(content.targetProfile);
  if (!profile) {
    throw new RoutineLibraryError(400, 'TargetProfileNotFound', `Target profile "${content.targetProfile}" does not exist`);
  }

  const asRequest = explorationRequestSchema.safeParse({
    targetProfile: content.targetProfile,
    credentialSet: content.credentialSet,
    actors: content.actors,
    options: content.options,
    parameters: content.parameters,
    steps: content.steps,
    teardown: content.teardown,
  });
  if (!asRequest.success) {
    throw new RoutineLibraryError(400, 'ValidationError', 'Routine steps are not runnable', zodDetails(asRequest.error));
  }

  // Includes are checked now, not at the first run: cycles (this routine included, directly or not),
  // depth, a missing or retired routine, another target profile, or an invalid expanded result.
  await expandIncludes(
    { steps: content.steps, teardown: content.teardown, ...(content.parameters ? { parameters: content.parameters } : {}), ...(content.actors ? { actors: content.actors } : {}) },
    { targetProfile: content.targetProfile, selfId: id },
  );

  // T5.5: a table of cases the routine refers to must exist and have the column (a version, when named). Included routines are checked at run time.
  for (const ref of tableRefsOf(content.parameters ?? [], [...content.steps, ...(content.teardown ?? [])])) {
    try {
      await loadTableRef(ref);
    } catch (error) {
      if (error instanceof RequestResolutionError) throw new RoutineLibraryError(error.status, error.name, error.message);
      throw error;
    }
  }

  const vaultValues = await listAllCredentialValues();
  const issues = [...lintRoutineSteps([...content.steps, ...(content.teardown ?? [])], vaultValues), ...lintParameters(content.parameters ?? [], vaultValues), ...lintRoutineDoc(content.doc, vaultValues)];
  if (issues.length > 0) {
    throw new RoutineLibraryError(422, 'RoutineLintError', 'Routine contains what looks like a secret', issues);
  }

  // T8.4: the authoring conventions. An error stops the save (nothing is stored); warnings are returned with the saved routine.
  const lint = lintConventions(content, conventionContext(profile, id));
  const errors = lint.findings.filter((finding) => finding.severity === 'error');
  if (errors.length > 0) {
    throw new RoutineLibraryError(
      422,
      'RoutineConventionError',
      `The routine breaks an authoring convention (${[...new Set(errors.map((finding) => finding.rule))].join(', ')}); fix it, or accept it on purpose with lintSuppress { rule, reason }`,
      errors.map((finding) => ({ path: finding.path, message: `${finding.rule}: ${finding.message}` })),
    );
  }

  return { ...(await saveRoutineVersion(id, content, body.createdBy)), lint };
}

/** What the convention rules need to know about the profile the routine belongs to. */
export function conventionContext(profile: NonNullable<Awaited<ReturnType<typeof getTarget>>>, routineId?: string) {
  const isLoginRoutine = routineId !== undefined && profile.loginRoutine === routineId;
  return {
    platform: profile.platform,
    ...(profile.loginRoutine ? { loginRoutineId: profile.loginRoutine } : {}),
    ...(isLoginRoutine ? { isLoginRoutine: true, ...(profile.loginGate ? { gateProvidedByProfile: true } : {}) } : {}),
  };
}

/** Lints steps without saving them (POST /v1/routines/lint, `scrapforai routines lint`). */
export async function lintRoutineContent(input: {
  targetProfile: string;
  steps: RoutineContent['steps'];
  teardown?: RoutineContent['teardown'];
  lintSuppress?: RoutineContent['lintSuppress'];
  routineId?: string;
}): Promise<ConventionLintResult> {
  const profile = await getTarget(input.targetProfile);
  if (!profile) {
    throw new RoutineLibraryError(400, 'TargetProfileNotFound', `Target profile "${input.targetProfile}" does not exist`);
  }
  return lintConventions(input, conventionContext(profile, input.routineId));
}

/**
 * Runs a stored routine at a pinned version (default: current). `body` carries per-run inputs only;
 * the steps, target profile and options always come from the stored version. `context.initiator` is who the run is for (REQUIRED: a credential
 * set may be restricted to some users, see `resolveExplorationRequest`).
 */
export async function runLibraryRoutine(
  id: string,
  version: number | undefined,
  body: RoutineRunBody,
  context: { suite?: { suiteRunId: string; variantKey: string }; initiator: Initiator },
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
    actors: routine.actors,
    variables: body.variables,
    parameters: routine.parameters,
    seed: body.seed,
    sample: body.sample,
    parameterValues: body.parameterValues,
    caller: body.caller,
    options:
      body.retention || body.profile || body.recordTraffic || body.docFigures
        ? {
            ...(routine.options ?? explorationRequestSchema.shape.options.parse(undefined)),
            ...(body.retention ? { retention: body.retention } : {}),
            ...(body.profile ? { profile: body.profile } : {}),
            ...(body.recordTraffic ? { recordTraffic: true } : {}),
            // T9.2: a figure needs the real page (full profile: images are not stand-ins) and a screenshot, whatever the routine's own options say.
            ...(body.docFigures ? { docFigures: true, profile: 'full' as const, screenshots: routine.options?.screenshots === 'always' ? ('always' as const) : ('onFailure' as const) } : {}),
          }
        : routine.options,
    steps: routine.steps,
    teardown: routine.teardown,
  });

  const resolved = await resolveExplorationRequest(request, { includeProfile: routine.targetProfile, initiator: context.initiator });
  resolved.routine = { id: routine.id, version: routine.version, sha256: routine.sha256 };
  if (context.suite) {
    resolved.suite = context.suite;
  }
  const result = await runExploration(resolved);
  // T3.4: the time each step took joins the routine's series. Never fails the run.
  await recordRunMetrics(result, { fixedParameters: body.parameterValues !== undefined });
  return result;
}

/**
 * Like runLibraryRoutine, but takes an interactive slot first, the way the synchronous HTTP endpoints do:
 * no free slot is a 429 and a credential in use by another run is a 409. For flows that run one routine
 * on behalf of a caller (regression vault: run, confirm-green).
 */
export async function runRoutineInteractive(id: string, version: number | undefined, body: RoutineRunBody, initiator: Initiator): Promise<ExplorationResult> {
  const routine = await getRoutine(id, version);
  if (!routine) {
    throw new RoutineLibraryError(404, 'RoutineNotFound', version === undefined ? `Routine "${id}" does not exist` : `Routine "${id}" has no version ${version}`);
  }

  const slot = await acquireInteractiveSlot({
    credentialSet: body.credentialSet ?? routine.credentialSet,
    actors: routine.actors,
    targetProfile: body.targetProfile ?? routine.targetProfile,
  });
  if (!slot.ok) {
    throw new RoutineLibraryError(slot.status, slot.type, slot.message);
  }

  try {
    return await runLibraryRoutine(id, version, body, { initiator });
  } finally {
    slot.release();
  }
}
