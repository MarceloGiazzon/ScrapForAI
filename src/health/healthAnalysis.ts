/**
 * T3.7: the health panel, pure (no I/O, no configuration import). It only RE-READS what the other pieces already know and groups it by target
 * profile: the last state and trend of each library routine (T3.4 series), flakiness (T3.5), performance alerts (T3.4), the regression vault
 * (T2.x) and the schedules (T3.2). It decides nothing new: no run is started, no status is changed, nothing is suggested that T3.5 did not.
 *
 * Rules worth knowing:
 *  - A routine is `failing` when its LAST run failed. A run that passed only on the automatic new attempt is a pass (the series holds both attempts).
 *  - `flaky` = T3.5 flagged it or proposes quarantine; `slower` = a T3.4 alert. Failing wins over flaky, flaky over slower.
 *  - A quarantined routine (or vault item) is reported apart: it does not turn its target red, as in suites (T3.5).
 *  - `draft`/`retired` routines are `inactive`: counted, not judged.
 *  - A target is `red` when something that counts is failing, `yellow` when nothing fails but something needs a person (flaky, slower, a quarantine
 *    suggestion, a schedule that cannot fire), `green` when it has results and none of that, `empty` when no routine or vault item has ever run.
 *  - Schedules that start a suite or the vault are not tied to ONE target (a suite can span several), so they are listed in `unscoped`.
 */

export type RoutineStatusName = 'draft' | 'active' | 'quarantined' | 'retired';
export type RoutineState = 'failing' | 'flaky' | 'slower' | 'passing' | 'never-run' | 'quarantined' | 'inactive';
export type Trend = 'worsening' | 'improving' | 'steady' | 'unknown';
export type TargetStatus = 'red' | 'yellow' | 'green' | 'empty';

export interface RoutineHealthInput {
  id: string;
  title: string;
  version: number;
  status: RoutineStatusName;
  targetProfile: string;
  /** The latest run of the series (any population, parametric or not), if the routine ever ran. */
  lastRun?: { jobId: string; at: string; status: 'passed' | 'failed'; buildId?: string };
  /** The latest FAILED run of the series (links from a row to its report); only ids, times and a build id. */
  lastFailedRun?: { jobId: string; at: string; buildId?: string };
  /** Pass/fail strip of the flakiness window, oldest first. */
  results: Array<'passed' | 'failed'>;
  flakyScore?: number;
  flaky: boolean;
  suggestion?: { action: 'quarantine' | 'release'; reason: string };
  /** Series that are slower than their baseline (`(run)` or a step id). */
  slower: Array<{ series: string; ratio?: number; suspectBuild?: string }>;
}

export interface RoutineHealth {
  id: string;
  title: string;
  version: number;
  status: RoutineStatusName;
  state: RoutineState;
  lastRun?: RoutineHealthInput['lastRun'];
  /** The latest failed run, only when it is not `lastRun` itself (the routine passed since). */
  lastFailedRun?: RoutineHealthInput['lastFailedRun'];
  /** Consecutive runs, at the end of the strip, with the same result as the last one. */
  streak?: { status: 'passed' | 'failed'; runs: number };
  trend: Trend;
  results: Array<'passed' | 'failed'>;
  flakyScore?: number;
  suggestion?: RoutineHealthInput['suggestion'];
  slower: RoutineHealthInput['slower'];
}

export interface VaultItemInput {
  id: string;
  title: string;
  status: 'ACTIVE' | 'QUARANTINED' | 'RETIRED';
  severity: string | null;
  surface: string;
  routineId: string;
  lastRun?: { jobId: string; status: 'passed' | 'failed'; at: string; buildId?: string };
}

export interface VaultHealth {
  total: number;
  active: number;
  quarantined: number;
  retired: number;
  /** Among ACTIVE items. */
  passing: number;
  failing: number;
  notRun: number;
  /** ACTIVE items whose last run failed, then ACTIVE ones never run: the ones that need an eye. */
  attention: Array<{ id: string; title: string; severity: string | null; surface: string; state: 'failing' | 'not-run'; lastRun?: VaultItemInput['lastRun'] }>;
  /** QUARANTINED items whose last run failed (reported apart, like quarantined routines). */
  quarantinedFailing: number;
}

