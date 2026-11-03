import { createHash } from 'node:crypto';
import type { ExplorationStep } from '../schemas/explorationRequest.schema.js';
import type { ExplorationResult } from '../schemas/explorationResult.schema.js';
import type {
  DeniedWhen,
  Expectation,
  MatrixCell,
  MatrixChange,
  MatrixRunState,
  PermissionMatrix,
  PermissionProbe,
} from '../schemas/permissionMatrix.schema.js';

/**
 * T6.1, the pure half of the permission matrix: how the cells are split into browser sessions, how a run's
 * result becomes cells, expectations, the diff against the previous run and the verdict. No I/O here, so all of it
 * is unit-tested without a browser (test/permission-matrix.test.ts).
 */

type PageProbe = Extract<PermissionProbe, { kind: 'url' | 'control' }>;
type ActionProbe = Extract<PermissionProbe, { kind: 'action' }>;

export interface Limits {
  maxStepsPerJob: number;
  jobTimeoutMs: number;
  stepTimeoutMs: number;
}

/** One browser run: a login as `role`, then either some url/control probes or one action routine. */
export type PlannedSession =
  | { role: string; kind: 'pages'; probes: PageProbe[]; steps: ExplorationStep[] }
  | { role: string; kind: 'action'; probes: [ActionProbe]; steps: ExplorationStep[] };

export const LOGIN_INCLUDE_ID = 'login';
/**
 * Name under which a probe's reading is stored in `result.extracted`. Deliberately NOT derived from the probe id: the
 * redactor masks the whole value of any extracted key that looks sensitive, so a probe called `change-password` came
 * back as "[REDACTED]" and the cell could not be answered. A hash keeps the name neutral for any id.
 */
export const readName = (probeId: string): string => `probe_${createHash('sha256').update(probeId).digest('hex').slice(0, 12)}`;
const stepId = (probeId: string, what: 'open' | 'settle' | 'read'): string => `probe-${probeId}-${what}`;

export function resolveProbeUrl(url: string, baseUrl: string): string {
  return url.startsWith('/') ? new URL(url, baseUrl).toString() : url;
}

export function textMarkersOf(deniedWhen: DeniedWhen[]): string[] {
  return deniedWhen.flatMap((rule) => ('textVisible' in rule ? [rule.textVisible] : []));
}

function loginSteps(matrix: PermissionMatrix, loginRoutine: string): ExplorationStep[] {
  return [
    {
      id: LOGIN_INCLUDE_ID,
      action: 'include',
      routineId: loginRoutine,
      ...(matrix.loginRoutineVersion === undefined ? {} : { version: matrix.loginRoutineVersion }),
    },
  ];
}

function pageProbeSteps(probe: PageProbe, matrix: PermissionMatrix, baseUrl: string, limits: Limits): ExplorationStep[] {
  const settle = Math.min(matrix.settleMs, limits.stepTimeoutMs);
  const wait = Math.min(matrix.controlWaitMs, limits.stepTimeoutMs);
  const markers = textMarkersOf(matrix.deniedWhen);

  return [
    { id: stepId(probe.id, 'open'), action: 'goto', url: resolveProbeUrl(probe.url, baseUrl) },
    ...(settle > 0 ? [{ id: stepId(probe.id, 'settle'), action: 'waitForTimeout' as const, timeoutMs: settle }] : []),
    {
      id: stepId(probe.id, 'read'),
      action: 'probePage',
      name: readName(probe.id),
      ...(probe.kind === 'control' ? { selector: probe.selector, ...(wait > 0 ? { timeoutMs: wait } : {}) } : {}),
      ...(markers.length > 0 ? { textMarkers: markers } : {}),
    },
  ];
}

/**
 * How many url/control probes fit in one session after a login of `loginStepCount` steps: bounded by
 * MAX_STEPS_PER_JOB and, roughly, by JOB_TIMEOUT_MS (a page costs its settle + control wait + ~5 s to load).
 */
