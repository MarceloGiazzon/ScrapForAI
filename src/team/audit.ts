import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { auditDir } from '../config/paths.js';

/**
 * T10.1 audit log: who did what, in `<dataDir>/audit/audit.jsonl`, one JSON object per line.
 *
 *  - Append-only and hash-chained: each line carries `seq`, `prev` (the `hash` of the line before) and its own `hash` (SHA-256 of the line
 *    without `hash`). Editing a line, or removing one from the middle, breaks the chain at that point; `verifyAudit` walks it.
 *    NOT detected: cutting lines off the END (nothing after them points back), and an attacker who rewrites the whole file and the chain. The
 *    chain is a tamper-evident log for honest operations, not a witness against whoever owns the data directory (compare Signed evidence).
 *  - What is recorded is the request line, never its content: method, path WITHOUT the query, status, the person (id, role, how they signed in,
 *    which key), the address, and the ids the answer created (`jobId`, `suiteRunId`, ...). No body, no header, no key, no value of a credential.
 *  - Reads (GET) are not recorded; changes, sign-ins, refusals and failed sign-ins are.
 *  - It never prunes itself. A failed write prints `[audit]` on stderr and does NOT fail the request (a full disk must not take the service
 *    down). That missing line is NOT visible in the chain (the next line simply follows the last one written), so watch for the stderr line.
 */

export interface AuditActor {
  userId: string;
  role: string;
  via: 'bearer' | 'session';
  keyId?: string;
}

export interface AuditInput {
  /** Absent when nobody could be identified (a failed sign-in). */
  actor?: AuditActor | undefined;
  event: string;
  ip?: string | undefined;
  method?: string | undefined;
  /** Without the query string. */
  path?: string | undefined;
  status?: number | undefined;
  /** First segment after /v1: credentials, targets, explorations... */
  area?: string | undefined;
  /** Ids the answer created, so "who ran what" can be followed to the evidence. */
  refs?: Record<string, string> | undefined;
  /** Small, non-secret facts a route adds (a role that was granted, a key id that was revoked). */
  detail?: Record<string, string | number | boolean> | undefined;
}

export interface AuditEntry extends AuditInput {
  seq: number;
  at: string;
  prev: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);
const FAILED_AUTH_PER_MINUTE = 60;
export const REF_KEYS = ['jobId', 'suiteRunId', 'runId', 'buildRunId', 'shrinkId', 'differentialId', 'snapshotId', 'reportId', 'id'] as const;

const auditFile = (): string => path.join(auditDir(), 'audit.jsonl');

let head: { seq: number; hash: string } | undefined;
let chain: Promise<unknown> = Promise.resolve();
let failedWindow = { minute: 0, count: 0, dropped: 0 };

const hashOf = (entry: Omit<AuditEntry, 'hash'>): string => crypto.createHash('sha256').update(JSON.stringify(entry), 'utf8').digest('hex');

/** The last line's seq and hash. Reads only the tail of the file. */
async function readHead(): Promise<{ seq: number; hash: string }> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(auditFile(), 'r');
    const { size } = await handle.stat();
    if (size === 0) return { seq: 0, hash: GENESIS };
    const length = Math.min(size, 64 * 1024);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n').filter((line) => line.trim() !== '');
    const last = lines.at(-1);
    const parsed = last ? (JSON.parse(last) as AuditEntry) : undefined;
    if (!parsed || typeof parsed.seq !== 'number' || typeof parsed.hash !== 'string') throw new Error('the last line of the audit log is not readable');
    return { seq: parsed.seq, hash: parsed.hash };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { seq: 0, hash: GENESIS };
    throw error;
  } finally {
    await handle?.close();
  }
}

/** True when a failed-sign-in line may be written now (a flood of wrong keys must not fill the disk). */
function failedAuthAllowed(): boolean {
  const minute = Math.floor(Date.now() / 60_000);
  if (failedWindow.minute !== minute) failedWindow = { minute, count: 0, dropped: failedWindow.dropped };
  if (failedWindow.count >= FAILED_AUTH_PER_MINUTE) {
    failedWindow.dropped += 1;
    return false;
  }
  failedWindow.count += 1;
  return true;
}

