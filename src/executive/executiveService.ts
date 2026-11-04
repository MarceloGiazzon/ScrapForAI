import { env } from '../config/env.js';
import { readPinnedManifests } from '../evidence/chain.js';
import { checkSignature } from '../evidence/signature.js';
import { readPublicKeyIfPresent } from '../evidence/signingKey.js';
import { getHealth } from '../health/healthService.js';
import { listRoutines } from '../library/routineLibrary.js';
import { listFlakiness } from '../metrics/flakyService.js';
import { readPerfRecords } from '../metrics/perfStore.js';
import { listItems } from '../vault/regression/regressionVault.js';
import { buildExecutive, type ExecPinInput, type ExecRoutineInput, type ExecVaultInput, type ExecutiveReport } from './executiveAnalysis.js';

/** T9.4 read side: gathers what T3.4/T3.5/T3.7, the regression vault and the pinned evidence already store and hands it to the pure `buildExecutive`. Read-only. */

export interface ExecutiveQuery {
  /** End of the period (default now). */
  to?: Date;
  days?: number;
  weeks?: number;
  targets?: string[];
}

/** Pinned, passing runs and whether their signature checks. Never creates a signing key: no key, nothing is "signed". */
async function pinInputs(): Promise<ExecPinInput[]> {
  const { entries } = await readPinnedManifests();
  const candidates = entries.filter((entry) => entry.manifest.context?.status === 'passed' && entry.manifest.context.buildId !== undefined && entry.manifest.signature !== undefined);
  if (candidates.length === 0) return [];
  const key = await readPublicKeyIfPresent();
  return candidates.map((entry) => ({
    jobId: entry.jobId,
    status: 'passed' as const,
    ...(entry.manifest.context?.routine ? { routineId: entry.manifest.context.routine.id } : {}),
    ...(entry.manifest.context?.buildId ? { buildId: entry.manifest.context.buildId } : {}),
    signed: key !== undefined && checkSignature(entry.manifest, key.publicKeyPem).status === 'valid',
  }));
}

export async function getExecutive(query: ExecutiveQuery = {}): Promise<ExecutiveReport> {
  const to = query.to ?? new Date();
  const [health, routines, flaky, items, pins] = await Promise.all([getHealth(to), listRoutines(), listFlakiness(), listItems(), pinInputs()]);

  const unstable = new Set(flaky.filter((item) => item.flaky || item.suggestion?.action === 'quarantine').map((item) => item.routineId));
  const series: ExecRoutineInput[] = [];
  for (const routine of routines) {
    series.push({ id: routine.id, title: routine.title, status: routine.status, targetProfile: routine.targetProfile, unstable: unstable.has(routine.id), records: await readPerfRecords(routine.id) });
  }

  const vault: ExecVaultInput[] = items.map((item) => ({
    id: item.id,
    status: item.status,
    routineId: item.routine.id,
    guarded: item.firstGreen !== null,
    ...(item.lastRun ? { lastRun: { status: item.lastRun.status, at: item.lastRun.at, ...(item.lastRun.buildId ? { buildId: item.lastRun.buildId } : {}) } } : {}),
  }));

  return buildExecutive({
    now: to.toISOString(),
    days: query.days ?? 30,
    weeks: query.weeks ?? 8,
    ...(query.targets ? { targets: query.targets } : {}),
    health,
    routines: series,
    vault,
    pins,
    perfCap: env.PERF_MAX_RECORDS,
  });
}
