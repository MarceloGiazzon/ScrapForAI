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

// ---- documents --------------------------------------------------------------------------------------------------------------

export type DocumentKind = 'ci-uy' | 'rut-uy' | 'cpf' | 'cnpj';
type DocumentGenerator = Extract<Generator, { type: 'document' }>;

const digitsOf = (rng: Rng, count: number): number[] => Array.from({ length: count }, () => intBetween(rng, 0, 9));
const weighted = (digits: number[], weights: number[]): number => digits.reduce((total, digit, index) => total + digit * weights[index]!, 0);

/** Check digits of a CPF: mod 11 over weights 10..2 then 11..2; a remainder of 10 is 0. */
function cpfCheckDigits(base: number[]): number[] {
  const first = ((weighted(base, [10, 9, 8, 7, 6, 5, 4, 3, 2]) * 10) % 11) % 10;
  const second = ((weighted([...base, first], [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]) * 10) % 11) % 10;
  return [first, second];
}

const CNPJ_W1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const CNPJ_W2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
function cnpjCheckDigits(base: number[]): number[] {
  const dv = (digits: number[], weights: number[]) => {
    const rest = weighted(digits, weights) % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  const first = dv(base, CNPJ_W1);
  return [first, dv([...base, first], CNPJ_W2)];
}

/** Uruguayan cédula: 7 digits + 1, weights 2,9,8,7,6,3,4, the check digit completes the sum to a multiple of 10. */
const ciCheckDigit = (base: number[]): number => (10 - (weighted(base, [2, 9, 8, 7, 6, 3, 4]) % 10)) % 10;

/** Uruguayan RUT: 12 digits, weights 4,3,2,9,8,7,6,5,4,3,2 over the first 11, mod 11. A remainder that would make the digit 10 does not exist. */
function rutCheckDigit(base: number[]): number | undefined {
  const dv = 11 - (weighted(base, [4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) % 11);
  return dv === 10 ? undefined : dv === 11 ? 0 : dv;
}

const LENGTHS: Record<DocumentKind, number> = { cpf: 11, cnpj: 14, 'ci-uy': 8, 'rut-uy': 12 };

/** All digits of a correct document, check digits included. */
function validDocumentDigits(kind: DocumentKind, rng: Rng): number[] {
  for (;;) {
    switch (kind) {
      case 'cpf': {
        const base = digitsOf(rng, 9);
        if (new Set(base).size === 1) continue; // 111.111.111-11 passes the arithmetic and is rejected by every validator
        return [...base, ...cpfCheckDigits(base)];
      }
      case 'cnpj': {
        const base = [...digitsOf(rng, 8), 0, 0, 0, 1];
        return [...base, ...cnpjCheckDigits(base)];
      }
      case 'ci-uy': {
        const base = [intBetween(rng, 1, 6), ...digitsOf(rng, 6)];
        return [...base, ciCheckDigit(base)];
      }
      default: {
        const prefix = intBetween(rng, 1, 22); // 01..22, the first two digits of a RUT
        const base = [Math.floor(prefix / 10), prefix % 10, ...digitsOf(rng, 6), 0, 0, 1];
        const dv = rutCheckDigit(base);
        if (dv === undefined) continue;
        return [...base, dv];
      }
    }
  }
}

/** True when `text` is a correct document of that kind (separators `. - /` and spaces are ignored). Used by the tests and by anyone who wants to check. */
export function isValidDocument(kind: DocumentKind, text: string): boolean {
  if (/[^0-9.\-/ ]/.test(text)) return false;
  const digits = [...text.replace(/[^0-9]/g, '')].map(Number);
  if (digits.length !== LENGTHS[kind]) return false;
  switch (kind) {
    case 'cpf':
      return new Set(digits).size > 1 && cpfCheckDigits(digits.slice(0, 9)).join('') === digits.slice(9).join('');
    case 'cnpj':
      // 00.000.000/0001-91 (a real, valid CNPJ) has a base of zeros; only fourteen identical digits are rejected.
      return new Set(digits).size > 1 && cnpjCheckDigits(digits.slice(0, 12)).join('') === digits.slice(12).join('');
    case 'ci-uy':
      return ciCheckDigit(digits.slice(0, 7)) === digits[7];
    default:
      return rutCheckDigit(digits.slice(0, 11)) === digits[11];
  }
}

function formatDocument(kind: DocumentKind, digits: string): string {
  switch (kind) {
    case 'cpf':
      return digits.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
    case 'cnpj':
      return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
    case 'ci-uy':
      return digits.replace(/^(\d)(\d{3})(\d{3})(\d)$/, '$1.$2.$3-$4');
    default:
      return digits;
  }
}

/** Changes the LAST digit to a different one. The last check digit is fully determined by the rest, so the result can never be valid. */
function withWrongCheckDigit(digits: number[], rng: Rng): number[] {
  const wrong = (digits[digits.length - 1]! + 1 + intBetween(rng, 0, 8)) % 10;
  return [...digits.slice(0, -1), wrong];
}

function documentValue(generator: DocumentGenerator, rng: Rng): string {
  const valid = validDocumentDigits(generator.kind, rng);
  const digits = (generator.valid ? valid : withWrongCheckDigit(valid, rng)).join('');
  return generator.formatted ? formatDocument(generator.kind, digits) : digits;
}

function documentEdges(generator: DocumentGenerator): string[] {
  // A valid document has no "edge" worth ordering ahead of the others. An INVALID one has the usual ways validation is fooled.
  if (generator.valid) return [];
  const rng = createRng(`edge:document:${generator.kind}`);
  const valid = validDocumentDigits(generator.kind, rng);
  const plain = valid.join('');
  return [
    '',
    plain.slice(0, -1),
    `${plain}0`,
    'A'.repeat(plain.length),
    (generator.formatted ? formatDocument(generator.kind, withWrongCheckDigit(valid, rng).join('')) : withWrongCheckDigit(valid, rng).join('')),
  ];
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
    case 'document':
      values = documentEdges(generator);
      break;
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
    case 'document':
      return documentValue(generator, rng);
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
