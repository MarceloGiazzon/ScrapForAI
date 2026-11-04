import fs from 'node:fs/promises';
import path from 'node:path';

import { RequestResolutionError } from '../runner/resolutionError.js';
import { type AccessibilityAudit, accessibilityAuditSchema } from '../schemas/accessibility.schema.js';
import { type ExpectedChanges, expectedChangesSchema } from '../schemas/expectedChanges.schema.js';
import { type ScreenInventory, screenInventorySchema } from '../schemas/screenInventory.schema.js';
import { writeFileAtomic } from '../storage/atomicWrite.js';
import { getTarget } from '../targets/targetStore.js';
import { diffSnapshots, type EvolutionDiff, renderChangesFile, type SnapshotView } from './compare.js';
import { folderSafe } from './snapshotPlan.js';
import { commitSnapshot, type GitOutcome, listSnapshots, readManifest, sha256, type SnapshotListing, targetFolder } from './snapshotStore.js';

/**
 * T4.5/T4.6/T4.7: reading snapshots back, comparing two of them, the changes a build declared, CHANGES.md and the timeline of a
 * control. Everything it reads is verified against the manifest's sha256 first: a hand-edited inventory is refused, not trusted.
 */

export class EvolutionError extends RequestResolutionError {}

export const CHANGES_FILE = 'CHANGES.md';
export const MAX_NARRATIVE_CHARS = 20_000;

/** Reads one screen's accessibility audit back and checks it against the manifest's sha256 (an edited baseline is refused, as an edited inventory is). */
async function readAccessibility(target: string, name: string, entry: { id: string; accessibility?: string; accessibilitySha256?: string }): Promise<AccessibilityAudit | undefined> {
  if (!entry.accessibility) return undefined;
  const file = path.join(targetFolder(target), name, ...entry.accessibility.split('/'));
  const text = await fs.readFile(file, 'utf8').catch(() => undefined);
  if (text === undefined) throw new EvolutionError(409, 'SnapshotIncomplete', `Snapshot "${name}": ${entry.accessibility} is listed in the manifest but missing`);
  if (sha256(text) !== entry.accessibilitySha256) {
    throw new EvolutionError(409, 'SnapshotTampered', `Snapshot "${name}": ${entry.accessibility} does not match the sha256 in snapshot.json (edited after capture)`);
  }
  return accessibilityAuditSchema.parse(JSON.parse(text));
}

export async function loadSnapshotView(target: string, name: string): Promise<SnapshotView> {
  const manifest = await readManifest(target, name);
  if (!manifest) throw new EvolutionError(404, 'SnapshotNotFound', `Snapshot "${name}" of "${target}" does not exist`);

  const inventories = new Map<string, ScreenInventory>();
  const accessibility = new Map<string, AccessibilityAudit>();
  const names = new Map<string, string>();
  for (const entry of manifest.screens) {
    names.set(entry.id, entry.name);
    const file = path.join(targetFolder(target), name, ...entry.inventory.split('/'));
    const text = await fs.readFile(file, 'utf8').catch(() => undefined);
    if (text === undefined) throw new EvolutionError(409, 'SnapshotIncomplete', `Snapshot "${name}": ${entry.inventory} is listed in the manifest but missing`);
    if (sha256(text) !== entry.inventorySha256) {
      throw new EvolutionError(409, 'SnapshotTampered', `Snapshot "${name}": ${entry.inventory} does not match the sha256 in snapshot.json (edited after capture)`);
    }
    inventories.set(entry.id, screenInventorySchema.parse(JSON.parse(text)));
    const audit = await readAccessibility(target, name, entry);
    if (audit) accessibility.set(entry.id, audit);
  }
  const notCaptured = new Map(manifest.notCaptured.map((item) => [item.id, item.reason]));
  for (const item of manifest.notCaptured) if (!names.has(item.id)) names.set(item.id, item.id);

  return { buildId: manifest.buildId, createdAt: manifest.createdAt, complete: manifest.complete, inventories, notCaptured, names, ...(accessibility.size > 0 ? { accessibility } : {}) };
}

export interface AccessibilityBaseline {
  buildId: string;
  createdAt: string;
  audit: AccessibilityAudit;
}

/**
 * T7.5: the accessibility baseline of one screen. Without `build`, the NEWEST snapshot that audited that screen; with it, that build's (and a
 * snapshot of that build without an audit of the screen is an error, not a silent fall back to an older one: the caller asked for a specific baseline).
 */
