import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { caseTableDir } from '../config/paths.js';
import { createMutex, writeFileAtomic } from '../storage/atomicWrite.js';
import { canonicalize } from '../util/canonicalJson.js';
import { z } from 'zod';
import { CaseTableError, parseCaseTable, type ParsedTable } from './caseTable.js';

/**
 * T5.5: the library of tables of cases, on disk like the routine library:
 *
 *   <caseTableDir>/<id>/v<N>.json     immutable, one per distinct content
 *   <caseTableDir>/<id>/current.json  { "version": N } pointer to the latest version
 *
 * The CSV text is kept as the person wrote it (only the line ends and a BOM are normalized), so a diff in git shows what they changed.
 * `columns` and `rowCount` are derived and re-checked on read; the digest covers the id, the title and the CSV, so a version edited by
 * hand fails its integrity check (500), exactly like a routine.
 */

export class CaseTableLibraryError extends Error {
  constructor(
    readonly status: number,
    name: string,
    message: string,
    readonly details?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = name;
  }
}

export const tableIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);

export const tableContentSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    csv: z.string().min(1),
  })
  .strict();
export type TableContent = z.infer<typeof tableContentSchema>;

const storedTableSchema = z
  .object({
    id: tableIdSchema,
    version: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    title: z.string().optional(),
    csv: z.string(),
    columns: z.array(z.string()),
    rowCount: z.number().int().nonnegative(),
    createdBy: z.string().optional(),
    createdAt: z.string(),
  })
  .strict();
export type StoredTable = z.infer<typeof storedTableSchema>;

export interface TableSummary {
  id: string;
  version: number;
  title?: string;
  columns: string[];
  rowCount: number;
  sha256: string;
  createdAt: string;
}

const withLock = createMutex();

/** Line ends and a BOM are not content: the same table saved from two editors is one version. */
export const normalizeCsv = (csv: string): string => `${csv.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\n+$/, '')}\n`;

export function tableDigest(id: string, content: TableContent): string {
  return createHash('sha256').update(JSON.stringify(canonicalize({ id, ...content }))).digest('hex');
}

function tableDir(id: string): string {
  if (!tableIdSchema.safeParse(id).success) throw new CaseTableLibraryError(400, 'ValidationError', 'Table id must match [a-zA-Z0-9_-]{1,80}');
  return path.join(caseTableDir(), id);
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function currentVersion(dir: string): Promise<number | undefined> {
  const pointer = (await readJson(path.join(dir, 'current.json'))) as { version?: unknown } | undefined;
  return typeof pointer?.version === 'number' ? pointer.version : undefined;
}

async function readVersion(id: string, dir: string, version: number): Promise<StoredTable | undefined> {
  const raw = await readJson(path.join(dir, `v${version}.json`));
  if (raw === undefined) return undefined;
  const table = storedTableSchema.parse(raw);
  const content: TableContent = { ...(table.title === undefined ? {} : { title: table.title }), csv: table.csv };
  if (table.id !== id || table.version !== version || tableDigest(id, content) !== table.sha256) {
    throw new CaseTableLibraryError(500, 'TableIntegrityError', `Table "${id}" v${version} does not match its recorded sha256 (edited or corrupted)`);
  }
  return table;
}

/** The requested version, or the current one when `version` is omitted. */
export async function getTable(id: string, version?: number): Promise<StoredTable | undefined> {
  const dir = tableDir(id);
  const wanted = version ?? (await currentVersion(dir));
  return wanted === undefined ? undefined : readVersion(id, dir, wanted);
}

export async function listVersions(id: string): Promise<number[]> {
  const files = await fs.readdir(tableDir(id)).catch(() => [] as string[]);
  return files
    .map((name) => /^v(\d+)\.json$/.exec(name)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

export async function listTables(): Promise<TableSummary[]> {
  const entries = await fs.readdir(caseTableDir(), { withFileTypes: true }).catch(() => []);
  const out: TableSummary[] = [];
  for (const entry of entries.filter((item) => item.isDirectory() && tableIdSchema.safeParse(item.name).success)) {
    const table = await getTable(entry.name).catch(() => undefined);
    if (table) {
      out.push({
        id: table.id,
        version: table.version,
        ...(table.title === undefined ? {} : { title: table.title }),
        columns: table.columns,
        rowCount: table.rowCount,
        sha256: table.sha256,
        createdAt: table.createdAt,
      });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** The parsed CSV of a stored table. Parsing was checked when it was saved, so this only fails if the file was damaged (integrity is checked first). */
export function tableData(table: StoredTable): ParsedTable {
  return parseCaseTable(table.csv);
}

/**
 * Stores `content` as the next version unless it is identical to the current one (no new version then, `created: false`). The CSV is parsed
 * first: a table that cannot be read is a 400 that names the line. The secret lint is the caller's (it needs the vault).
 */
export async function saveTableVersion(id: string, content: TableContent, createdBy?: string): Promise<{ table: StoredTable; created: boolean }> {
  const dir = tableDir(id);
  const normalized: TableContent = { ...(content.title === undefined ? {} : { title: content.title }), csv: normalizeCsv(content.csv) };
  let parsed: ParsedTable;
  try {
    parsed = parseCaseTable(normalized.csv);
  } catch (error) {
    if (error instanceof CaseTableError) throw new CaseTableLibraryError(400, 'InvalidCaseTable', error.message);
    throw error;
  }

  return withLock(async () => {
    const sha256 = tableDigest(id, normalized);
    const existing = await getTable(id);
    if (existing && existing.sha256 === sha256) return { table: existing, created: false };

    const version = ((await listVersions(id)).at(-1) ?? 0) + 1;
    const table: StoredTable = storedTableSchema.parse({
      id,
      version,
      sha256,
      ...(normalized.title === undefined ? {} : { title: normalized.title }),
      csv: normalized.csv,
      columns: parsed.columns,
      rowCount: parsed.rows.length,
      ...(createdBy === undefined ? {} : { createdBy }),
      createdAt: new Date().toISOString(),
    });
    await fs.mkdir(dir, { recursive: true });
    // 'wx': a version file is never overwritten, even if the pointer and the directory disagree.
    await fs.writeFile(path.join(dir, `v${version}.json`), `${JSON.stringify(table, null, 2)}\n`, { flag: 'wx' });
    await writeFileAtomic(path.join(dir, 'current.json'), `${JSON.stringify({ version })}\n`);
    return { table, created: true };
  });
}
