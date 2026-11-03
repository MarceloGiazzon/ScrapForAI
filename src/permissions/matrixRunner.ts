import fs from 'node:fs/promises';
import path from 'node:path';

import { nanoid } from 'nanoid';

import { env } from '../config/env.js';
import { permissionsDir } from '../config/paths.js';
import { JobCancelledError } from '../orchestrator/jobQueue.js';
import { jobQueue, maxSessionsFor } from '../runner/jobSlots.js';
import { resolveExplorationRequest } from '../runner/resolveRequest.js';
import { runExploration } from '../runner/runExploration.js';
import { explorationRequestSchema } from '../schemas/explorationRequest.schema.js';
import { type MatrixRunBody, type MatrixRunState, matrixRunStateSchema } from '../schemas/permissionMatrix.schema.js';
import { createMutex, writeFileAtomic } from '../storage/atomicWrite.js';
import {
  applyExpectation,
  cellsForBrokenSession,
  classifySession,
  concludeMatrix,
  diffAgainst,
  type PlannedSession,
  planSessions,
  recount,
} from './matrixLogic.js';
import { getMatrix, PermissionMatrixError, resolveMatrixContext } from './matrixStore.js';

/**
 * T6.1 runner. A matrix run is split into browser sessions (planSessions) that go through the same job queue as
 * suites: suite priority, INTERACTIVE_RESERVED_SLOTS respected, and the credential lock, so one role (credential set)
 * is never logged in twice at once. Like a suite, it answers 202 at once and its state is written to
 * <dataDir>/permissions/runs/<runId>.json after every session.
 */

export const MATRIX_RUN_ID_PATTERN = /^perm_[A-Za-z0-9_-]{1,40}$/;
const TERMINAL: ReadonlySet<MatrixRunState['status']> = new Set(['completed', 'cancelled', 'interrupted']);

interface ActiveRun {
  state: MatrixRunState;
  controller: AbortController;
  finished: Promise<void>;
}

const active = new Map<string, ActiveRun>();
const withLock = createMutex();

function runsDir(): string {
  return path.join(permissionsDir(), 'runs');
}

function runFile(runId: string): string {
  return path.join(runsDir(), `${runId}.json`);
}

function persist(state: MatrixRunState): Promise<void> {
  recount(state);
  const snapshot = `${JSON.stringify(state, null, 2)}\n`;
  return withLock(() => writeFileAtomic(runFile(state.runId), snapshot)).catch(() => undefined);
}

function suiteSlots(): number {
  const reserved = Math.min(env.INTERACTIVE_RESERVED_SLOTS, env.MAX_PARALLEL_JOBS - 1);
  return Math.max(1, env.MAX_PARALLEL_JOBS - reserved);
}

/** The latest finished run of the same matrix on the same target profile: what this run is compared with. */
async function previousRun(matrixId: string, targetProfile: string): Promise<MatrixRunState | undefined> {
  const runs = await listMatrixRuns({ matrixId, limit: 200 });
  for (const summary of runs) {
    if (summary.status !== 'completed') continue;
    const state = await getMatrixRun(summary.runId).catch(() => undefined);
    if (state && state.targetProfile === targetProfile) return state;
  }
  return undefined;
}