export function probesPerSession(matrix: PermissionMatrix, loginStepCount: number, limits: Limits): number {
  const stepsPerProbe = Math.min(matrix.settleMs, limits.stepTimeoutMs) > 0 ? 3 : 2;
  const bySteps = Math.floor((limits.maxStepsPerJob - loginStepCount) / stepsPerProbe);
  const hasControl = matrix.probes.some((probe) => probe.kind === 'control');
  const perProbeMs = Math.min(matrix.settleMs, limits.stepTimeoutMs) + (hasControl ? Math.min(matrix.controlWaitMs, limits.stepTimeoutMs) : 0) + 5000;
  const byTime = Math.floor((limits.jobTimeoutMs - 20_000) / perProbeMs);
  return Math.max(1, Math.min(bySteps, byTime));
}

export function planSessions(
  matrix: PermissionMatrix,
  context: { baseUrl: string; loginRoutine: string; loginStepCount: number; limits: Limits },
): PlannedSession[] {
  const pageProbes = matrix.probes.filter((probe): probe is PageProbe => probe.kind !== 'action');
  const actionProbes = matrix.probes.filter((probe): probe is ActionProbe => probe.kind === 'action');
  const chunk = matrix.isolation === 'perProbe' ? 1 : probesPerSession(matrix, context.loginStepCount, context.limits);
  const sessions: PlannedSession[] = [];

  // Role-major: the sessions of one role are adjacent, so the single-session lock of a credential is held by one
  // run at a time and the other roles proceed in parallel.
  for (const role of matrix.roles) {
    for (let start = 0; start < pageProbes.length; start += chunk) {
      const probes = pageProbes.slice(start, start + chunk);
      sessions.push({
        role,
        kind: 'pages',
        probes,
        steps: [...loginSteps(matrix, context.loginRoutine), ...probes.flatMap((probe) => pageProbeSteps(probe, matrix, context.baseUrl, context.limits))],
      });
    }
    for (const probe of actionProbes) {
      sessions.push({
        role,
        kind: 'action',
        probes: [probe],
        steps: [
          ...loginSteps(matrix, context.loginRoutine),
          { id: 'action', action: 'include', routineId: probe.routineId, ...(probe.version === undefined ? {} : { version: probe.version }) },
        ],
      });
    }
  }

  return sessions;
}

interface PageReading {
  url: string;
  documentStatus: number | null;
  markersFound: string[];
  selector?: { count: number; visible: boolean; enabled: boolean };
}

function isPageReading(value: unknown): value is PageReading {
  return typeof value === 'object' && value !== null && typeof (value as PageReading).url === 'string' && Array.isArray((value as PageReading).markersFound);
}

/** The first deniedWhen rule the evidence satisfies, described for the report; undefined when none does. */
export function matchDenial(deniedWhen: DeniedWhen[], evidence: { url?: string; markersFound: string[]; statuses: number[] }): string | undefined {
  for (const rule of deniedWhen) {
    if ('urlContains' in rule && evidence.url?.includes(rule.urlContains)) return `urlContains "${rule.urlContains}"`;
    if ('textVisible' in rule && evidence.markersFound.includes(rule.textVisible)) return `textVisible "${rule.textVisible}"`;
    if ('status' in rule && evidence.statuses.includes(rule.status)) return `status ${rule.status}`;
  }
  return undefined;
}

const short = (text: string | undefined): string | undefined => (text === undefined ? undefined : text.slice(0, 500));

function errorCell(base: Pick<MatrixCell, 'role' | 'probeId' | 'kind'>, type: string, message: string | undefined, jobId?: string): MatrixCell {
  return { ...base, outcome: 'error', errorType: type, ...(message ? { errorMessage: short(message) } : {}), ...(jobId ? { jobId } : {}) };
}

/** True when the run broke inside the included login (its steps come first). */
function failedInLogin(result: ExplorationResult, loginStepCount: number): boolean {
  return result.failedStepIndex !== undefined && result.failedStepIndex < loginStepCount;
}

/** Cells of a session that could not run at all (credential refused, job timeout, server error). */
export function cellsForBrokenSession(session: PlannedSession, type: string, message: string): MatrixCell[] {
  return session.probes.map((probe) => errorCell({ role: session.role, probeId: probe.id, kind: probe.kind }, type, message));
}

