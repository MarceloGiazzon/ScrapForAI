import fs from 'node:fs/promises';
import path from 'node:path';

import { nanoid } from 'nanoid';

import { env } from '../config/env.js';
import { evolutionRunsDir } from '../config/paths.js';
import { resolveJobFile } from '../evidence/locate.js';
import { deriveScreenInventory, type StructureInput } from '../inventory/deriveInventory.js';
import { expandIncludes } from '../library/includeExpander.js';
import { JobCancelledError } from '../orchestrator/jobQueue.js';
import { jobQueue, maxSessionsFor } from '../runner/jobSlots.js';
import { RequestResolutionError } from '../runner/resolutionError.js';
import { resolveExplorationRequest } from '../runner/resolveRequest.js';
import { runExploration } from '../runner/runExploration.js';
import { explorationRequestSchema } from '../schemas/explorationRequest.schema.js';
import {
  SNAPSHOT_ID_PATTERN,
  type SnapshotBody,
  type SnapshotManifest,
  type SnapshotRunState,
  snapshotRunStateSchema,
} from '../schemas/evolution.schema.js';
import { validateTargetUrl } from '../security/validateTargetUrl.js';
import { createMutex, writeFileAtomic } from '../storage/atomicWrite.js';
import { getTarget } from '../targets/targetStore.js';
import {
  inventoryName,
  LOGIN_STEP_ID,
  type PlannedScreenSession,
  planSnapshotSessions,
  resolveUrl,
  screenshotName,
  screensToCapture,
  SnapshotPlanError,
  snapshotFolderName,
} from './snapshotPlan.js';
import { commitSnapshot, findSnapshotOfBuild, MANIFEST_FILE, sha256, type SnapshotFile, writeSnapshotFolder } from './snapshotStore.js';
import { readFileRetry } from '../storage/transientIo.js';

/**
 * T4.4 runner. A snapshot is split into browser sessions (planSnapshotSessions) that go through the job queue like a
 * suite: suite priority, INTERACTIVE_RESERVED_SLOTS respected and the credential lock, so one account is never logged in
 * twice at once. It answers 202 at once; its state is written to <dataDir>/evolution-runs/<snapshotId>.json.
 *
 * Nothing is written to the evolution directory until every wanted screen was captured (or `allowPartial`): a snapshot
 * with a screen missing would later read as "that screen was removed".
 */

export class SnapshotError extends RequestResolutionError {}

const TERMINAL: ReadonlySet<SnapshotRunState['status']> = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

interface ActiveRun {
  state: SnapshotRunState;
  controller: AbortController;
  finished: Promise<void>;
}

const active = new Map<string, ActiveRun>();
const withLock = createMutex();

const runFile = (snapshotId: string): string => path.join(evolutionRunsDir(), `${snapshotId}.json`);

function persist(state: SnapshotRunState): Promise<void> {
  const snapshot = `${JSON.stringify(state, null, 2)}\n`;
  return withLock(() => writeFileAtomic(runFile(state.snapshotId), snapshot)).catch(() => undefined);
}

function suiteSlots(): number {
  const reserved = Math.min(env.INTERACTIVE_RESERVED_SLOTS, env.MAX_PARALLEL_JOBS - 1);
  return Math.max(1, env.MAX_PARALLEL_JOBS - reserved);
}

type Captured = { structure: StructureInput; jobId: string; screenshotPath?: string };