/** What a scheduled occurrence started (T3.2): `run` = a job id, `suite` = a suite run id. Ids only. */
export interface ScheduleRunRef {
  kind: 'run' | 'suite' | 'snapshot' | 'summary';
  id: string;
}

export interface ScheduleInput {
  id: string;
  enabled: boolean;
  cron: string;
  timezone: string;
  target: { kind: 'routine' | 'suite' | 'vault' | 'evolutionSnapshot' | 'summary'; routineId?: string; targetProfile?: string };
  next: string[];
  running?: boolean;
  lastRun?: { outcome: string; at: string; passedOnRetry?: boolean; run?: ScheduleRunRef };
  notify: number;
}

export type ScheduleState = 'ok' | 'failing' | 'disabled' | 'not-firing' | 'never-ran';

export interface ScheduleHealth {
  id: string;
  kind: ScheduleInput['target']['kind'];
  routineId?: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  state: ScheduleState;
  next?: string;
  running: boolean;
  lastRun?: ScheduleInput['lastRun'];
  /** True when the schedule has webhooks that would be told of a break. */
  notifies: boolean;
}

export interface TargetInput {
  id: string;
  name?: string;
  environment?: string;
}

export interface TargetHealth {
  id: string;
  name?: string;
  environment?: string;
  /** False when routines point at a profile that no longer exists. */
  known: boolean;
  status: TargetStatus;
  /** One short sentence per reason the status is not green, most important first. */
  reasons: string[];
  routines: {
    total: number;
    counts: Record<RoutineState, number>;
    list: RoutineHealth[];
  };
  vault: VaultHealth;
  schedules: ScheduleHealth[];
}

export interface HealthReport {
  generatedAt: string;
  schedulerRunning: boolean;
  /** Worst target first, then by id. */
  targets: TargetHealth[];
  /** Vault items that no known routine places on a target, and schedules that start a suite or the vault. */
  unscoped: { vault: VaultHealth; schedules: ScheduleHealth[] };
  totals: { targets: number; red: number; yellow: number; green: number; empty: number };
}

const STATES: RoutineState[] = ['failing', 'flaky', 'slower', 'passing', 'never-run', 'quarantined', 'inactive'];
const STATE_ORDER: Record<RoutineState, number> = { failing: 0, flaky: 1, slower: 2, 'never-run': 3, passing: 4, quarantined: 5, inactive: 6 };
const STATUS_ORDER: Record<TargetStatus, number> = { red: 0, yellow: 1, green: 2, empty: 3 };

/** Older half vs newer half of the strip: a clear change in the share of failures. Needs 6 results, else `unknown`. */
export function trendOf(results: Array<'passed' | 'failed'>): Trend {
  if (results.length < 6) return 'unknown';
  const middle = Math.floor(results.length / 2);
  const rate = (part: Array<'passed' | 'failed'>): number => part.filter((result) => result === 'failed').length / part.length;
  const change = rate(results.slice(middle)) - rate(results.slice(0, middle));
  return change >= 0.25 ? 'worsening' : change <= -0.25 ? 'improving' : 'steady';
}

