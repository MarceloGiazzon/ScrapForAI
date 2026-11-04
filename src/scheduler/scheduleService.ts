import { assertWebhooksExist } from '../integrations/webhookService.js';
import { getRoutine } from '../library/routineLibrary.js';
import { planSuite } from '../orchestrator/suiteRunner.js';
import { RequestResolutionError } from '../runner/resolutionError.js';
import { type Schedule, type ScheduleHistoryEntry, scheduleWriteSchema, type ScheduleWrite } from '../schemas/schedule.schema.js';
import { getTarget } from '../targets/targetStore.js';
import { assertTimeZone, CronError, parseCron, upcoming } from './cron.js';
import { deleteSchedule, getSchedule, getState, listSchedules, putSchedule, type StoredSchedule } from './scheduleStore.js';

export class ScheduleError extends RequestResolutionError {}

export interface ScheduleView {
  schedule: Schedule;
  createdAt: string;
  updatedAt: string;
  /** The next occurrences (ISO instants), nothing if the schedule is disabled or can never fire. */
  next: string[];
  running?: { kind: string; id: string; startedAt: string };
  lastRun?: ScheduleHistoryEntry;
  /** Counts over the history kept (the last 100 entries). */
  counts: Record<string, number>;
}

async function view(stored: StoredSchedule, nowMs: number, withHistory: boolean): Promise<ScheduleView & { history?: ScheduleHistoryEntry[] }> {
  const { schedule } = stored;
  const state = await getState(schedule.id);
  let next: string[] = [];
  try {
    next = schedule.enabled ? upcoming(parseCron(schedule.cron), nowMs, schedule.timezone, 3).map((ms) => new Date(ms).toISOString()) : [];
  } catch {
    next = [];
  }

  const counts: Record<string, number> = {};
  for (const entry of state?.history ?? []) counts[entry.outcome] = (counts[entry.outcome] ?? 0) + (entry.count ?? 1);
  const ran = (state?.history ?? []).filter((entry) => entry.outcome !== 'missed' && !entry.outcome.startsWith('skipped'));

  return {
    schedule,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    next,
    ...(state?.running ? { running: { kind: state.running.kind, id: state.running.id, startedAt: state.running.startedAt } } : {}),
    ...(ran.length > 0 ? { lastRun: ran[ran.length - 1]! } : {}),
    counts,
    ...(withHistory ? { history: [...(state?.history ?? [])].reverse() } : {}),
  };
}

export async function listScheduleViews(nowMs = Date.now()): Promise<ScheduleView[]> {
  return Promise.all((await listSchedules()).map((stored) => view(stored, nowMs, false)));
}

export async function getScheduleView(id: string, nowMs = Date.now()): Promise<(ScheduleView & { history?: ScheduleHistoryEntry[] }) | undefined> {
  const stored = await getSchedule(id);
  return stored ? view(stored, nowMs, true) : undefined;
}

/** Validates what can be checked without running anything, then stores. A bad cron, zone, routine or profile is a 400/404 here, not a silent failure at 03:00. */
export async function saveScheduleDefinition(id: string, body: unknown, nowMs = Date.now()): Promise<{ view: ScheduleView; created: boolean }> {
  const parsed = scheduleWriteSchema.parse(body);
  const schedule: Schedule = { id, ...parsed };

  try {
    assertTimeZone(schedule.timezone);
    const spec = parseCron(schedule.cron);
    if (upcoming(spec, nowMs, schedule.timezone, 1).length === 0) throw new CronError('this expression never fires (for example 31 February)');
  } catch (error) {
    if (error instanceof CronError) throw new ScheduleError(400, 'InvalidSchedule', error.message);
    throw error;
  }

  await assertWebhooksExist(schedule.notify);

  const { target } = schedule;
  switch (target.kind) {
    case 'routine': {
      const routine = await getRoutine(target.routineId, target.version);
      if (!routine) throw new ScheduleError(404, 'RoutineNotFound', `Routine "${target.routineId}" ${target.version === undefined ? 'does not exist' : `has no version ${target.version}`}`);
      break;
    }
    case 'suite':
      await planSuite(target.suite); // 404 for an unknown routine, 400 when it expands past the limit
      break;
    case 'evolutionSnapshot':
      if (!(await getTarget(target.targetProfile))) throw new ScheduleError(404, 'TargetProfileNotFound', `Target profile "${target.targetProfile}" does not exist`);
      break;
    case 'vault':
      break;
  }

  const { stored, created } = await putSchedule(schedule, new Date(nowMs).toISOString());
  return { view: await view(stored, nowMs, false), created };
}

export async function removeSchedule(id: string): Promise<boolean> {
  return deleteSchedule(id);
}

export type { ScheduleWrite };
