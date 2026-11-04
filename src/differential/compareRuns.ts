import { compileDiffConfig, maskText, MAX_TEXT_FOR_PATTERNS, type CompiledNormalizers } from '../diff/normalizers.js';
import { countChanges, structuralDiff, type ChangeSet } from '../diff/structuralDiff.js';
import type { DiffConfigInput } from '../schemas/diffConfig.schema.js';
import { differentialToleranceSchema, type DifferentialDimension, type DifferentialTolerance } from '../schemas/differential.schema.js';
import type { ExplorationResult } from '../schemas/explorationResult.schema.js';

/**
 * T6.3: compares two runs of the same routine, `left` (the baseline) and `right` (the candidate). Pure and deterministic: no I/O, no
 * configuration import. Five dimensions: step status, extracted values (T4.1 structural diff, with tolerance), NEW console errors, the
 * SHAPE of the network (method + path with ids masked + status, never the origin: the origin is what differs between two environments)
 * and the time per step. `timing` is information; the other four decide `equivalent`.
 */

/** The part of a run result the comparison reads. */
export type ComparableRun = Pick<ExplorationResult, 'status' | 'durationMs' | 'steps' | 'extracted' | 'evidence'> & Partial<Pick<ExplorationResult, 'teardownStatus' | 'error'>>;

export type StepDifference =
  | { key: string; kind: 'run-status'; left: string; right: string }
  | { key: string; kind: 'status'; left: string; right: string; leftError?: string; rightError?: string }
  | { key: string; kind: 'only-left'; left: string }
  | { key: string; kind: 'only-right'; right: string }
  | { key: string; kind: 'error-type'; leftError: string; rightError: string }
  | { key: string; kind: 'teardown'; left: string; right: string };

export type Counted = { text: string; count: number };
export type NetworkShapeChange =
  | { shape: string; kind: 'only-right'; right: string[] }
  | { shape: string; kind: 'only-left'; left: string[] }
  | { shape: string; kind: 'status'; left: string[]; right: string[] };

export type TimingChange = { key: string; leftMs: number; rightMs: number; ratio: number; direction: 'slower' | 'faster' };

export interface DifferentialComparison {
  /** No difference in steps, extracted values, console or network (timing never counts). */
  equivalent: boolean;
  statuses: { left: string; right: string };
  compared: DifferentialDimension[];
  steps: { differences: StepDifference[] };
  extracted: ChangeSet;
  console: { newInRight: Counted[]; goneInRight: Counted[]; truncated: boolean };
  network: { changes: NetworkShapeChange[]; leftShapes: number; rightShapes: number; truncated: boolean };
  timing: { applicable: boolean; run?: TimingChange; steps: TimingChange[]; slower: number; faster: number };
  counts: { steps: number; extracted: number; console: number; network: number; timing: number };
  /** One line: "2 step(s), 1 extracted value, 3 new console error(s)". Empty when equivalent. */
  headline: string;
  notes: string[];
}