export function classifyRoutine(input: RoutineHealthInput): RoutineHealth {
  let state: RoutineState;
  if (input.status === 'draft' || input.status === 'retired') state = 'inactive';
  else if (input.status === 'quarantined') state = 'quarantined';
  else if (!input.lastRun) state = 'never-run';
  else if (input.lastRun.status === 'failed') state = 'failing';
  else if (input.flaky || input.suggestion?.action === 'quarantine') state = 'flaky';
  else if (input.slower.length > 0) state = 'slower';
  else state = 'passing';

  let streak: RoutineHealth['streak'];
  if (input.results.length > 0) {
    const last = input.results[input.results.length - 1]!;
    let runs = 0;
    for (let index = input.results.length - 1; index >= 0 && input.results[index] === last; index -= 1) runs += 1;
    streak = { status: last, runs };
  }

  return {
    id: input.id,
    title: input.title,
    version: input.version,
    status: input.status,
    state,
    ...(input.lastRun ? { lastRun: input.lastRun } : {}),
    ...(input.lastFailedRun && input.lastFailedRun.jobId !== input.lastRun?.jobId ? { lastFailedRun: input.lastFailedRun } : {}),
    ...(streak ? { streak } : {}),
    trend: trendOf(input.results),
    results: input.results,
    ...(input.flakyScore === undefined ? {} : { flakyScore: input.flakyScore }),
    ...(input.suggestion ? { suggestion: input.suggestion } : {}),
    slower: input.slower,
  };
}

export function summarizeVault(items: VaultItemInput[]): VaultHealth {
  const active = items.filter((item) => item.status === 'ACTIVE');
  const attention: VaultHealth['attention'] = [];
  for (const item of active) {
    const state = item.lastRun === undefined ? 'not-run' : item.lastRun.status === 'failed' ? 'failing' : undefined;
    if (state) attention.push({ id: item.id, title: item.title, severity: item.severity, surface: item.surface, state, ...(item.lastRun ? { lastRun: item.lastRun } : {}) });
  }
  attention.sort((a, b) => Number(a.state === 'not-run') - Number(b.state === 'not-run') || a.id.localeCompare(b.id, 'en', { numeric: true }));

  return {
    total: items.length,
    active: active.length,
    quarantined: items.filter((item) => item.status === 'QUARANTINED').length,
    retired: items.filter((item) => item.status === 'RETIRED').length,
    passing: active.filter((item) => item.lastRun?.status === 'passed').length,
    failing: attention.filter((item) => item.state === 'failing').length,
    notRun: attention.filter((item) => item.state === 'not-run').length,
    attention,
    quarantinedFailing: items.filter((item) => item.status === 'QUARANTINED' && item.lastRun?.status === 'failed').length,
  };
}

export function classifySchedule(input: ScheduleInput, schedulerRunning: boolean): ScheduleHealth {
  const outcome = input.lastRun?.outcome;
  let state: ScheduleState;
  if (!input.enabled) state = 'disabled';
  else if (!schedulerRunning) state = 'not-firing';
  else if (outcome === 'failed' || outcome === 'error') state = 'failing';
  else if (!input.lastRun) state = 'never-ran';
  else state = 'ok';

  return {
    id: input.id,
    kind: input.target.kind,
    ...(input.target.routineId ? { routineId: input.target.routineId } : {}),
    cron: input.cron,
    timezone: input.timezone,
    enabled: input.enabled,
    state,
    ...(input.next[0] ? { next: input.next[0] } : {}),
    running: input.running === true,
    ...(input.lastRun ? { lastRun: input.lastRun } : {}),
    notifies: input.notify > 0,
  };
}

function countStates(list: RoutineHealth[]): Record<RoutineState, number> {
  const counts = Object.fromEntries(STATES.map((state) => [state, 0])) as Record<RoutineState, number>;
  for (const routine of list) counts[routine.state] += 1;
  return counts;
}

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

