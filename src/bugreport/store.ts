import fs from 'node:fs/promises';
import path from 'node:path';

import { bugReportsDir } from '../config/paths.js';
import { BUG_REPORT_ID_PATTERN, type BugReport, bugReportSchema, type BugReportStatus } from '../schemas/bugReport.schema.js';
import { createMutex, writeFileAtomic } from '../storage/atomicWrite.js';

/** T9.1 persistence: <dataDir>/bug-reports/<id>.json, one file per report. What is stored is what would be sent, already cleaned. */

/** The find-or-create of a report and every change to one run under this lock, so two runs of the same failure cannot make two reports. */
export const withBugReportLock = createMutex();

const fileOf = (id: string): string => path.join(bugReportsDir(), `${id}.json`);

export async function getBugReport(id: string): Promise<BugReport | undefined> {
  if (!BUG_REPORT_ID_PATTERN.test(id)) return undefined;
  try {
    return bugReportSchema.parse(JSON.parse(await fs.readFile(fileOf(id), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export interface ListQuery {
  status?: BugReportStatus;
  limit?: number;
}

/** Newest first. A file that does not parse is skipped, never fatal. */
export async function listBugReports(query: ListQuery = {}): Promise<BugReport[]> {
  const files = await fs.readdir(bugReportsDir()).catch(() => [] as string[]);
  const reports: BugReport[] = [];
  for (const file of files.filter((name) => name.endsWith('.json'))) {
    const report = await getBugReport(file.slice(0, -'.json'.length)).catch(() => undefined);
    if (report && (!query.status || report.status === query.status)) reports.push(report);
  }
  reports.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));
  return reports.slice(0, query.limit ?? 200);
}

/** The newest report with this signature, whatever its status (the caller decides what that means). */
export async function findBySignature(hash: string): Promise<BugReport | undefined> {
  return (await listBugReports({ limit: 100_000 })).find((report) => report.signature.hash === hash);
}

/** NOT locked: call it inside `withBugReportLock`. */
export async function writeBugReport(report: BugReport): Promise<void> {
  await writeFileAtomic(fileOf(report.id), `${JSON.stringify(bugReportSchema.parse(report), null, 2)}\n`);
}
