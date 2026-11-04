import fs from 'node:fs/promises';
import path from 'node:path';

import { env } from '../config/env.js';
import { metricsDir } from '../config/paths.js';
import { createMutex, writeFileAtomic } from '../storage/atomicWrite.js';
import type { PerfRecord } from './perfAnalysis.js';

/**
 * T3.4 persistence: <dataDir>/metrics/<routineId>.jsonl, one JSON line per run of a library routine (append-only; the oldest lines are dropped past
 * PERF_MAX_RECORDS). A line holds ids, times and a build id: nothing the page showed, nothing typed, no secret.
 */

const withLock = createMutex();
const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const fileOf = (routineId: string): string => path.join(metricsDir(), `${routineId}.jsonl`);

function parse(text: string): PerfRecord[] {
  const records: PerfRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as PerfRecord;
      // A hand-edited or half-written line is skipped, never fatal: the series is advice, not evidence.
      if (typeof value.jobId === 'string' && typeof value.at === 'string' && typeof value.durationMs === 'number' && Array.isArray(value.steps)) records.push(value);
    } catch {
      /* skip */
    }
  }
  return records;
}

export async function readPerfRecords(routineId: string): Promise<PerfRecord[]> {
  if (!ID.test(routineId)) return [];
  try {
    return parse(await fs.readFile(fileOf(routineId), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export function appendPerfRecord(routineId: string, record: PerfRecord, maxRecords = env.PERF_MAX_RECORDS): Promise<void> {
  if (!ID.test(routineId)) return Promise.resolve();
  return withLock(async () => {
    const file = fileOf(routineId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');

    // Trim in batches (a tenth of the cap), not on every run, so a long-lived routine is not rewritten each time.
    const records = parse(await fs.readFile(file, 'utf8'));
    if (records.length > maxRecords + Math.max(1, Math.floor(maxRecords / 10))) {
      await writeFileAtomic(file, `${records.slice(-maxRecords).map((item) => JSON.stringify(item)).join('\n')}\n`);
    }
  });
}

/** Ids of the routines that have a series. */
export async function listPerfRoutines(): Promise<string[]> {
  const files = await fs.readdir(metricsDir()).catch(() => [] as string[]);
  return files.filter((name) => name.endsWith('.jsonl')).map((name) => name.slice(0, -'.jsonl'.length)).filter((id) => ID.test(id)).sort();
}

export async function deletePerfRecords(routineId: string): Promise<void> {
  if (ID.test(routineId)) await fs.rm(fileOf(routineId), { force: true });
}
