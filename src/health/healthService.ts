import { listRoutines } from '../library/routineLibrary.js';
import { analyzeFlakiness, suggestionFor } from '../metrics/flakyAnalysis.js';
import { flakyConfig } from '../metrics/flakyService.js';
import { analyzeRoutine } from '../metrics/perfAnalysis.js';
import { alertsOf, perfConfig } from '../metrics/perfService.js';
import { readPerfRecords } from '../metrics/perfStore.js';
import { getScheduler } from '../scheduler/runtime.js';
import { listScheduleViews } from '../scheduler/scheduleService.js';
import { listTargets } from '../targets/targetStore.js';
import { listItems } from '../vault/regression/regressionVault.js';
import { buildHealth, type HealthReport, type RoutineHealthInput, type ScheduleInput, type VaultItemInput } from './healthAnalysis.js';

/** T3.7 read side: gathers what T3.2/T3.4/T3.5 and the regression vault already store and hands it to the pure `buildHealth`. Read-only. */

async function routineInputs(): Promise<RoutineHealthInput[]> {
  const flaky = flakyConfig();
  const perf = perfConfig();
  const out: RoutineHealthInput[] = [];

  for (const routine of await listRoutines()) {
    const records = await readPerfRecords(routine.id);
    const latest = records.reduce<(typeof records)[number] | undefined>((best, record) => (best === undefined || record.at >= best.at ? record : best), undefined);

    const lastFailed = records.reduce<(typeof records)[number] | undefined>((best, record) => (record.status === 'failed' && (best === undefined || record.at >= best.at) ? record : best), undefined);

    const flakiness = records.length > 0 ? analyzeFlakiness(records, flaky) : undefined;
    const suggestion = flakiness ? suggestionFor(routine.status, flakiness, flaky) : undefined;
    const analysis = records.length > 0 ? analyzeRoutine(records, perf, { limit: 1, select: {} }) : undefined;

    out.push({
      id: routine.id,
      title: routine.title,
      version: routine.version,
      status: routine.status,
      targetProfile: routine.targetProfile,
      ...(latest ? { lastRun: { jobId: latest.jobId, at: latest.at, status: latest.status, ...(latest.buildId ? { buildId: latest.buildId } : {}) } } : {}),
      ...(lastFailed ? { lastFailedRun: { jobId: lastFailed.jobId, at: lastFailed.at, ...(lastFailed.buildId ? { buildId: lastFailed.buildId } : {}) } } : {}),
      results: flakiness?.results.map((result) => result.status) ?? [],
      ...(flakiness?.score === undefined ? {} : { flakyScore: flakiness.score }),
      flaky: flakiness?.flaky === true,
      ...(suggestion ? { suggestion } : {}),
      slower: analysis ? alertsOf(routine.id, analysis).map((alert) => ({ series: alert.series, ...(alert.ratio === undefined ? {} : { ratio: alert.ratio }), ...(alert.suspectBuild ? { suspectBuild: alert.suspectBuild } : {}) })) : [],
    });
  }
  return out;
}

async function vaultInputs(): Promise<VaultItemInput[]> {
  return (await listItems()).map((item) => ({
    id: item.id,
    title: item.title,
    status: item.status,
    severity: item.severity,
    surface: item.surface,
    routineId: item.routine.id,
    ...(item.lastRun ? { lastRun: item.lastRun } : {}),
  }));
}

async function scheduleInputs(): Promise<ScheduleInput[]> {
  return (await listScheduleViews()).map((view) => {
    const { target } = view.schedule;
    return {
      id: view.schedule.id,
      enabled: view.schedule.enabled,
      cron: view.schedule.cron,
      timezone: view.schedule.timezone,
      target: {
        kind: target.kind,
        ...(target.kind === 'routine' ? { routineId: target.routineId, ...(target.targetProfile ? { targetProfile: target.targetProfile } : {}) } : {}),
        ...(target.kind === 'evolutionSnapshot' ? { targetProfile: target.targetProfile } : {}),
      },
      next: view.next,
      running: view.running !== undefined,
      ...(view.lastRun ? { lastRun: { outcome: view.lastRun.outcome, at: view.lastRun.finishedAt ?? view.lastRun.firedAt ?? view.lastRun.at, ...(view.lastRun.passedOnRetry ? { passedOnRetry: true } : {}), ...(view.lastRun.run ? { run: { kind: view.lastRun.run.kind, id: view.lastRun.run.id } } : {}) } } : {}),
      notify: view.schedule.notify.length,
    };
  });
}

export async function getHealth(now = new Date()): Promise<HealthReport> {
  const [targets, routines, vault, schedules] = await Promise.all([listTargets(), routineInputs(), vaultInputs(), scheduleInputs()]);
  return buildHealth({
    now: now.toISOString(),
    schedulerRunning: getScheduler() !== undefined,
    targets: targets.map((target) => ({ id: target.id, name: target.name, environment: target.environment })),
    routines,
    vault,
    schedules,
  });
}
