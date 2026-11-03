import { compileDiffConfig, normalizeKey, type CompiledNormalizers } from '../diff/normalizers.js';
import type { DiffConfig, DiffConfigInput } from '../schemas/diffConfig.schema.js';
import {
  screenInventorySchema,
  type InventoryAction,
  type InventoryField,
  type InventoryGrid,
  type ScreenInventory,
} from '../schemas/screenInventory.schema.js';

/**
 * T4.3: a ScreenInventory from what `inspect_dom` reports with `includeStructure`.
 *
 * Pure. The input type is structural (not imported from the runner) so this runs without Playwright. The input
 * never contains a value, and nothing here reads one: that is the whole safety argument.
 *
 * KEY DERIVATION (generic, until T8.3 teaches it GeneXus): `name`, else `id`, else a slug of the label, then the
 * same normalizers the diff uses (grid row suffix, web-component prefix, masks). Several controls that end up with
 * one key are told apart in document order (`key`, `key#2`...), except radio buttons, which are ONE field.
 */

export type StructureInput = {
  fields: {
    id?: string;
    name?: string;
    tag?: string;
    type: string;
    label?: string;
    required: boolean;
    enabled: boolean;
    visible: boolean;
    maxLength?: number;
    options?: string[];
  }[];
  actions: { id?: string; name?: string; tag?: string; label?: string; enabled: boolean; visible: boolean }[];
  tables: { id?: string; name?: string; caption?: string; columns: string[] }[];
};

export type DeriveInventoryOptions = {
  screenId: string;
  title?: string;
  /** Target profile `diff` configuration: the same normalizers the diff will apply. */
  config?: DiffConfigInput | DiffConfig;
  /** Leave out controls that are not visible (default: keep them, with `visible: false`). */
  visibleOnly?: boolean;
};

const slug = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

function keyFor(
  source: { id?: string; name?: string; label?: string },
  prefix: string,
  normalizers: CompiledNormalizers,
): string | undefined {
  const raw = source.name || source.id;
  if (raw) {
    const key = normalizeKey(raw, normalizers);
    if (key) return key;
  }
  const fromLabel = source.label ? slug(source.label) : '';
  return fromLabel ? `${prefix}:${fromLabel}` : undefined;
}

/** Same key twice: document order tells them apart. */
function uniqueKey(key: string, seen: Map<string, number>): string {
  const count = (seen.get(key) ?? 0) + 1;
  seen.set(key, count);
  return count === 1 ? key : `${key}#${count}`;
}

const byKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

export function deriveScreenInventory(structure: StructureInput, options: DeriveInventoryOptions): ScreenInventory {
  const normalizers = compileDiffConfig(options.config ?? {});
  const keep = <T extends { visible: boolean }>(item: T) => !options.visibleOnly || item.visible;
  let unkeyed = 0;

  const fields: InventoryField[] = [];
  const fieldsByKey = new Map<string, InventoryField>();
  const fieldSeen = new Map<string, number>();
  for (const source of structure.fields.filter(keep)) {
    const key = keyFor(source, 'field', normalizers);
    if (!key) {
      unkeyed += 1;
      continue;
    }
    const field: InventoryField = {
      key,
      ...(source.label ? { label: source.label } : {}),
      type: source.type,
      required: source.required,
      enabled: source.enabled,
      visible: source.visible,
      ...(source.maxLength !== undefined ? { maxLength: source.maxLength } : {}),
      ...(source.options ? { options: source.options } : {}),
    };
    const existing = fieldsByKey.get(key);
    if (existing && source.type === 'radio' && existing.type === 'radio') {
      // One radio group, one field: the group is required/enabled/visible if any member is.
      existing.required ||= field.required;
      existing.enabled ||= field.enabled;
      existing.visible ||= field.visible;
      continue;
    }
    field.key = uniqueKey(key, fieldSeen);
    fieldsByKey.set(field.key, field);
    fields.push(field);
  }

  const actions: InventoryAction[] = [];
  const actionSeen = new Map<string, number>();
  for (const source of structure.actions.filter(keep)) {
    const key = keyFor(source, 'action', normalizers);
    if (!key) {
      unkeyed += 1;
      continue;
    }
    actions.push({
      key: uniqueKey(key, actionSeen),
      ...(source.label ? { label: source.label } : {}),
      enabled: source.enabled,
    });
  }

  const grids: InventoryGrid[] = [];
  const gridSeen = new Map<string, number>();
  for (const source of structure.tables) {
    const key = keyFor({ id: source.id, name: source.name, label: source.caption }, 'grid', normalizers);
    if (!key) {
      unkeyed += 1;
      continue;
    }
    grids.push({ key: uniqueKey(key, gridSeen), columns: source.columns.filter((column) => column.length > 0) });
  }

  return screenInventorySchema.parse({
    screenId: options.screenId,
    ...(options.title ? { title: options.title.slice(0, 300) } : {}),
    fields: fields.sort(byKey),
    actions: actions.sort(byKey),
    grids: grids.sort(byKey),
    unkeyed,
  });
}
