import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { env } from '../config/env.js';
import { historyDir } from '../config/paths.js';
import { runSummarySchema, type RunSummary } from './runSummary.js';

/**
 * Append-only JSONL index of exploration runs.
 *
 * Layout: <dataDir>/history/runs.jsonl — one JSON object per line, oldest first.
 *
 * The whole file is read into memory once at startup. With HISTORY_MAX_RUNS at 5000 and
 * ~500 bytes per record that is ~2.5 MB, so filtering and pagination are plain array
 * operations. See docs/PRODUCTIZATION-PLAN.md §1.5 for why this is not SQLite, and for the
 * threshold at which it should become SQLite.
 *
 * Single-process only: appends assume no concurrent writer.
 */

let runs: RunSummary[] = [];
const byId = new Map<string, RunSummary>();
let initialized = false;
let initPromise: Promise<void> | undefined;

function historyFilePath(): string {
  return path.join(historyDir(), 'runs.jsonl');
}

async function loadFromDisk(): Promise<void> {
  await fs.mkdir(historyDir(), { recursive: true });

  const filePath = historyFilePath();
  if (!existsSync(filePath)) {
    runs = [];
    byId.clear();
    return;
  }

  const raw = await fs.readFile(filePath, 'utf8');
  const loaded: RunSummary[] = [];
  let corruptLines = 0;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const parsed = runSummarySchema.safeParse(JSON.parse(trimmed));
      if (parsed.success) {
        loaded.push(parsed.data);
      } else {
        corruptLines += 1;
      }
    } catch {
      // A partially-written final line is expected after an unclean shutdown. Skipping it
      // is correct: never abort startup because the history file has a bad tail.
      corruptLines += 1;
    }
  }

  runs = loaded;
  byId.clear();
  for (const run of runs) {
    byId.set(run.jobId, run);
  }

  if (corruptLines > 0) {
    process.stderr.write(`[history] skipped ${corruptLines} unreadable line(s) in runs.jsonl\n`);
  }
}

/** Idempotent; safe to call from multiple entry points. */
export async function initRunHistory(): Promise<void> {
  if (initialized) {
    return;
  }

  initPromise ??= loadFromDisk().then(() => {
    initialized = true;
  });

  await initPromise;
}

/**
 * Records one run. Never throws: a history failure must not fail an otherwise good job.
 */
export async function appendRun(summary: RunSummary): Promise<void> {
  try {
    await initRunHistory();

    runs.push(summary);
    byId.set(summary.jobId, summary);

    await fs.appendFile(historyFilePath(), `${JSON.stringify(summary)}\n`, 'utf8');

    // Compact only when meaningfully over budget, so this is not a per-run cost.
    if (runs.length > env.HISTORY_MAX_RUNS * 1.1) {
      await pruneHistory();
    }
  } catch (error) {
    process.stderr.write(`[history] failed to record run ${summary.jobId}: ${String(error)}\n`);
  }
}

export interface ListRunsQuery {
  status?: 'passed' | 'failed';
  scenario?: string;
  /** ISO date-time; inclusive lower bound on startedAt. */
  since?: string;
  /** ISO date-time; inclusive upper bound on startedAt. */
  until?: string;
  /** Case-insensitive substring over scenarioName, targetUrl and jobId. */
  q?: string;
  limit?: number;
  offset?: number;
}

export interface ListRunsResult {
  total: number;
  limit: number;
  offset: number;
  items: RunSummary[];
}

export async function listRuns(query: ListRunsQuery = {}): Promise<ListRunsResult> {
  await initRunHistory();

  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const offset = Math.max(query.offset ?? 0, 0);
  const needle = query.q?.trim().toLowerCase();

  const filtered = runs.filter((run) => {
    if (query.status && run.status !== query.status) {
      return false;
    }
    if (query.scenario && run.scenarioName !== query.scenario) {
      return false;
    }
    if (query.since && run.startedAt < query.since) {
      return false;
    }
    if (query.until && run.startedAt > query.until) {
      return false;
    }
    if (needle) {
      const haystack = `${run.scenarioName ?? ''} ${run.targetUrl} ${run.jobId}`.toLowerCase();
      if (!haystack.includes(needle)) {
        return false;
      }
    }
    return true;
  });

  // Stored oldest-first; the UI wants newest-first.
  filtered.reverse();

  return {
    total: filtered.length,
    limit,
    offset,
    items: filtered.slice(offset, offset + limit),
  };
}

export async function getRun(jobId: string): Promise<RunSummary | undefined> {
  await initRunHistory();
  return byId.get(jobId);
}

/** Distinct scenario names, for the UI filter dropdown. */
export async function listScenarioNames(): Promise<string[]> {
  await initRunHistory();

  const names = new Set<string>();
  for (const run of runs) {
    if (run.scenarioName) {
      names.add(run.scenarioName);
    }
  }

  return [...names].sort();
}

export interface HistoryStats {
  totalRuns: number;
  passedRuns: number;
  failedRuns: number;
  oldestRunAt?: string;
  newestRunAt?: string;
  retentionDays: number;
  maxRuns: number;
}

export async function historyStats(): Promise<HistoryStats> {
  await initRunHistory();

  let passed = 0;
  for (const run of runs) {
    if (run.status === 'passed') {
      passed += 1;
    }
  }

  return {
    totalRuns: runs.length,
    passedRuns: passed,
    failedRuns: runs.length - passed,
    oldestRunAt: runs[0]?.startedAt,
    newestRunAt: runs[runs.length - 1]?.startedAt,
    retentionDays: env.HISTORY_RETENTION_DAYS,
    maxRuns: env.HISTORY_MAX_RUNS,
  };
}

/**
 * Enforces HISTORY_RETENTION_DAYS and HISTORY_MAX_RUNS, then rewrites the file.
 *
 * Rewrite is atomic: write a temp file, then rename over the original. A crash mid-prune
 * therefore leaves the previous good file intact.
 */
export async function pruneHistory(): Promise<{ removed: number; kept: number }> {
  await initRunHistory();

  const before = runs.length;
  const cutoff = new Date(Date.now() - env.HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  let kept = runs.filter((run) => run.startedAt >= cutoff);
  if (kept.length > env.HISTORY_MAX_RUNS) {
    kept = kept.slice(kept.length - env.HISTORY_MAX_RUNS);
  }

  if (kept.length === before) {
    return { removed: 0, kept: before };
  }

  const filePath = historyFilePath();
  const tempPath = `${filePath}.tmp`;
  const payload = kept.map((run) => `${JSON.stringify(run)}\n`).join('');

  await fs.writeFile(tempPath, payload, 'utf8');
  await fs.rename(tempPath, filePath);

  runs = kept;
  byId.clear();
  for (const run of runs) {
    byId.set(run.jobId, run);
  }

  return { removed: before - kept.length, kept: kept.length };
}

/** Test-only: drops in-memory state so the next call reloads from disk. */
export function resetRunHistoryForTests(): void {
  runs = [];
  byId.clear();
  initialized = false;
  initPromise = undefined;
}
