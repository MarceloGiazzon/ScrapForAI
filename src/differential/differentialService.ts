import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { nanoid } from 'nanoid';

import { env } from '../config/env.js';
import { differentialsDir } from '../config/paths.js';
import { resolveJobFile } from '../evidence/locate.js';
import { getRoutine } from '../library/routineLibrary.js';
import { runLibraryRoutine } from '../library/routineService.js';
import { JobCancelledError } from '../orchestrator/jobQueue.js';
import { sessionCredentialSets } from '../runner/actors.js';
import { jobQueue, maxSessionsFor } from '../runner/jobSlots.js';
import { RequestResolutionError } from '../runner/resolutionError.js';
import type { DiffConfigInput } from '../schemas/diffConfig.schema.js';
import type { DifferentialCompareRequest, DifferentialRequest, DifferentialTolerance } from '../schemas/differential.schema.js';
import type { ExplorationResult } from '../schemas/explorationResult.schema.js';
import { walkWithPath } from '../schemas/stepTree.js';
import { createMutex, writeFileAtomic } from '../storage/atomicWrite.js';
import { getTarget } from '../targets/targetStore.js';
import { compareRuns, describeComparison, describeTiming, type DifferentialComparison } from './compareRuns.js';

/**
 * T6.3 service. A differential run executes each routine against TWO target profiles through the same job queue as suites (suite
 * priority, one session per credential set), compares the two results with `compareRuns` and keeps the comparison. Starting returns at
 * once; state is written to <dataDir>/differentials/<id>.json after every routine, so a poll sees it advance and a restart leaves it
 * `interrupted`. The routine version is pinned when it starts: both sides always run the same steps.
 */

export const DIFFERENTIAL_ID_PATTERN = /^diff_[A-Za-z0-9_-]{1,40}$/;
export class DifferentialError extends RequestResolutionError {}

export type DifferentialVerdict = 'same' | 'different' | 'infra-error';

/** What is kept of one side's run: where to find the evidence and how it ended. The result itself stays in the run's evidence. */
export interface SideRun {
  jobId?: string;
  status?: 'passed' | 'failed';
  durationMs?: number;
  buildId?: string;
  buildIdSource?: string;
  /** Present when the run could not execute at all (profile, credential, browser...). */
  error?: string;
}

export interface PairState {
  routineId: string;
  version: number;
  state: 'pending' | 'running' | 'done';
  outcome?: DifferentialVerdict;
  left?: SideRun;
  right?: SideRun;
  comparison?: DifferentialComparison;
  /** The differences in plain words, one per line (what the CLI and the markdown print), and the time differences apart. */
  lines?: string[];
  timeLines?: string[];
  /** Why the pair is `infra-error`. */
  error?: string;
}

export interface DifferentialState {
  differentialId: string;
  status: 'running' | 'completed' | 'cancelled' | 'interrupted';
  createdAt: string;
  finishedAt?: string;
  request: DifferentialRequest;
  labels: { left: string; right: string };
  pairs: PairState[];
  counts: { total: number; same: number; different: number; infraError: number; notRun: number };
  /** `different` (exit 1) wins over `infra-error` (exit 2), as in the permission matrix: a difference found is a finding even if another pair could not run. */
  verdict?: DifferentialVerdict;
  /** 0 same, 1 different, 2 infra-error: what a CI guard exits with. */
  exitCode?: 0 | 1 | 2;
  reason?: string;
  /** Things that make the comparison less meaningful than it looks; the run still goes ahead. */
  warnings?: string[];
  error?: string;
}

interface Active {
  state: DifferentialState;
  controller: AbortController;
  finished: Promise<void>;
}

const active = new Map<string, Active>();
const withLock = createMutex();
const TERMINAL: ReadonlySet<DifferentialState['status']> = new Set(['completed', 'cancelled', 'interrupted']);

const stateFile = (id: string): string => path.join(differentialsDir(), `${id}.json`);

function persist(state: DifferentialState): Promise<void> {
  const text = `${JSON.stringify(state, null, 2)}\n`;
  return withLock(() => writeFileAtomic(stateFile(state.differentialId), text)).catch(() => undefined);
}

export function tally(state: Pick<DifferentialState, 'pairs'>): DifferentialState['counts'] {
  const count = (outcome: DifferentialVerdict): number => state.pairs.filter((pair) => pair.outcome === outcome).length;
  return { total: state.pairs.length, same: count('same'), different: count('different'), infraError: count('infra-error'), notRun: state.pairs.filter((pair) => pair.outcome === undefined).length };
}

