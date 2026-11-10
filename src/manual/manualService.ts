import fs from 'node:fs/promises';
import path from 'node:path';

import { nanoid } from 'nanoid';

import { env } from '../config/env.js';
import { manualBuildsDir } from '../config/paths.js';
import { resolveJobFile } from '../evidence/locate.js';
import { getRoutine, listRoutines } from '../library/routineLibrary.js';
import { runLibraryRoutine } from '../library/routineService.js';
import { JobCancelledError } from '../orchestrator/jobQueue.js';
import { sessionCredentialSets } from '../runner/actors.js';
import type { Initiator } from '../team/initiator.js';
import { jobQueue, maxSessionsFor } from '../runner/jobSlots.js';
import { RequestResolutionError } from '../runner/resolutionError.js';
import { DOC_TAG } from '../schemas/docStep.schema.js';
import type { ExplorationResult } from '../schemas/explorationResult.schema.js';
import { type FigureChangeSet, MANUAL_BUILD_ID_PATTERN, type ManualBuildBody, type ManualFigure, type ManualManifest } from '../schemas/manual.schema.js';
import { createMutex, writeFileAtomic } from '../storage/atomicWrite.js';
import { readFileRetry } from '../storage/transientIo.js';
import { getTarget } from '../targets/targetStore.js';
import { diffFigures } from './figureChanges.js';
import { describeFigure } from './figureHash.js';
import { type Chapter, figureFileOf, figureIdOf, type ManualModel, missingCaptionsOf, orderedChapters } from './manualModel.js';
import { renderManual } from './manualRender.js';
import { type ManualFile, readManualManifest, targetFolder, writeManual } from './manualStore.js';

/**
 * T9.2 service. A manual build runs the active routines of one target profile that are tagged `doc` -- through the same job queue as suites (suite
 * priority, one session per credential set) -- with `docFigures` on, takes the captions and figures out of the runs, and writes the manual.
 *
 * ALL OR NOTHING, like a system-evolution snapshot: if any routine fails or cannot run, NOTHING is written. A manual with the chapters of the
 * routines that passed and the old figures of the one that did not would look complete and be partly wrong. The previous build stays as it was and the
 * state says which routine failed and where.
 *
 * Starting returns at once; the state is written to <dataDir>/manual-builds/<id>.json after every routine, so a poll sees it advance and a restart
 * leaves a build `interrupted`. The routine versions are pinned when the build starts.
 */

export const MANUAL_BUILD_ID = MANUAL_BUILD_ID_PATTERN;
export class ManualError extends RequestResolutionError {}

/** Generated values (a parametric routine) are drawn from this seed, so the same routine takes the same figure on every build. */
export const MANUAL_SEED = 'manual-build';

export interface ChapterState {
  routineId: string;
  version: number;
  title: string;
  state: 'pending' | 'running' | 'done';
  outcome?: 'ok' | 'failed' | 'error';
  jobId?: string;
  durationMs?: number;
  /** Figures taken (steps that carry doc and ran). */
  figures?: number;
  error?: string;
}

export interface ManualBuildState {
  buildRunId: string;
  targetProfile: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  createdAt: string;
  finishedAt?: string;
  request: ManualBuildBody;
  routines: ChapterState[];
  /** `doc` routines of the target profile that were left out, and why. */
  skipped: Array<{ routineId: string; status: string; reason: string }>;
  /** Present once the manual was written. */
  output?: {
    folder: string;
    buildId: string;
    buildIdSource: string;
    langs: string[];
    formats: string[];
    files: number;
    removedFiles: number;
    figures: { total: number; new: number; changed: number; negligible: number; unchanged: number; removed: number };
    changes: FigureChangeSet;
    missingCaptions: number;
  };
  /** 0 = the manual was written; 2 = anything else (a routine failed, cancelled, interrupted). There is no 1: this is not a test verdict. */
  exitCode?: 0 | 2;
  reason?: string;
  warnings?: string[];
  error?: string;
}