export function classifySession(session: PlannedSession, result: ExplorationResult, matrix: PermissionMatrix, loginStepCount: number): MatrixCell[] {
  const jobId = result.jobId;

  if (failedInLogin(result, loginStepCount)) {
    return session.probes.map((probe) =>
      errorCell({ role: session.role, probeId: probe.id, kind: probe.kind }, 'LoginFailed', `the login of role "${session.role}" failed: ${result.error?.message ?? 'unknown'}`, jobId),
    );
  }

  if (session.kind === 'action') {
    const probe = session.probes[0];
    const base = { role: session.role, probeId: probe.id, kind: probe.kind } as const;
    if (result.status === 'passed') {
      return [{ ...base, outcome: 'allowed', jobId }];
    }

    const domText = result.evidence.domTextSnapshot ?? '';
    const deniedBy = matchDenial(matrix.deniedWhen, {
      url: result.finalUrl,
      markersFound: textMarkersOf(matrix.deniedWhen).filter((marker) => domText.includes(marker)),
      statuses: result.evidence.network.filter((entry) => entry.resourceType === 'document' && entry.status !== undefined).map((entry) => entry.status!),
    });
    return deniedBy
      ? [{ ...base, outcome: 'denied', deniedBy, jobId, ...(result.finalUrl ? { finalUrl: result.finalUrl } : {}) }]
      : [
          errorCell(
            base,
            'ActionFailedWithoutDenial',
            `the routine failed and no deniedWhen rule matched (a broken routine, not an answer): ${result.error?.message ?? 'unknown'}`,
            jobId,
          ),
        ];
  }

  return session.probes.map((probe) => {
    const base = { role: session.role, probeId: probe.id, kind: probe.kind } as const;
    const failed = result.steps.find((step) => step.id?.startsWith(`probe-${probe.id}-`) && step.status === 'failed');
    if (failed) {
      return errorCell(base, failed.error?.type ?? 'StepFailed', failed.error?.message, jobId);
    }

    const reading = result.extracted[readName(probe.id)];
    if (!isPageReading(reading)) {
      return errorCell(
        base,
        'NotReached',
        `an earlier probe in the same session failed (${result.error?.message ?? 'run ended early'}); isolation "perProbe" keeps probes apart`,
        jobId,
      );
    }

    const deniedBy = matchDenial(matrix.deniedWhen, {
      url: reading.url,
      markersFound: reading.markersFound,
      statuses: reading.documentStatus === null ? [] : [reading.documentStatus],
    });
    if (deniedBy) {
      return { ...base, outcome: 'denied', deniedBy, finalUrl: reading.url, jobId };
    }

    if (probe.kind === 'url') {
      return { ...base, outcome: 'allowed', finalUrl: reading.url, jobId };
    }

    const selector = reading.selector;
    const state = !selector || selector.count === 0 || !selector.visible ? 'hidden' : selector.enabled ? 'enabled' : 'disabled';
    return { ...base, outcome: 'allowed', state, finalUrl: reading.url, jobId };
  });
}

/** Does an answered cell meet an expectation? A control on a denied page counts as hidden (nobody can use it). */
export function meets(expectation: Expectation, cell: MatrixCell): boolean {
  switch (expectation) {
    case 'allowed':
      return cell.outcome === 'allowed';
    case 'denied':
      return cell.outcome === 'denied';
    case 'visible':
      return cell.outcome === 'allowed' && (cell.state === 'enabled' || cell.state === 'disabled');
    case 'hidden':
      return cell.outcome === 'denied' || cell.state === 'hidden';
    case 'enabled':
      return cell.outcome === 'allowed' && cell.state === 'enabled';
    case 'disabled':
      return cell.outcome === 'allowed' && cell.state === 'disabled';
  }
}

export function applyExpectation(cell: MatrixCell, matrix: PermissionMatrix): MatrixCell {
  const expected = matrix.expected?.[cell.role]?.[cell.probeId];
  if (expected === undefined) return cell;
  if (cell.outcome === 'error' || cell.outcome === 'pending') return { ...cell, expected };
  return { ...cell, expected, matches: meets(expected, cell) };
}

