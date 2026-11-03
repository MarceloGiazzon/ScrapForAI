import type { DiffConfigInput } from '../schemas/diffConfig.schema.js';
import { compileDiffConfig, normalizeKey, scalarsEqual, type CompiledNormalizers } from './normalizers.js';

/**
 * T4.1: structural diff of two JSON documents, by IDENTITY and not by array index.
 *
 * Reordering is not a change. An array of objects is matched on a key (`field.key`, declared per array in the
 * config or found as `key`/`id`/`name` on every item); an array of scalars is compared as a multiset; only an
 * array declared `ordered`, or one with no usable identity, is compared by position. Identities and key-like
 * properties go through the normalizers (grid row suffix, web-component prefix, masks), so `vNAME_0001` in one
 * render and `vNAME_0002` in the next are the same control.
 *
 * Pure and deterministic: no I/O, no configuration import, output sorted by path. Shared by the evolution
 * snapshots (T4.4), permission diffs (T6.1/T6.3) and accessibility baselines (T7.5).
 */

export type AddedChange = { path: string; value: unknown; summary: string };
export type RemovedChange = { path: string; value: unknown; summary: string };
export type ValueChange = { path: string; before: unknown; after: unknown; summary: string };

export type ChangeSet = {
  added: AddedChange[];
  removed: RemovedChange[];
  changed: ValueChange[];
  /** True when the number of changes reached `maxChanges` and the rest was not listed. */
  truncated: boolean;
};

export type StructuralDiffOptions = {
  /** Normalizer/identity configuration, normally `targetProfile.diff`. */
  config?: DiffConfigInput;
  /** Stop listing after this many changes (default 5000). */
  maxChanges?: number;
  /** Deepest nesting compared (default 30); anything deeper is compared as one opaque value. */
  maxDepth?: number;
};

const DEFAULT_MAX_CHANGES = 5000;
const DEFAULT_MAX_DEPTH = 30;
const IDENTITY_FALLBACKS = ['key', 'id', 'name'] as const;

type Context = {
  normalizers: CompiledNormalizers;
  maxChanges: number;
  maxDepth: number;
  out: ChangeSet;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isScalar = (value: unknown): value is string | number | boolean | null =>
  value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

export function structuralDiff(before: unknown, after: unknown, options: StructuralDiffOptions = {}): ChangeSet {
  const context: Context = {
    normalizers: compileDiffConfig(options.config ?? {}),
    maxChanges: options.maxChanges ?? DEFAULT_MAX_CHANGES,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    out: { added: [], removed: [], changed: [], truncated: false },
  };
  diffValue(before, after, '', '', undefined, 0, context);
  const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  context.out.added.sort(byPath);
  context.out.removed.sort(byPath);
  context.out.changed.sort(byPath);
  return context.out;
}

export const isEmptyChangeSet = (changes: ChangeSet): boolean =>
  changes.added.length === 0 && changes.removed.length === 0 && changes.changed.length === 0;

export const countChanges = (changes: ChangeSet): number => changes.added.length + changes.removed.length + changes.changed.length;

// ---------------------------------------------------------------------------------------------------------------

function total(context: Context): number {
  return context.out.added.length + context.out.removed.length + context.out.changed.length;
}

function full(context: Context): boolean {
  if (total(context) >= context.maxChanges) {
    context.out.truncated = true;
    return true;
  }
  return false;
}

function ignored(path: string, schemaPath: string, context: Context): boolean {
  if (context.normalizers.ignore.length === 0) return false;
  return context.normalizers.ignore.some((regex) => regex.test(schemaPath) || regex.test(path));
}

const joinPath = (parent: string, key: string): string => (parent ? `${parent}.${key}` : key);

function diffValue(before: unknown, after: unknown, path: string, schemaPath: string, property: string | undefined, depth: number, context: Context): void {
  if (full(context) || ignored(path, schemaPath, context)) return;

  if (Array.isArray(before) && Array.isArray(after) && depth < context.maxDepth) {
    diffArray(before, after, path, schemaPath, depth, context);
    return;
  }

  if (isPlainObject(before) && isPlainObject(after) && depth < context.maxDepth) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      const childPath = joinPath(path, key);
      const childSchema = joinPath(schemaPath, key);
      if (ignored(childPath, childSchema, context)) continue;
      const inBefore = Object.prototype.hasOwnProperty.call(before, key);
      const inAfter = Object.prototype.hasOwnProperty.call(after, key);
      if (inBefore && !inAfter) pushRemoved(childPath, before[key], context);
      else if (!inBefore && inAfter) pushAdded(childPath, after[key], context);
      else diffValue(before[key], after[key], childPath, childSchema, key, depth + 1, context);
    }
    return;
  }

  if (!sameLeaf(before, after, property, context)) pushChanged(path, before, after, context);
}

/** Scalars by the normalizers; anything else that reaches here (type change, depth cap) by canonical equality. */
function sameLeaf(before: unknown, after: unknown, property: string | undefined, context: Context): boolean {
  if (isScalar(before) && isScalar(after)) return scalarsEqual(before, after, context.normalizers, property);
  return JSON.stringify(before) === JSON.stringify(after);
}

type Keyed = { key: string; item: unknown };

