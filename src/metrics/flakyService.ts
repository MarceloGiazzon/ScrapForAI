import { env } from '../config/env.js';
import { getRoutine } from '../library/routineLibrary.js';
import { analyzeFlakiness, type FlakyAnalysis, type FlakyConfig, type FlakySuggestion, suggestionFor } from './flakyAnalysis.js';
import { listPerfRoutines, readPerfRecords } from './perfStore.js';

/** T3.5 read side: the flakiness of a routine over the series T3.4 already records, with its current status and what to propose. */

export function flakyConfig(): FlakyConfig {
  return { window: env.FLAKY_WINDOW, minRuns: env.FLAKY_MIN_RUNS, threshold: env.FLAKY_THRESHOLD };
}

export interface RoutineFlakiness extends FlakyAnalysis {
  routineId: string;
  /** The routine's status NOW (current version). Absent when the routine no longer exists. */
  status?: 'draft' | 'active' | 'quarantined' | 'retired';
  suggestion?: FlakySuggestion;
  thresholds: FlakyConfig;
}

export interface FlakyQuery {
  version?: number;
  profile?: 'full' | 'functional';
  env?: string;
}

/** undefined = the routine has no series at all. */
export async function getRoutineFlakiness(routineId: string, query: FlakyQuery = {}): Promise<RoutineFlakiness | undefined> {
  const records = await readPerfRecords(routineId);
  if (records.length === 0) return undefined;

  const config = flakyConfig();
  const select = { ...(query.version === undefined ? {} : { version: query.version }), ...(query.profile ? { profile: query.profile } : {}), ...(query.env ? { env: query.env } : {}) };
  const analysis = analyzeFlakiness(records, config, select);
  const routine = await getRoutine(routineId).catch(() => undefined);
  const suggestion = routine ? suggestionFor(routine.status, analysis, config) : undefined;

  return { routineId, thresholds: config, ...(routine ? { status: routine.status } : {}), ...analysis, ...(suggestion ? { suggestion } : {}) };
}

/** One line per routine with a series, the ones with something to say first (a suggestion, then the highest score). */
export async function listFlakiness(): Promise<Array<Omit<RoutineFlakiness, 'populations' | 'results'>>> {
  const out: Array<Omit<RoutineFlakiness, 'populations' | 'results'>> = [];
  for (const routineId of await listPerfRoutines()) {
    const found = await getRoutineFlakiness(routineId);
    if (!found || found.runs === 0) continue;
    const { populations: _populations, results: _results, ...summary } = found;
    out.push(summary);
  }
  return out.sort((a, b) => Number(b.suggestion !== undefined) - Number(a.suggestion !== undefined) || (b.score ?? -1) - (a.score ?? -1) || a.routineId.localeCompare(b.routineId));
}
