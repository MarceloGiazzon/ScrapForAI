import { SECRET_PATTERNS } from '../library/routineLint.js';
import { scanText, maskSpans } from '../security/piiDetectors.js';

/**
 * T3.3: what goes out through a webhook is built from facts of a run (names, ids, counts, an error message), and an error message
 * can carry anything the page printed. So every string is cleaned before it is placed in a message, and the finished payload is
 * checked once more; if that check still finds a secret, nothing is sent (the delivery is recorded as `blocked`).
 *
 * "Secret" here = a value in the credential vault (this includes every webhook URL) or text shaped like a well-known secret (the same
 * shapes the routine lint refuses). Personal data (T7.8: CPF, CNPJ, CI/RUT of Uruguay, cards, e-mails, phones) is MASKED the same way the PII scan masks it,
 * so a message tells that something was there without carrying it.
 */

export const REDACTED = '[REDACTED]';

/** Same rule as the routine lint: a short value would match innocently inside longer text, so it only counts when it is the whole string. */
const MIN_SUBSTRING_SECRET_LENGTH = 6;

const GLOBAL_PATTERNS = SECRET_PATTERNS.map(({ name, pattern }) => ({ name, pattern: new RegExp(pattern.source, 'g') }));

/** Control characters other than newline/tab, and bidirectional overrides (they could reorder what a person reads in a chat). */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g;

export interface Scrubbed {
  text: string;
  /** How many replacements were made (0 = the text was already clean). */
  redactions: number;
}

export function scrubText(text: string, vaultValues: string[], maxLength = 500): Scrubbed {
  let out = text.replace(UNSAFE_CHARS, '');
  let redactions = 0;

  // Longest first, so a value that contains another one is replaced whole.
  for (const secret of [...vaultValues].sort((a, b) => b.length - a.length)) {
    if (secret.length === 0) continue;
    if (out === secret) {
      out = REDACTED;
      redactions += 1;
    } else if (secret.length >= MIN_SUBSTRING_SECRET_LENGTH && out.includes(secret)) {
      redactions += out.split(secret).length - 1;
      out = out.split(secret).join(REDACTED);
    }
  }
  for (const { pattern } of GLOBAL_PATTERNS) {
    out = out.replace(pattern, () => {
      redactions += 1;
      return REDACTED;
    });
  }

  // T7.8: personal data that is not a secret (secrets were replaced above) keeps its shape but loses its value.
  const personal = scanText(out);
  if (personal.length > 0) {
    out = maskSpans(out, personal);
    redactions += personal.length;
  }

  if (out.length > maxLength) out = `${out.slice(0, maxLength - 1)}…`;
  return { text: out, redactions };
}

/** Why a string must not leave the server, or undefined when it is clean. Never echoes the string. */
export function leakIn(text: string, vaultValues: string[]): string | undefined {
  for (const secret of vaultValues) {
    if (secret.length === 0) continue;
    if (text === secret || (secret.length >= MIN_SUBSTRING_SECRET_LENGTH && text.includes(secret))) return 'a credential vault value';
  }
  const known = GLOBAL_PATTERNS.find(({ pattern }) => new RegExp(pattern.source).test(text));
  return known ? known.name : undefined;
}

/** The first leak in any string of a JSON-like value (keys included), or undefined. */
export function findLeak(value: unknown, vaultValues: string[]): string | undefined {
  if (typeof value === 'string') return leakIn(value, vaultValues);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findLeak(item, vaultValues);
      if (found) return found;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const found = leakIn(key, vaultValues) ?? findLeak(item, vaultValues);
      if (found) return found;
    }
  }
  return undefined;
}