const MAX_LISTED = 100;
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// --- normalization -------------------------------------------------------------------------------------------------

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const URL_ORIGIN = /\bhttps?:\/\/[^\s/'")\]>]+/gi;
const URL_QUERY = /(<origin>[^\s?#'")\]>]*)[?#][^\s'")\]>]*/g;
const LONG_NUMBER = /\d{3,}/g;
const HASH_IN_NAME = /\.[0-9a-f]{8,}(?=\.)/gi;
const SESSION_PARAM = /;jsessionid=[^/?#;]*/gi;

/** A console/page-error message with the environment and the dynamic parts taken out, so the same error compares equal on both sides. */
export function normalizeMessage(text: string, normalizers: CompiledNormalizers): string {
  let result = text.length > MAX_TEXT_FOR_PATTERNS ? text.slice(0, MAX_TEXT_FOR_PATTERNS) : text;
  result = result.replace(URL_ORIGIN, '<origin>').replace(URL_QUERY, '$1').replace(UUID, '<uuid>').replace(HASH_IN_NAME, '.<hash>').replace(LONG_NUMBER, '#');
  result = maskText(result, normalizers).replace(/\s+/g, ' ').trim();
  return clip(result, 300);
}

/** The stable shape of a path: ids, numbers and build hashes become placeholders, the session id goes away. Query strings are not part of `pathname`. */
export function normalizePath(pathname: string, normalizers: CompiledNormalizers): string {
  const segments = pathname
    .replace(SESSION_PARAM, '')
    .split('/')
    .map((segment) => {
      if (segment === '') return segment;
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // keep as it is
      }
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded)) return ':uuid';
      if (/^\d+$/.test(decoded)) return ':n';
      if (/^[0-9a-f]{16,}$/i.test(decoded)) return ':hex';
      if (decoded.length >= 20 && /\d/.test(decoded) && /^[A-Za-z0-9_-]+$/.test(decoded)) return ':token';
      return decoded.replace(HASH_IN_NAME, '.:hash');
    });
  return maskText(segments.join('/') || '/', normalizers);
}

// --- dimensions ----------------------------------------------------------------------------------------------------

type StepLike = ComparableRun['steps'][number];

function keyedSteps(steps: StepLike[]): Map<string, StepLike> {
  const map = new Map<string, StepLike>();
  for (const step of steps) {
    const base = step.id ?? `#${step.index}`;
    let key = base;
    for (let n = 2; map.has(key); n += 1) key = `${base}#${n}`;
    map.set(key, step);
  }
  return map;
}

const errorLine = (step: StepLike): string | undefined => (step.error ? clip(`${step.error.type}: ${step.error.message}`, 200) : undefined);

function compareSteps(left: ComparableRun, right: ComparableRun): StepDifference[] {
  const differences: StepDifference[] = [];
  if (left.status !== right.status) differences.push({ key: '(run)', kind: 'run-status', left: left.status, right: right.status });

  const leftSteps = keyedSteps(left.steps);
  const rightSteps = keyedSteps(right.steps);
  for (const [key, l] of leftSteps) {
    const r = rightSteps.get(key);
    if (!r) {
      differences.push({ key, kind: 'only-left', left: l.status });
    } else if (l.status !== r.status) {
      const leftError = errorLine(l);
      const rightError = errorLine(r);
      differences.push({ key, kind: 'status', left: l.status, right: r.status, ...(leftError ? { leftError } : {}), ...(rightError ? { rightError } : {}) });
    } else if (l.status === 'failed' && l.error && r.error && l.error.type !== r.error.type) {
      differences.push({ key, kind: 'error-type', leftError: errorLine(l)!, rightError: errorLine(r)! });
    }
  }
  for (const [key, r] of rightSteps) {
    if (!leftSteps.has(key)) differences.push({ key, kind: 'only-right', right: r.status });
  }
  if ((left.teardownStatus ?? 'none') !== (right.teardownStatus ?? 'none')) {
    differences.push({ key: '(teardown)', kind: 'teardown', left: left.teardownStatus ?? 'none', right: right.teardownStatus ?? 'none' });
  }
  return differences;
}

function countTexts(texts: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const text of texts) counts.set(text, (counts.get(text) ?? 0) + 1);
  return counts;
}

function consoleMessages(run: ComparableRun, normalizers: CompiledNormalizers): string[] {
  const where = (url: string | undefined): string => {
    if (!url) return '';
    try {
      return ` @ ${normalizePath(new URL(url).pathname, normalizers)}`;
    } catch {
      return '';
    }
  };
  return [
    ...run.evidence.consoleErrors.map((entry) => `${normalizeMessage(entry.text, normalizers)}${where(entry.location?.url)}`),
    ...run.evidence.pageErrors.map((text) => `page error: ${normalizeMessage(text, normalizers)}`),
  ];
}

