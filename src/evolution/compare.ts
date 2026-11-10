import { compareAudits } from '../a11y/audit.js';
import { guidanceFor } from '../a11y/platformGuidance.js';
import type { ChangeSet } from '../diff/structuralDiff.js';
import { globToRegExp } from '../diff/normalizers.js';
import { diffInventories } from '../inventory/diffInventory.js';
import type { AccessibilityAudit, AccessibilityDelta } from '../schemas/accessibility.schema.js';
import type { DiffConfigInput } from '../schemas/diffConfig.schema.js';
import type { ExpectedChanges, ExpectedEntry } from '../schemas/expectedChanges.schema.js';
import type { ScreenInventory } from '../schemas/screenInventory.schema.js';

/**
 * T4.5/T4.6/T4.7, the pure half: two snapshots become a per-screen diff, each change is classified against what the build
 * declared it would change, and the result is rendered as deterministic text. No I/O, no clock, no LLM: the same snapshots
 * always give the same words (P7: the server does not call a model; an agent may add a narrative on top).
 */

export interface SnapshotView {
  buildId: string;
  createdAt: string;
  complete: boolean;
  /** Screen id -> inventory, for the screens captured in this snapshot. */
  inventories: Map<string, ScreenInventory>;
  /** Screen id -> why it was not captured (partial snapshots). */
  notCaptured: Map<string, string>;
  /** T7.5: screen id -> accessibility audit, for the screens the snapshot audited (absent when it audited none). */
  accessibility?: Map<string, AccessibilityAudit>;
  /** Screen id -> display name. */
  names: Map<string, string>;
}

export type ChangeKind = 'added' | 'removed' | 'changed';

export interface DescribedChange {
  kind: ChangeKind;
  /** Where inside the screen, as the diff reports it. */
  path: string;
  /** Deterministic sentence: "+ field Phone (text, optional)". */
  text: string;
  /** Classification against the build's declared changes. Absent when the build declared none. */
  classification?: 'expected' | 'unexpected';
  /** The `ref`/`note` of the entry that covers it. */
  coveredBy?: string;
}

export interface ScreenDiff {
  id: string;
  name: string;
  /** `unknown`: not captured in one of the two snapshots, so nothing can be said about it. */
  status: 'added' | 'removed' | 'changed' | 'unchanged' | 'unknown';
  reason?: string;
  changes: DescribedChange[];
  truncated: boolean;
  classification?: 'expected' | 'unexpected';
  coveredBy?: string;
  /** T7.5: accessibility new/fixed since the earlier snapshot. Absent when neither snapshot audited this screen. */
  accessibility?: ScreenAccessibility;
}

export interface ScreenAccessibility {
  /** `compared`: both snapshots audited it with the same standard. `first-audit`: only the newer one did, so it is a baseline, not a change. */
  status: 'compared' | 'first-audit' | 'not-comparable' | 'no-longer-audited';
  reason?: string;
  delta?: AccessibilityDelta;
  standard?: string;
}

export interface EvolutionDiff {
  from: { buildId: string; createdAt: string; complete: boolean };
  to: { buildId: string; createdAt: string; complete: boolean };
  screens: ScreenDiff[];
  counts: { screensChanged: number; screensAdded: number; screensRemoved: number; screensUnknown: number; changes: number; expected: number; unexpected: number };
  /** True when the `to` build declared its expected changes, so `unexpected` means something. */
  classified: boolean;
  /** T7.5: present only when either snapshot audited accessibility. Kept apart from `counts`: a new violation is not a structural change and never moves the expected/unexpected verdict. */
  accessibility?: { screensCompared: number; new: number; fixed: number; notComparable: number };
}

// ---------------------------------------------------------------------------------------------------------------------
// Words

const CHANGE_PATH = /^(fields|actions|grids)\[key=(.*?)\](.*)$/;

function nameOf(section: string, key: string, inventory: ScreenInventory | undefined): string {
  const item = inventory?.[section as 'fields' | 'actions' | 'grids']?.find((entry) => entry.key === key) as { label?: string } | undefined;
  return item?.label && item.label !== key ? `${item.label} (${key})` : key;
}

const singular = (section: string): string => (section === 'fields' ? 'field' : section === 'actions' ? 'action' : 'grid');
const shown = (value: unknown): string => (typeof value === 'string' ? `"${value}"` : JSON.stringify(value));

