import { createHmac } from 'node:crypto';

import { isValidDocument } from '../generators/generators.js';
import { SECRET_PATTERNS } from '../library/routineLint.js';

/**
 * T7.8: what looks like personal data or a secret in text that came out of a page. PURE: no I/O, no configuration, no browser. The runner side
 * (src/runner/piiScanner.ts) decides WHERE to look; this file decides WHAT counts.
 *
 * Rules that shape everything here:
 *  - The patterns are OURS and bounded (no nested quantifiers; the text is cut at MAX_SCAN_CHARS), because the text comes from a page the
 *    caller does not control. Never accept a caller regex.
 *  - A document needs a correct check digit (CPF, CNPJ, CI/RUT of Uruguay) and a card needs Luhn: a random digit run is not reported.
 *  - The RAW value never leaves this module in a finding: the caller gets a masked sample and a keyed fingerprint (HMAC-SHA256), not the value.
 *    A plain sha256 of an 11-digit CPF can be reversed by trying every CPF, so the fingerprint is keyed with a secret of the installation.
 */

export const PII_DETECTORS = [
  'cpf',
  'cnpj',
  'ci-uy',
  'rut-uy',
  'card',
  'email',
  'phone-uy',
  'jwt',
  'bearer',
  'api-key',
  'secret-named',
  'known-secret',
  'cookie-no-httponly',
] as const;
export type PiiDetector = (typeof PII_DETECTORS)[number];

export const PII_SURFACES = ['url', 'console', 'storage', 'cookie', 'response-body', 'hidden-input'] as const;
export type PiiSurface = (typeof PII_SURFACES)[number];

/** Longest text scanned in one call. Longer text is cut, never skipped: the start of a page is where a leak usually is. */
export const MAX_SCAN_CHARS = 200_000;
const MAX_MATCHES_PER_TEXT = 100;
/** A short secret would match innocently inside longer text (same rule as the routine lint), so it only counts when it is the whole text. */
const MIN_SUBSTRING_SECRET_LENGTH = 6;

export interface RawMatch {
  detector: PiiDetector;
  start: number;
  end: number;
  /** The matched text. Used to mask and fingerprint; NEVER copy it into a finding. */
  raw: string;
}

// --- check-digit helpers -------------------------------------------------------------------------------------------------------------------

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

const onlyDigits = (text: string): string => text.replace(/\D/g, '');

/** CI of Uruguay: the number (6 or 7 digits, a 6-digit one has a leading zero) + a check digit. Issued numbers are below 7,000,000 today. */
function validCiUy(raw: string): boolean {
  const digits = onlyDigits(raw);
  if (digits.length !== 7 && digits.length !== 8) return false;
  const padded = digits.padStart(8, '0');
  const number = Number(padded.slice(0, 7));
  return number >= 100_000 && number < 7_000_000 && isValidDocument('ci-uy', padded);
}

/** RUT of Uruguay: department 01-22, six digits, series 001, check digit. `isValidDocument` requires the structure on top of the checksum (1 in 11 random numbers passes the checksum alone). */
function validRutUy(raw: string): boolean {
  return raw.length === 12 && isValidDocument('rut-uy', raw);
}

// --- detectors -------------------------------------------------------------------------------------------------------------------------------

interface PatternDetector {
  detector: PiiDetector;
  pattern: RegExp;
  accept: (raw: string) => boolean;
}

const SECRET_SHAPES = SECRET_PATTERNS.filter(({ name }) => !name.includes('JSON Web Token')).map(({ pattern }) => new RegExp(pattern.source, 'g'));

const IMAGE_OR_ASSET_TLD = /^(png|jpe?g|gif|svg|webp|avif|ico|css|js|map|woff2?|ttf)$/i;