function compareConsole(left: ComparableRun, right: ComparableRun, normalizers: CompiledNormalizers): DifferentialComparison['console'] {
  const l = countTexts(consoleMessages(left, normalizers));
  const r = countTexts(consoleMessages(right, normalizers));
  // A message is "new" when it appears on the right and NOT on the left at all; more repetitions of a known one are not a new error.
  const newInRight = [...r].filter(([text]) => !l.has(text)).map(([text, count]) => ({ text, count }));
  const goneInRight = [...l].filter(([text]) => !r.has(text)).map(([text, count]) => ({ text, count }));
  const byText = (a: Counted, b: Counted) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0);
  newInRight.sort(byText);
  goneInRight.sort(byText);
  return {
    newInRight: newInRight.slice(0, MAX_LISTED),
    goneInRight: goneInRight.slice(0, MAX_LISTED),
    truncated: newInRight.length > MAX_LISTED || goneInRight.length > MAX_LISTED,
  };
}

const isError = (status: string): boolean => status === 'failed' || (/^\d+$/.test(status) && Number(status) >= 400);

/**
 * shape ("GET /api/orders/:n") -> the distinct statuses seen, sorted. A request that got no answer is `failed`. `counted` are the shapes
 * that take part in the comparison (an application conversation, or any request that failed); `all` has every shape, so a counted
 * failure on one side is judged against what the other side got for the SAME shape, even when that shape is not a counted type.
 */
function networkShapes(run: ComparableRun, tolerance: DifferentialTolerance, normalizers: CompiledNormalizers): { all: Map<string, string[]>; counted: Set<string> } {
  const types = new Set(tolerance.networkResourceTypes);
  const all = new Map<string, Set<string>>();
  const counted = new Set<string>();
  for (const request of [...(run.evidence.traffic ?? []), ...run.evidence.network]) {
    const status = request.status === undefined ? 'failed' : String(request.status);
    // A request the page cancelled itself (`net::ERR_ABORTED`, typically a navigation) is not a statement about the server: compare answers, not cancellations.
    if (status === 'failed' && request.failureText?.includes('ERR_ABORTED')) continue;
    const shape = `${request.method.toUpperCase()} ${normalizePath(request.pathname, normalizers)}`;
    const seen = all.get(shape) ?? new Set<string>();
    seen.add(status);
    all.set(shape, seen);
    if (types.size === 0 || (request.resourceType !== undefined && types.has(request.resourceType)) || isError(status)) counted.add(shape);
  }
  return { all: new Map([...all].map(([shape, statuses]) => [shape, [...statuses].sort()])), counted };
}

function compareNetwork(left: ComparableRun, right: ComparableRun, tolerance: DifferentialTolerance, normalizers: CompiledNormalizers): DifferentialComparison['network'] {
  const l = networkShapes(left, tolerance, normalizers);
  const r = networkShapes(right, tolerance, normalizers);
  const changes: NetworkShapeChange[] = [];
  for (const shape of new Set([...l.counted, ...r.counted])) {
    const a = l.all.get(shape);
    const b = r.all.get(shape);
    if (a && !b) changes.push({ shape, kind: 'only-left', left: a });
    else if (!a && b) changes.push({ shape, kind: 'only-right', right: b });
    else if (a && b && a.join(',') !== b.join(',')) changes.push({ shape, kind: 'status', left: a, right: b });
  }
  changes.sort((a, b) => (a.shape < b.shape ? -1 : a.shape > b.shape ? 1 : a.kind < b.kind ? -1 : 1));
  return { changes: changes.slice(0, MAX_LISTED), leftShapes: l.counted.size, rightShapes: r.counted.size, truncated: changes.length > MAX_LISTED };
}

