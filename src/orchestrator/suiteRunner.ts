import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { nanoid } from 'nanoid';

import { env } from '../config/env.js';
import { suitesDir } from '../config/paths.js';
import { expandIncludes } from '../library/includeExpander.js';
import { getRoutine } from '../library/routineLibrary.js';
import { runLibraryRoutine } from '../library/routineService.js';
import { jobQueue, maxSessionsFor } from '../runner/jobSlots.js';
import { RequestResolutionError } from '../runner/resolutionError.js';
import type { ExplorationResult } from '../schemas/explorationResult.schema.js';
import { someStep } from '../schemas/stepTree.js';
import { type SuiteRequest, type SuiteState, suiteStateSchema, type VariantState } from '../schemas/suiteRequest.schema.js';
import { createMutex, writeFileAtomic } from '../storage/atomicWrite.js';
import { listItems, recordLastRun } from '../vault/regression/regressionVault.js';
import { orderByImpact } from '../vault/regression/impact.js';
import { sessionCredentialSets } from '../runner/actors.js';
import { JobCancelledError } from './jobQueue.js';
import { attemptMetadata, runAttempts } from './retry.js';

/**
 * T1.6 suite runner. A suite is a list of saved routines multiplied by credential sets and target
 * profiles. Starting one returns at once (202) with an id; the work happens in the background and the
 * state is written to <dataDir>/suites/<id>.json after every change, so it survives polling, long
 * runs and (as `interrupted`) a server restart.
 */

export const SUITE_ID_PATTERN = /^suite_[A-Za-z0-9_-]{1,40}$/;
const MAX_VARIANTS = 500;
const TERMINAL: ReadonlySet<SuiteState['status']> = new Set(['completed', 'cancelled', 'interrupted']);

export class SuiteError extends RequestResolutionError {}

interface PlannedVariant {
  state: VariantState;
  /** What the run is started with. Absent fields mean "the routine's own". */
  credentialSet?: string;
  targetProfile?: string;
  /** T5.4: which sample of its parameters this run takes (parametric routines only, and only when the suite asks for `samples`). */
  sample?: number;
  /** Concurrency domain for the single-session rule: the credential set this variant will really use. */
  lockKey?: string;
  /** T6.4: one more session per declared actor that has a credential set; held together with `lockKey`. */
  actorLockKeys: string[];
  maxSessions: number;
}

interface ActiveSuite {
  state: SuiteState;
  controller: AbortController;
  finished: Promise<void>;
}

const active = new Map<string, ActiveSuite>();
const withLock = createMutex();

function suiteFile(id: string): string {
  return path.join(suitesDir(), `${id}.json`);
}

function recount(state: SuiteState): void {
  const counts = { pending: 0, running: 0, passed: 0, failed: 0, error: 0, notRun: 0 };
  for (const variant of state.variants) {
    counts[variant.status] += 1;
  }
  state.counts = counts;
}

function persist(state: SuiteState): Promise<void> {
  recount(state);
  const snapshot = `${JSON.stringify(state, null, 2)}\n`;
  return withLock(() => writeFileAtomic(suiteFile(state.suiteRunId), snapshot)).catch(() => undefined);
}

/** A readable, unique-per-suite label such as `crud-ventas@v2/cred:gam-admin/target:qa`. */
function variantKeyFor(routineId: string, pinnedVersion: number | undefined, credentialSet?: string, targetProfile?: string): string {
  return [
    pinnedVersion === undefined ? routineId : `${routineId}@v${pinnedVersion}`,
    credentialSet === undefined ? undefined : `cred:${credentialSet}`,
    targetProfile === undefined ? undefined : `target:${targetProfile}`,
  ]
    .filter(Boolean)
    .join('/');
}

interface Source {
  routineId: string;
  /** Pinned in the variantKey only when the author pinned it. */
  keyVersion?: number;
  version?: number;
  keyBase?: string;
  vaultItemId?: string;
  /** T3.5: the regression-vault item is QUARANTINED (the routine itself may be active). */
  quarantined?: boolean;
  order?: { position: number; reasons: string[] };
}