interface Active {
  state: ManualBuildState;
  controller: AbortController;
  finished: Promise<void>;
  /** Who started the build: every routine loads its credential sets on that account. */
  initiator: Initiator;
}

const active = new Map<string, Active>();
const withLock = createMutex();
const TERMINAL: ReadonlySet<ManualBuildState['status']> = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

const stateFile = (id: string): string => path.join(manualBuildsDir(), `${id}.json`);

function persist(state: ManualBuildState): Promise<void> {
  const text = `${JSON.stringify(state, null, 2)}\n`;
  return withLock(() => writeFileAtomic(stateFile(state.buildRunId), text)).catch(() => undefined);
}

const errorText = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500);

/** A routine fixed at the version the build runs. */
interface Pinned {
  id: string;
  version: number;
  title: string;
  description?: string;
  doc?: Chapter['doc'];
  credentialSet?: string;
  actors?: Record<string, { credentialSet?: string | undefined }>;
}

/** Everything that can be checked without a browser: the profile, the routines, their status. */
async function plan(body: ManualBuildBody): Promise<{ title: string; pinned: Pinned[]; skipped: ManualBuildState['skipped'] }> {
  const profile = await getTarget(body.targetProfile);
  if (!profile) throw new ManualError(404, 'TargetNotFound', `Target profile "${body.targetProfile}" does not exist`);

  // The WHOLE manual is built every time: a build writes the chapters it has and removes the files of the ones it no longer has, so building a subset would
  // quietly delete the other chapters. Draft, quarantined and retired routines are left out and listed.
  const tagged = (await listRoutines()).filter((routine) => routine.targetProfile === body.targetProfile && routine.tags.includes(DOC_TAG));
  const skipped: ManualBuildState['skipped'] = tagged
    .filter((routine) => routine.status !== 'active')
    .map((routine) => ({ routineId: routine.id, status: routine.status, reason: `${routine.status}: only active routines are built into the manual` }));
  const wanted = tagged.filter((routine) => routine.status === 'active');

  if (wanted.length === 0) {
    throw new ManualError(404, 'NoDocRoutines', `No active routine of target profile "${body.targetProfile}" is tagged "${DOC_TAG}"; tag the routines that document the application`);
  }

  const pinned: Pinned[] = [];
  for (const summary of wanted) {
    const routine = await getRoutine(summary.id, summary.version);
    if (!routine) throw new ManualError(404, 'RoutineNotFound', `Routine "${summary.id}" disappeared`);
    pinned.push({
      id: routine.id,
      version: routine.version,
      title: routine.title,
      ...(routine.description === undefined ? {} : { description: routine.description }),
      ...(routine.doc === undefined ? {} : { doc: routine.doc }),
      ...(routine.credentialSet ? { credentialSet: routine.credentialSet } : {}),
      ...(routine.actors ? { actors: routine.actors } : {}),
    });
  }
  return { title: profile.name, pinned, skipped };
}

const failureOf = (result: ExplorationResult): string => {
  const step = result.failedStepIndex === undefined ? undefined : result.steps[result.failedStepIndex];
  return `${step?.id ? `step "${step.id}"` : result.failedStepIndex === undefined ? 'a step' : `step #${result.failedStepIndex}`}: ${result.error?.type ?? 'failed'}: ${result.error?.message ?? ''}`.slice(0, 500);
};