/** What a cell answered, as one comparable word: allowed/denied, or for controls hidden/disabled/enabled/denied. */
export function observed(cell: MatrixCell): string | undefined {
  if (cell.outcome === 'error' || cell.outcome === 'pending') return undefined;
  if (cell.kind === 'control' && cell.outcome === 'allowed') return cell.state;
  return cell.outcome;
}

const ACCESS_RANK: Record<string, number> = { denied: 0, hidden: 0, disabled: 1, allowed: 2, enabled: 2 };

/**
 * Cells whose answer changed since the previous run of the same matrix. Only cells whose probe definition is the
 * same in both runs are compared (a probe pointed at a new URL is a new question, not a change).
 */
export function diffAgainst(previous: MatrixRunState, cells: MatrixCell[], matrix: PermissionMatrix): MatrixChange[] {
  const probeNow = new Map(matrix.probes.map((probe) => [probe.id, JSON.stringify(probe)]));
  const probeThen = new Map(previous.matrix.probes.map((probe) => [probe.id, JSON.stringify(probe)]));
  const before = new Map(previous.cells.map((cell) => [`${cell.role}\u0000${cell.probeId}`, cell]));
  const changes: MatrixChange[] = [];

  for (const cell of cells) {
    if (probeNow.get(cell.probeId) !== probeThen.get(cell.probeId)) continue;
    const old = before.get(`${cell.role}\u0000${cell.probeId}`);
    const from = old ? observed(old) : undefined;
    const to = observed(cell);
    if (from === undefined || to === undefined || from === to) continue;

    const gained = (ACCESS_RANK[to] ?? 0) > (ACCESS_RANK[from] ?? 0);
    if ((ACCESS_RANK[to] ?? 0) === (ACCESS_RANK[from] ?? 0)) continue;
    changes.push({
      role: cell.role,
      probeId: cell.probeId,
      from,
      to,
      change: gained ? 'gainedAccess' : 'lostAccess',
      alert: gained && cell.expected === undefined,
    });
  }

  return changes;
}

export function recount(state: MatrixRunState): void {
  const counts = { pending: 0, allowed: 0, denied: 0, error: 0, mismatches: 0, alerts: 0 };
  for (const cell of state.cells) {
    counts[cell.outcome] += 1;
    if (cell.matches === false) counts.mismatches += 1;
  }
  counts.alerts = state.changes.filter((change) => change.alert).length;
  state.counts = counts;
}

export function concludeMatrix(state: MatrixRunState, cancelled: boolean): void {
  recount(state);
  const { counts } = state;
  state.finishedAt = new Date().toISOString();
  state.status = cancelled ? 'cancelled' : 'completed';
  const answered = counts.allowed + counts.denied;

  const reasons: string[] = [];
  if (counts.mismatches > 0) reasons.push(`${counts.mismatches} cell(s) differ from the expectation`);
  if (counts.alerts > 0) reasons.push(`${counts.alerts} role/probe pair(s) gained access that no expectation covers`);

  if (reasons.length > 0) {
    state.verdict = 'red';
    state.verdictReason = [...reasons, ...(counts.error > 0 ? [`${counts.error} cell(s) could not be answered`] : [])].join('; ');
  } else if (cancelled) {
    state.verdict = 'infra-error';
    state.verdictReason = 'the matrix run was cancelled';
  } else if (counts.error > 0) {
    state.verdict = 'infra-error';
    state.verdictReason = `${counts.error} cell(s) could not be answered`;
  } else if (answered === 0) {
    state.verdict = 'infra-error';
    state.verdictReason = 'no cell was answered';
  } else {
    state.verdict = 'green';
    state.verdictReason = `${answered} cell(s) answered${state.matrix.expected ? ', every expectation met' : ''}${state.comparedTo ? ', no unexpected gain of access' : ''}`;
  }
  state.exitCode = state.verdict === 'green' ? 0 : state.verdict === 'red' ? 1 : 2;
}