/** Turns the suite's items into concrete (routine, version) sources, in the order they will run. */
async function sourcesFor(request: SuiteRequest): Promise<Source[]> {
  const sources: Source[] = [];

  for (const item of request.items) {
    if ('routineId' in item) {
      sources.push({ routineId: item.routineId, version: item.version, keyVersion: item.version });
      continue;
    }

    const items = await listItems({ status: item.vault.status ?? ['ACTIVE'], type: item.vault.type, tags: item.vault.tags, surface: item.vault.surface });
    if (items.length === 0) {
      throw new SuiteError(404, 'SuiteItemNotFound', 'No regression-vault item matches the vault filter of this suite');
    }

    const ordered =
      request.order === 'impact'
        ? await orderByImpact(items, request.impact)
        : items.map((entry, index) => ({ item: entry, position: index + 1, reasons: [] as Array<{ detail: string }> }));

    for (const entry of ordered) {
      sources.push({
        routineId: entry.item.routine.id,
        version: entry.item.routine.version,
        keyBase: entry.item.id,
        vaultItemId: entry.item.id,
        ...(entry.item.status === 'QUARANTINED' ? { quarantined: true } : {}),
        ...(request.order === 'impact' ? { order: { position: entry.position, reasons: entry.reasons.map((reason) => reason.detail) } } : {}),
      });
    }
  }

  return sources;
}

/** Expands the suite into the concrete runs (items x credential sets x target profiles). Exported for tests. */
export async function planSuite(request: SuiteRequest): Promise<PlannedVariant[]> {
  const credentialSets: Array<string | undefined> = request.variants?.credentialSets ?? [undefined];
  const targetProfiles: Array<string | undefined> = request.variants?.targetProfiles ?? [undefined];

  if (request.items.length * credentialSets.length * targetProfiles.length > MAX_VARIANTS) {
    throw new SuiteError(400, 'SuiteTooLarge', `The suite expands to more than ${MAX_VARIANTS} runs; split it`);
  }

  const sources = await sourcesFor(request);
  if (sources.length * credentialSets.length * targetProfiles.length > MAX_VARIANTS) {
    throw new SuiteError(400, 'SuiteTooLarge', `The suite expands to more than ${MAX_VARIANTS} runs; split it`);
  }

  const planned: PlannedVariant[] = [];
  const seenKeys = new Map<string, number>();
  const parametricCache = new Map<string, boolean>();

  for (const source of sources) {
    const routine = await getRoutine(source.routineId, source.version);
    if (!routine) {
      throw new SuiteError(
        404,
        'SuiteItemNotFound',
        source.version === undefined ? `Routine "${source.routineId}" does not exist` : `Routine "${source.routineId}" has no version ${source.version}`,
      );
    }

    // T5.4: only a routine that draws values is multiplied by `samples`; the rest runs once.
    const cacheKey = `${routine.id}@${routine.version}`;
    if (request.samples !== undefined && !parametricCache.has(cacheKey)) {
      parametricCache.set(cacheKey, await isParametric(routine));
    }
    const samples: Array<number | undefined> =
      request.samples !== undefined && parametricCache.get(cacheKey) ? Array.from({ length: request.samples }, (_, index) => index) : [undefined];

    for (const credentialSet of credentialSets) {
      for (const targetProfile of targetProfiles) {
        for (const sample of samples) {
          let key =
            source.keyBase === undefined
              ? variantKeyFor(routine.id, source.keyVersion, credentialSet, targetProfile)
              : variantKeyFor(source.keyBase, undefined, credentialSet, targetProfile);
          if (sample !== undefined) {
            key = `${key}/sample:${sample}`;
          }
          const seen = (seenKeys.get(key) ?? 0) + 1;
          seenKeys.set(key, seen);
          if (seen > 1) {
            key = `${key}#${seen}`; // the same item listed twice
          }

          const effectiveCredential = credentialSet ?? routine.credentialSet;
          const effectiveProfile = targetProfile ?? routine.targetProfile;
          const skipped = !request.statuses.includes(routine.status);
          // T3.5: pinned now, like the version. A skipped variant is "not run", not "quarantined".
          const quarantined = !skipped && (routine.status === 'quarantined' || source.quarantined === true);

          planned.push({
            // Pinned HERE: the version that is current now is the one every variant of this suite runs.
            state: {
              variantKey: key,
              routineId: routine.id,
              routineVersion: routine.version,
              ...(source.vaultItemId ? { vaultItemId: source.vaultItemId } : {}),
              ...(source.order ? { order: source.order } : {}),
              ...(effectiveCredential === undefined ? {} : { credentialSet: effectiveCredential }),
              targetProfile: effectiveProfile,
              ...(sample === undefined ? {} : { sample }),
              ...(quarantined ? { quarantined: true } : {}),
              status: skipped ? 'notRun' : 'pending',
              ...(skipped ? { notRunReason: `routine status is "${routine.status}"; this suite runs: ${request.statuses.join(', ')}` } : {}),
            },
            ...(credentialSet === undefined ? {} : { credentialSet }),
            ...(targetProfile === undefined ? {} : { targetProfile }),
            ...(sample === undefined ? {} : { sample }),
            ...(effectiveCredential === undefined ? {} : { lockKey: effectiveCredential }),
            actorLockKeys: sessionCredentialSets({ actors: routine.actors }),
            maxSessions: await maxSessionsFor(effectiveProfile),
          });
        }
      }
    }

    if (planned.length > MAX_VARIANTS) {
      throw new SuiteError(400, 'SuiteTooLarge', `The suite expands to more than ${MAX_VARIANTS} runs (samples included); split it`);
    }
  }

  return planned;
}

