import { z } from 'zod';

/**
 * T4.1: how two JSON documents (screen inventories, permission matrices, accessibility results...) are compared.
 * Lives in a target profile (`diff`) because what counts as noise is a property of the application: a GeneXus
 * app renders `vNAME_0001`, `vNAME_0002` for grid rows and `W0012vNAME` inside web components, an ERP prints
 * session numbers in titles, and so on.
 *
 * Everything here is data, never code. Patterns are regular expressions of bounded length applied to bounded text
 * (see `MAX_TEXT_FOR_PATTERNS` in the normalizers), and a pattern that does not compile is refused at save time.
 */
const compilable = (value: string): boolean => {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
};

export const maskPatternSchema = z
  .object({
    pattern: z.string().min(1).max(200).refine(compilable, { message: 'pattern is not a valid regular expression' }),
    flags: z
      .string()
      .max(5)
      .regex(/^[imsu]*$/, 'flags: any of i, m, s, u')
      .optional(),
    // What every match becomes before comparing. A constant, so two different dynamic ids compare equal.
    replacement: z.string().max(40).default('#'),
  })
  .strict();

export const diffConfigSchema = z
  .object({
    // Array identity: generic path of the array ("fields", "grids", "grids[].columns") -> property that identifies an item.
    // An array with no declared key falls back to a `key`, `id` or `name` found on every item, then to position.
    identityKeys: z.record(z.string().min(1).max(200), z.string().min(1).max(100)).default({}),
    // Arrays whose ORDER is part of the meaning (for example wizard steps): compared by position.
    ordered: z.array(z.string().min(1).max(200)).max(100).default([]),
    // Dynamic text -> constant: ids with a counter, dates, session numbers.
    maskPatterns: z.array(maskPatternSchema).max(50).default([]),
    // GeneXus grid rows: `vNAME_0001`, `vNAME_0002` -> `vNAME`.
    gridRowSuffix: z.boolean().default(true),
    // GeneXus web components: `W0012vNAME` -> `vNAME`.
    webComponentPrefix: z.boolean().default(true),
    // Properties whose string value is a control name/selector: the two GeneXus rules above apply to them and to identities.
    keyProperties: z.array(z.string().min(1).max(100)).max(50).default(['key', 'id', 'name', 'selector', 'targetKey']),
    // Two numbers closer than this are the same value (a measured time, a rounded amount).
    numericTolerance: z
      .object({ absolute: z.number().min(0).default(0), relative: z.number().min(0).max(1).default(0) })
      .strict()
      .default({ absolute: 0, relative: 0 }),
    // Paths ignored entirely. `*` = anything inside one segment, `**` = anything. Tested against the generic path
    // (`fields[].id`) and the full path (`fields[key=cep].id`).
    ignorePaths: z.array(z.string().min(1).max(200)).max(200).default([]),
  })
  .strict();

export type DiffConfig = z.infer<typeof diffConfigSchema>;
export type DiffConfigInput = z.input<typeof diffConfigSchema>;
