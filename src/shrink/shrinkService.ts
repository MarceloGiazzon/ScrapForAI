import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { nanoid } from 'nanoid';

import { env } from '../config/env.js';
import { shrinksDir } from '../config/paths.js';
import { resolveJobFile } from '../evidence/locate.js';
import { declareParameters } from '../generators/resolveParameters.js';
import { expandIncludes } from '../library/includeExpander.js';
import { getRoutine } from '../library/routineLibrary.js';
import { runLibraryRoutine } from '../library/routineService.js';
import { JobCancelledError } from '../orchestrator/jobQueue.js';
import { sessionCredentialSets } from '../runner/actors.js';
import type { Initiator } from '../team/initiator.js';
import { jobQueue, maxSessionsFor } from '../runner/jobSlots.js';
import { RequestResolutionError } from '../runner/resolutionError.js';
import type { ExplorationResult } from '../schemas/explorationResult.schema.js';
import type { ShrinkRequest } from '../schemas/shrink.schema.js';
import { createMutex, writeFileAtomic } from '../storage/atomicWrite.js';
import { describeParameters } from './describe.js';
import { shrink, type ShrinkResult, summarizeShrink } from './shrink.js';

/**
 * T5.6 service: shrinks a failure by running the routine again and again with exact parameter values, through the same job queue as
 * suites (suite priority, one session per credential set). Starting returns at once; state is written to <dataDir>/shrinks/<id>.json
 * after every run, so a poll sees the search advance and a restart leaves it `interrupted`.
 */

export const SHRINK_ID_PATTERN = /^shrink_[A-Za-z0-9_-]{1,40}$/;
export class ShrinkError extends RequestResolutionError {}

/** What "the same failure" means: the same step fails with the same kind of error. */
export interface FailureSignature {
  stepId: string;
  action?: string;
  errorType: string;
}

export interface ShrinkState {
  shrinkId: string;
  status: 'running' | 'completed' | 'cancelled' | 'interrupted';
  createdAt: string;
  finishedAt?: string;
  request: ShrinkRequest;
  routine?: { id: string; version: number };
  signature?: FailureSignature;
  /** Real runs so far (live while running). */
  runs: number;
  /** The smallest failing values found so far (live while running). */
  currentValues?: Record<string, string>;
  /**
   * How it ended: a ShrinkResult status, or `not-failing` (the sample passes, nothing to shrink) / `no-parameters` (the routine draws no value)
   * / `failed` (could not start, see `error`).
   */
  outcome?: ShrinkResult['status'] | 'not-failing' | 'no-parameters' | 'failed';
  result?: ShrinkResult;
  /** One line: "fails with qty=1000, passes with qty=999". */
  summary?: string;
  /** Replay: `POST /v1/routines/:id/run` with these. */
  replay?: { routineId: string; version: number; parameterValues: Record<string, string> };
  error?: string;
}

interface Active {
  state: ShrinkState;
  controller: AbortController;
  finished: Promise<void>;
  /** Who started the shrink: every probe loads its credential sets on that account. */
  initiator: Initiator;
}

const active = new Map<string, Active>();
const withLock = createMutex();
const TERMINAL: ReadonlySet<ShrinkState['status']> = new Set(['completed', 'cancelled', 'interrupted']);

const stateFile = (id: string): string => path.join(shrinksDir(), `${id}.json`);

function persist(state: ShrinkState): Promise<void> {
  const text = `${JSON.stringify(state, null, 2)}\n`;
  return withLock(() => writeFileAtomic(stateFile(state.shrinkId), text)).catch(() => undefined);
}

async function readJob<T>(jobId: string, name: 'request.json' | 'result.json'): Promise<T | undefined> {
  const file = resolveJobFile(jobId, name);
  if (!file || !existsSync(file)) return undefined;
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}

export const signatureOf = (result: Pick<ExplorationResult, 'status' | 'steps' | 'failedStepIndex' | 'error'>): FailureSignature | undefined => {
  if (result.status !== 'failed' || result.failedStepIndex === undefined) return undefined;
  const step = result.steps[result.failedStepIndex];
  return { stepId: step?.id ?? `#${result.failedStepIndex}`, ...(step?.action ? { action: step.action } : {}), errorType: result.error?.type ?? 'unknown' };
};

export const sameFailure = (a: FailureSignature | undefined, b: FailureSignature): boolean => a !== undefined && a.stepId === b.stepId && a.errorType === b.errorType;

/** Everything needed to start, resolved from the request (and the failed run's evidence): quick and deterministic, no browser. */
interface Source {
  routineId: string;
  version: number;
  credentialSet?: string;
  targetProfile?: string;
  /** Present with `fromJobId`; otherwise the worker runs the sample once to get them. */
  failing?: { values: Record<string, string>; signature: FailureSignature };
}