type StepList = Array<Record<string, unknown>>;
// Inside a `parallel` block too (T6.5).
const drawsValues = (steps: StepList): boolean => someStep(steps, (step) => step.valueFromParameter !== undefined || step.valueFromGenerator !== undefined);

/** Does running this routine draw any generated value (own parameters, inline generators, or those of an included routine)? */
async function isParametric(routine: NonNullable<Awaited<ReturnType<typeof getRoutine>>>): Promise<boolean> {
  if ((routine.parameters?.length ?? 0) > 0) {
    return true;
  }

  const steps = routine.steps as unknown as StepList;
  const teardown = (routine.teardown ?? []) as unknown as StepList;
  if (drawsValues(steps) || drawsValues(teardown)) {
    return true;
  }
  if (!someStep([...steps, ...teardown], (step) => step.action === 'include')) {
    return false;
  }

  try {
    const expanded = await expandIncludes({ steps: routine.steps, teardown: routine.teardown }, { targetProfile: routine.targetProfile });
    return expanded.parameters.length > 0 || drawsValues(expanded.steps as unknown as StepList) || drawsValues(expanded.teardown as unknown as StepList);
  } catch {
    return false; // the run itself will report why the includes cannot be expanded, once
  }
}

const MAX_EXTRACTED_KEYS = 20;
const MAX_EXTRACTED_CHARS = 200;

/** A short, flat copy of what a run extracted, for the samples table: not the evidence (that is the run's own). */
function compactExtracted(extracted: Record<string, unknown> | undefined): Record<string, string> | undefined {
  const entries = Object.entries(extracted ?? {}).slice(0, MAX_EXTRACTED_KEYS);
  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    entries.map(([name, value]) => {
      const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
      return [name, text.length > MAX_EXTRACTED_CHARS ? `${text.slice(0, MAX_EXTRACTED_CHARS)}…` : text];
    }),
  );
}

function suiteSlots(): number {
  const reserved = Math.min(env.INTERACTIVE_RESERVED_SLOTS, env.MAX_PARALLEL_JOBS - 1);
  return Math.max(1, env.MAX_PARALLEL_JOBS - reserved);
}

function tally(variants: VariantState[]): { passed: number; failed: number; error: number; notRun: number } {
  const counts = { passed: 0, failed: 0, error: 0, notRun: 0 };
  for (const variant of variants) {
    if (variant.status === 'passed' || variant.status === 'failed' || variant.status === 'error' || variant.status === 'notRun') counts[variant.status] += 1;
  }
  return counts;
}

/**
 * The verdict is the verdict of the variants that COUNT: a quarantined one (T3.5) ran and is reported, but a known-unstable routine going red
 * must not turn the suite red, and one going green must not make it green. What it did is in `quarantine` and in the reason.
 */
