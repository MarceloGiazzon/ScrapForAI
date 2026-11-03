import { z } from 'zod';

import { safeName } from './explorationRequest.schema.js';

/**
 * T4.3 / Appendix A.10: what a screen IS, never what it HOLDS. No field value, no cell text and no typed text
 * appears anywhere in this shape: it is what makes an inventory comparable between builds (little noise) and
 * safe to keep in git (no PII).
 */
export const inventoryFieldSchema = z
  .object({
    key: z.string().min(1).max(200),
    label: z.string().max(200).optional(),
    type: z.string().max(60),
    required: z.boolean(),
    enabled: z.boolean(),
    visible: z.boolean(),
    maxLength: z.number().int().nonnegative().optional(),
    // Labels of a select's options. Never a typed value.
    options: z.array(z.string().max(200)).max(200).optional(),
  })
  .strict();

export const inventoryActionSchema = z
  .object({
    key: z.string().min(1).max(200),
    label: z.string().max(200).optional(),
    enabled: z.boolean(),
  })
  .strict();

export const inventoryGridSchema = z
  .object({
    key: z.string().min(1).max(200),
    columns: z.array(z.string().max(200)).max(200),
  })
  .strict();

export const screenInventorySchema = z
  .object({
    screenId: safeName,
    title: z.string().max(300).optional(),
    fields: z.array(inventoryFieldSchema).max(1000),
    actions: z.array(inventoryActionSchema).max(1000),
    grids: z.array(inventoryGridSchema).max(100),
    // Controls that had nothing to build a stable key from (no id, name or label): counted, not listed.
    unkeyed: z.number().int().nonnegative().default(0),
  })
  .strict();

export type InventoryField = z.infer<typeof inventoryFieldSchema>;
export type InventoryAction = z.infer<typeof inventoryActionSchema>;
export type InventoryGrid = z.infer<typeof inventoryGridSchema>;
export type ScreenInventory = z.infer<typeof screenInventorySchema>;