function compareTiming(left: ComparableRun, right: ComparableRun, tolerance: DifferentialTolerance): DifferentialComparison['timing'] {
  // A failed run is cut short or waited for a timeout: its times say nothing about speed (same rule as the performance series, T3.4).
  if (left.status !== 'passed' || right.status !== 'passed') return { applicable: false, steps: [], slower: 0, faster: 0 };

  const judge = (key: string, leftMs: number, rightMs: number): TimingChange | undefined => {
    if (leftMs <= 0 || rightMs <= 0) return undefined;
    if (rightMs > leftMs * tolerance.timeRatio && rightMs - leftMs >= tolerance.minTimeDeltaMs) return { key, leftMs, rightMs, ratio: round(rightMs / leftMs), direction: 'slower' };
    if (leftMs > rightMs * tolerance.timeRatio && leftMs - rightMs >= tolerance.minTimeDeltaMs) return { key, leftMs, rightMs, ratio: round(rightMs / leftMs), direction: 'faster' };
    return undefined;
  };

  const rightSteps = keyedSteps(right.steps);
  const steps: TimingChange[] = [];
  for (const [key, l] of keyedSteps(left.steps)) {
    const r = rightSteps.get(key);
    if (!r || l.status !== 'passed' || r.status !== 'passed') continue;
    const change = judge(key, l.durationMs, r.durationMs);
    if (change) steps.push(change);
  }
  const run = judge('(run)', left.durationMs, right.durationMs);
  return {
    applicable: true,
    ...(run ? { run } : {}),
    steps: steps.slice(0, MAX_LISTED),
    slower: steps.filter((s) => s.direction === 'slower').length,
    faster: steps.filter((s) => s.direction === 'faster').length,
  };
}

const round = (value: number): number => Math.round(value * 100) / 100;

// --- the comparison --------------------------------------------------------------------------------------------------

const EMPTY_CHANGES = (): ChangeSet => ({ added: [], removed: [], changed: [], truncated: false });

/**
 * @param diff the comparison rules for extracted values: normally `tolerance.diff`, else the left target profile's `diff`.
 */
export function compareRuns(left: ComparableRun, right: ComparableRun, toleranceInput: Partial<DifferentialTolerance> = {}, diff?: DiffConfigInput): DifferentialComparison {
  const tolerance = differentialToleranceSchema.parse(toleranceInput);
  const compared = tolerance.dimensions;
  const has = (dimension: DifferentialDimension): boolean => compared.includes(dimension);
  const normalizers = compileDiffConfig(tolerance.diff ?? diff ?? {});

  const steps = has('steps') ? compareSteps(left, right) : [];
  const extracted = has('extracted') ? structuralDiff(left.extracted, right.extracted, { config: tolerance.diff ?? diff ?? {}, maxChanges: MAX_LISTED }) : EMPTY_CHANGES();
  const consoleDiff = has('console') ? compareConsole(left, right, normalizers) : { newInRight: [], goneInRight: [], truncated: false };
  const network = has('network') ? compareNetwork(left, right, tolerance, normalizers) : { changes: [], leftShapes: 0, rightShapes: 0, truncated: false };
  const timing = has('timing') ? compareTiming(left, right, tolerance) : { applicable: false, steps: [], slower: 0, faster: 0 };

  const counts = {
    steps: steps.length,
    extracted: countChanges(extracted),
    console: consoleDiff.newInRight.length + consoleDiff.goneInRight.length,
    network: network.changes.length,
    timing: timing.steps.length + (timing.run ? 1 : 0),
  };
  const equivalent = counts.steps + counts.extracted + counts.console + counts.network === 0;

  const notes: string[] = [];
  if (has('network') && !left.evidence.traffic && !right.evidence.traffic) {
    notes.push('network compared on failing requests only: these runs did not record their traffic (options.recordTraffic)');
  } else if (has('network') && (!left.evidence.traffic || !right.evidence.traffic)) {
    notes.push('only one of the two runs recorded its traffic: successful requests of the other side are not known, so the network comparison is incomplete');
  }
  if (left.evidence.trafficTruncated || right.evidence.trafficTruncated) notes.push('a run made more distinct requests than the evidence keeps: the network comparison is incomplete');
  if (left.status === 'failed' && right.status === 'failed' && counts.steps === 0) notes.push('both runs failed in the same way: equivalent, but neither side is healthy');
  if (!timing.applicable && has('timing')) notes.push('timing not compared: a failed run is cut short, its times say nothing about speed');
  if (extracted.truncated || consoleDiff.truncated || network.truncated) notes.push(`lists are cut at ${MAX_LISTED} entries; the counts are complete only up to that`);
  if (steps.some((s) => s.kind === 'only-left' || s.kind === 'only-right')) notes.push('a step exists on one side only: the two profiles expand different steps (for example a different login routine)');

  const parts: string[] = [];
  if (counts.steps > 0) parts.push(`${counts.steps} step difference(s)`);
  if (counts.extracted > 0) parts.push(`${counts.extracted} extracted value(s)`);
  if (consoleDiff.newInRight.length > 0) parts.push(`${consoleDiff.newInRight.length} new console error(s)`);
  if (consoleDiff.goneInRight.length > 0) parts.push(`${consoleDiff.goneInRight.length} console error(s) gone`);
  if (counts.network > 0) parts.push(`${counts.network} network difference(s)`);

  return {
    equivalent,
    statuses: { left: left.status, right: right.status },
    compared,
    steps: { differences: steps },
    extracted,
    console: consoleDiff,
    network,
    timing,
    counts,
    headline: parts.join(', '),
    notes,
  };
}