export function concludeSuite(state: SuiteState, cancelled: boolean): void {
  state.finishedAt = new Date().toISOString();
  state.status = cancelled ? 'cancelled' : 'completed';
  state.teardownFailures = state.variants.filter((variant) => variant.teardownStatus === 'failed').length;

  const counted = state.variants.filter((variant) => !variant.quarantined);
  const quarantined = state.variants.filter((variant) => variant.quarantined);
  const counts = tally(counted);
  const ran = counts.passed + counts.failed + counts.error;

  const retried = counted.filter((variant) => variant.passedOnRetry).length;
  if (retried > 0) state.passedOnRetry = retried;
  else delete state.passedOnRetry;

  if (quarantined.length > 0) {
    const apart = tally(quarantined);
    state.quarantine = { total: quarantined.length, ...apart };
  } else {
    delete state.quarantine;
  }

  const notes = [
    retried > 0 ? `${retried} passed only on a new attempt` : undefined,
    state.quarantine && state.quarantine.failed + state.quarantine.error > 0
      ? `${state.quarantine.failed + state.quarantine.error} of ${state.quarantine.total} quarantined run(s) did not pass (not counted)`
      : undefined,
  ].filter((note): note is string => note !== undefined);
  const suffix = notes.length > 0 ? ` (${notes.join('; ')})` : '';

  if (cancelled) {
    state.verdict = 'infra-error';
    state.verdictReason = 'the suite was cancelled';
  } else if (counts.error > 0) {
    state.verdict = 'infra-error';
    state.verdictReason = `${counts.error} run(s) could not be executed${suffix}`;
  } else if (counts.failed > 0) {
    state.verdict = 'red';
    state.verdictReason = `${counts.failed} of ${ran} run(s) failed${suffix}`;
  } else if (ran === 0) {
    // Nothing was verified, so "green" would be a lie.
    state.verdict = 'infra-error';
    state.verdictReason = quarantined.length > 0 ? 'no run that counts was executed (only quarantined routines ran, and they do not count)' : 'no run was executed (every variant was skipped)';
  } else {
    state.verdict = 'green';
    state.verdictReason = `${counts.passed} of ${ran} run(s) passed${suffix}`;
  }

  state.exitCode = state.verdict === 'green' ? 0 : state.verdict === 'red' ? 1 : 2;
}