export async function loadAccessibilityBaseline(target: string, screenId: string, build?: string): Promise<AccessibilityBaseline> {
  const listing = (await listSnapshots(target)).reverse();
  const candidates = build === undefined ? listing : listing.filter((item) => item.buildId === build);
  if (build !== undefined && candidates.length === 0) {
    throw new EvolutionError(404, 'SnapshotNotFound', `No snapshot of build "${build}" for "${target}" (have: ${listing.map((item) => item.buildId).join(', ') || 'none'})`);
  }
  for (const item of candidates) {
    const manifest = await readManifest(target, item.name);
    const entry = manifest?.screens.find((screen) => screen.id === screenId);
    if (!entry?.accessibility) continue;
    const audit = await readAccessibility(target, item.name, entry);
    if (audit) return { buildId: item.buildId, createdAt: item.createdAt, audit };
  }
  throw new EvolutionError(
    404,
    'NoAccessibilityBaseline',
    build === undefined
      ? `No snapshot of "${target}" has an accessibility baseline for screen "${screenId}". Take one with: scrapforai evolution snapshot ${target} --accessibility`
      : `The snapshot of build "${build}" has no accessibility baseline for screen "${screenId}"`,
  );
}

/** `latest`, `previous`, a build id or a folder name -> a listed snapshot. */
function pick(listing: SnapshotListing[], ref: string, which: string): SnapshotListing {
  const found =
    ref === 'latest' ? listing.at(-1) : ref === 'previous' ? listing.at(-2) : (listing.find((item) => item.buildId === ref) ?? listing.find((item) => item.name === ref));
  if (!found) throw new EvolutionError(404, 'SnapshotNotFound', `${which} snapshot "${ref}" not found (have: ${listing.map((item) => item.buildId).join(', ') || 'none'})`);
  return found;
}

/** Defaults: `to` = the latest snapshot, `from` = the one right before `to`. */
export async function resolvePair(target: string, from?: string, to?: string): Promise<{ from: SnapshotListing; to: SnapshotListing }> {
  const listing = await listSnapshots(target);
  if (listing.length === 0) throw new EvolutionError(404, 'NoSnapshots', `Target "${target}" has no snapshots (run: scrapforai evolution snapshot ${target})`);
  const toItem = pick(listing, to ?? 'latest', 'to');
  const fromItem = from === undefined ? listing[listing.indexOf(toItem) - 1] : pick(listing, from, 'from');
  if (!fromItem) throw new EvolutionError(409, 'NoPreviousSnapshot', `Build "${toItem.buildId}" is the first snapshot of "${target}": there is nothing earlier to compare it with`);
  if (fromItem.name === toItem.name) throw new EvolutionError(400, 'SamePairNotComparable', 'from and to are the same snapshot');
  return { from: fromItem, to: toItem };
}

// ---------------------------------------------------------------------------------------------------------------------
// Expected changes (T4.7)

const expectedFile = (target: string, buildId: string): string => path.join(targetFolder(target), 'expected', `${folderSafe(buildId)}.json`);