/** Takes the captions and the figure files out of one run. Throws ManualError on anything that would make the chapter wrong. */
async function chapterFrom(routine: Pinned, result: ExplorationResult, files: ManualFile[], figures: ManualFigure[], claimed: Map<string, string>): Promise<Chapter> {
  const documented = result.steps.filter((step) => step.doc !== undefined);
  if (documented.length === 0) {
    throw new ManualError(409, 'NoFigures', `Routine "${routine.id}" ran but took no figure: no step that carries doc ran (does it have any?)`);
  }

  const chapter: Chapter = {
    routineId: routine.id,
    version: routine.version,
    title: routine.title,
    ...(routine.description === undefined ? {} : { description: routine.description }),
    ...(routine.doc === undefined ? {} : { doc: routine.doc }),
    jobId: result.jobId,
    steps: [],
  };

  for (const step of documented) {
    const stepId = step.id;
    const doc = step.doc!;
    if (stepId === undefined) throw new ManualError(409, 'FigureWithoutId', `A documented step of "${routine.id}" has no id`);

    const shot = result.evidence.screenshots.find((item) => item.name === doc.figure);
    // Two different causes used to share one message: the run never listed the figure, or its folder/file cannot be found now.
    if (!shot) throw new ManualError(409, 'FigureMissing', `The figure of step "${stepId}" (${routine.id}) is not in the run's evidence: the run did not list a screenshot named "${doc.figure}" (job ${result.jobId})`);
    const location = resolveJobFile(result.jobId, `screenshots/${path.posix.basename(shot.path.replace(/\\/g, '/'))}`);
    if (!location) throw new ManualError(409, 'FigureMissing', `The figure of step "${stepId}" (${routine.id}) is not in the run's evidence: the run listed it but the evidence folder of ${result.jobId} cannot be found now`);
    const png = await readFileRetry(location);

    const id = figureIdOf(routine.id, stepId);
    const file = figureFileOf(routine.id, stepId);
    const other = claimed.get(file);
    if (other !== undefined) throw new ManualError(409, 'FigureNameCollision', `Steps "${other}" and "${id}" would write the same figure file (${file}); give them ids that differ in more than punctuation`);
    claimed.set(file, id);

    const description = describeFigure(png);
    figures.push({ id, routineId: routine.id, stepId, file, ...description });
    files.push({ relative: file, data: png });
    chapter.steps.push({ stepId, caption: doc.caption, figure: { id, file, width: description.width, height: description.height } });
  }
  return chapter;
}

/** The last stage: from the runs to the files on disk. Throws ManualError and writes nothing if any chapter is wrong. */
async function assemble(state: ManualBuildState, title: string, pinned: Pinned[], results: Map<string, ExplorationResult>): Promise<void> {
  const { request } = state;
  const files: ManualFile[] = [];
  const figures: ManualFigure[] = [];
  const claimed = new Map<string, string>();
  const chapters: Chapter[] = [];

  for (const routine of pinned) {
    const chapter = await chapterFrom(routine, results.get(routine.id)!, files, figures, claimed);
    state.routines.find((item) => item.routineId === routine.id)!.figures = chapter.steps.length;
    chapters.push(chapter);
  }

  const knownBuilds = [...new Set([...results.values()].map((result) => result.buildId).filter((build): build is string => build !== undefined && build !== 'unknown'))];
  const buildId = request.buildId ?? knownBuilds[0] ?? 'unknown';
  const buildIdSource = request.buildId ? 'provided' : knownBuilds.length > 0 ? ([...results.values()].find((result) => result.buildId === knownBuilds[0])?.buildIdSource ?? 'probe') : 'unknown';
  const warnings: string[] = [];
  if (request.buildId === undefined && knownBuilds.length > 1) warnings.push(`the routines reported different builds (${knownBuilds.join(', ')}); the manual is labelled ${buildId}`);
  for (const result of results.values()) {
    if (result.teardownStatus === 'failed') warnings.push(`the teardown of routine "${result.routine?.id ?? result.jobId}" failed: the application may be left in a state the next build does not expect`);
  }

  const createdAt = new Date().toISOString();
  const model: ManualModel = { targetProfile: request.targetProfile, title, buildId, createdAt, chapters };
  const previous = await readManualManifest(request.targetProfile);
  const changes = diffFigures(previous, figures);
  const missing = missingCaptionsOf(chapters, request.langs);

  const rendered = renderManual({ model, langs: request.langs, formats: request.formats, changes });
  const everyFile = [...files, ...rendered];
  const manifest: ManualManifest = {
    manualVersion: 1,
    targetProfile: request.targetProfile,
    title,
    buildId,
    buildIdSource,
    createdAt,
    langs: request.langs,
    formats: request.formats,
    routines: orderedChapters(chapters).map((chapter) => ({ id: chapter.routineId, version: chapter.version, title: chapter.title, jobId: chapter.jobId, figures: chapter.steps.length })),
    figures: figures.sort((a, b) => a.id.localeCompare(b.id)),
    changes,
    missingCaptions: missing,
    files: everyFile.map((file) => file.relative).sort(),
  };

  const removed = await writeManual(request.targetProfile, everyFile, manifest, previous);
  if (missing.length > 0) warnings.push(`${missing.length} caption(s), title(s) or introduction(s) have no text in a requested language (listed in manual.json, marked in the pages)`);

  state.output = {
    folder: targetFolder(request.targetProfile),
    buildId,
    buildIdSource,
    langs: request.langs,
    formats: request.formats,
    files: everyFile.length,
    removedFiles: removed.length,
    figures: { total: figures.length, new: changes.new.length, changed: changes.changed.length, negligible: changes.negligible.length, unchanged: changes.unchanged, removed: changes.removed.length },
    changes,
    missingCaptions: missing.length,
  };
  if (warnings.length > 0) state.warnings = [...(state.warnings ?? []), ...warnings];
}