async function execute(suite: ActiveSuite, planned: PlannedVariant[]): Promise<void> {
  const { state, controller } = suite;
  const request = state.request;
  const concurrency = request.mode === 'parallel' ? Math.min(request.concurrency ?? suiteSlots(), suiteSlots()) : 1;
  let cursor = 0;
  let stoppedBy: string | undefined;

  const runOne = async (entry: PlannedVariant): Promise<void> => {
    const variant = entry.state;
    variant.status = 'running';
    variant.startedAt = new Date().toISOString();
    await persist(state);

    try {
      // T3.5: a failed run may be tried once more (only when the request asks, and never for a quarantined variant or a parametric sample).
      const retries = variant.quarantined || entry.sample !== undefined ? 0 : (request.retries ?? 0);
      const attempted = await runAttempts<ExplorationResult>(
        (attempt, previous) =>
          jobQueue.run(
            () =>
              runLibraryRoutine(
                variant.routineId,
                variant.routineVersion,
                {
                  ...(entry.credentialSet === undefined ? {} : { credentialSet: entry.credentialSet }),
                  ...(entry.targetProfile === undefined ? {} : { targetProfile: entry.targetProfile }),
                  ...(request.retention === undefined ? {} : { retention: request.retention }),
                  ...(request.profile === undefined ? {} : { profile: request.profile }),
                  ...(request.buildId === undefined ? {} : { buildId: request.buildId }),
                  // T5.4: every sample draws from the suite's one seed, so any row of the table replays alone.
                  ...(entry.sample === undefined ? {} : { seed: state.seed, sample: entry.sample }),
                  caller: { source: 'suite', correlationId: state.suiteRunId, metadata: { variantKey: variant.variantKey, ...attemptMetadata(attempt, previous) } },
                },
                { suite: { suiteRunId: state.suiteRunId, variantKey: variant.variantKey } },
              ),
            { priority: 'suite', lockKey: entry.lockKey, lockKeys: entry.actorLockKeys, maxPerLock: entry.maxSessions, signal: controller.signal },
          ),
        { retries, canRetry: () => !controller.signal.aborted && stoppedBy === undefined },
      );
      const result = attempted.results[attempted.results.length - 1]!;

      if (attempted.results.length > 1) {
        variant.attempts = attempted.results.map((attempt, index) => ({
          attempt: index + 1,
          jobId: attempt.jobId,
          status: attempt.status === 'passed' ? ('passed' as const) : ('failed' as const),
          durationMs: attempt.durationMs,
          ...(attempt.status !== 'passed' ? { failedStepIndex: attempt.failedStepIndex, errorType: attempt.error?.type, errorMessage: attempt.error?.message.slice(0, 500) } : {}),
        }));
        if (result.status === 'passed') variant.passedOnRetry = true;
      }

      variant.jobId = result.jobId;
      variant.status = result.status === 'passed' ? 'passed' : 'failed';
      variant.durationMs = result.durationMs;
      variant.teardownStatus = result.teardownStatus;
      if (result.parameters) {
        variant.sample ??= result.parameters.sample;
        variant.parameters = result.parameters.values;
        if (result.parameters.synthetic) variant.synthetic = result.parameters.synthetic;
        const extracted = compactExtracted(result.extracted);
        if (extracted) variant.extracted = extracted;
      }
      if (result.status !== 'passed') {
        variant.failedStepIndex = result.failedStepIndex;
        variant.errorType = result.error?.type;
        variant.errorMessage = result.error?.message.slice(0, 500);
        if (attempted.retryError !== undefined) {
          // The failure stands (it is the only result), and the reader is told why there is no second attempt.
          const reason = attempted.retryError instanceof Error ? attempted.retryError.message : String(attempted.retryError);
          variant.errorMessage = `${variant.errorMessage ?? ''} [the new attempt could not run: ${reason}]`.trim().slice(0, 500);
        }
      }
    } catch (error) {
      if (error instanceof JobCancelledError) {
        variant.status = 'notRun';
        variant.notRunReason = 'cancelled';
      } else {
        // The run could not happen (credential refused, vault unreadable, profile gone, job timeout...).
        variant.status = 'error';
        variant.errorType = error instanceof Error ? error.name : 'Error';
        variant.errorMessage = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      }
    }

    variant.finishedAt = new Date().toISOString();
    if (variant.vaultItemId && variant.jobId && (variant.status === 'passed' || variant.status === 'failed')) {
      // The vault item remembers its latest outcome. Best effort: a missing item must not fail the suite.
      await recordLastRun(variant.vaultItemId, {
        jobId: variant.jobId,
        status: variant.status,
        at: variant.finishedAt,
        ...(request.buildId ? { buildId: request.buildId } : {}),
      }).catch(() => undefined);
    }
    if (variant.status === 'failed' || variant.status === 'error') {
      // A quarantined routine failing is what quarantine is for: it must not stop the suite.
      if (request.failFast && !variant.quarantined) {
        stoppedBy ??= variant.variantKey;
      }
    }
    await persist(state);
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (controller.signal.aborted || stoppedBy !== undefined || cursor >= planned.length) {
        return;
      }

      const entry = planned[cursor++]!;
      if (entry.state.status === 'pending') {
        await runOne(entry);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));

  const cancelled = controller.signal.aborted;
  for (const entry of planned) {
    if (entry.state.status === 'pending') {
      entry.state.status = 'notRun';
      entry.state.notRunReason = cancelled ? 'cancelled' : `failFast: ${stoppedBy} did not pass`;
    }
  }

  recount(state);
  concludeSuite(state, cancelled);
  await persist(state);
}

/**
 * Validates and expands the suite, records it, starts it in the background and returns its initial
 * state. Throws SuiteError (404 for an unknown routine, nothing runs) before any run starts.
 */
