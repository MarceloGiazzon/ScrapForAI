import fs from 'node:fs/promises';
import path from 'node:path';

import { regressionVaultDir } from '../../config/paths.js';
import { getRoutine } from '../../library/routineLibrary.js';
import {
  type EvidenceRef,
  ITEM_ID_PATTERN,
  type RegressionItem,
  type RegressionItemWrite,
  regressionItemSchema,
} from '../../schemas/regressionItem.schema.js';
import { createMutex, writeFileAtomic } from '../../storage/atomicWrite.js';

/**
 * T2.1 regression vault on disk: <REGRESSION_VAULT_DIR>/<ITEM-ID>.json, one file per item so the
 * directory can live in a git repository and be reviewed like code.
 *
 * Definition fields are written through `saveItem`; the evidence fields (provenRed, firstGreen,
 * lastRun) only through the dedicated setters used by the flows that actually capture them.
 */

export class VaultItemError extends Error {
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

const withLock = createMutex();

function itemFile(id: string): string {
  if (!ITEM_ID_PATTERN.test(id)) {
    throw new VaultItemError(400, 'ValidationError', 'Item id must look like GX-12 or REG-209');
  }
  return path.join(regressionVaultDir(), `${id}.json`);
}

export async function getItem(id: string): Promise<RegressionItem | undefined> {
  try {
    return regressionItemSchema.parse(JSON.parse(await fs.readFile(itemFile(id), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

export interface ItemFilter {
  status?: string[];
  tags?: string[];
  surface?: string;
  type?: string[];
}

export async function listItems(filter: ItemFilter = {}): Promise<RegressionItem[]> {
  const files = await fs.readdir(regressionVaultDir()).catch(() => [] as string[]);
  const items: RegressionItem[] = [];

  for (const file of files.filter((name) => name.endsWith('.json'))) {
    const item = await getItem(file.slice(0, -'.json'.length)).catch(() => undefined);
    if (!item) continue;
    if (filter.status && !filter.status.includes(item.status)) continue;
    if (filter.type && !filter.type.includes(item.type)) continue;
    if (filter.surface && item.surface !== filter.surface) continue;
    if (filter.tags && !filter.tags.every((tag) => item.tags.includes(tag))) continue;
    items.push(item);
  }

  return items.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
}

async function write(item: RegressionItem): Promise<RegressionItem> {
  const parsed = regressionItemSchema.safeParse(item);
  if (!parsed.success) {
    throw new VaultItemError(
      400,
      'ValidationError',
      'Invalid regression item',
      parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }

  await writeFileAtomic(itemFile(item.id), `${JSON.stringify(parsed.data, null, 2)}\n`);
  return parsed.data;
}

/**
 * Creates an item or updates its DEFINITION (evidence is kept as it is). The routine and version it
 * points to must exist, and a retired routine cannot back an item.
 */
export function saveItem(id: string, body: RegressionItemWrite): Promise<{ item: RegressionItem; created: boolean }> {
  return withLock(async () => {
    const routine = await getRoutine(body.routine.id, body.routine.version);
    if (!routine) {
      throw new VaultItemError(404, 'RoutineNotFound', `Routine "${body.routine.id}" v${body.routine.version} does not exist`);
    }

    const existing = await getItem(id);
    const item = await write({
      ...body,
      id,
      opened: body.opened ?? existing?.opened ?? new Date().toISOString().slice(0, 10),
      provenRed: existing?.provenRed ?? null,
      firstGreen: existing?.firstGreen ?? null,
      ...(existing?.lastRun ? { lastRun: existing.lastRun } : {}),
    });

    return { item, created: existing === undefined };
  });
}

/** Creates an item whose RED evidence was captured by a flow (add-from-run). Fails if the id is taken. */
export function createItemWithEvidence(item: RegressionItem): Promise<RegressionItem> {
  return withLock(async () => {
    if (await getItem(item.id)) {
      throw new VaultItemError(409, 'ItemExists', `Item ${item.id} already exists`);
    }
    return write(item);
  });
}

async function update(id: string, change: (item: RegressionItem) => RegressionItem): Promise<RegressionItem> {
  return withLock(async () => {
    const existing = await getItem(id);
    if (!existing) {
      throw new VaultItemError(404, 'ItemNotFound', `Item ${id} does not exist`);
    }
    return write(change(existing));
  });
}

export const setFirstGreen = (id: string, evidence: EvidenceRef): Promise<RegressionItem> => update(id, (item) => ({ ...item, firstGreen: evidence }));

export const recordLastRun = (id: string, lastRun: NonNullable<RegressionItem['lastRun']>): Promise<RegressionItem | undefined> =>
  update(id, (item) => ({ ...item, lastRun })).catch((error) => {
    if (error instanceof VaultItemError && error.status === 404) return undefined; // the item was removed while a run was in flight
    throw error;
  });

/** Deterministic, git-friendly snapshot of the whole vault (sorted ids, stable key order). */
export async function exportVault(): Promise<{ exportedAt: string; count: number; items: RegressionItem[] }> {
  const items = await listItems();
  return { exportedAt: new Date().toISOString(), count: items.length, items };
}