function describeAddedRemoved(sign: '+' | '-', path: string, value: unknown, inventory: ScreenInventory | undefined): string {
  const match = CHANGE_PATH.exec(path);
  if (!match) return `${sign} ${path}`;
  const [, section, key, rest] = match as unknown as [string, string, string, string];
  const label = nameOf(section, key, inventory);

  if (rest === '') {
    const item = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
    if (section === 'fields') {
      return `${sign} field ${label} (${String(item.type ?? 'unknown')}, ${item.required === true ? 'required' : 'optional'})`;
    }
    if (section === 'grids') {
      const columns = Array.isArray(item.columns) ? item.columns.length : 0;
      return `${sign} grid ${label} (${columns} column${columns === 1 ? '' : 's'})`;
    }
    return `${sign} ${singular(section)} ${label}`;
  }
  const inner = /^\.(columns|options)\[="(.*)"\]$/.exec(rest);
  if (inner) return `${sign} ${inner[1] === 'columns' ? 'column' : 'option'} ${shown(inner[2])} in ${singular(section)} ${label}`;
  return `${sign} ${singular(section)} ${label}${rest}`;
}

const FLAG_WORDS: Record<string, [string, string]> = {
  required: ['now required', 'no longer required'],
  enabled: ['now enabled', 'now disabled'],
  visible: ['now visible', 'now hidden'],
};

function describeChanged(path: string, before: unknown, after: unknown, inventory: ScreenInventory | undefined): string {
  const match = CHANGE_PATH.exec(path);
  if (!match) return `~ ${path}: ${shown(before)} -> ${shown(after)}`;
  const [, section, key, rest] = match as unknown as [string, string, string, string];
  const label = nameOf(section, key, inventory);
  const property = rest.replace(/^\./, '');
  const flag = FLAG_WORDS[property];
  if (flag && typeof after === 'boolean') return `~ ${singular(section)} ${label} is ${after ? flag[0] : flag[1]}`;
  if (property === 'label') return `~ ${singular(section)} ${key} renamed ${shown(before)} -> ${shown(after)}`;
  if (property === 'type') return `~ ${singular(section)} ${label} changed type ${shown(before)} -> ${shown(after)}`;
  if (property === 'maxLength') return `~ ${singular(section)} ${label} max length ${shown(before)} -> ${shown(after)}`;
  return `~ ${singular(section)} ${label}: ${property || 'value'} ${shown(before)} -> ${shown(after)}`;
}

function describe(changes: ChangeSet, before: ScreenInventory, after: ScreenInventory): DescribedChange[] {
  return [
    ...changes.added.map((change): DescribedChange => ({ kind: 'added', path: change.path, text: describeAddedRemoved('+', change.path, change.value, after) })),
    ...changes.removed.map((change): DescribedChange => ({ kind: 'removed', path: change.path, text: describeAddedRemoved('-', change.path, change.value, before) })),
    ...changes.changed.map((change): DescribedChange => ({ kind: 'changed', path: change.path, text: describeChanged(change.path, change.before, change.after, after) })),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : 1));
}

// ---------------------------------------------------------------------------------------------------------------------
// Diff

export function diffSnapshots(before: SnapshotView, after: SnapshotView, options: { config?: DiffConfigInput; expected?: ExpectedChanges } = {}): EvolutionDiff {
  const ids = [...new Set([...before.inventories.keys(), ...after.inventories.keys(), ...before.notCaptured.keys(), ...after.notCaptured.keys()])].sort();
  const screens: ScreenDiff[] = [];

  for (const id of ids) {
    const name = after.names.get(id) ?? before.names.get(id) ?? id;
    const was = before.inventories.get(id);
    const now = after.inventories.get(id);

    if (!was && !now) {
      screens.push({ id, name, status: 'unknown', reason: 'not captured in either snapshot', changes: [], truncated: false });
    } else if (was && now) {
      const changeSet = diffInventories(was, now, options.config ? { config: options.config } : {});
      const changes = describe(changeSet, was, now);
      screens.push({ id, name, status: changes.length === 0 ? 'unchanged' : 'changed', changes, truncated: changeSet.truncated });
    } else if (now) {
      // Only in `after`. If `before` simply failed to capture it, "added" would be a lie.
      const missing = before.notCaptured.get(id);
      screens.push(
        missing !== undefined
          ? { id, name, status: 'unknown', reason: `not captured in build ${before.buildId}: ${missing}`, changes: [], truncated: false }
          : { id, name, status: 'added', changes: [], truncated: false },
      );
    } else {
      const missing = after.notCaptured.get(id);
      screens.push(
        missing !== undefined
          ? { id, name, status: 'unknown', reason: `not captured in build ${after.buildId}: ${missing}`, changes: [], truncated: false }
          : { id, name, status: 'removed', changes: [], truncated: false },
      );
    }
  }

  const accessibility = attachAccessibility(screens, before, after);
  if (options.expected) classify(screens, options.expected.expected);
  return { from: view(before), to: view(after), screens, counts: count(screens), classified: options.expected !== undefined, ...(accessibility ? { accessibility } : {}) };
}