export async function startSuite(request: SuiteRequest): Promise<SuiteState> {
  const planned = await planSuite(request);

  const state: SuiteState = {
    suiteRunId: `suite_${nanoid(12)}`,
    name: request.name,
    status: 'running',
    createdAt: new Date().toISOString(),
    request,
    ...(request.samples !== undefined || request.seed !== undefined ? { seed: request.seed ?? randomBytes(6).toString('hex') } : {}),
    total: planned.length,
    counts: { pending: 0, running: 0, passed: 0, failed: 0, error: 0, notRun: 0 },
    variants: planned.map((entry) => entry.state),
  };

  const suite: ActiveSuite = { state, controller: new AbortController(), finished: Promise.resolve() };
  active.set(state.suiteRunId, suite);
  await persist(state);

  suite.finished = execute(suite, planned)
    .catch(async (error) => {
      // A bug in the runner itself: never leave a suite "running" forever.
      state.status = 'interrupted';
      state.finishedAt = new Date().toISOString();
      state.verdict = 'infra-error';
      state.verdictReason = `suite runner failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500);
      state.exitCode = 2;
      for (const variant of state.variants) {
        if (variant.status === 'pending' || variant.status === 'running') {
          variant.status = 'notRun';
          variant.notRunReason = 'suite runner failed';
        }
      }
      await persist(state);
    })
    .finally(() => {
      // Kept in memory a while so pollers read the final state without touching the disk.
      setTimeout(() => active.delete(state.suiteRunId), 60_000).unref();
    });

  return structuredClone(state);
}

export async function getSuite(id: string): Promise<SuiteState | undefined> {
  if (!SUITE_ID_PATTERN.test(id)) {
    return undefined;
  }

  const live = active.get(id);
  if (live) {
    recount(live.state);
    return structuredClone(live.state);
  }

  try {
    return suiteStateSchema.parse(JSON.parse(await fs.readFile(suiteFile(id), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/** Long poll: resolves when the suite ends or after `waitMs`, whichever is first. */
export async function waitForSuite(id: string, waitMs: number): Promise<SuiteState | undefined> {
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

  return getSuite(id);
}

/**
 * Stops starting new variants and drops the ones still waiting in the queue. A run already in the
 * browser finishes (it is not interrupted mid-step); everything not started is listed as not run.
 */
export async function cancelSuite(id: string): Promise<SuiteState | undefined> {
  const live = active.get(id);
  if (!live) {
    return getSuite(id);
  }

  live.controller.abort();
  await live.finished;
  return getSuite(id);
}

export interface SuiteSummary {
  suiteRunId: string;
  name: string;
  status: SuiteState['status'];
  verdict?: SuiteState['verdict'];
  exitCode?: SuiteState['exitCode'];
  createdAt: string;
  finishedAt?: string;
  total: number;
  counts: SuiteState['counts'];
}

export async function listSuites(limit = 50): Promise<SuiteSummary[]> {
  const files = await fs.readdir(suitesDir()).catch(() => [] as string[]);
  const summaries: SuiteSummary[] = [];

  for (const file of files.filter((name) => name.endsWith('.json'))) {
    const state = await getSuite(file.slice(0, -'.json'.length)).catch(() => undefined);
    if (state) {
      summaries.push({
        suiteRunId: state.suiteRunId,
        name: state.name,
        status: state.status,
        ...(state.verdict === undefined ? {} : { verdict: state.verdict }),
        ...(state.exitCode === undefined ? {} : { exitCode: state.exitCode }),
        createdAt: state.createdAt,
        ...(state.finishedAt === undefined ? {} : { finishedAt: state.finishedAt }),
        total: state.total,
        counts: state.counts,
      });
    }
  }

  return summaries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, limit);
}

/**
 * At startup: a state file still saying "running" belongs to a process that no longer exists, so it is
 * closed as `interrupted` (an infrastructure error, exit 2) instead of lying forever. Also removes
 * suite files older than HISTORY_RETENTION_DAYS.
 */
export async function recoverSuites(): Promise<{ interrupted: number; pruned: number }> {
  const files = await fs.readdir(suitesDir()).catch(() => [] as string[]);
  const cutoff = Date.now() - env.HISTORY_RETENTION_DAYS * 24 * 3600_000;
  let interrupted = 0;
  let pruned = 0;

  for (const file of files.filter((name) => name.endsWith('.json'))) {
    const full = path.join(suitesDir(), file);
    const stats = await fs.stat(full).catch(() => undefined);
    if (stats && stats.mtimeMs < cutoff) {
      await fs.rm(full, { force: true });
      pruned += 1;
      continue;
    }

    const state = await getSuite(file.slice(0, -'.json'.length)).catch(() => undefined);
    if (!state || state.status !== 'running' || active.has(state.suiteRunId)) {
      continue;
    }

    for (const variant of state.variants) {
      if (variant.status === 'running') {
        variant.status = 'error';
        variant.errorType = 'ServerRestarted';
        variant.errorMessage = 'The server stopped while this run was in progress';
      } else if (variant.status === 'pending') {
        variant.status = 'notRun';
        variant.notRunReason = 'server restarted';
      }
    }

    state.status = 'interrupted';
    state.finishedAt = new Date().toISOString();
    state.verdict = 'infra-error';
    state.verdictReason = 'the server stopped before the suite finished';
    state.exitCode = 2;
    await persist(state);
    interrupted += 1;
  }

  return { interrupted, pruned };
}