export async function startSnapshot(body: SnapshotBody): Promise<SnapshotRunState> {
  const profile = await getTarget(body.targetProfile);
  if (!profile) throw new SnapshotError(404, 'TargetProfileNotFound', `Target profile "${body.targetProfile}" does not exist`);

  let sessions: PlannedScreenSession[];
  let screens;
  let loginStepCount = 0;
  try {
    screens = screensToCapture(profile, body.screens);
    for (const screen of screens) {
      if ('url' in screen.reach) {
        try {
          validateTargetUrl(resolveUrl(screen.reach.url, profile.baseUrl));
        } catch (error) {
          throw new SnapshotPlanError(`screen "${screen.id}": ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    if (profile.loginRoutine && profile.credentialSets.length > 0) {
      loginStepCount = (await expandIncludes({ steps: [{ id: LOGIN_STEP_ID, action: 'include', routineId: profile.loginRoutine }] }, { targetProfile: profile.id })).steps.length;
    }
    sessions = planSnapshotSessions(profile, screens, {
      loginStepCount,
      settleMs: Math.min(body.settleMs, env.STEP_TIMEOUT_MS),
      screenshots: body.screenshots,
      limits: { maxStepsPerJob: env.MAX_STEPS_PER_JOB, jobTimeoutMs: env.JOB_TIMEOUT_MS, stepTimeoutMs: env.STEP_TIMEOUT_MS },
    });
  } catch (error) {
    if (error instanceof SnapshotPlanError) throw new SnapshotError(400, 'SnapshotNotPlannable', error.message);
    throw error;
  }

  // Every session must be a valid request before anything runs: fail now, not halfway.
  for (const session of sessions) {
    const check = explorationRequestSchema.safeParse({
      targetProfile: profile.id,
      ...(session.credentialSet ? { credentialSet: session.credentialSet } : {}),
      steps: session.steps,
    });
    if (!check.success) {
      throw new SnapshotError(400, 'SnapshotNotRunnable', `A snapshot session is not a valid run: ${check.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
    }
  }

  if (body.buildId && !body.force) {
    const existing = await findSnapshotOfBuild(profile.id, body.buildId);
    if (existing) {
      throw new SnapshotError(409, 'SnapshotExists', `Build "${body.buildId}" already has a snapshot (${existing.folder}); pass force to replace it`);
    }
  }

  const state: SnapshotRunState = {
    snapshotId: `evo_${nanoid(12)}`,
    targetProfile: profile.id,
    ...(body.buildId ? { buildId: body.buildId, buildIdSource: 'provided' as const } : {}),
    status: 'running',
    createdAt: new Date().toISOString(),
    sessions: sessions.length,
    screens: screens.map((screen) => ({ screenId: screen.id, name: screen.name, status: 'pending' as const })),
    warnings: [],
  };

  const run: ActiveRun = { state, controller: new AbortController(), finished: Promise.resolve() };
  active.set(state.snapshotId, run);
  await persist(state);

  const maxSessions = await maxSessionsFor(profile.id);
  run.finished = execute(run, profile, sessions, maxSessions, body, loginStepCount)
    .catch(async (error) => {
      state.status = 'interrupted';
      state.finishedAt = new Date().toISOString();
      state.reason = `snapshot runner failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500);
      state.exitCode = 2;
      await persist(state);
    })
    .finally(() => {
      setTimeout(() => active.delete(state.snapshotId), 60_000).unref();
    });

  return structuredClone(state);
}

async function execute(
  run: ActiveRun,
  profile: NonNullable<Awaited<ReturnType<typeof getTarget>>>,
  sessions: PlannedScreenSession[],
  maxSessions: number,
  body: SnapshotBody,
  loginStepCount: number,
): Promise<void> {
  const { state, controller } = run;
  const captured = new Map<string, Captured>();
  let probedBuild: string | undefined;
  let cursor = 0;

  const markError = (screenId: string, type: string, message: string, jobId?: string) => {
    const entry = state.screens.find((screen) => screen.screenId === screenId);
    if (entry) Object.assign(entry, { status: 'error', errorType: type, errorMessage: message.slice(0, 500), ...(jobId ? { jobId } : {}) });
  };

  const runOne = async (session: PlannedScreenSession): Promise<void> => {
    try {
      const result = await jobQueue.run(
        async () => {
          const request = explorationRequestSchema.parse({
            scenarioName: `evolution snapshot ${profile.id}`,
            targetProfile: profile.id,
            ...(session.credentialSet ? { credentialSet: session.credentialSet } : {}),
            ...(body.buildId ? { buildId: body.buildId } : {}),
            caller: { source: 'evolution', correlationId: state.snapshotId, metadata: { target: profile.id } },
            options: { screenshots: body.screenshots ? 'always' : 'off', collectDomOnFailure: false },
            steps: session.steps,
          });
          return runExploration(await resolveExplorationRequest(request));
        },
        { priority: 'suite', ...(session.credentialSet ? { lockKey: session.credentialSet } : {}), maxPerLock: maxSessions, signal: controller.signal },
      );

      if (result.buildId && result.buildIdSource === 'probe' && !probedBuild) probedBuild = result.buildId;
      const loginFailed = loginStepCount > 0 && result.failedStepIndex !== undefined && result.failedStepIndex < loginStepCount;

      for (const screen of session.screens) {
        const structure = result.extracted[inventoryName(screen.id)];
        if (loginFailed) {
          markError(screen.id, 'LoginFailed', `the login failed: ${result.error?.message ?? 'unknown'}`, result.jobId);
          continue;
        }
        if (!structure || typeof structure !== 'object') {
          markError(screen.id, result.error?.type ?? 'NotCaptured', result.error?.message ?? 'the screen was not read (an earlier step of the session failed)', result.jobId);
          continue;
        }
        const shot = result.evidence.screenshots.find((entry) => entry.name === screenshotName(screen.id));
        captured.set(screen.id, {
          structure: structure as unknown as StructureInput,
          jobId: result.jobId,
          ...(shot ? { screenshotPath: shot.path } : {}),
        });
        const entry = state.screens.find((item) => item.screenId === screen.id);
        if (entry) Object.assign(entry, { status: 'captured', jobId: result.jobId });
      }
    } catch (error) {
      if (error instanceof JobCancelledError) return;
      for (const screen of session.screens) markError(screen.id, error instanceof Error ? error.name : 'Error', error instanceof Error ? error.message : String(error));
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

  state.finishedAt = new Date().toISOString();
  if (controller.signal.aborted) {
    state.status = 'cancelled';
    state.reason = 'cancelled before it finished; nothing was written';
    state.exitCode = 2;
    await persist(state);
    return;
  }

  // The build: what the caller said, else what the application reported (T3.1), else unknown.
  if (!state.buildId) {
    state.buildId = probedBuild ?? 'unknown';
    state.buildIdSource = probedBuild ? 'probe' : 'unknown';
  }

  const failed = state.screens.filter((screen) => screen.status !== 'captured');
  if (captured.size === 0 || (failed.length > 0 && !body.allowPartial)) {
    state.status = 'failed';
    state.reason = `${failed.length} of ${state.screens.length} screen(s) could not be captured; nothing was written (allowPartial writes the rest)`;
    state.exitCode = 2;
    await persist(state);
    return;
  }

  await finalize(state, profile, captured, body);
  await persist(state);
}

async function finalize(
  state: SnapshotRunState,
  profile: NonNullable<Awaited<ReturnType<typeof getTarget>>>,
  captured: Map<string, Captured>,
  body: SnapshotBody,
): Promise<void> {
  const buildId = state.buildId!;
  const known = buildId !== 'unknown';

  const existing = known ? await findSnapshotOfBuild(profile.id, buildId) : undefined;
  if (existing && !body.force) {
    state.status = 'failed';
    state.reason = `build "${buildId}" already has a snapshot (${existing.folder}); pass force to replace it`;
    state.exitCode = 2;
    return;
  }

  // "unknown" is never idempotent: two unknown-build snapshots must not overwrite each other.
  const name = snapshotFolderName(state.createdAt, known ? buildId : `unknown-${state.createdAt.slice(11, 19).replaceAll(':', '')}`);
  const files: SnapshotFile[] = [];
  const manifestScreens: SnapshotManifest['screens'] = [];

  for (const screen of state.screens.filter((item) => item.status === 'captured')) {
    const data = captured.get(screen.screenId)!;
    try {
      const inventory = deriveScreenInventory(data.structure, { screenId: screen.screenId, title: screen.name, ...(profile.diff ? { config: profile.diff } : {}) });
      const inventoryText = `${JSON.stringify(inventory, null, 2)}\n`;
      files.push({ relative: `screens/${screen.screenId}.json`, data: inventoryText });
      const entry: SnapshotManifest['screens'][number] = {
        id: screen.screenId,
        name: screen.name,
        inventory: `screens/${screen.screenId}.json`,
        inventorySha256: sha256(inventoryText),
        jobId: data.jobId,
      };
      Object.assign(screen, { counts: { fields: inventory.fields.length, actions: inventory.actions.length, grids: inventory.grids.length, unkeyed: inventory.unkeyed } });

      if (body.screenshots) {
        const absolute = data.screenshotPath ? resolveJobFile(data.jobId, `screenshots/${path.basename(data.screenshotPath)}`) : undefined;
        let image: Buffer | undefined;
        let why = data.screenshotPath ? 'its evidence folder is gone (expired or pruned)' : "the run's evidence has no screenshot of it";
        if (absolute) {
          try {
            image = await readFileRetry(absolute);
          } catch (error) {
            why = `${(error as NodeJS.ErrnoException).code ?? 'read error'} on ${path.basename(absolute)}`;
          }
        }
        if (image) {
          files.push({ relative: `screens/${screen.screenId}.png`, data: image });
          entry.screenshot = `screens/${screen.screenId}.png`;
          entry.screenshotSha256 = sha256(image);
          screen.screenshot = true;
        } else {
          state.warnings.push(`screen "${screen.screenId}": no screenshot was kept (${why})`);
        }
      }
      manifestScreens.push(entry);
    } catch (error) {
      markFailed(state, screen.screenId, 'InventoryFailed', error instanceof Error ? error.message : String(error));
    }
  }

  if (manifestScreens.length === 0) {
    state.status = 'failed';
    state.reason = 'no screen produced an inventory; nothing was written';
    state.exitCode = 2;
    return;
  }

  const stillFailed = state.screens.filter((item) => item.status !== 'captured');
  if (stillFailed.length > 0 && !body.allowPartial) {
    state.status = 'failed';
    state.reason = `${stillFailed.length} screen(s) could not be turned into an inventory; nothing was written`;
    state.exitCode = 2;
    return;
  }

  const manifest: SnapshotManifest = {
    schemaVersion: 1,
    targetProfile: profile.id,
    environment: profile.environment,
    buildId,
    buildIdSource: state.buildIdSource ?? 'unknown',
    createdAt: state.createdAt,
    screenshots: body.screenshots,
    complete: stillFailed.length === 0,
    screens: manifestScreens.sort((a, b) => (a.id < b.id ? -1 : 1)),
    notCaptured: stillFailed.map((item) => ({ id: item.screenId, reason: `${item.errorType ?? 'NotCaptured'}: ${item.errorMessage ?? ''}`.trim().slice(0, 300) })),
  };
  files.push({ relative: MANIFEST_FILE, data: `${JSON.stringify(manifest, null, 2)}\n` });

  await writeSnapshotFolder(profile.id, name, files, existing ? [existing.name] : []);
  state.folder = `${profile.id}/${name}`;
  state.git = await commitSnapshot(profile.id, `evolution(${profile.id}): ${buildId}${manifest.complete ? '' : ' (partial)'}`);
  if (state.git.repository && !state.git.committed && state.git.note && state.git.note !== 'nothing to commit') state.warnings.push(state.git.note);
  state.status = 'completed';
  state.exitCode = manifest.complete ? 0 : 2;
  if (!manifest.complete) state.reason = `partial: ${stillFailed.length} screen(s) not captured`;
}

function markFailed(state: SnapshotRunState, screenId: string, type: string, message: string): void {
  const entry = state.screens.find((screen) => screen.screenId === screenId);
  if (entry) Object.assign(entry, { status: 'error', errorType: type, errorMessage: message.slice(0, 500) });
}

export async function getSnapshotRun(snapshotId: string): Promise<SnapshotRunState | undefined> {
  if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) return undefined;
  const live = active.get(snapshotId);
  if (live) return structuredClone(live.state);
  try {
    return snapshotRunStateSchema.parse(JSON.parse(await fs.readFile(runFile(snapshotId), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function waitForSnapshotRun(snapshotId: string, waitMs: number): Promise<SnapshotRunState | undefined> {
  const live = active.get(snapshotId);
  if (live && !TERMINAL.has(live.state.status) && waitMs > 0) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([live.finished, new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]);
    clearTimeout(timer);
  }
  return getSnapshotRun(snapshotId);
}

export async function cancelSnapshotRun(snapshotId: string): Promise<SnapshotRunState | undefined> {
  const live = active.get(snapshotId);
  if (!live) return getSnapshotRun(snapshotId);
  live.controller.abort();
  await live.finished;
  return getSnapshotRun(snapshotId);
}

/** At startup: a snapshot left "running" by a dead process is closed as interrupted (nothing was written to the folder); old run files are pruned. */
export async function recoverSnapshotRuns(): Promise<{ interrupted: number; pruned: number }> {
  const dir = evolutionRunsDir();
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  const cutoff = Date.now() - env.HISTORY_RETENTION_DAYS * 24 * 3600_000;
  let interrupted = 0;
  let pruned = 0;
  for (const file of files.filter((name) => name.endsWith('.json'))) {
    const full = path.join(dir, file);
    const stats = await fs.stat(full).catch(() => undefined);
    if (stats && stats.mtimeMs < cutoff) {
      await fs.rm(full, { force: true });
      pruned += 1;
      continue;
    }
    const state = await getSnapshotRun(file.slice(0, -'.json'.length)).catch(() => undefined);
    if (!state || state.status !== 'running' || active.has(state.snapshotId)) continue;
    state.status = 'interrupted';
    state.finishedAt = new Date().toISOString();
    state.reason = 'the server stopped before the snapshot finished; nothing was written';
    state.exitCode = 2;
    await persist(state);
    interrupted += 1;
  }
  return { interrupted, pruned };
}
