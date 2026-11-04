import { fingerprintOf, maskValue, type PiiDetector, type PiiSurface } from './piiDetectors.js';

/**
 * T7.8: the finding of a PII scan and how findings are collected. PURE (the keyed fingerprint comes in as a parameter).
 *
 * A finding never holds the raw value: `maskedSample` shows the shape, `fingerprint` (HMAC, see piiDetectors.ts) tells two sightings of one value apart,
 * `location` says where without copying the value (a URL is reduced to origin, masked path and parameter NAMES).
 */

export const PII_SEVERITIES = ['high', 'medium', 'low', 'info'] as const;
export type PiiSeverity = (typeof PII_SEVERITIES)[number];

export const SEVERITY_RANK: Record<PiiSeverity, number> = { high: 3, medium: 2, low: 1, info: 0 };

/** The level at which a `scanForPii` step fails: `any` = even an informative finding. */
export const PII_FAIL_LEVELS = ['none', 'high', 'medium', 'low', 'any'] as const;
export type PiiFailLevel = (typeof PII_FAIL_LEVELS)[number];

export function meetsFailLevel(severity: PiiSeverity, level: PiiFailLevel): boolean {
  if (level === 'none') return false;
  if (level === 'any') return true;
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[level];
}

const SECRETS: ReadonlySet<PiiDetector> = new Set(['jwt', 'bearer', 'api-key', 'secret-named', 'known-secret']);
const IDENTITY_DOCUMENTS: ReadonlySet<PiiDetector> = new Set(['cpf', 'cnpj', 'ci-uy', 'rut-uy']);

/**
 * The severity a finding has when nothing says otherwise. The reasoning: a secret in a URL or a log is spent the moment it is written there (it ends in
 * server logs, history, Referer headers); in storage it is the application's design, still worth knowing. A person's identity document is a leak
 * wherever a public page or a URL shows it. An e-mail is the weakest: it is on most pages on purpose. T7.9 lets a target profile change all of this.
 */
export function defaultSeverity(detector: PiiDetector, surface: PiiSurface): PiiSeverity {
  if (detector === 'card') return surface === 'hidden-input' ? 'medium' : 'high';
  if (detector === 'cookie-no-httponly') return 'medium';
  if (SECRETS.has(detector)) return surface === 'storage' || surface === 'hidden-input' || surface === 'cookie' ? 'medium' : 'high';
  if (IDENTITY_DOCUMENTS.has(detector)) return surface === 'console' || surface === 'storage' || surface === 'hidden-input' ? 'medium' : 'high';
  // e-mail and phone
  if (surface === 'url') return 'medium';
  if (surface === 'console' || surface === 'response-body' || surface === 'cookie') return 'low';
  return 'info';
}

export interface PiiFinding {
  detector: PiiDetector;
  surface: PiiSurface;
  /** Where it was seen, without the value (see above). */
  location: string;
  maskedSample: string;
  /** Keyed hash of the value: the same value gives the same fingerprint in this installation. */
  fingerprint: string;
  severity: PiiSeverity;
  /** How many times the same value was seen in the same place (a request repeated, a log line printed twice). */
  count: number;
  /** T7.9: why the severity is what it is, when a profile policy changed it. */
  severityReason?: string;
}

export const MAX_FINDINGS = 200;

export interface CollectorOptions {
  /** Secret of the installation that keys the fingerprints. */
  key: Buffer | string;
  maxFindings?: number;
}

/** Accumulates findings, merging a repeat of the same value in the same place. Past the cap, findings are dropped and `truncated` says so. */
export class FindingCollector {
  private readonly byKey = new Map<string, PiiFinding>();
  private readonly max: number;
  truncated = false;

  constructor(private readonly options: CollectorOptions) {
    this.max = options.maxFindings ?? MAX_FINDINGS;
  }

  add(detector: PiiDetector, surface: PiiSurface, location: string, raw: string): void {
    const fingerprint = fingerprintOf(detector, raw, this.options.key);
    const key = `${detector}|${surface}|${location}|${fingerprint}`;
    const existing = this.byKey.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    if (this.byKey.size >= this.max) {
      this.truncated = true;
      return;
    }
    this.byKey.set(key, {
      detector,
      surface,
      location: location.slice(0, 300),
      maskedSample: maskValue(detector, raw),
      fingerprint,
      severity: defaultSeverity(detector, surface),
      count: 1,
    });
  }

  /** Most severe first, then by surface and location, so the report is stable. */
  findings(): PiiFinding[] {
    return [...this.byKey.values()].sort(
      (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.surface.localeCompare(b.surface) || a.location.localeCompare(b.location) || a.detector.localeCompare(b.detector),
    );
  }
}

/**
 * Lists, not maps keyed by detector or surface: a result goes through `redactSecrets`, which blanks every value whose KEY looks like a secret
 * (`cookie`, `secret`, `token`...), and `known-secret` / `cookie-no-httponly` are exactly such names.
 */
export interface PiiCounts {
  total: number;
  bySeverity: Record<PiiSeverity, number>;
  byDetector: Array<{ detector: PiiDetector; count: number }>;
  bySurface: Array<{ surface: PiiSurface; count: number }>;
}

export function countFindings(findings: readonly PiiFinding[]): PiiCounts {
  const bySeverity: Record<PiiSeverity, number> = { high: 0, medium: 0, low: 0, info: 0 };
  const byDetector = new Map<PiiDetector, number>();
  const bySurface = new Map<PiiSurface, number>();
  for (const finding of findings) {
    bySeverity[finding.severity] += 1;
    byDetector.set(finding.detector, (byDetector.get(finding.detector) ?? 0) + 1);
    bySurface.set(finding.surface, (bySurface.get(finding.surface) ?? 0) + 1);
  }
  return {
    total: findings.length,
    bySeverity,
    byDetector: [...byDetector].map(([detector, count]) => ({ detector, count })).sort((a, b) => b.count - a.count || a.detector.localeCompare(b.detector)),
    bySurface: [...bySurface].map(([surface, count]) => ({ surface, count })).sort((a, b) => b.count - a.count || a.surface.localeCompare(b.surface)),
  };
}
