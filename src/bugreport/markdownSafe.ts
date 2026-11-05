/**
 * T9.1: the report becomes the text of a GitHub issue, and part of that text comes from a page the tool does not control (an error message,
 * a console line, a label). In an issue that text could mention a person (`@name` sends them a notification), link an issue (`#123`), put in an
 * image or a link (`![x](https://...)`, `<img>`) or break out of the structure of the report. So:
 *   - everything that comes from outside goes inside a code span or a code block, where none of those has any effect;
 *   - the fence is always LONGER than any run of backticks in the text, so the text cannot close it;
 *   - the title (which cannot hold a code block) has those characters removed.
 * Pure.
 */

const longestBacktickRun = (text: string): number => {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return longest;
};

/** A code block whose fence the text cannot close. */
export function fenced(text: string, info = 'text'): string {
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${fence}${info}\n${text}\n${fence}`;
}

/** A single-line code span whose delimiter the text cannot close. Empty text reads as `(none)`. */
export function inlineCode(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return '`(none)`';
  const ticks = '`'.repeat(longestBacktickRun(flat) + 1);
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${flat}${pad}${ticks}`;
}

/** Plain text for a place with no code formatting (the issue title): no mention, reference, markup or link characters, one line. */
export function titleSafe(text: string, maxLength: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001F\u007F<>@#`\\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength - 1)}…` : flat;
}