export async function startMatrixRun(matrixId: string, body: MatrixRunBody): Promise<MatrixRunState> {
  const stored = await getMatrix(matrixId);
  if (!stored) {
    throw new PermissionMatrixError(404, 'PermissionMatrixNotFound', `Permission matrix "${matrixId}" does not exist`);
  }

  const context = await resolveMatrixContext(stored.matrix);
  const { matrix } = context; // with the probes generated from the screen catalogue (T6.2)
  const sessions = planSessions(matrix, {
    baseUrl: context.profile.baseUrl,
    loginRoutine: context.loginRoutine,
    loginStepCount: context.loginStepCount,
    limits: { maxStepsPerJob: env.MAX_STEPS_PER_JOB, jobTimeoutMs: env.JOB_TIMEOUT_MS, stepTimeoutMs: env.STEP_TIMEOUT_MS },
  });

  // Every session must be a valid request before anything runs (step limits, ids...): fail now, not halfway.
  for (const session of sessions) {
    const check = explorationRequestSchema.safeParse({ targetProfile: matrix.targetProfile, credentialSet: session.role, steps: session.steps });
    if (!check.success) {
      throw new PermissionMatrixError(
        400,
        'MatrixNotRunnable',
        `A session of role "${session.role}" is not a valid run: ${check.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
      );
    }
  }

  const comparedWith = await previousRun(matrixId, matrix.targetProfile);
  const state: MatrixRunState = {
    runId: `perm_${nanoid(12)}`,
    matrixId,
    matrixSha256: stored.sha256,
    matrix,
    ...(matrix.title ? { title: matrix.title } : {}),
    targetProfile: matrix.targetProfile,
    ...(body.buildId ? { buildId: body.buildId } : {}),
    status: 'running',
    createdAt: new Date().toISOString(),
    sessions: sessions.length,
    cells: matrix.roles.flatMap((role) => matrix.probes.map((probe) => ({ role, probeId: probe.id, kind: probe.kind, outcome: 'pending' as const }))),
    ...(comparedWith ? { comparedTo: { runId: comparedWith.runId, createdAt: comparedWith.createdAt, ...(comparedWith.buildId ? { buildId: comparedWith.buildId } : {}) } } : {}),
    changes: [],
    counts: { pending: 0, allowed: 0, denied: 0, error: 0, mismatches: 0, alerts: 0, unofferedAccess: 0 },
  };

  const run: ActiveRun = { state, controller: new AbortController(), finished: Promise.resolve() };
  active.set(state.runId, run);
  await persist(state);

  const maxSessions = await maxSessionsFor(matrix.targetProfile);
  run.finished = execute(run, sessions, context.loginStepCount, maxSessions, body, comparedWith)
    .catch(async (error) => {
      state.status = 'interrupted';
      state.finishedAt = new Date().toISOString();
      state.verdict = 'infra-error';
      state.verdictReason = `matrix runner failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500);
      state.exitCode = 2;
      await persist(state);
    })
    .finally(() => {
      setTimeout(() => active.delete(state.runId), 60_000).unref();
    });

  return structuredClone(state);
}

async function execute(
  run: ActiveRun,
  sessions: PlannedSession[],
  loginStepCount: number,
  maxSessions: number,
  body: MatrixRunBody,
  comparedWith: MatrixRunState | undefined,
): Promise<void> {
  const { state, controller } = run;
  const { matrix } = state;
  let cursor = 0;

  const store = (cells: ReturnType<typeof cellsForBrokenSession>) => {
    for (const cell of cells) {
      const index = state.cells.findIndex((existing) => existing.role === cell.role && existing.probeId === cell.probeId);
      if (index >= 0) state.cells[index] = applyExpectation(cell, matrix);
    }
  };

  const runOne = async (session: PlannedSession): Promise<void> => {
    try {
      const result = await jobQueue.run(
        async () => {
          const request = explorationRequestSchema.parse({
            scenarioName: `permissions ${state.matrixId} / ${session.role}${session.kind === 'action' ? ` / ${session.probes[0].id}` : ''}`,
            targetProfile: matrix.targetProfile,
            credentialSet: session.role,
            ...(body.buildId ? { buildId: body.buildId } : {}),
            caller: { source: 'permissions', correlationId: state.runId, metadata: { matrixId: state.matrixId, role: session.role } },
            options: { collectDomOnFailure: true, ...(body.retention ? { retention: body.retention } : {}) },
            steps: session.steps,
          });
          return runExploration(await resolveExplorationRequest(request));
        },
        { priority: 'suite', lockKey: session.role, maxPerLock: maxSessions, signal: controller.signal },
      );
      store(classifySession(session, result, matrix, loginStepCount));
    } catch (error) {
      if (error instanceof JobCancelledError) return;
      store(cellsForBrokenSession(session, error instanceof Error ? error.name : 'Error', error instanceof Error ? error.message : String(error)));
    }
    await persist(state);
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (controller.signal.aborted || cursor >= sessions.length) return;
      await runOne(sessions[cursor++]!);
    }
  };

  await Promise.all(Array.from({ length: Math.min(suiteSlots(), sessions.length) }, worker));

  if (comparedWith) {
    state.changes = diffAgainst(comparedWith, state.cells, matrix);
  }
  concludeMatrix(state, controller.signal.aborted);
  await persist(state);
}

