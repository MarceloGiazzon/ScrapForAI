import { diffConfigSchema, type DiffConfig, type DiffConfigInput } from '../schemas/diffConfig.schema.js';

/**
 * T4.1 normalizers: pure functions that turn "what the page said this time" into "what it means", so two
 * renders of the same screen compare equal. No configuration import on purpose: they run anywhere (CLI, tests).
 */

/**
 * User patterns only run on strings up to this length, so a hostile or accidental huge value cannot stall a diff
 * with a catastrophic pattern. A longer string is NOT truncated (that would hide a difference past the cut): it is
 * compared as it is, unmasked.
 */
export const MAX_TEXT_FOR_PATTERNS = 2000;

/** GeneXus grid row suffix: `vNAME_0001`. */
const GRID_ROW_SUFFIX = /_\d{4}$/;
/** GeneXus web component prefix: `W0012vNAME`, also stacked `W0012W0003vNAME`; the prefix alone is left as it is. */
const WEB_COMPONENT_PREFIX = /(^|[^A-Za-z0-9])(?:W\d{4})+(?=[A-Za-z_])/g;

export type CompiledNormalizers = {
  config: DiffConfig;
  masks: { regex: RegExp; replacement: string }[];
  keyProperties: Set<string>;
  ignore: RegExp[];
  ordered: Set<string>;
};

export function compileDiffConfig(input: DiffConfigInput | DiffConfig = {}): CompiledNormalizers {
  const config = diffConfigSchema.parse(input);
  return {
    config,
    masks: config.maskPatterns.map((mask) => ({
      regex: new RegExp(mask.pattern, `${mask.flags ?? ''}g`),
      replacement: mask.replacement,
    })),
    keyProperties: new Set(config.keyProperties),
    ignore: config.ignorePaths.map(globToRegExp),
    ordered: new Set(config.ordered),
  };
}

/** `*` = anything inside one segment (no dot), `**` = anything. Anchored at both ends. */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === '*') {
      if (glob[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^.]*';
      }
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/** Dynamic text -> constants (the configured mask patterns). */
export function maskText(text: string, normalizers: CompiledNormalizers): string {
  if (text.length > MAX_TEXT_FOR_PATTERNS) return text;
  let result = text;
  for (const mask of normalizers.masks) {
    mask.regex.lastIndex = 0;
    result = result.replace(mask.regex, mask.replacement);
  }
  return result;
}

/**
 * The stable name of a control: GeneXus row suffix and web-component prefix removed, then the mask patterns.
 * Used for identities and for the properties listed in `keyProperties` (and by T7.4 for an axe `targetKey`).
 */
export function normalizeKey(value: string, normalizers: CompiledNormalizers): string {
  let result = value;
  if (normalizers.config.webComponentPrefix) result = result.replace(WEB_COMPONENT_PREFIX, '$1');
  if (normalizers.config.gridRowSuffix) result = result.replace(GRID_ROW_SUFFIX, '');
  return maskText(result, normalizers);
}

/** Equality of two scalars under the configured tolerance. Strings are compared after masking. */
export function scalarsEqual(before: unknown, after: unknown, normalizers: CompiledNormalizers, property?: string): boolean {
  if (typeof before === 'number' && typeof after === 'number') {
    if (before === after) return true;
    const { absolute, relative } = normalizers.config.numericTolerance;
    const delta = Math.abs(before - after);
    if (delta <= absolute) return true;
    return relative > 0 && delta <= relative * Math.max(Math.abs(before), Math.abs(after));
  }
  if (typeof before === 'string' && typeof after === 'string') {
    if (before === after) return true;
    const isKey = property !== undefined && normalizers.keyProperties.has(property);
    const normalize = (text: string) => (isKey ? normalizeKey(text, normalizers) : maskText(text, normalizers));
    return normalize(before) === normalize(after);
  }
  return Object.is(before, after);
}