function diffArray(before: unknown[], after: unknown[], path: string, schemaPath: string, depth: number, context: Context): void {
  const itemSchema = `${schemaPath}[]`;
  const { normalizers } = context;
  const ordered = normalizers.ordered.has(schemaPath);

  if (!ordered) {
    const identity = identityFor(schemaPath, before, after, context);
    if (identity) {
      diffKeyed(before, after, identity, path, itemSchema, depth, context);
      return;
    }
    if (before.every(isScalar) && after.every(isScalar)) {
      diffScalarSet(before, after, path, schemaPath, context);
      return;
    }
  }

  // By position: declared `ordered`, or nothing in the items says who is who.
  const length = Math.max(before.length, after.length);
  for (let index = 0; index < length; index += 1) {
    if (full(context)) return;
    const itemPath = `${path}[${index}]`;
    if (index >= after.length) pushRemoved(itemPath, before[index], context);
    else if (index >= before.length) pushAdded(itemPath, after[index], context);
    else diffValue(before[index], after[index], itemPath, itemSchema, undefined, depth + 1, context);
  }
}

/** The property that identifies the items of this array, or undefined. Declared in the config first. */
function identityFor(schemaPath: string, before: unknown[], after: unknown[], context: Context): string | undefined {
  const items = [...before, ...after];
  if (items.length === 0 || !items.every(isPlainObject)) return undefined;
  const hasKey = (name: string) => items.every((item) => ['string', 'number'].includes(typeof (item as Record<string, unknown>)[name]));
  const declared = context.normalizers.config.identityKeys[schemaPath];
  if (declared) return hasKey(declared) ? declared : undefined;
  return IDENTITY_FALLBACKS.find(hasKey);
}

function keyItems(items: unknown[], identity: string, context: Context): Map<string, unknown> {
  const seen = new Map<string, number>();
  const result = new Map<string, unknown>();
  const keyed: Keyed[] = items.map((item) => ({
    key: normalizeKey(String((item as Record<string, unknown>)[identity]), context.normalizers),
    item,
  }));
  for (const { key, item } of keyed) {
    // Several items that normalize to the same key (grid rows) are told apart by order of appearance: key, key#2, ...
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    result.set(count === 1 ? key : `${key}#${count}`, item);
  }
  return result;
}

function diffKeyed(before: unknown[], after: unknown[], identity: string, path: string, itemSchema: string, depth: number, context: Context): void {
  const beforeItems = keyItems(before, identity, context);
  const afterItems = keyItems(after, identity, context);
  const keys = [...new Set([...beforeItems.keys(), ...afterItems.keys()])].sort();
  for (const key of keys) {
    if (full(context)) return;
    const itemPath = `${path}[${identity}=${key}]`;
    if (ignored(itemPath, itemSchema, context)) continue;
    const inBefore = beforeItems.has(key);
    const inAfter = afterItems.has(key);
    if (inBefore && !inAfter) pushRemoved(itemPath, beforeItems.get(key), context);
    else if (!inBefore && inAfter) pushAdded(itemPath, afterItems.get(key), context);
    else diffValue(beforeItems.get(key), afterItems.get(key), itemPath, itemSchema, undefined, depth + 1, context);
  }
}

/** Scalars as a multiset: `["a","b"]` equals `["b","a"]`, `["a","a"]` does not equal `["a"]`. */
function diffScalarSet(before: unknown[], after: unknown[], path: string, schemaPath: string, context: Context): void {
  const property = schemaPath.split('.').pop()?.replace(/\[\]$/, '');
  const normalize = (value: unknown) =>
    typeof value === 'string' ? (property && context.normalizers.keyProperties.has(property) ? normalizeKey(value, context.normalizers) : value) : value;
  const count = (items: unknown[]) => {
    const map = new Map<string, { value: unknown; n: number }>();
    for (const item of items) {
      const key = JSON.stringify(normalize(item));
      const entry = map.get(key);
      if (entry) entry.n += 1;
      else map.set(key, { value: item, n: 1 });
    }
    return map;
  };
  const beforeCounts = count(before);
  const afterCounts = count(after);
  for (const key of [...new Set([...beforeCounts.keys(), ...afterCounts.keys()])].sort()) {
    if (full(context)) return;
    const b = beforeCounts.get(key);
    const a = afterCounts.get(key);
    const itemPath = `${path}[=${key}]`;
    if (ignored(itemPath, `${schemaPath}[]`, context)) continue;
    // Extra occurrences count as additions/removals of the same value.
    for (let extra = (b?.n ?? 0); extra < (a?.n ?? 0); extra += 1) pushAdded(itemPath, a!.value, context);
    for (let extra = (a?.n ?? 0); extra < (b?.n ?? 0); extra += 1) pushRemoved(itemPath, b!.value, context);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Human-readable text. Short, English, deterministic; T4.5 renders it per language when it needs to.

const LABEL_PROPERTIES = ['label', 'title', 'name', 'text', 'key', 'id'] as const;

/** A short name for a value: its label/title/name when it is an object, otherwise the value itself. */
export function describeValue(value: unknown): string {
  if (isPlainObject(value)) {
    for (const property of LABEL_PROPERTIES) {
      const candidate = value[property];
      if (typeof candidate === 'string' && candidate.length > 0) return truncate(`"${candidate}"`);
    }
    return '{...}';
  }
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (typeof value === 'string') return truncate(JSON.stringify(value));
  return String(value);
}

const truncate = (text: string, max = 60): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function pushAdded(path: string, value: unknown, context: Context): void {
  if (full(context)) return;
  context.out.added.push({ path, value, summary: `+ ${path || '(root)'}: ${describeValue(value)}` });
}

function pushRemoved(path: string, value: unknown, context: Context): void {
  if (full(context)) return;
  context.out.removed.push({ path, value, summary: `- ${path || '(root)'}: ${describeValue(value)}` });
}

function pushChanged(path: string, before: unknown, after: unknown, context: Context): void {
  if (full(context)) return;
  context.out.changed.push({ path: path || '(root)', before, after, summary: `~ ${path || '(root)'}: ${describeValue(before)} -> ${describeValue(after)}` });
}
