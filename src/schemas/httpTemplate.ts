/**
 * T5.7 follow-up: parameters inside an `httpRequest` `url` and `body`. Pure, no configuration import (the request schema, the
 * parameter machinery, the include expander and the runner all read it).
 *
 * A placeholder is `{{name}}` where `name` is a parameter of the run (same names as `valueFromParameter`), optionally with an encoding
 * after a bar: `{{name|json}}` (a JSON string literal, quotes and escapes included) or `{{name|url}}` (percent-encoded).
 *  - in the `url` every placeholder is percent-encoded (`encodeURIComponent`), whatever is written, so a value cannot add a path
 *    segment, a query parameter or a host; only the bare form is accepted there;
 *  - in the `body` a bare `{{name}}` is the value AS IS (a number stays a number: `{"qty": {{qty}}}`), `|json` makes a string literal,
 *    `|url` serves a `application/x-www-form-urlencoded` body. A hostile value in a bare slot may break the body: that is the test.
 * Anything that is not exactly this shape (a single brace, `{{ a b }}`, `{{name|xml}}`) is literal text, so JSON bodies are untouched.
 * The value is never part of the stored routine: the step keeps the placeholder, the run draws the value.
 */

export type TemplateEncoding = 'raw' | 'json' | 'url';
export type TemplateField = 'url' | 'body';

export interface Placeholder {
  name: string;
  encoding: TemplateEncoding;
}

const PLACEHOLDER = /\{\{([a-zA-Z0-9_-]{1,80})(?:\|(json|url))?\}\}/g;

/** Every placeholder of a text, in order, repeats included. */
export function placeholdersOf(text: string | undefined): Placeholder[] {
  if (text === undefined || !text.includes('{{')) return [];
  return [...text.matchAll(PLACEHOLDER)].map((match) => ({ name: match[1]!, encoding: (match[2] as 'json' | 'url' | undefined) ?? 'raw' }));
}

/** The distinct parameter names a text refers to. */
export function placeholderNames(text: string | undefined): string[] {
  return [...new Set(placeholdersOf(text).map((placeholder) => placeholder.name))];
}

/** Problems of the encodings used in a field (the url takes the bare form only). Empty = fine. */
export function placeholderProblems(text: string | undefined, field: TemplateField): string[] {
  if (field === 'body') return [];
  return placeholdersOf(text)
    .filter((placeholder) => placeholder.encoding !== 'raw')
    .map((placeholder) => `{{${placeholder.name}|${placeholder.encoding}}}: in the url every value is percent-encoded already, write {{${placeholder.name}}}`);
}

/** Renames the parameters a text refers to (an included routine's parameters, `qty` -> `a_qty`). Unmapped names stay. */
export function renamePlaceholders(text: string, scope: ReadonlyMap<string, string>): string {
  if (scope.size === 0 || !text.includes('{{')) return text;
  return text.replace(PLACEHOLDER, (whole, name: string, encoding: string | undefined) => {
    const renamed = scope.get(name);
    return renamed === undefined ? whole : `{{${renamed}${encoding ? `|${encoding}` : ''}}}`;
  });
}

const encode = (value: string, encoding: TemplateEncoding): string => {
  if (encoding === 'json') return JSON.stringify(value);
  if (encoding === 'url') return encodeURIComponent(value);
  return value;
};

export class MissingPlaceholderValue extends Error {
  constructor(readonly parameter: string) {
    super(`parameter "${parameter}" has no value in this run`);
    this.name = 'MissingPlaceholderValue';
  }
}

/**
 * Fills the placeholders. Values are taken from `values` by name; a name without a value throws (never an empty string: a request with a hole
 * in it would be a different test). The substitution is one pass over the TEXT, so a value that itself looks like `{{other}}` is not expanded.
 */
export function fillPlaceholders(text: string, values: Readonly<Record<string, string>>, field: TemplateField): string {
  if (!text.includes('{{')) return text;
  return text.replace(PLACEHOLDER, (_whole, name: string, encodingText: string | undefined) => {
    const value = Object.hasOwn(values, name) ? values[name] : undefined;
    if (value === undefined) throw new MissingPlaceholderValue(name);
    return encode(value, field === 'url' ? 'url' : ((encodingText as 'json' | 'url' | undefined) ?? 'raw'));
  });
}