/** T7.5: for every screen audited in either snapshot, what is new and what was fixed. Returns the totals, or undefined when nobody audited. */
function attachAccessibility(screens: ScreenDiff[], before: SnapshotView, after: SnapshotView): EvolutionDiff['accessibility'] {
  if (!before.accessibility?.size && !after.accessibility?.size) return undefined;
  const totals = { screensCompared: 0, new: 0, fixed: 0, notComparable: 0 };
  for (const screen of screens) {
    const was = before.accessibility?.get(screen.id);
    const now = after.accessibility?.get(screen.id);
    if (!was && !now) continue;
    if (was && now) {
      const comparison = compareAudits(was, now);
      if (comparison.comparable) {
        screen.accessibility = { status: 'compared', delta: comparison.delta, standard: now.standard };
        totals.screensCompared += 1;
        totals.new += comparison.delta.new.length;
        totals.fixed += comparison.delta.fixed.length;
      } else {
        screen.accessibility = { status: 'not-comparable', reason: comparison.reason };
        totals.notComparable += 1;
      }
    } else if (now) {
      screen.accessibility = { status: 'first-audit', standard: now.standard };
    } else {
      screen.accessibility = { status: 'no-longer-audited', reason: `build ${after.buildId} has no accessibility audit of this screen` };
    }
  }
  return totals;
}

const view = (snapshot: SnapshotView) => ({ buildId: snapshot.buildId, createdAt: snapshot.createdAt, complete: snapshot.complete });