// Order = priority when two matches overlap (the first one wins): a secret before a document, a CNPJ before the CPF-shaped digits inside it.
const PATTERN_DETECTORS: PatternDetector[] = [
  { detector: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, accept: () => true },
  { detector: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, accept: () => true },
  { detector: 'cnpj', pattern: /(?<!\d)\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}(?!\d)/g, accept: (raw) => isValidDocument('cnpj', raw) },
  { detector: 'cpf', pattern: /(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)/g, accept: (raw) => isValidDocument('cpf', raw) },
  { detector: 'rut-uy', pattern: /(?<!\d)\d{12}(?!\d)/g, accept: validRutUy },
  { detector: 'ci-uy', pattern: /(?<![\d.])\d\.\d{3}\.\d{3}-\d(?!\d)/g, accept: validCiUy },
  { detector: 'ci-uy', pattern: /(?<![\d.])\d{6,7}-\d(?!\d)/g, accept: validCiUy },
  {
    detector: 'card',
    pattern: /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g,
    accept: (raw) => {
      const digits = onlyDigits(raw);
      return digits.length >= 13 && digits.length <= 19 && /^[2-6]/.test(digits) && new Set(digits).size > 1 && luhn(digits);
    },
  },
  {
    detector: 'phone-uy',
    // With the country code, or the 09x mobile format with its trunk zero. A bare 8-digit number is not matched: it is too common.
    pattern: /(?:(?:\+|\b00)598[ -]?(?:9\d[ -]?\d{3}[ -]?\d{3}|[2-5]\d{3}[ -]?\d{4})|(?<![\d+])09\d[ -]?\d{3}[ -]?\d{3})(?!\d)/g,
    accept: () => true,
  },
  {
    detector: 'email',
    pattern: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,4}/g,
    accept: (raw) => {
      const tld = raw.slice(raw.lastIndexOf('.') + 1);
      return /^[A-Za-z]{2,24}$/.test(tld) && !IMAGE_OR_ASSET_TLD.test(tld);
    },
  },
];

const PRIORITY: PiiDetector[] = ['known-secret', 'jwt', 'bearer', 'api-key', ...PATTERN_DETECTORS.map((entry) => entry.detector)];
const priorityOf = (detector: PiiDetector): number => {
  const position = PRIORITY.indexOf(detector);
  return position === -1 ? PRIORITY.length : position;
};

function* execAll(pattern: RegExp, text: string): Generator<RegExpExecArray> {
  pattern.lastIndex = 0;
  let match = pattern.exec(text);
  while (match) {
    yield match;
    if (match[0].length === 0) pattern.lastIndex += 1;
    match = pattern.exec(text);
  }
}

export interface ScanOptions {
  /** Values of the credential vault and of the run: reported as `known-secret` wherever they appear. */
  knownSecrets?: readonly string[];
}

/** Every detector over one text. Overlaps are resolved by priority (and then by length), so one piece of text is reported once. */
export function scanText(input: string, options: ScanOptions = {}): RawMatch[] {
  const text = input.length > MAX_SCAN_CHARS ? input.slice(0, MAX_SCAN_CHARS) : input;
  if (text.length === 0) return [];
  const candidates: RawMatch[] = [];

  for (const secret of options.knownSecrets ?? []) {
    if (secret.length === 0) continue;
    if (text === secret) {
      candidates.push({ detector: 'known-secret', start: 0, end: text.length, raw: text });
    } else if (secret.length >= MIN_SUBSTRING_SECRET_LENGTH) {
      let from = text.indexOf(secret);
      while (from !== -1 && candidates.length < MAX_MATCHES_PER_TEXT) {
        candidates.push({ detector: 'known-secret', start: from, end: from + secret.length, raw: secret });
        from = text.indexOf(secret, from + secret.length);
      }
    }
  }

  for (const pattern of SECRET_SHAPES) {
    for (const match of execAll(pattern, text)) {
      candidates.push({ detector: 'api-key', start: match.index, end: match.index + match[0].length, raw: match[0] });
      if (candidates.length >= MAX_MATCHES_PER_TEXT * 4) break;
    }
  }

  for (const { detector, pattern, accept } of PATTERN_DETECTORS) {
    for (const match of execAll(pattern, text)) {
      if (accept(match[0])) candidates.push({ detector, start: match.index, end: match.index + match[0].length, raw: match[0] });
      if (candidates.length >= MAX_MATCHES_PER_TEXT * 4) break;
    }
  }

  candidates.sort((a, b) => priorityOf(a.detector) - priorityOf(b.detector) || b.end - b.start - (a.end - a.start) || a.start - b.start);
  const accepted: RawMatch[] = [];
  for (const candidate of candidates) {
    if (accepted.length >= MAX_MATCHES_PER_TEXT) break;
    if (accepted.every((other) => candidate.end <= other.start || candidate.start >= other.end)) accepted.push(candidate);
  }
  return accepted.sort((a, b) => a.start - b.start);
}