export function verdictOf(state: Pick<DifferentialState, 'pairs' | 'counts'>, cancelled: boolean): { verdict: DifferentialVerdict; reason: string; exitCode: 0 | 1 | 2 } {
  const decided = decide(state, cancelled);
  return { ...decided, exitCode: decided.verdict === 'same' ? 0 : decided.verdict === 'different' ? 1 : 2 };
}

function decide(state: Pick<DifferentialState, 'pairs' | 'counts'>, cancelled: boolean): { verdict: DifferentialVerdict; reason: string } {
  const { total, same, different, infraError, notRun } = state.counts;
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  const tail = [infraError > 0 ? `${plural(infraError, 'routine')} could not run on one side` : '', notRun > 0 ? `${plural(notRun, 'routine')} not run` : ''].filter(Boolean).join('; ');
  if (different > 0) {
    return { verdict: 'different', reason: `${different} of ${total} routine(s) behave differently${same > 0 ? `, ${same} the same` : ''}${tail ? `; ${tail}` : ''}` };
  }
  if (infraError > 0 || notRun > 0 || cancelled) {
    return { verdict: 'infra-error', reason: `nothing different found, but ${tail || 'the run was cancelled'}` };
  }
  return { verdict: 'same', reason: `${plural(same, 'routine')} behave the same on both sides` };
}

/** A routine fixed at the version both sides run; `actors` (T6.4) only to know which credential sessions it holds. */
interface PinnedRoutine {
  id: string;
  version: number;
  credentialSet?: string;
  actors?: Record<string, { credentialSet?: string | undefined }>;
}

/** Everything that can be checked without a browser: routines, profiles and the credential set of each side. */
async function validate(request: DifferentialRequest): Promise<{ routines: PinnedRoutine[]; leftDiff?: DiffConfigInput; warnings: string[] }> {
  const routines: PinnedRoutine[] = [];
  const fixedAddresses: Array<{ routineId: string; stepId: string; origin: string }> = [];
  for (const wanted of request.routines) {
    const routine = await getRoutine(wanted.routineId, wanted.version);
    if (!routine) {
      throw new DifferentialError(404, 'RoutineNotFound', wanted.version === undefined ? `Routine "${wanted.routineId}" does not exist` : `Routine "${wanted.routineId}" has no version ${wanted.version}`);
    }
    if (routine.status === 'retired') throw new DifferentialError(409, 'RoutineRetired', `Routine "${routine.id}" v${routine.version} is retired`);
    routines.push({ id: routine.id, version: routine.version, ...(routine.credentialSet ? { credentialSet: routine.credentialSet } : {}), ...(routine.actors ? { actors: routine.actors } : {}) });
    for (const { step: routineStep, path } of walkWithPath(routine.steps, ['steps'])) {
      if (routineStep.action !== 'goto' || routineStep.url === '$targetUrl') continue;
      try {
        // `#3`, or `#3.branches.1.0` inside a parallel block.
        fixedAddresses.push({ routineId: routine.id, stepId: routineStep.id ?? `#${path.slice(1).join('.')}`, origin: new URL(routineStep.url).origin });
      } catch {
        // not an absolute address: nothing to say about it
      }
    }
  }

  let leftDiff: DiffConfigInput | undefined;
  const baseOrigins: string[] = [];
  for (const [name, side] of [['left', request.left], ['right', request.right]] as const) {
    const profile = await getTarget(side.targetProfile);
    if (!profile) throw new DifferentialError(404, 'TargetNotFound', `The ${name} target profile "${side.targetProfile}" does not exist`);
    if (side.credentialSet !== undefined && !profile.credentialSets.includes(side.credentialSet)) {
      throw new DifferentialError(400, 'CredentialSetNotAllowed', `Credential set "${side.credentialSet}" is not allowed for the ${name} target profile "${side.targetProfile}"`);
    }
    if (name === 'left') leftDiff = profile.diff;
    try {
      baseOrigins.push(new URL(profile.baseUrl).origin);
    } catch {
      // a profile without a usable baseUrl cannot be compared against another
    }
  }

  // A routine that opens a fixed address opens the SAME address on both sides: the comparison would be of one application with itself.
  const warnings: string[] = [];
  if (new Set(baseOrigins).size > 1) {
    for (const fixed of fixedAddresses) {
      warnings.push(`routine "${fixed.routineId}" step "${fixed.stepId}" goes to a fixed address (${fixed.origin}): both sides open it. Use goto "$targetUrl" to follow each target profile's baseUrl.`);
    }
  }
  return { routines, ...(leftDiff ? { leftDiff } : {}), warnings };
}

const summarize = (result: ExplorationResult): SideRun => ({
  jobId: result.jobId,
  status: result.status,
  durationMs: result.durationMs,
  ...(result.buildId ? { buildId: result.buildId } : {}),
  ...(result.buildIdSource ? { buildIdSource: result.buildIdSource } : {}),
});