export async function getMatrixRun(runId: string): Promise<MatrixRunState | undefined> {
  if (!MATRIX_RUN_ID_PATTERN.test(runId)) return undefined;
  const live = active.get(runId);
  if (live) {
    recount(live.state);
    return structuredClone(live.state);
  }
  try {
    return matrixRunStateSchema.parse(JSON.parse(await fs.readFile(runFile(runId), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function waitForMatrixRun(runId: string, waitMs: number): Promise<MatrixRunState | undefined> {
  const live = active.get(runId);
  if (live && !TERMINAL.has(live.state.status) && waitMs > 0) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([live.finished, new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]);
    clearTimeout(timer);
  }
  return getMatrixRun(runId);
}

export async function cancelMatrixRun(runId: string): Promise<MatrixRunState | undefined> {
  const live = active.get(runId);
  if (!live) return getMatrixRun(runId);
  live.controller.abort();
  await live.finished;
  return getMatrixRun(runId);
}

export interface MatrixRunSummary {
  runId: string;
  matrixId: string;
  targetProfile: string;
  buildId?: string;
  status: MatrixRunState['status'];
  verdict?: MatrixRunState['verdict'];
  exitCode?: MatrixRunState['exitCode'];
  createdAt: string;
  finishedAt?: string;
  counts: MatrixRunState['counts'];
}

export async function listMatrixRuns(filter: { matrixId?: string; limit?: number } = {}): Promise<MatrixRunSummary[]> {
  const files = await fs.readdir(runsDir()).catch(() => [] as string[]);
  const out: MatrixRunSummary[] = [];
  for (const file of files.filter((name) => name.endsWith('.json'))) {
    const state = await getMatrixRun(file.slice(0, -'.json'.length)).catch(() => undefined);
    if (!state || (filter.matrixId !== undefined && state.matrixId !== filter.matrixId)) continue;
    out.push({
      runId: state.runId,
      matrixId: state.matrixId,
      targetProfile: state.targetProfile,
      ...(state.buildId ? { buildId: state.buildId } : {}),
      status: state.status,
      ...(state.verdict ? { verdict: state.verdict } : {}),
      ...(state.exitCode === undefined ? {} : { exitCode: state.exitCode }),
      createdAt: state.createdAt,
      ...(state.finishedAt ? { finishedAt: state.finishedAt } : {}),
      counts: state.counts,
    });
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, filter.limit ?? 50);
}

/** At startup: a run left "running" by a dead process is closed as interrupted; files past HISTORY_RETENTION_DAYS are removed. */
export async function recoverMatrixRuns(): Promise<{ interrupted: number; pruned: number }> {
  const files = await fs.readdir(runsDir()).catch(() => [] as string[]);
  const cutoff = Date.now() - env.HISTORY_RETENTION_DAYS * 24 * 3600_000;
  let interrupted = 0;
  let pruned = 0;

  for (const file of files.filter((name) => name.endsWith('.json'))) {
    const full = path.join(runsDir(), file);
    const stats = await fs.stat(full).catch(() => undefined);
    if (stats && stats.mtimeMs < cutoff) {
      await fs.rm(full, { force: true });
      pruned += 1;
      continue;
    }

    const state = await getMatrixRun(file.slice(0, -'.json'.length)).catch(() => undefined);
    if (!state || state.status !== 'running' || active.has(state.runId)) continue;
    for (const cell of state.cells) {
      if (cell.outcome === 'pending') {
        Object.assign(cell, { outcome: 'error', errorType: 'ServerRestarted', errorMessage: 'The server stopped before this cell was answered' });
      }
    }
    state.status = 'interrupted';
    state.finishedAt = new Date().toISOString();
    state.verdict = 'infra-error';
    state.verdictReason = 'the server stopped before the matrix run finished';
    state.exitCode = 2;
    await persist(state);
    interrupted += 1;
  }

  return { interrupted, pruned };
}
