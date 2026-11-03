import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';

import { pinJob } from '../../evidence/pin.js';
import { resolveJobFile } from '../../evidence/locate.js';
import { getRoutine } from '../../library/routineLibrary.js';
import { runRoutineInteractive, saveRoutine } from '../../library/routineService.js';
import type { ExplorationResult } from '../../schemas/explorationResult.schema.js';
import type { AddFromRun, EvidenceRef, RegressionItem } from '../../schemas/regressionItem.schema.js';
import { createItemWithEvidence, getItem, recordLastRun, setFirstGreen, VaultItemError } from './regressionVault.js';

/**
 * T2.2 RED -> GREEN flow. Evidence is never typed in: a RED is a real failing run that gets pinned, a
 * GREEN is a real passing run of the SAME routine version on a build with the fix, also pinned.
 */

async function readResult(jobId: string): Promise<ExplorationResult> {
  const file = resolveJobFile(jobId, 'result.json');
  if (!file || !existsSync(file)) {
    throw new VaultItemError(404, 'EvidenceNotFound', `No evidence for ${jobId}: it expired (ARTIFACT_RETENTION_HOURS) or never existed`);
  }
  return JSON.parse(await fs.readFile(file, 'utf8')) as ExplorationResult;
}

function evidenceRef(result: ExplorationResult, manifestSha256: string): EvidenceRef {
  return {
    jobId: result.jobId,
    at: result.finishedAt,
    ...(result.buildId === undefined ? {} : { buildId: result.buildId }),
    manifestSha256,
  };
}

/**
 * The agent has just reproduced a bug: the routine FAILS because the application misbehaves. Saves that
 * routine to the library, pins the failing run as `provenRed`, and creates the item ACTIVE.
 *
 * The routine will stay red until the bug is fixed; `firstGreen` stays null until confirm-green.
 */
export async function addFromRun(input: AddFromRun): Promise<{ item: RegressionItem; routine: { id: string; version: number }; created: boolean }> {
  if (await getItem(input.id)) {
    throw new VaultItemError(409, 'ItemExists', `Item ${input.id} already exists`);
  }

  const red = await readResult(input.fromJobId);
  if (red.status !== 'failed') {
    throw new VaultItemError(
      409,
      'JobNotRed',
      `${input.fromJobId} passed. A RED proof is a run that FAILS because the bug is present; reproduce the bug first (or create the item by hand with redNotCapturedReason).`,
    );
  }

  const routineId = input.routineId ?? input.id.toLowerCase();
  const saved = await saveRoutine(
    routineId,
    {
      fromJobId: input.fromJobId,
      title: `${input.id}: ${input.title}`.slice(0, 160),
      tags: ['regression', input.id, ...input.tags],
      surface: input.surface,
      ...(input.targetProfile ? { targetProfile: input.targetProfile } : {}),
    },
    { allowFailedJob: true },
  );

  const pin = await pinJob(input.fromJobId, { reason: `RED proof for ${input.id}`, ref: input.ledgerRef ?? input.id });

  const item = await createItemWithEvidence({
    id: input.id,
    title: input.title,
    type: input.type,
    severity: input.severity,
    status: 'ACTIVE',
    opened: new Date().toISOString().slice(0, 10),
    surface: input.surface,
    tags: input.tags,
    routine: { id: saved.routine.id, version: saved.routine.version },
    ...(input.ledgerRef ? { ledgerRef: input.ledgerRef } : {}),
    provenRed: evidenceRef(red, pin.manifestSha256),
    firstGreen: null,
    lastRun: { jobId: red.jobId, status: 'failed', at: red.finishedAt, ...(red.buildId ? { buildId: red.buildId } : {}) },
  });

  return { item, routine: { id: saved.routine.id, version: saved.routine.version }, created: saved.created };
}

export interface ItemRunOutcome {
  item: RegressionItem;
  result: Pick<ExplorationResult, 'jobId' | 'status' | 'durationMs' | 'error' | 'failedStepIndex' | 'buildId' | 'teardownStatus'>;
}

function summarize(result: ExplorationResult): ItemRunOutcome['result'] {
  return {
    jobId: result.jobId,
    status: result.status,
    durationMs: result.durationMs,
    ...(result.error ? { error: result.error } : {}),
    ...(result.failedStepIndex === undefined ? {} : { failedStepIndex: result.failedStepIndex }),
    ...(result.buildId ? { buildId: result.buildId } : {}),
    ...(result.teardownStatus ? { teardownStatus: result.teardownStatus } : {}),
  };
}

/** Runs the item's routine at the version the item pins, and records `lastRun`. */
export async function runItem(id: string, options: { buildId?: string } = {}): Promise<ItemRunOutcome> {
  const item = await getItem(id);
  if (!item) {
    throw new VaultItemError(404, 'ItemNotFound', `Item ${id} does not exist`);
  }

  const result = await runRoutineInteractive(item.routine.id, item.routine.version, { ...(options.buildId ? { buildId: options.buildId } : {}) });
  const updated = await recordLastRun(id, {
    jobId: result.jobId,
    status: result.status,
    at: result.finishedAt,
    ...(result.buildId ? { buildId: result.buildId } : {}),
  });

  return { item: updated ?? item, result: summarize(result) };
}

/**
 * Runs the item against the (fixed) build. If it PASSES, that run is pinned as `firstGreen`. If it still
 * fails, the item is left exactly as it was and the failure is reported: the fix is not there yet.
 */
export async function confirmGreen(id: string, options: { buildId?: string } = {}): Promise<ItemRunOutcome & { confirmed: boolean }> {
  const item = await getItem(id);
  if (!item) {
    throw new VaultItemError(404, 'ItemNotFound', `Item ${id} does not exist`);
  }
  if (item.firstGreen) {
    throw new VaultItemError(409, 'AlreadyConfirmed', `Item ${id} already has a firstGreen (${item.firstGreen.jobId}); it records the FIRST pass and is not overwritten`);
  }

  const routine = await getRoutine(item.routine.id, item.routine.version);
  if (!routine) {
    throw new VaultItemError(404, 'RoutineNotFound', `Routine "${item.routine.id}" v${item.routine.version} no longer exists`);
  }

  const result = await runRoutineInteractive(item.routine.id, item.routine.version, { ...(options.buildId ? { buildId: options.buildId } : {}) });

  if (result.status !== 'passed') {
    return { confirmed: false, item, result: summarize(result) };
  }

  const pin = await pinJob(result.jobId, { reason: `GREEN proof for ${id}`, ref: item.ledgerRef ?? id });
  const confirmed = await setFirstGreen(id, evidenceRef(result, pin.manifestSha256));
  const final = (await recordLastRun(id, { jobId: result.jobId, status: 'passed', at: result.finishedAt, ...(result.buildId ? { buildId: result.buildId } : {}) })) ?? confirmed;

  return { confirmed: true, item: final, result: summarize(result) };
}