async function resolveSource(request: ShrinkRequest): Promise<Source> {
  if (request.fromJobId === undefined) {
    const routine = await getRoutine(request.routineId!, request.version);
    if (!routine) throw new ShrinkError(404, 'RoutineNotFound', `Routine "${request.routineId}" ${request.version === undefined ? 'does not exist' : `has no version ${request.version}`}`);
    return { routineId: routine.id, version: routine.version };
  }

  const result = await readJob<ExplorationResult>(request.fromJobId, 'result.json');
  if (!result) throw new ShrinkError(404, 'EvidenceNotFound', `No evidence for ${request.fromJobId}: it expired (ARTIFACT_RETENTION_HOURS) or never existed`);
  if (!result.routine) throw new ShrinkError(400, 'NotALibraryRun', `${request.fromJobId} did not run a library routine; shrinking replays a routine, so save it first`);
  if (!result.parameters) throw new ShrinkError(400, 'NoParameters', `${request.fromJobId} drew no generated value: there is nothing to shrink`);
  const signature = signatureOf(result);
  if (!signature) throw new ShrinkError(409, 'JobDidNotFail', `${request.fromJobId} did not fail (status ${result.status}); only a failure can be shrunk`);

  const recorded = await readJob<{ credentialSet?: string; targetProfile?: string }>(request.fromJobId, 'request.json');
  return {
    routineId: result.routine.id,
    version: result.routine.version,
    ...(recorded?.credentialSet ? { credentialSet: recorded.credentialSet } : {}),
    ...(recorded?.targetProfile ? { targetProfile: recorded.targetProfile } : {}),
    failing: { values: result.parameters.values, signature },
  };
}

async function worker(entry: Active, source: Source): Promise<void> {
  const { state, controller } = entry;
  const { request } = state;
  const credentialSet = request.credentialSet ?? source.credentialSet;
  const targetProfile = request.targetProfile ?? source.targetProfile;
  const base = {
    ...(credentialSet ? { credentialSet } : {}),
    ...(targetProfile ? { targetProfile } : {}),
    ...(request.variables ? { variables: request.variables } : {}),
    ...(request.buildId ? { buildId: request.buildId } : {}),
    ...(request.profile ? { profile: request.profile } : {}),
    caller: { source: 'shrink', correlationId: state.shrinkId },
  };

  const routine = (await getRoutine(source.routineId, source.version))!;
  const effectiveCredential = credentialSet ?? routine.credentialSet;
  const maxPerLock = await maxSessionsFor(targetProfile ?? routine.targetProfile);

  const run = (body: Record<string, unknown>): Promise<ExplorationResult> =>
    jobQueue.run(() => runLibraryRoutine(source.routineId, source.version, { ...base, ...body } as never, { initiator: entry.initiator }), {
      priority: 'suite',
      lockKeys: sessionCredentialSets({ credentialSet: effectiveCredential, actors: routine.actors }),
      maxPerLock,
      signal: controller.signal,
    });

  let failing = source.failing;
  let initialRuns = 0;
  if (!failing) {
    // By seed + sample: one run tells whether it fails, and how.
    initialRuns = 1;
    const first = await run({ seed: request.seed, sample: request.sample });
    state.runs = 1;
    const signature = signatureOf(first);
    if (!first.parameters) {
      state.outcome = 'no-parameters';
      state.summary = 'the routine draws no generated value: there is nothing to shrink';
      return;
    }
    if (!signature) {
      state.outcome = first.status === 'passed' ? 'not-failing' : 'failed';
      state.summary = first.status === 'passed' ? `sample ${request.sample} of seed "${request.seed}" passes: there is nothing to shrink` : 'the run failed without a failing step';
      return;
    }
    failing = { values: first.parameters.values, signature };
  }

  // Every parameter the run really had: declared ones, the implicit one of each inline generator, and those of included routines.
  const expanded = await expandIncludes({ steps: routine.steps, teardown: routine.teardown, parameters: routine.parameters ?? [] }, { targetProfile: routine.targetProfile });
  const declared = declareParameters({
    steps: expanded.steps,
    ...(expanded.teardown.length > 0 ? { teardown: expanded.teardown } : {}),
    parameters: [...(routine.parameters ?? []), ...expanded.parameters],
  });
  const known = declared.parameters.filter((parameter) => Object.hasOwn(failing!.values, parameter.name));
  // T5.5: with a table each row is ONE case with its own expected result; another value for a column would no longer match it. The failing row is already the input.
  if (known.some((parameter) => 'fromTable' in parameter)) {
    state.outcome = 'no-parameters';
    state.summary = 'the values come from a table of cases: a row is one case with its own expected result, so the failing row is already the smallest input (nothing to shrink)';
    return;
  }
  if (known.length === 0) {
    state.outcome = 'no-parameters';
    state.summary = 'the routine draws no generated value: there is nothing to shrink';
    return;
  }

  state.signature = failing.signature;
  state.currentValues = failing.values;
  await persist(state);

  const signature = failing.signature;
  const result = await shrink({
    parameters: describeParameters(known),
    failing: Object.fromEntries(known.map((parameter) => [parameter.name, failing!.values[parameter.name]!])),
    maxRuns: Math.max(1, request.maxShrinkRuns - initialRuns),
    deadline: Date.parse(state.createdAt) + request.maxShrinkSeconds * 1000,
    signal: controller.signal,
    probe: async (values) => {
      const probed = await run({ parameterValues: values });
      return { fails: sameFailure(signatureOf(probed), signature), jobId: probed.jobId };
    },
    onProgress: ({ runs, current }) => {
      state.runs = runs + initialRuns;
      state.currentValues = current;
      void persist(state);
    },
  });

  state.runs = result.runs + initialRuns;
  state.result = result;
  state.outcome = result.status;
  state.summary = summarizeShrink(result);
  state.currentValues = result.minimal;
  if (result.status !== 'not-reproduced') {
    state.replay = { routineId: source.routineId, version: source.version, parameterValues: result.minimal };
  }
}