const errorText = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500);

async function worker(entry: Active, pinned: PinnedRoutine[], leftDiff: DiffConfigInput | undefined): Promise<void> {
  const { state, controller } = entry;
  const { request } = state;

  const runSide = async (side: DifferentialRequest['left'], which: 'left' | 'right', routine: PinnedRoutine): Promise<ExplorationResult> => {
    const credentialSet = side.credentialSet ?? routine.credentialSet;
    const maxPerLock = await maxSessionsFor(side.targetProfile);
    return jobQueue.run(
      () =>
        runLibraryRoutine(routine.id, routine.version, {
          targetProfile: side.targetProfile,
          ...(side.credentialSet ? { credentialSet: side.credentialSet } : {}),
          ...(request.variables ? { variables: request.variables } : {}),
          ...(side.buildId ? { buildId: side.buildId } : {}),
          ...(request.profile ? { profile: request.profile } : {}),
          recordTraffic: true,
          ...(request.retention ? { retention: request.retention } : {}),
          caller: { source: 'differential', correlationId: state.differentialId, metadata: { side: which } },
        } as never),
      { priority: 'suite', lockKeys: sessionCredentialSets({ credentialSet, actors: routine.actors }), maxPerLock, signal: controller.signal },
    );
  };

  await Promise.all(
    pinned.map(async (routine, index) => {
      const pair = state.pairs[index]!;
      pair.state = 'running';
      const [left, right] = await Promise.allSettled([runSide(request.left, 'left', routine), runSide(request.right, 'right', routine)]);

      if (left.status === 'rejected' && left.reason instanceof JobCancelledError) {
        pair.state = 'pending';
        return;
      }
      if (right.status === 'rejected' && right.reason instanceof JobCancelledError) {
        pair.state = 'pending';
        return;
      }

      pair.left = left.status === 'fulfilled' ? summarize(left.value) : { error: errorText(left.reason) };
      pair.right = right.status === 'fulfilled' ? summarize(right.value) : { error: errorText(right.reason) };
      if (left.status === 'fulfilled' && right.status === 'fulfilled') {
        pair.comparison = compareRuns(left.value, right.value, request.tolerance, leftDiff);
        pair.outcome = pair.comparison.equivalent ? 'same' : 'different';
        if (!pair.comparison.equivalent) pair.lines = describeComparison(pair.comparison, state.labels);
        if (pair.comparison.timing.steps.length > 0 || pair.comparison.timing.run) pair.timeLines = describeTiming(pair.comparison, state.labels);
      } else {
        pair.outcome = 'infra-error';
        pair.error = [pair.left.error ? `left: ${pair.left.error}` : '', pair.right.error ? `right: ${pair.right.error}` : ''].filter(Boolean).join(' | ');
      }
      pair.state = 'done';
      state.counts = tally(state);
      await persist(state);
    }),
  );
}