function judge(routines: TargetHealth['routines'], vault: VaultHealth, schedules: ScheduleHealth[]): { status: TargetStatus; reasons: string[] } {
  const red: string[] = [];
  const yellow: string[] = [];
  const { counts } = routines;

  if (counts.failing > 0) red.push(`${plural(counts.failing, 'routine')} failing in the last run`);
  if (vault.failing > 0) red.push(`${plural(vault.failing, 'vault item')} failing`);
  const failingSchedules = schedules.filter((schedule) => schedule.state === 'failing').length;
  if (failingSchedules > 0) red.push(`${plural(failingSchedules, 'schedule')} failed at the last occurrence`);

  if (counts.flaky > 0) yellow.push(`${plural(counts.flaky, 'flaky routine')}`);
  if (counts.slower > 0) yellow.push(`${plural(counts.slower, 'routine')} slower than usual`);
  const toQuarantine = routines.list.filter((routine) => routine.suggestion?.action === 'quarantine' && routine.state !== 'flaky' && routine.state !== 'failing').length;
  if (toQuarantine > 0) yellow.push(`${plural(toQuarantine, 'routine')} proposed for quarantine`);
  const toRelease = routines.list.filter((routine) => routine.suggestion?.action === 'release').length;
  if (toRelease > 0) yellow.push(`${plural(toRelease, 'quarantined routine')} could be released`);
  const notFiring = schedules.filter((schedule) => schedule.state === 'not-firing').length;
  if (notFiring > 0) yellow.push(`${plural(notFiring, 'schedule')} enabled but the scheduler is not running`);

  const ran = counts.failing + counts.flaky + counts.slower + counts.passing + vault.passing + vault.failing;
  if (red.length > 0) return { status: 'red', reasons: [...red, ...yellow] };
  if (yellow.length > 0) return { status: 'yellow', reasons: yellow };
  return { status: ran > 0 ? 'green' : 'empty', reasons: [] };
}

export interface HealthInput {
  now: string;
  schedulerRunning: boolean;
  targets: TargetInput[];
  routines: RoutineHealthInput[];
  vault: VaultItemInput[];
  schedules: ScheduleInput[];
}

export function buildHealth(input: HealthInput): HealthReport {
  const routineTarget = new Map(input.routines.map((routine) => [routine.id, routine.targetProfile]));
  const known = new Map(input.targets.map((target) => [target.id, target]));
  const ids = new Set<string>([...input.targets.map((target) => target.id), ...input.routines.map((routine) => routine.targetProfile)]);

  const vaultByTarget = new Map<string, VaultItemInput[]>();
  const unscopedVault: VaultItemInput[] = [];
  for (const item of input.vault) {
    const target = routineTarget.get(item.routineId);
    if (!target) {
      unscopedVault.push(item);
      continue;
    }
    vaultByTarget.set(target, [...(vaultByTarget.get(target) ?? []), item]);
  }

  const schedulesByTarget = new Map<string, ScheduleHealth[]>();
  const unscopedSchedules: ScheduleHealth[] = [];
  for (const schedule of input.schedules) {
    const health = classifySchedule(schedule, input.schedulerRunning);
    const { target } = schedule;
    const owner =
      target.kind === 'routine' ? (target.targetProfile ?? (target.routineId ? routineTarget.get(target.routineId) : undefined)) : target.kind === 'evolutionSnapshot' ? target.targetProfile : undefined;
    if (!owner) {
      unscopedSchedules.push(health);
      continue;
    }
    ids.add(owner);
    schedulesByTarget.set(owner, [...(schedulesByTarget.get(owner) ?? []), health]);
  }

  const targets: TargetHealth[] = [...ids].map((id) => {
    const list = input.routines
      .filter((routine) => routine.targetProfile === id)
      .map(classifyRoutine)
      .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.id.localeCompare(b.id));
    const routines = { total: list.length, counts: countStates(list), list };
    const vault = summarizeVault(vaultByTarget.get(id) ?? []);
    const schedules = (schedulesByTarget.get(id) ?? []).sort((a, b) => a.id.localeCompare(b.id));
    const profile = known.get(id);
    return {
      id,
      ...(profile?.name ? { name: profile.name } : {}),
      ...(profile?.environment ? { environment: profile.environment } : {}),
      known: profile !== undefined,
      ...judge(routines, vault, schedules),
      routines,
      vault,
      schedules,
    };
  });
  targets.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.id.localeCompare(b.id));

  const totals = { targets: targets.length, red: 0, yellow: 0, green: 0, empty: 0 };
  for (const target of targets) totals[target.status] += 1;

  return {
    generatedAt: input.now,
    schedulerRunning: input.schedulerRunning,
    targets,
    unscoped: { vault: summarizeVault(unscopedVault), schedules: unscopedSchedules.sort((a, b) => a.id.localeCompare(b.id)) },
    totals,
  };
}