/** Plain-words lines for a comparison (CLI, markdown, MCP): deterministic, one difference per line. */
export function describeComparison(comparison: DifferentialComparison, labels: { left: string; right: string } = { left: 'left', right: 'right' }): string[] {
  const lines: string[] = [];
  for (const step of comparison.steps.differences) {
    switch (step.kind) {
      case 'run-status':
        lines.push(`run: ${labels.left} ${step.left}, ${labels.right} ${step.right}`);
        break;
      case 'status':
        lines.push(`step ${step.key}: ${labels.left} ${step.left}${step.leftError ? ` (${step.leftError})` : ''}, ${labels.right} ${step.right}${step.rightError ? ` (${step.rightError})` : ''}`);
        break;
      case 'only-left':
        lines.push(`step ${step.key}: only on ${labels.left} (${step.left})`);
        break;
      case 'only-right':
        lines.push(`step ${step.key}: only on ${labels.right} (${step.right})`);
        break;
      case 'error-type':
        lines.push(`step ${step.key} fails differently: ${labels.left} ${step.leftError}; ${labels.right} ${step.rightError}`);
        break;
      case 'teardown':
        lines.push(`teardown: ${labels.left} ${step.left}, ${labels.right} ${step.right}`);
        break;
    }
  }
  for (const change of [...comparison.extracted.added, ...comparison.extracted.removed, ...comparison.extracted.changed]) lines.push(`extracted ${change.summary}`);
  for (const entry of comparison.console.newInRight) lines.push(`console, new on ${labels.right}: ${entry.text}${entry.count > 1 ? ` (x${entry.count})` : ''}`);
  for (const entry of comparison.console.goneInRight) lines.push(`console, gone on ${labels.right}: ${entry.text}${entry.count > 1 ? ` (x${entry.count})` : ''}`);
  for (const change of comparison.network.changes) {
    if (change.kind === 'only-right') lines.push(`network, only on ${labels.right}: ${change.shape} -> ${change.right.join('/')}`);
    else if (change.kind === 'only-left') lines.push(`network, only on ${labels.left}: ${change.shape} -> ${change.left.join('/')}`);
    else lines.push(`network ${change.shape}: ${labels.left} ${change.left.join('/')}, ${labels.right} ${change.right.join('/')}`);
  }
  return lines;
}

/** Plain-words lines for the time differences (information, listed apart from the differences). */
export function describeTiming(comparison: DifferentialComparison, labels: { left: string; right: string } = { left: 'left', right: 'right' }): string[] {
  const all = [...(comparison.timing.run ? [comparison.timing.run] : []), ...comparison.timing.steps];
  return all.map((t) => `${t.key}: ${t.direction} on ${labels.right} (${labels.left} ${t.leftMs} ms, ${labels.right} ${t.rightMs} ms, x${t.ratio})`);
}