/** Validates, starts in the background, returns the initial state. Throws DifferentialError (404/400/409) before anything runs. */
export async function startDifferential(request: DifferentialRequest): Promise<DifferentialState> {
  const { routines, leftDiff, warnings } = await validate(request);

  const state: DifferentialState = {
    differentialId: `diff_${nanoid(12)}`,
    status: 'running',
    createdAt: new Date().toISOString(),
    request: { ...request, routines: routines.map((routine) => ({ routineId: routine.id, version: routine.version })) },
    labels: { left: request.left.label ?? request.left.targetProfile, right: request.right.label ?? request.right.targetProfile },
    pairs: routines.map((routine) => ({ routineId: routine.id, version: routine.version, state: 'pending' as const })),
    counts: { total: routines.length, same: 0, different: 0, infraError: 0, notRun: routines.length },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  const entry: Active = { state, controller: new AbortController(), finished: Promise.resolve() };
  active.set(state.differentialId, entry);
  await persist(state);

  entry.finished = worker(entry, routines, leftDiff)
    .catch((error) => {
      state.error = errorText(error);
    })
    .finally(async () => {
      const cancelled = entry.controller.signal.aborted;
      state.status = cancelled ? 'cancelled' : 'completed';
      state.finishedAt = new Date().toISOString();
      state.counts = tally(state);
      Object.assign(state, verdictOf(state, cancelled));
      await persist(state);
      setTimeout(() => active.delete(state.differentialId), 60_000).unref();
    });

  return structuredClone(state);
}

export async function getDifferential(id: string): Promise<DifferentialState | undefined> {
  if (!DIFFERENTIAL_ID_PATTERN.test(id)) return undefined;
  const live = active.get(id);
  if (live) return structuredClone(live.state);
  try {
    return JSON.parse(await fs.readFile(stateFile(id), 'utf8')) as DifferentialState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function waitForDifferential(id: string, waitMs: number): Promise<DifferentialState | undefined> {
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
  return getDifferential(id);
}

/** Stops starting routines; one already running finishes. What was compared is kept. */
export async function cancelDifferential(id: string): Promise<DifferentialState | undefined> {
  const live = active.get(id);
  if (!live) return getDifferential(id);
  live.controller.abort();
  await live.finished;
  return getDifferential(id);
}

/** At startup: a state still `running` belongs to a dead process. Also prunes old files. */
export async function recoverDifferentials(): Promise<{ interrupted: number; pruned: number }> {
  const files = await fs.readdir(differentialsDir()).catch(() => [] as string[]);
  const cutoff = Date.now() - env.HISTORY_RETENTION_DAYS * 24 * 3600_000;
  let interrupted = 0;
  let pruned = 0;

  for (const file of files.filter((name) => name.endsWith('.json'))) {
    const full = path.join(differentialsDir(), file);
    const stats = await fs.stat(full).catch(() => undefined);
    if (stats && stats.mtimeMs < cutoff) {
      await fs.rm(full, { force: true });
      pruned += 1;
      continue;
    }
    const state = await getDifferential(file.slice(0, -'.json'.length)).catch(() => undefined);
    if (!state || state.status !== 'running' || active.has(state.differentialId)) continue;
    state.status = 'interrupted';
    state.finishedAt = new Date().toISOString();
    state.counts = tally(state);
    Object.assign(state, verdictOf(state, true));
    state.error = 'the server stopped before every routine was compared; the pairs that finished are kept';
    await persist(state);
    interrupted += 1;
  }
  return { interrupted, pruned };
}

// --- comparing runs that already happened ---------------------------------------------------------------------------------

async function readJob<T>(jobId: string, name: 'request.json' | 'result.json'): Promise<T | undefined> {
  const file = resolveJobFile(jobId, name);
  if (!file || !existsSync(file)) return undefined;
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}

export interface CompareJobsResult {
  left: { jobId: string; label: string; routine?: { id: string; version: number }; status: string; buildId?: string };
  right: { jobId: string; label: string; routine?: { id: string; version: number }; status: string; buildId?: string };
  verdict: DifferentialVerdict;
  comparison: DifferentialComparison;
  lines: string[];
  timeLines: string[];
  notes: string[];
}

/** Compares two runs whose evidence still exists (for example the same routine before and after a deploy). Synchronous: nothing runs. */
export async function compareJobs(request: DifferentialCompareRequest): Promise<CompareJobsResult> {
  if (request.leftJobId === request.rightJobId) throw new DifferentialError(400, 'SameRun', 'leftJobId and rightJobId are the same run');

  const load = async (jobId: string) => {
    const result = await readJob<ExplorationResult>(jobId, 'result.json');
    if (!result) throw new DifferentialError(404, 'EvidenceNotFound', `No evidence for ${jobId}: it expired (ARTIFACT_RETENTION_HOURS) or never existed`);
    const recorded = await readJob<{ targetProfile?: string }>(jobId, 'request.json');
    return { result, targetProfile: recorded?.targetProfile };
  };
  const [left, right] = await Promise.all([load(request.leftJobId), load(request.rightJobId)]);

  const notes: string[] = [];
  if (left.result.routine && right.result.routine) {
    if (left.result.routine.id !== right.result.routine.id) notes.push(`the runs are of different routines (${left.result.routine.id} and ${right.result.routine.id}); steps will not line up`);
    else if (left.result.routine.sha256 !== right.result.routine.sha256) notes.push(`the runs used different versions of ${left.result.routine.id} (v${left.result.routine.version} and v${right.result.routine.version}); a difference may come from the steps, not the application`);
  } else {
    notes.push('at least one run is not from the routine library: the comparison does not know whether the steps were the same');
  }

  const profile = left.targetProfile ? await getTarget(left.targetProfile).catch(() => undefined) : undefined;
  const comparison = compareRuns(left.result, right.result, request.tolerance as Partial<DifferentialTolerance>, profile?.diff);
  const describe = (side: typeof left) => ({
    jobId: side.result.jobId,
    label: side.targetProfile ?? side.result.targetUrl,
    ...(side.result.routine ? { routine: { id: side.result.routine.id, version: side.result.routine.version } } : {}),
    status: side.result.status,
    ...(side.result.buildId ? { buildId: side.result.buildId } : {}),
  });
  const labels = { left: describe(left).label, right: describe(right).label };
  return {
    left: describe(left),
    right: describe(right),
    verdict: comparison.equivalent ? 'same' : 'different',
    comparison,
    lines: describeComparison(comparison, labels),
    timeLines: describeTiming(comparison, labels),
    notes: [...notes, ...comparison.notes],
  };
}
