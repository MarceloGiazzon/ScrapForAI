import fs from 'node:fs/promises';
import path from 'node:path';

import { schedulesDir } from '../config/paths.js';
import { type Schedule, scheduleSchema, type ScheduleState, scheduleStateSchema } from '../schemas/schedule.schema.js';
import { createMutex, writeFileAtomic } from '../storage/atomicWrite.js';

/** T3.2 persistence: <dataDir>/schedules/<id>.json (definition) and schedules/state/<id>.json (cursor, the run in progress, history). */

export const HISTORY_LIMIT = 100;
const withLock = createMutex();

const definitionFile = (id: string): string => path.join(schedulesDir(), `${id}.json`);
const stateFile = (id: string): string => path.join(schedulesDir(), 'state', `${id}.json`);

export interface StoredSchedule {
  schedule: Schedule;
  createdAt: string;
  updatedAt: string;
}

async function readJson(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function listSchedules(): Promise<StoredSchedule[]> {
  const files = await fs.readdir(schedulesDir()).catch(() => [] as string[]);
  const out: StoredSchedule[] = [];
  for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
    const stored = await getSchedule(file.slice(0, -'.json'.length)).catch(() => undefined);
    if (stored) out.push(stored);
  }
  return out;
}

export async function getSchedule(id: string): Promise<StoredSchedule | undefined> {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) return undefined;
  const raw = (await readJson(definitionFile(id))) as { schedule?: unknown; createdAt?: string; updatedAt?: string } | undefined;
  if (!raw) return undefined;
  const schedule = scheduleSchema.parse(raw.schedule);
  return { schedule, createdAt: raw.createdAt ?? new Date(0).toISOString(), updatedAt: raw.updatedAt ?? raw.createdAt ?? new Date(0).toISOString() };
}

/** Stores the definition. The first save starts the cursor at `now`: a new schedule never runs for the time before it existed. */
export async function putSchedule(schedule: Schedule, nowIso: string): Promise<{ stored: StoredSchedule; created: boolean }> {
  return withLock(async () => {
    const previous = await getSchedule(schedule.id);
    const stored: StoredSchedule = { schedule, createdAt: previous?.createdAt ?? nowIso, updatedAt: nowIso };
    await writeFileAtomic(definitionFile(schedule.id), `${JSON.stringify(stored, null, 2)}\n`);
    if (!(await readJson(stateFile(schedule.id)))) {
      const state: ScheduleState = { scheduleId: schedule.id, cursor: nowIso, history: [] };
      await writeFileAtomic(stateFile(schedule.id), `${JSON.stringify(state, null, 2)}\n`);
    }
    return { stored, created: previous === undefined };
  });
}

export async function deleteSchedule(id: string): Promise<boolean> {
  return withLock(async () => {
    const existed = (await getSchedule(id)) !== undefined;
    await fs.rm(definitionFile(id), { force: true });
    await fs.rm(stateFile(id), { force: true });
    return existed;
  });
}

export async function getState(id: string): Promise<ScheduleState | undefined> {
  const raw = await readJson(stateFile(id));
  return raw === undefined ? undefined : scheduleStateSchema.parse(raw);
}

/** Read-modify-write of one schedule's state under a lock, so a tick and a finishing run never overwrite each other. */
export function updateState(id: string, change: (state: ScheduleState) => void, fallbackCursor: string): Promise<ScheduleState> {
  return withLock(async () => {
    const state = (await getState(id)) ?? { scheduleId: id, cursor: fallbackCursor, history: [] };
    change(state);
    // A run that finishes after its schedule was deleted must not bring the state file back.
    if (!(await readJson(definitionFile(id)))) return state;
    if (state.history.length > HISTORY_LIMIT) state.history.splice(0, state.history.length - HISTORY_LIMIT);
    await writeFileAtomic(stateFile(id), `${JSON.stringify(state, null, 2)}\n`);
    return state;
  });
}