export async function getExpectedChanges(target: string, buildId: string): Promise<ExpectedChanges | undefined> {
  try {
    const parsed = expectedChangesSchema.parse(JSON.parse(await fs.readFile(expectedFile(target, buildId), 'utf8')));
    // folderSafe is lossy ("a/b" and "a_b" share a file): the file says which build it is for.
    return parsed.buildId === buildId ? parsed : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function saveExpectedChanges(target: string, declared: ExpectedChanges): Promise<{ stored: ExpectedChanges; git: GitOutcome }> {
  const body = `${JSON.stringify(declared, null, 2)}\n`;
  const file = expectedFile(target, declared.buildId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, body);
  return { stored: declared, git: await commitSnapshot(target, `evolution(${target}): expected changes for ${declared.buildId}`) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Diff and CHANGES.md (T4.5)

export async function diffBuilds(target: string, from?: string, to?: string): Promise<{ diff: EvolutionDiff; fromName: string; toName: string }> {
  const pair = await resolvePair(target, from, to);
  const [before, after, profile, expected] = await Promise.all([
    loadSnapshotView(target, pair.from.name),
    loadSnapshotView(target, pair.to.name),
    getTarget(target).catch(() => undefined),
    // What the NEWER build declared it would change.
    getExpectedChanges(target, pair.to.buildId),
  ]);
  const diff = diffSnapshots(before, after, { ...(profile?.diff ? { config: profile.diff } : {}), ...(expected ? { expected } : {}) });
  return { diff, fromName: pair.from.name, toName: pair.to.name };
}

/**
 * Writes CHANGES.md next to the newer snapshot: the deterministic section, plus the agent's narrative when it gave one. The
 * server never writes the narrative itself (it calls no model); the file labels it as not verified.
 */
export async function writeChanges(
  target: string,
  options: { from?: string; to?: string; narrative?: string },
): Promise<{ diff: EvolutionDiff; file: string; git: GitOutcome }> {
  if (options.narrative !== undefined && options.narrative.length > MAX_NARRATIVE_CHARS) {
    throw new EvolutionError(400, 'NarrativeTooLong', `narrative is limited to ${MAX_NARRATIVE_CHARS} characters`);
  }
  const { diff, toName } = await diffBuilds(target, options.from, options.to);
  const relative = `${target}/${toName}/${CHANGES_FILE}`;
  await writeFileAtomic(path.join(targetFolder(target), toName, CHANGES_FILE), renderChangesFile(diff, target, options.narrative));
  const git = await commitSnapshot(target, `evolution(${target}): changes ${diff.from.buildId} -> ${diff.to.buildId}`);
  return { diff, file: relative, git };
}

// ---------------------------------------------------------------------------------------------------------------------
// Timeline and queries (T4.6)

export interface TimelineEvent {
  /** The build in which the change first showed up. */
  buildId: string;
  createdAt: string;
  screen: string;
  screenName: string;
  kind: 'screen-added' | 'screen-removed' | 'added' | 'removed' | 'changed';
  path?: string;
  text: string;
}

export interface TimelineAnswer {
  targetProfile: string;
  snapshots: number;
  /** The builds that have a snapshot, oldest first: what a question can be asked about. */
  builds: Array<{ buildId: string; createdAt: string; complete: boolean }>;
  events: TimelineEvent[];
  truncated: boolean;
  /** With `key`: where that control is today and since when it has been seen. */
  control?: { key: string; screen?: string; presentInLatest: boolean; firstSeenIn?: { buildId: string; createdAt: string; isFirstSnapshot: boolean } };
}

const MAX_EVENTS = 500;

/** Every change between consecutive snapshots, oldest first, optionally narrowed to a screen, a control key and a start date. */
export async function queryTimeline(
  target: string,
  filter: { screen?: string; key?: string; since?: string; limit?: number } = {},
): Promise<TimelineAnswer> {
  const listing = await listSnapshots(target);
  const profile = await getTarget(target).catch(() => undefined);
  const views: Array<{ listing: SnapshotListing; view: SnapshotView }> = [];
  for (const item of listing) views.push({ listing: item, view: await loadSnapshotView(target, item.name) });

  const limit = Math.min(filter.limit ?? MAX_EVENTS, MAX_EVENTS);
  const events: TimelineEvent[] = [];
  let truncated = false;
  const keyToken = filter.key ? `[key=${filter.key}]` : undefined;

  for (let index = 1; index < views.length; index += 1) {
    const diff = diffSnapshots(views[index - 1]!.view, views[index]!.view, profile?.diff ? { config: profile.diff } : {});
    for (const screen of diff.screens) {
      if (filter.screen && screen.id !== filter.screen) continue;
      const base = { buildId: diff.to.buildId, createdAt: diff.to.createdAt, screen: screen.id, screenName: screen.name };
      if (screen.status === 'added' || screen.status === 'removed') {
        if (!keyToken) events.push({ ...base, kind: screen.status === 'added' ? 'screen-added' : 'screen-removed', text: `screen ${screen.name} ${screen.status}` });
      }
      for (const change of screen.changes) {
        if (keyToken && !change.path.includes(keyToken)) continue;
        events.push({ ...base, kind: change.kind, path: change.path, text: change.text });
      }
    }
  }

  const sinceFiltered = filter.since ? events.filter((event) => event.createdAt >= filter.since!) : events;
  if (sinceFiltered.length > limit) truncated = true;

  const answer: TimelineAnswer = {
    targetProfile: target,
    snapshots: views.length,
    builds: listing.map((item) => ({ buildId: item.buildId, createdAt: item.createdAt, complete: item.complete })),
    events: sinceFiltered.slice(0, limit),
    truncated,
  };

  if (filter.key) {
    const holds = (view: SnapshotView): string | undefined => {
      for (const [screenId, inventory] of view.inventories) {
        if (filter.screen && screenId !== filter.screen) continue;
        if ([...inventory.fields, ...inventory.actions, ...inventory.grids].some((item) => item.key === filter.key)) return screenId;
      }
      return undefined;
    };
    const first = views.find(({ view }) => holds(view) !== undefined);
    const latest = views.at(-1);
    const where = latest ? holds(latest.view) : undefined;
    answer.control = {
      key: filter.key,
      ...(where ? { screen: where } : {}),
      presentInLatest: where !== undefined,
      ...(first ? { firstSeenIn: { buildId: first.listing.buildId, createdAt: first.listing.createdAt, isFirstSnapshot: first === views[0] } } : {}),
    };
  }
  return answer;
}