async function worker(entry: Active, title: string, pinned: Pinned[]): Promise<void> {
  const { state, controller } = entry;
  const results = new Map<string, ExplorationResult>();
  const maxPerLock = await maxSessionsFor(state.targetProfile);

  await Promise.all(
    pinned.map(async (routine, index) => {
      const chapter = state.routines[index]!;
      chapter.state = 'running';
      try {
        const result = await jobQueue.run(
          () =>
            runLibraryRoutine(routine.id, routine.version, {
              docFigures: true,
              seed: MANUAL_SEED,
              ...(state.request.variables ? { variables: state.request.variables } : {}),
              ...(state.request.buildId ? { buildId: state.request.buildId } : {}),
              caller: { source: 'manual', correlationId: state.buildRunId },
            }, { initiator: entry.initiator }),
          { priority: 'suite', lockKeys: sessionCredentialSets({ credentialSet: routine.credentialSet, actors: routine.actors }), maxPerLock, signal: controller.signal },
        );
        results.set(routine.id, result);
        chapter.jobId = result.jobId;
        chapter.durationMs = result.durationMs;
        if (result.status === 'passed') {
          chapter.outcome = 'ok';
        } else {
          chapter.outcome = 'failed';
          chapter.error = failureOf(result);
        }
      } catch (error) {
        if (error instanceof JobCancelledError) {
          chapter.state = 'pending';
          return;
        }
        chapter.outcome = 'error';
        chapter.error = errorText(error);
      }
      chapter.state = 'done';
      await persist(state);
    }),
  );

  if (controller.signal.aborted) return;
  const bad = state.routines.filter((chapter) => chapter.outcome !== 'ok');
  if (bad.length > 0) {
    state.reason = `${bad.length} of ${state.routines.length} routine(s) did not pass (${bad.map((chapter) => chapter.routineId).join(', ')}); nothing was written, the previous manual is untouched`;
    state.status = 'failed';
    return;
  }

  try {
    await assemble(state, title, pinned, results);
    state.status = 'completed';
    state.reason = `manual written: ${state.output!.figures.total} figure(s) in ${state.routines.length} chapter(s)`;
  } catch (error) {
    state.status = 'failed';
    state.reason = `the manual could not be assembled; nothing was written: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500);
    if (!(error instanceof ManualError)) state.error = errorText(error);
  }
}

/** Validates, starts in the background, returns the initial state. Throws ManualError (404/409) before anything runs. */
export async function startManualBuild(body: ManualBuildBody, initiator: Initiator): Promise<ManualBuildState> {
  for (const running of active.values()) {
    if (running.state.targetProfile === body.targetProfile && running.state.status === 'running') {
      throw new ManualError(409, 'ManualBuildRunning', `A manual build of "${body.targetProfile}" is already running (${running.state.buildRunId})`);
    }
  }
  const { title, pinned, skipped } = await plan(body);

  const state: ManualBuildState = {
    buildRunId: `man_${nanoid(12)}`,
    targetProfile: body.targetProfile,
    status: 'running',
    createdAt: new Date().toISOString(),
    request: body,
    routines: pinned.map((routine) => ({ routineId: routine.id, version: routine.version, title: routine.title, state: 'pending' as const })),
    skipped,
  };
  const entry: Active = { state, controller: new AbortController(), finished: Promise.resolve(), initiator };
  active.set(state.buildRunId, entry);
  await persist(state);

  entry.finished = worker(entry, title, pinned)
    .catch((error) => {
      state.status = 'failed';
      state.error = errorText(error);
      state.reason = 'the build stopped on an unexpected error; nothing was written';
    })
    .finally(async () => {
      if (entry.controller.signal.aborted && state.status === 'running') {
        state.status = 'cancelled';
        state.reason = 'cancelled; nothing was written';
      }
      state.finishedAt = new Date().toISOString();
      state.exitCode = state.status === 'completed' ? 0 : 2;
      await persist(state);
      setTimeout(() => active.delete(state.buildRunId), 60_000).unref();
    });

  return structuredClone(state);
}

export async function getManualBuild(id: string): Promise<ManualBuildState | undefined> {
  if (!MANUAL_BUILD_ID.test(id)) return undefined;
  const live = active.get(id);
  if (live) return structuredClone(live.state);
  try {
    return JSON.parse(await fs.readFile(stateFile(id), 'utf8')) as ManualBuildState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function waitForManualBuild(id: string, waitMs: number): Promise<ManualBuildState | undefined> {
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
  return getManualBuild(id);
}

/** Stops starting routines; one already running finishes. Nothing is written. */
export async function cancelManualBuild(id: string): Promise<ManualBuildState | undefined> {
  const live = active.get(id);
  if (!live) return getManualBuild(id);
  live.controller.abort();
  await live.finished;
  return getManualBuild(id);
}

/** At startup: a state still `running` belongs to a dead process. Also prunes old files. */
export async function recoverManualBuilds(): Promise<{ interrupted: number; pruned: number }> {
  const files = await fs.readdir(manualBuildsDir()).catch(() => [] as string[]);
  const cutoff = Date.now() - env.HISTORY_RETENTION_DAYS * 24 * 3600_000;
  let interrupted = 0;
  let pruned = 0;

  for (const file of files.filter((name) => name.endsWith('.json'))) {
    const full = path.join(manualBuildsDir(), file);
    const stats = await fs.stat(full).catch(() => undefined);
    if (stats && stats.mtimeMs < cutoff) {
      await fs.rm(full, { force: true });
      pruned += 1;
      continue;
    }
    const state = await getManualBuild(file.slice(0, -'.json'.length)).catch(() => undefined);
    if (!state || state.status !== 'running' || active.has(state.buildRunId)) continue;
    state.status = 'interrupted';
    state.finishedAt = new Date().toISOString();
    state.exitCode = 2;
    state.reason = 'the server stopped during the build; nothing was written';
    await persist(state);
    interrupted += 1;
  }
  return { interrupted, pruned };
}

/** What the last build of a target wrote: `manual.json` plus where it is. Undefined when the target has no manual yet. */
export async function getManual(target: string): Promise<(ManualManifest & { folder: string }) | undefined> {
  const manifest = await readManualManifest(target);
  return manifest ? { ...manifest, folder: targetFolder(target) } : undefined;
}
