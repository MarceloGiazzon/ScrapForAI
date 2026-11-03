import { structuralDiff, type ChangeSet, type StructuralDiffOptions } from '../diff/structuralDiff.js';
import type { ScreenInventory } from '../schemas/screenInventory.schema.js';

/**
 * Two inventories of the same screen, compared by control key: a field that moved is not a change, a field that
 * became required is. The target profile's `diff` configuration applies on top of the inventory identities.
 */
export const INVENTORY_IDENTITY_KEYS = { fields: 'key', actions: 'key', grids: 'key' } as const;

export function diffInventories(before: ScreenInventory, after: ScreenInventory, options: StructuralDiffOptions = {}): ChangeSet {
  return structuralDiff(before, after, {
    ...options,
    config: {
      ...options.config,
      identityKeys: { ...INVENTORY_IDENTITY_KEYS, ...options.config?.identityKeys },
    },
  });
}