// --- names that say "this is a secret" ---------------------------------------------------------------------------------------------------------

const SECRET_NAME = /^(?:access[_-]?token|id[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token|token|auth|authorization|api[_-]?key|apikey|x-api-key|client[_-]?secret|secret|password|passwd|pwd|jsessionid|phpsessid|sessionid|session[_-]?id|sid)$/i;
/** Anti-forgery tokens and framework state are meant to sit in a page: naming them would only produce noise. */
const EXPECTED_IN_PAGE = /csrf|xsrf|antiforgery|requestverificationtoken|viewstate|eventvalidation|nonce/i;
const MIN_NAMED_SECRET_LENGTH = 8;

/** True when `name` says its value is a secret (token, password, api key, session id) and the value is long enough to be one. */
export function isSecretName(name: string, value: string): boolean {
  return value.length >= MIN_NAMED_SECRET_LENGTH && SECRET_NAME.test(name.trim()) && !EXPECTED_IN_PAGE.test(name);
}

/** A cookie name that carries a session or a token (looser than `isSecretName`: cookies are called `app_session`, `XSRF-TOKEN`, `.AspNet.Cookies`). */
const SECRET_COOKIE_NAME = /(?:token|session|sess|sid|auth|jwt)/i;
export function isSessionCookieName(name: string, value: string): boolean {
  return value.length >= 16 && SECRET_COOKIE_NAME.test(name) && !EXPECTED_IN_PAGE.test(name);
}

// --- URLs ------------------------------------------------------------------------------------------------------------------------------------

export interface UrlHit {
  detector: PiiDetector;
  raw: string;
  /** Which part: `path`, `query:<param name>`, `fragment`. Names are the application's own, not values. */
  where: string;
}

export interface UrlScan {
  /** Origin plus the path with every matched value masked: safe to store as the location of a finding. */
  display: string;
  hits: UrlHit[];
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Parameters of `a=1&b=2`; a fragment that looks like that (`#access_token=...`, the OAuth implicit flow) is read the same way. */
function paramsOf(text: string): Array<[string, string]> {
  return text
    .split('&')
    .map((pair) => {
      const equals = pair.indexOf('=');
      return equals === -1 ? ([decoded(pair), ''] as [string, string]) : ([decoded(pair.slice(0, equals)), decoded(pair.slice(equals + 1))] as [string, string]);
    })
    .slice(0, 100);
}

/**
 * Looks at every part of a URL: path (including `;jsessionid=` path parameters), each query value, the fragment. The URL itself is never copied into
 * the result; `display` has the origin and a path whose matched values are masked, and the query is reduced to parameter NAMES.
 */
export function scanUrl(rawUrl: string, options: ScanOptions = {}): UrlScan {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { display: 'invalid-url', hits: [] };
  }
  const hits: UrlHit[] = [];

  const path = decoded(url.pathname);
  const pathMatches = scanText(path, options);
  for (const match of pathMatches) hits.push({ detector: match.detector, raw: match.raw, where: 'path' });
  // ;jsessionid=XYZ and ;PHPSESSID=XYZ live in the path, not in the query.
  for (const [, name, value] of path.matchAll(/;([A-Za-z0-9_-]{1,40})=([^;/?#]*)/g)) {
    if (name !== undefined && value !== undefined && isSecretName(name, value) && !pathMatches.some((match) => match.raw.includes(value))) {
      hits.push({ detector: 'secret-named', raw: value, where: `path:${name}` });
    }
  }

  const queryNames: string[] = [];
  const fragmentNames: string[] = [];
  const consider = (part: 'query' | 'fragment', pairs: Array<[string, string]>) => {
    for (const [name, value] of pairs) {
      (part === 'query' ? queryNames : fragmentNames).push(name);
      const label = `${part}:${name.slice(0, 40)}`;
      const found = scanText(value, options);
      for (const match of found) hits.push({ detector: match.detector, raw: match.raw, where: label });
      if (isSecretName(name, value) && !found.some((match) => match.detector === 'known-secret' || match.raw === value)) {
        hits.push({ detector: 'secret-named', raw: value, where: label });
      }
    }
  };
  if (url.search.length > 1) consider('query', paramsOf(url.search.slice(1)));
  const fragment = url.hash.slice(1);
  if (fragment.length > 0) {
    if (fragment.includes('=')) {
      consider('fragment', paramsOf(fragment));
    } else {
      for (const match of scanText(decoded(fragment), options)) hits.push({ detector: match.detector, raw: match.raw, where: 'fragment' });
    }
  }

  const shownPath = pathMatches.length > 0 ? maskSpans(path, pathMatches) : path;
  const query = queryNames.length > 0 ? `?${queryNames.slice(0, 20).join(',')}` : '';
  const shownFragment = fragment.length === 0 ? '' : fragmentNames.length > 0 ? `#${fragmentNames.slice(0, 20).join(',')}` : '#…';
  return { display: `${url.origin}${shownPath}${query}${shownFragment}`.slice(0, 300), hits };
}

/** The text with every match replaced by its masked form: for evidence a hunting run keeps (console, page errors) so it does not store what it found. */
export function maskText(text: string, options: ScanOptions = {}): string {
  const matches = scanText(text, options);
  return matches.length === 0 ? text : maskSpans(text, matches);
}

/**
 * The URL itself with every value the hunt flags replaced by its masked form (also in its percent-encoded form). For the address a run records: a run
 * that hunts for secrets in URLs must not write the secret it found into its own result.
 */
export function maskUrl(rawUrl: string, options: ScanOptions = {}): string {
  let out = rawUrl;
  for (const hit of scanUrl(rawUrl, options).hits) {
    if (hit.raw.length === 0) continue;
    const masked = maskValue(hit.detector, hit.raw);
    out = out.split(hit.raw).join(masked).split(encodeURIComponent(hit.raw)).join(masked);
  }
  return out;
}

// --- masking and fingerprint -----------------------------------------------------------------------------------------------------------------

const SECRET_DETECTORS = new Set<PiiDetector>(['jwt', 'bearer', 'api-key', 'secret-named', 'known-secret', 'cookie-no-httponly']);

/** What may be shown of a value: enough to tell two findings apart, never enough to use it. */
export function maskValue(detector: PiiDetector, raw: string): string {
  if (detector === 'known-secret' || detector === 'secret-named' || detector === 'cookie-no-httponly') return `*** (${raw.length} chars)`;
  if (SECRET_DETECTORS.has(detector)) return `${raw.slice(0, Math.min(3, Math.floor(raw.length / 4)))}*** (${raw.length} chars)`;
  if (detector === 'email') {
    const at = raw.lastIndexOf('@');
    const domain = raw.slice(at + 1);
    const dot = domain.lastIndexOf('.');
    return `${raw.charAt(0)}***@${domain.charAt(0)}***${domain.slice(dot)}`;
  }
  // Documents, cards, phones: keep the separators and the last two digits.
  const total = onlyDigits(raw).length;
  let seen = 0;
  return raw.replace(/\d/g, (digit) => {
    seen += 1;
    return total - seen < 2 ? digit : '*';
  });
}

/** Replaces each match in `text` by its masked form (for the location of a finding: a CPF in a path must not survive there). */
export function maskSpans(text: string, matches: readonly RawMatch[]): string {
  let out = '';
  let cursor = 0;
  for (const match of [...matches].sort((a, b) => a.start - b.start)) {
    if (match.start < cursor) continue;
    out += text.slice(cursor, match.start) + maskValue(match.detector, match.raw);
    cursor = match.end;
  }
  return out + text.slice(cursor);
}

/** What makes two sightings "the same value": separators and case do not matter. */
function normalized(detector: PiiDetector, raw: string): string {
  if (detector === 'email') return raw.toLowerCase();
  if (detector === 'cpf' || detector === 'cnpj' || detector === 'ci-uy' || detector === 'rut-uy' || detector === 'card' || detector === 'phone-uy') return onlyDigits(raw);
  return raw;
}

/**
 * HMAC-SHA256 under `key` (a secret of the installation), hex. Same value -> same fingerprint inside one installation, so a leak seen on two screens
 * is recognised as one; with no key, nobody can recover the value by trying candidates. (Departure from the roadmap, which says plain sha256.)
 */
export function fingerprintOf(detector: PiiDetector, raw: string, key: Buffer | string): string {
  return createHmac('sha256', key).update(`${detector}:${normalized(detector, raw)}`, 'utf8').digest('hex');
}
