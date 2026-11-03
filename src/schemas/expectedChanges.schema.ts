import { z } from 'zod';

import { buildIdSchema } from './explorationRequest.schema.js';

/**
 * T4.7: the changes a build is SUPPOSED to contain. `<SYSTEM_EVOLUTION_DIR>/<target>/expected/<build>.json`, in the same
 * repository as the snapshots, so a release declares its intent where it can be reviewed. A change the diff finds that no entry
 * covers is unexpected: "I touched one screen and broke another".
 */
export const expectedEntrySchema = z
  .object({
    // Catalogue screen id, or "*" for any screen.
    screen: z.string().min(1).max(52),
    // What happened to it: the whole screen appeared/disappeared, something inside it changed, or any of those.
    kind: z.enum(['added', 'removed', 'changed', '*']).default('*'),
    // Where inside the screen, as the diff reports it (`fields[key=phone]`, `grids[key=orders].columns[="Total"]`).
    // `*` matches inside one segment, `**` anything; absent = anywhere in the screen.
    path: z.string().min(1).max(300).optional(),
    // Why: a ledger item, a ticket, a sentence. Shown next to the change it covers.
    ref: z.string().min(1).max(200).optional(),
    note: z.string().min(1).max(500).optional(),
  })
  .strict();

export const expectedChangesSchema = z
  .object({
    buildId: buildIdSchema,
    expected: z.array(expectedEntrySchema).max(500),
  })
  .strict();

export type ExpectedEntry = z.infer<typeof expectedEntrySchema>;
export type ExpectedChanges = z.infer<typeof expectedChangesSchema>;