/** Validates, starts in the background, returns the initial state. Throws ShrinkError (404/400/409) before anything runs. */
export async function startShrink(request: ShrinkRequest, initiator: Initiator): Promise<ShrinkState> {
  const source = await resolveSource(request);

  const state: ShrinkState = {
    shrinkId: `shrink_${nanoid(12)}`,
    status: 'running',
    createdAt: new Date().toISOString(),
    request,
    routine: { id: source.routineId, version: source.version },
    ...(source.failing ? { signature: source.failing.signature, currentValues: source.failing.values } : {}),
    runs: 0,
  };
  const entry: Active = { state, controller: new AbortController(), finished: Promise.resolve(), initiator };
  active.set(state.shrinkId, entry);
  await persist(state);

  entry.finished = worker(entry, source)
    .catch((error) => {
      if (error instanceof JobCancelledError) {
        state.outcome = 'cancelled';
        state.summary = 'cancelled';
      } else {
        // The probe could not run at all (credential refused, profile gone...): reported, never left "running".
        state.outcome = 'failed';
        state.error = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500);
      }
    })
    .finally(async () => {
      state.status = entry.controller.signal.aborted ? 'cancelled' : 'completed';
      state.finishedAt = new Date().toISOString();
      await persist(state);
      setTimeout(() => active.delete(state.shrinkId), 60_000).unref();
    });

  return structuredClone(state);
}

export async function getShrink(id: string): Promise<ShrinkState | undefined> {
  if (!SHRINK_ID_PATTERN.test(id)) return undefined;
  const live = active.get(id);
  if (live) return structuredClone(live.state);
  try {
    return JSON.parse(await fs.readFile(stateFile(id), 'utf8')) as ShrinkState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function waitForShrink(id: string, waitMs: number): Promise<ShrinkState | undefined> {
  const live = active.get(id);
  if (live && !TERMINAL.has(live.state.status) && waitMs > 0) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      live.finished,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs);
      }),
    ]);
    clearTimeout(timer);
  }
  return getShrink(id);
}

/** Stops after the run in progress: the best failing input found so far is kept in the state. */
export async function cancelShrink(id: string): Promise<ShrinkState | undefined> {
  const live = active.get(id);
  if (!live) return getShrink(id);
  live.controller.abort();
  await live.finished;
  return getShrink(id);
}

/** At startup: a state still `running` belongs to a dead process. Also prunes old files. */
export async function recoverShrinks(): Promise<{ interrupted: number; pruned: number }> {
  const files = await fs.readdir(shrinksDir()).catch(() => [] as string[]);
  const cutoff = Date.now() - env.HISTORY_RETENTION_DAYS * 24 * 3600_000;
  let interrupted = 0;
  let pruned = 0;

  for (const file of files.filter((name) => name.endsWith('.json'))) {
    const full = path.join(shrinksDir(), file);
    const stats = await fs.stat(full).catch(() => undefined);
    if (stats && stats.mtimeMs < cutoff) {
      await fs.rm(full, { force: true });
      pruned += 1;
      continue;
    }
    const state = await getShrink(file.slice(0, -'.json'.length)).catch(() => undefined);
    if (!state || state.status !== 'running' || active.has(state.shrinkId)) continue;
    state.status = 'interrupted';
    state.finishedAt = new Date().toISOString();
    state.error = 'the server stopped before the search finished; currentValues is the smallest failing input found until then';
    await persist(state);
    interrupted += 1;
  }
  return { interrupted, pruned };
}