/** Never throws. Lines are written one after the other, in the order they were asked for. */
export function appendAudit(input: AuditInput): Promise<void> {
  if (input.event === 'auth.failed' && !failedAuthAllowed()) return Promise.resolve();
  const write = async (): Promise<void> => {
    try {
      head ??= await readHead();
      const base: Omit<AuditEntry, 'hash'> = {
        seq: head.seq + 1,
        at: new Date().toISOString(),
        prev: head.hash,
        event: input.event,
        ...(input.actor ? { actor: input.actor } : {}),
        ...(input.ip ? { ip: input.ip } : {}),
        ...(input.method ? { method: input.method } : {}),
        ...(input.path ? { path: input.path } : {}),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.area ? { area: input.area } : {}),
        ...(input.refs && Object.keys(input.refs).length > 0 ? { refs: input.refs } : {}),
        ...(input.detail && Object.keys(input.detail).length > 0 ? { detail: input.detail } : {}),
      };
      const entry: AuditEntry = { ...base, hash: hashOf(base) };
      await fs.mkdir(auditDir(), { recursive: true });
      await fs.appendFile(auditFile(), `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
      head = { seq: entry.seq, hash: entry.hash };
    } catch (error) {
      head = undefined; // read the file again next time: what is on disk is the truth
      process.stderr.write(`[audit] could not write an entry (${(error as Error).message})\n`);
    }
  };
  const queued = chain.then(write, write);
  chain = queued;
  return queued;
}

export interface AuditQuery {
  limit?: number;
  /** Only entries with seq below this (paging backwards). */
  before?: number;
  user?: string;
  method?: string;
  area?: string;
  event?: string;
  since?: string;
}

async function* lines(): AsyncGenerator<string> {
  try {
    await fs.access(auditFile());
  } catch {
    return;
  }
  const reader = readline.createInterface({ input: createReadStream(auditFile(), { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of reader) if (line.trim() !== '') yield line;
}

/** Newest first. Reads the whole file (a log of a team is small); `limit` is capped at 1000. */
export async function readAudit(query: AuditQuery = {}): Promise<{ entries: AuditEntry[]; hasMore: boolean }> {
  await chain.catch(() => undefined);
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000);
  const matches: AuditEntry[] = [];
  for await (const line of lines()) {
    let entry: AuditEntry;
    try {
      entry = JSON.parse(line) as AuditEntry;
    } catch {
      continue; // a damaged line is for verifyAudit to report
    }
    if (query.before !== undefined && entry.seq >= query.before) continue;
    if (query.user !== undefined && entry.actor?.userId !== query.user) continue;
    if (query.method !== undefined && entry.method?.toUpperCase() !== query.method.toUpperCase()) continue;
    if (query.area !== undefined && entry.area !== query.area) continue;
    if (query.event !== undefined && entry.event !== query.event) continue;
    if (query.since !== undefined && entry.at < query.since) continue;
    matches.push(entry);
  }
  matches.reverse();
  return { entries: matches.slice(0, limit), hasMore: matches.length > limit };
}

export interface AuditVerification {
  ok: boolean;
  entries: number;
  lastSeq: number;
  lastHash: string;
  problems: Array<{ seq: number | null; problem: string }>;
}

/** Walks the chain from the first line: sequence without gaps, each `prev` the hash before it, each `hash` the line's own. */
export async function verifyAudit(): Promise<AuditVerification> {
  await chain.catch(() => undefined);
  const problems: AuditVerification['problems'] = [];
  let expectedSeq = 1;
  let previous = GENESIS;
  let entries = 0;
  let lastHash = GENESIS;
  const note = (seq: number | null, problem: string): void => {
    if (problems.length < 20) problems.push({ seq, problem });
  };

  for await (const line of lines()) {
    entries += 1;
    let entry: AuditEntry;
    try {
      entry = JSON.parse(line) as AuditEntry;
    } catch {
      note(null, `line ${entries} is not valid JSON`);
      continue;
    }
    const { hash, ...rest } = entry;
    if (entry.seq !== expectedSeq) note(entry.seq, `expected seq ${expectedSeq}: lines were removed or inserted here`);
    if (entry.prev !== previous) note(entry.seq, 'does not follow the line before it');
    if (hash !== hashOf(rest)) note(entry.seq, 'its content does not match its hash: the line was edited');
    expectedSeq = entry.seq + 1;
    previous = hash;
    lastHash = hash;
  }
  return { ok: problems.length === 0, entries, lastSeq: expectedSeq - 1, lastHash, problems };
}

/** Failed sign-in lines dropped because of the per-minute budget (so a flood is visible even though it is not all written). */
export const droppedFailedAuthEntries = (): number => failedWindow.dropped;

/** Tests only. */
export function resetAuditForTests(): void {
  head = undefined;
  chain = Promise.resolve();
  failedWindow = { minute: 0, count: 0, dropped: 0 };
}
