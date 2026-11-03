import type { Generator, Parameter } from '../schemas/parameters.schema.js';
import { createRng, intBetween, pick, type Rng } from './prng.js';

/**
 * T5.3 value generators. Pure and deterministic: the same parameter, seed and sample index always give the same value.
 *
 * Every generator has an ordered list of EDGE values (valores de borda) that come before any random one, because that is where
 * validation bugs live: the limits, one step outside them, zero, negative, empty and the maximum length. Values just outside the
 * range (`min-1`, `max+1`, a too-long string) are INTENDED: they test that the application rejects them. A test that wants only
 * valid input uses `includeBoundaries: false` or `oneOf`/`cases`.
 */

const DAY_MS = 86_400_000;

// ---- numbers ----------------------------------------------------------------------------------------------------------------

const factor = (scale: number): number => 10 ** scale;
const fixed = (scaled: number, scale: number): string => (scaled / factor(scale)).toFixed(scale);

function decimalEdges(generator: Extract<Generator, { type: 'decimal' }>): string[] {
  const { scale } = generator;
  const f = factor(scale);
  const min = Math.round(generator.min * f);
  const max = Math.round(generator.max * f);
  return [min, min - 1, max, max + 1, 0, -1].map((scaled) => fixed(scaled, scale));
}

// ---- dates ------------------------------------------------------------------------------------------------------------------

const parseIso = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);

export function formatDate(ms: number, format: string): string {
  const date = new Date(ms);
  const yyyy = String(date.getUTCFullYear()).padStart(4, '0');
  const pad = (n: number) => String(n).padStart(2, '0');
  return format.replace(/yyyy|yy|MM|dd/g, (token) => {
    switch (token) {
      case 'yyyy':
        return yyyy;
      case 'yy':
        return yyyy.slice(-2);
      case 'MM':
        return pad(date.getUTCMonth() + 1);
      default:
        return pad(date.getUTCDate());
    }
  });
}

// ---- strings ----------------------------------------------------------------------------------------------------------------

const ALPHA = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'];
const ALNUM = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'];
// Accents, ñ/ç, Greek, Cyrillic, CJK, Hebrew and an emoji: what breaks code that assumes ASCII or one UTF-16 unit per character.
const UNICODE = [...'áéíóúüñçÁÉÍÓÚÑÇßøåæœ'.concat('αβγδΩЖДЯшщ', '日本語中文한국어', 'שלום', '😀🚀')];
/** What a hostile string is made of: quotes, markup, an injection, format directives, emoji, a right-to-left override. */
export const HOSTILE_FRAGMENTS: readonly string[] = [
  `'`,
  `"`,
  `<script>alert(1)</script>`,
  `'; DROP TABLE users;--`,
  `%s%n%x`,
  `😀👨‍👩‍👧`,
  `‮evil`,
  `../../etc/passwd`,
  `{{7*7}}`,
  `\\`,
];

/** Length is counted in characters (code points), so a surrogate pair is never cut in half. */
function stringOf(length: number, charset: 'alpha' | 'alnum' | 'unicode' | 'hostile', rng: Rng): string {
  if (length <= 0) return '';
  if (charset === 'hostile') {
    const points: string[] = [];
    let at = intBetween(rng, 0, HOSTILE_FRAGMENTS.length - 1);
    while (points.length < length) {
      points.push(...HOSTILE_FRAGMENTS[at % HOSTILE_FRAGMENTS.length]!);
      at += 1;
    }
    return points.slice(0, length).join('');
  }
  const pool = charset === 'alpha' ? ALPHA : charset === 'alnum' ? ALNUM : UNICODE;
  let out = '';
  for (let i = 0; i < length; i += 1) out += pick(rng, pool);
  return out;
}

// ---- the generators ---------------------------------------------------------------------------------------------------------

/** The edge values of a generator, in the order a run should try them, without repeats. */
export function boundaryValues(generator: Generator): string[] {
  let values: string[];
  switch (generator.type) {
    case 'int':
      values = [generator.min, generator.min - 1, generator.max, generator.max + 1, 0, -1].map(String);
      break;
    case 'decimal':
      values = decimalEdges(generator);
      break;
    case 'date': {
      const from = parseIso(generator.from);
      const to = parseIso(generator.to);
      values = [from, from - DAY_MS, to, to + DAY_MS].map((ms) => formatDate(ms, generator.format));
      values.push('');
      break;
    }
    case 'string': {
      const rng = createRng(`edge:${generator.charset}`);
      const lengths = [0, generator.minLength, generator.minLength - 1, generator.maxLength, generator.maxLength + 1].filter((n) => n >= 0);
      values = lengths.map((length) => stringOf(length, generator.charset, rng));
      break;
    }
    default:
      values = [...generator.values];
  }
  return [...new Set(values)];
}

/** A random value inside the valid range of the generator. */
export function randomValue(generator: Generator, rng: Rng): string {
  switch (generator.type) {
    case 'int':
      return String(intBetween(rng, generator.min, generator.max));
    case 'decimal': {
      const f = factor(generator.scale);
      const low = Math.ceil(generator.min * f);
      const high = Math.floor(generator.max * f);
      return fixed(low > high ? Math.round(generator.min * f) : intBetween(rng, low, high), generator.scale);
    }
    case 'date': {
      const from = parseIso(generator.from);
      const days = Math.round((parseIso(generator.to) - from) / DAY_MS);
      return formatDate(from + intBetween(rng, 0, days) * DAY_MS, generator.format);
    }
    case 'string':
      return stringOf(intBetween(rng, generator.minLength, generator.maxLength), generator.charset, rng);
    default:
      return pick(rng, generator.values);
  }
}

export interface GeneratedValue {
  value: string;
  source: 'boundary' | 'random' | 'case';
  /** Position in that stream: edge number, random draw number or case number. */
  index: number;
}

/**
 * The `index`-th value of a parameter for a seed. Edge values first (unless `includeBoundaries` is false), then random ones; the
 * random value of position n depends only on (seed, name, n), never on what was drawn before, so any sample can be replayed alone.
 */
export function valueAt(parameter: Parameter, index: number, seed: string): GeneratedValue {
  if ('cases' in parameter) {
    return { value: parameter.cases[index % parameter.cases.length]!, source: 'case', index: index % parameter.cases.length };
  }
  const edges = parameter.includeBoundaries ? boundaryValues(parameter.generator) : [];
  if (index < edges.length) return { value: edges[index]!, source: 'boundary', index };
  const draw = index - edges.length;
  return { value: randomValue(parameter.generator, createRng(`${seed}|${parameter.name}|${draw}`)), source: 'random', index: draw };
}

/** How many edge values a parameter has before its random ones begin (cases: all of them, they cycle). */
export function edgeCount(parameter: Parameter): number {
  if ('cases' in parameter) return parameter.cases.length;
  return parameter.includeBoundaries ? boundaryValues(parameter.generator).length : 0;
}