function count(screens: ScreenDiff[]): EvolutionDiff['counts'] {
  const all = screens.flatMap((screen) => (screen.status === 'added' || screen.status === 'removed' ? [screen.classification] : screen.changes.map((change) => change.classification)));
  return {
    screensChanged: screens.filter((s) => s.status === 'changed').length,
    screensAdded: screens.filter((s) => s.status === 'added').length,
    screensRemoved: screens.filter((s) => s.status === 'removed').length,
    screensUnknown: screens.filter((s) => s.status === 'unknown').length,
    changes: screens.reduce((total, s) => total + (s.status === 'added' || s.status === 'removed' ? 1 : s.changes.length), 0),
    expected: all.filter((c) => c === 'expected').length,
    unexpected: all.filter((c) => c === 'unexpected').length,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// T4.7 classification

const coverText = (entry: ExpectedEntry): string => [entry.ref, entry.note].filter(Boolean).join(': ') || 'declared';

/**
 * Does an entry cover a whole-screen change (`path` undefined: the screen appeared or disappeared) or one inside a screen?
 * Inside a screen, kind `changed` means "something in it changed" and covers an added, removed or modified control alike;
 * `added` / `removed` are narrower. A whole-screen change is only covered by an entry with no `path`.
 */
function matches(entry: ExpectedEntry, screenId: string, kind: ChangeKind, path?: string): boolean {
  if (entry.screen !== '*' && entry.screen !== screenId) return false;
  if (path === undefined) return entry.path === undefined && (entry.kind === '*' || entry.kind === kind);
  if (entry.kind !== '*' && entry.kind !== 'changed' && entry.kind !== kind) return false;
  return entry.path === undefined || globToRegExp(entry.path).test(path);
}

/** Marks every change as expected (an entry covers it) or unexpected. A `changed`/`*` screen entry without a path covers the whole screen. */
function classify(screens: ScreenDiff[], expected: ExpectedEntry[]): void {
  for (const screen of screens) {
    if (screen.status === 'unknown' || screen.status === 'unchanged') continue;
    if (screen.status === 'added' || screen.status === 'removed') {
      const entry = expected.find((candidate) => matches(candidate, screen.id, screen.status as ChangeKind));
      screen.classification = entry ? 'expected' : 'unexpected';
      if (entry) screen.coveredBy = coverText(entry);
      continue;
    }
    for (const change of screen.changes) {
      const entry = expected.find((candidate) => matches(candidate, screen.id, change.kind, change.path));
      change.classification = entry ? 'expected' : 'unexpected';
      if (entry) change.coveredBy = coverText(entry);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// T4.5 CHANGES.md (deterministic section)

const hasAccessibilityNews = (screen: ScreenDiff): boolean =>
  screen.accessibility !== undefined && (screen.accessibility.status !== 'compared' || screen.accessibility.delta!.new.length + screen.accessibility.delta!.fixed.length > 0);

const MAX_A11Y_LINES = 25;

/** The accessibility part of a screen's section: what is new (with the platform note) and what was fixed. English, like the rest of CHANGES.md. */
function accessibilityLines(screen: ScreenDiff, platform?: string): string[] {
  const a11y = screen.accessibility;
  if (!a11y) return [];
  if (a11y.status === 'first-audit') return [`- Accessibility: first audit of this screen (${a11y.standard}); it is the baseline from now on.`];
  if (a11y.status === 'not-comparable' || a11y.status === 'no-longer-audited') return [`- Accessibility: not compared (${a11y.reason ?? 'unknown'}).`];
  const delta = a11y.delta!;
  if (delta.new.length + delta.fixed.length === 0) return [];
  const out = [`- Accessibility (${a11y.standard}): ${delta.new.length} new, ${delta.fixed.length} fixed, ${delta.unchanged} unchanged${delta.incomplete ? ' (a list was cut: counts may be incomplete)' : ''}.`];
  if (delta.axeVersionChanged) out.push(`  - axe-core changed from ${delta.axeVersionChanged.before} to ${delta.axeVersionChanged.after}: a new finding may come from a changed rule.`);
  for (const finding of delta.new.slice(0, MAX_A11Y_LINES)) {
    out.push(`  - **NEW** [${finding.impact}] ${finding.ruleId} at \`${finding.targetKey}\`: ${finding.help}${finding.wcag.length ? ` (WCAG ${finding.wcag.join(', ')})` : ''}`);
    const note = guidanceFor(finding.ruleId, 'en', platform);
    if (note) out.push(`    - ${note.platform}`);
  }
  if (delta.new.length > MAX_A11Y_LINES) out.push(`  - ... ${delta.new.length - MAX_A11Y_LINES} more new violation(s)`);
  for (const finding of delta.fixed.slice(0, MAX_A11Y_LINES)) out.push(`  - fixed [${finding.impact}] ${finding.ruleId} at \`${finding.targetKey}\``);
  if (delta.fixed.length > MAX_A11Y_LINES) out.push(`  - ... ${delta.fixed.length - MAX_A11Y_LINES} more fixed`);
  return out;
}

const mark = (item: { classification?: 'expected' | 'unexpected'; coveredBy?: string }): string =>
  item.classification === 'unexpected' ? '  **UNEXPECTED**' : item.classification === 'expected' ? `  (expected: ${item.coveredBy})` : '';

export function renderChangesMarkdown(diff: EvolutionDiff, target: string, platform?: string): string {
  const lines: string[] = [];
  lines.push(`# Changes in ${target}: ${diff.from.buildId} -> ${diff.to.buildId}`);
  lines.push('');
  lines.push(`From snapshot ${diff.from.createdAt.slice(0, 10)} (build ${diff.from.buildId}${diff.from.complete ? '' : ', partial'}) to ${diff.to.createdAt.slice(0, 10)} (build ${diff.to.buildId}${diff.to.complete ? '' : ', partial'}).`);
  lines.push('');
  const c = diff.counts;
  lines.push(
    `Summary: ${c.screensChanged} screen(s) changed, ${c.screensAdded} added, ${c.screensRemoved} removed, ${c.changes} change(s)` +
      `${diff.classified ? `, ${c.expected} expected, ${c.unexpected} unexpected` : ''}${c.screensUnknown ? `, ${c.screensUnknown} could not be compared` : ''}.`,
  );
  lines.push('');

  if (diff.accessibility) {
    const a = diff.accessibility;
    lines.push(`Accessibility: ${a.new} new violation(s), ${a.fixed} fixed, across ${a.screensCompared} screen(s) compared${a.notComparable ? `; ${a.notComparable} could not be compared` : ''}.`);
    lines.push('');
  }

  const interesting = diff.screens.filter((screen) => screen.status !== 'unchanged' || hasAccessibilityNews(screen));
  if (interesting.length === 0) {
    lines.push(diff.accessibility ? 'No structural change between these two snapshots, and nothing new or fixed in accessibility.' : 'No structural change between these two snapshots.');
    lines.push('');
  }
  for (const screen of interesting) {
    if (screen.status === 'added') lines.push(`## Screen ${screen.name}: added${mark(screen)}`);
    else if (screen.status === 'removed') lines.push(`## Screen ${screen.name}: removed${mark(screen)}`);
    else if (screen.status === 'unknown') lines.push(`## Screen ${screen.name}: could not be compared (${screen.reason ?? 'unknown'})`);
    else {
      lines.push(`## Screen ${screen.name}`);
      for (const change of screen.changes) lines.push(`- ${change.text}${mark(change)}`);
      if (screen.truncated) lines.push('- ... more changes than are listed here');
    }
    lines.push(...accessibilityLines(screen, platform));
    lines.push('');
  }
  return lines.join('\n');
}

/** The whole file: the deterministic section, then (when an agent wrote one) a narrative that says it is not verified. */
export function renderChangesFile(diff: EvolutionDiff, target: string, narrative?: string, platform?: string): string {
  const base = renderChangesMarkdown(diff, target, platform);
  if (!narrative?.trim()) return `${base.trimEnd()}\n`;
  return `${base.trimEnd()}\n\n---\n\n## Narrative (AI-generated summary, not verified)\n\n${narrative.trim()}\n`;
}
