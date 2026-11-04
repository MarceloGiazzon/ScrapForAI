import type { HealthReport, TargetStatus } from '../health/healthAnalysis.js';
import type { Field, Message } from '../integrations/message.js';
import type { PerfRecord } from '../metrics/perfAnalysis.js';

/**
 * T9.3: the periodic summary (weekly by default), pure (no I/O, no configuration import). It RE-READS what the other pieces store and says, for
 * a period: the health of each target (T3.7, the state NOW), what broke and what was fixed (from the T3.4 series), what is flaky (T3.5),
 * what is slower (T3.4), new accessibility findings (T7.5) and how the screens changed (T4.5), from the evolution snapshots of the period.
 *
 * Rules worth knowing:
 *  - A routine's RUN is the last attempt: a first attempt that an automatic new attempt repeated (T3.5 `retryOf`) is left out, so a pass on the
 *    retry is a pass. Runs that drew generated values (`parametric`) are left out: an edge value fails on purpose.
 *  - `broke`: the last run of the period failed and a pass came before that trailing failure (in the period or before it). `fixed`: the last run
 *    before the period failed and the last one in it passed. `still-failing`: failing before and at the end (or failing with no pass ever seen).
 *    `intermittent`: passing at both ends, with failures in between. A routine with no run in the period is not listed.
 *  - Quarantined routines are listed (flagged) but never counted, as in suites. Draft/retired ones are left out.
 *  - Flakiness and performance alerts are the state NOW (their own windows), not only this period; health too. `notes` says so.
 *  - Only ids, statuses, builds, counts, times and the reasons the health panel already writes. No extracted value, no typed text, no change text
 *    of a screen (a label could be anything): evolution is counted, the details are in `GET /v1/evolution/:target/diff`.
 */

export type SummaryLang = 'en' | 'pt' | 'es';
export type RegressionKind = 'broke' | 'fixed' | 'still-failing' | 'intermittent';

export interface RoutineSeriesInput {
  id: string;
  title?: string;
  status: 'draft' | 'active' | 'quarantined' | 'retired';
  targetProfile: string;
  records: PerfRecord[];
}

export interface RegressionEntry {
  routineId: string;
  targetProfile: string;
  kind: RegressionKind;
  quarantined?: true;
  /** Runs of the period (last attempts only) and how many failed. */
  runs: number;
  failed: number;
  /** broke: the first failing run of the trailing streak; fixed: the first passing run of it. */
  since?: string;
  jobId?: string;
  /** The build of that run, and of the run right before it (for `broke`: the last build that passed). */
  build?: string;
  previousBuild?: string;
  /** broke / still-failing: the id of the first failed step of that run (`#<index>` when it had none). */
  failedStep?: string;
}

export interface FlakyInput {
  routineId: string;
  score?: number;
  runs: number;
  flaky: boolean;
  suggestion?: { action: 'quarantine' | 'release'; reason: string };
}

export interface PerfAlertInput {
  routineId: string;
  series: string;
  baselineMs: number;
  recentMs: number;
  ratio?: number;
  suspectBuild?: string;
}

export interface EvolutionPairInput {
  from: string;
  to: string;
  /** When the newer snapshot was taken. */
  at: string;
  complete?: boolean;
  counts?: { screensChanged: number; screensAdded: number; screensRemoved: number; screensUnknown: number; changes: number; expected: number; unexpected: number };
  classified?: boolean;
  accessibility?: { screensCompared: number; new: number; fixed: number; notComparable: number };
  /** The pair could not be compared (tampered, incomplete...): the code, never a path. */
  error?: string;
}

export interface EvolutionInput {
  target: string;
  pairs: EvolutionPairInput[];
  /** Builds whose snapshot in the period is the first of the target: a baseline, nothing to compare with. */
  firstSnapshots: string[];
  /** More pairs existed than the cap. */
  truncated?: boolean;
}

export interface SummaryInput {
  generatedAt: string;
  from: string;
  to: string;
  days: number;
  /** The caller's filter (absent = every target). */
  targets?: string[];
  health: HealthReport;
  routines: RoutineSeriesInput[];
  flaky: FlakyInput[];
  perfAlerts: PerfAlertInput[];
  evolution: EvolutionInput[];
}

export interface SummaryTargetHealth {
  id: string;
  name?: string;
  environment?: string;
  status: TargetStatus;
  reasons: string[];
  routines: number;
  failing: number;
  vault: { active: number; failing: number };
}

export interface SummaryReport {
  kind: 'scrapforai-summary';
  generatedAt: string;
  period: { from: string; to: string; days: number };
  targets?: string[];
  health: { schedulerRunning: boolean; totals: { targets: number; red: number; yellow: number; green: number; empty: number }; targets: SummaryTargetHealth[] };
  regressions: { counts: Record<RegressionKind, number>; items: RegressionEntry[] };
  flaky: Array<FlakyInput & { targetProfile?: string; quarantined?: true }>;
  performance: Array<PerfAlertInput & { targetProfile?: string }>;
  accessibility: { screensCompared: number; new: number; fixed: number; notComparable: number };
  evolution: EvolutionInput[];
  counts: {
    red: number;
    broke: number;
    fixed: number;
    stillFailing: number;
    flaky: number;
    perfAlerts: number;
    snapshots: number;
    screensChanged: number;
    unexpectedChanges: number;
    a11yNew: number;
  };
  notes: string[];
}

export const MAX_REASONS = 5;
const KIND_ORDER: Record<RegressionKind, number> = { broke: 0, 'still-failing': 1, intermittent: 2, fixed: 3 };

/** The runs that count: last attempts only, not parametric, oldest first. */
export function effectiveRuns(records: PerfRecord[]): PerfRecord[] {
  const repeated = new Set(records.map((record) => record.retryOf).filter((id): id is string => id !== undefined));
  return records.filter((record) => !record.parametric && !repeated.has(record.jobId)).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

const failedStepOf = (record: PerfRecord): string | undefined => {
  const index = record.steps.findIndex((step) => step.status === 'failed');
  if (index < 0) return undefined;
  return record.steps[index]!.id ?? `#${index}`;
};

/** What happened to one routine in [from, to]. Undefined = nothing to say (no run in the period, or passing throughout). */
export function classifyRegression(routine: RoutineSeriesInput, fromMs: number, toMs: number): RegressionEntry | undefined {
  const runs = effectiveRuns(routine.records);
  const before = runs.filter((run) => Date.parse(run.at) < fromMs);
  const inPeriod = runs.filter((run) => Date.parse(run.at) >= fromMs && Date.parse(run.at) <= toMs);
  if (inPeriod.length === 0) return undefined;

  const failed = inPeriod.filter((run) => run.status === 'failed').length;
  const last = inPeriod[inPeriod.length - 1]!;
  const start = before[before.length - 1];
  const base = { routineId: routine.id, targetProfile: routine.targetProfile, runs: inPeriod.length, failed, ...(routine.status === 'quarantined' ? { quarantined: true as const } : {}) };

  // The trailing streak (in the whole series up to the end of the period) with the last run's status.
  const upToEnd = [...before, ...inPeriod];
  let streakStart = upToEnd.length - 1;
  while (streakStart > 0 && upToEnd[streakStart - 1]!.status === last.status) streakStart -= 1;
  const first = upToEnd[streakStart]!;
  const previous = streakStart > 0 ? upToEnd[streakStart - 1] : undefined;
  const at = { since: first.at, jobId: first.jobId, ...(first.buildId ? { build: first.buildId } : {}), ...(previous?.buildId ? { previousBuild: previous.buildId } : {}) };

  if (last.status === 'failed') {
    const step = failedStepOf(first);
    // A pass came before the streak, and the streak began inside the period: it broke now.
    if (previous !== undefined && Date.parse(first.at) >= fromMs) return { ...base, kind: 'broke', ...at, ...(step ? { failedStep: step } : {}) };
    return { ...base, kind: 'still-failing', ...at, ...(step ? { failedStep: step } : {}) };
  }
  if (start?.status === 'failed') return { ...base, kind: 'fixed', ...at };
  if (failed > 0) return { ...base, kind: 'intermittent' };
  return undefined;
}

export function buildSummary(input: SummaryInput): SummaryReport {
  const fromMs = Date.parse(input.from);
  const toMs = Date.parse(input.to);
  const wanted = input.targets ? new Set(input.targets) : undefined;
  const inScope = (target: string | undefined): boolean => wanted === undefined || (target !== undefined && wanted.has(target));

  const routineOf = new Map(input.routines.map((routine) => [routine.id, routine]));

  // Health (the state now), only the targets in scope.
  const targets = input.health.targets.filter((target) => inScope(target.id));
  const totals = { targets: targets.length, red: 0, yellow: 0, green: 0, empty: 0 };
  for (const target of targets) totals[target.status] += 1;
  const health: SummaryReport['health'] = {
    schedulerRunning: input.health.schedulerRunning,
    totals,
    targets: targets.map((target) => ({
      id: target.id,
      ...(target.name ? { name: target.name } : {}),
      ...(target.environment ? { environment: target.environment } : {}),
      status: target.status,
      reasons: target.reasons.slice(0, MAX_REASONS),
      routines: target.routines.total,
      failing: target.routines.counts.failing,
      vault: { active: target.vault.active, failing: target.vault.failing },
    })),
  };

  // Regressions, from the series.
  const items: RegressionEntry[] = [];
  for (const routine of input.routines) {
    if (routine.status === 'draft' || routine.status === 'retired' || !inScope(routine.targetProfile)) continue;
    const entry = classifyRegression(routine, fromMs, toMs);
    if (entry) items.push(entry);
  }
  items.sort((a, b) => Number(a.quarantined === true) - Number(b.quarantined === true) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.routineId.localeCompare(b.routineId));
  const regressionCounts: Record<RegressionKind, number> = { broke: 0, fixed: 0, 'still-failing': 0, intermittent: 0 };
  for (const item of items) if (!item.quarantined) regressionCounts[item.kind] += 1;

  // Flaky and slower (state now), placed on a target through the routine.
  const flaky = input.flaky
    .filter((item) => item.flaky || item.suggestion !== undefined)
    .map((item) => {
      const routine = routineOf.get(item.routineId);
      return { ...item, ...(routine ? { targetProfile: routine.targetProfile } : {}), ...(routine?.status === 'quarantined' ? { quarantined: true as const } : {}) };
    })
    .filter((item) => inScope(item.targetProfile))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.routineId.localeCompare(b.routineId));
  const performance = input.perfAlerts
    .map((alert) => {
      const routine = routineOf.get(alert.routineId);
      return { ...alert, ...(routine ? { targetProfile: routine.targetProfile } : {}) };
    })
    .filter((alert) => inScope(alert.targetProfile))
    .sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0) || a.routineId.localeCompare(b.routineId) || a.series.localeCompare(b.series));

  // Evolution and accessibility, from the snapshots of the period.
  const evolution = input.evolution.filter((item) => inScope(item.target) && (item.pairs.length > 0 || item.firstSnapshots.length > 0));
  const accessibility = { screensCompared: 0, new: 0, fixed: 0, notComparable: 0 };
  let snapshots = 0;
  let screensChanged = 0;
  let unexpected = 0;
  for (const item of evolution) {
    snapshots += item.pairs.length + item.firstSnapshots.length;
    for (const pair of item.pairs) {
      if (pair.counts) {
        screensChanged += pair.counts.screensChanged + pair.counts.screensAdded + pair.counts.screensRemoved;
        if (pair.classified) unexpected += pair.counts.unexpected;
      }
      if (pair.accessibility) {
        accessibility.screensCompared += pair.accessibility.screensCompared;
        accessibility.new += pair.accessibility.new;
        accessibility.fixed += pair.accessibility.fixed;
        accessibility.notComparable += pair.accessibility.notComparable;
      }
    }
  }

  const notes = [
    'Health, flakiness and performance alerts are the state when the summary was made (their own windows), not only this period.',
    ...(input.health.schedulerRunning ? [] : ['The scheduler is not running in this server: schedules are stored but nothing fires.']),
    ...(evolution.some((item) => item.truncated) ? ['Some targets had more snapshot pairs than the summary lists.'] : []),
  ];

  return {
    kind: 'scrapforai-summary',
    generatedAt: input.generatedAt,
    period: { from: input.from, to: input.to, days: input.days },
    ...(input.targets ? { targets: input.targets } : {}),
    health,
    regressions: { counts: regressionCounts, items },
    flaky,
    performance,
    accessibility,
    evolution,
    counts: {
      red: totals.red,
      broke: regressionCounts.broke,
      fixed: regressionCounts.fixed,
      stillFailing: regressionCounts['still-failing'],
      flaky: flaky.filter((item) => !item.quarantined).length,
      perfAlerts: performance.length,
      snapshots,
      screensChanged,
      unexpectedChanges: unexpected,
      a11yNew: accessibility.new,
    },
    notes,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Words

interface Words {
  title: (from: string, to: string) => string;
  headline: (c: SummaryReport['counts'], targets: number) => string;
  quiet: string;
  section: Record<'health' | 'regressions' | 'flaky' | 'performance' | 'accessibility' | 'evolution' | 'notes', string>;
  status: Record<TargetStatus, string>;
  kind: Record<RegressionKind, string>;
  none: string;
  more: (n: number) => string;
  routinesLine: (total: number, failing: number, vaultActive: number, vaultFailing: number) => string;
  runs: (runs: number, failed: number) => string;
  since: string;
  build: string;
  previousBuild: string;
  step: string;
  quarantined: string;
  score: string;
  suggest: Record<'quarantine' | 'release', string>;
  slower: (series: string, baseline: number, recent: number) => string;
  suspect: string;
  a11y: (n: number, fixed: number, screens: number) => string;
  a11yNotComparable: (n: number) => string;
  pair: (from: string, to: string) => string;
  pairCounts: (changed: number, added: number, removed: number, unknown: number) => string;
  unexpected: (n: number) => string;
  notClassified: string;
  incomplete: string;
  firstSnapshot: (build: string) => string;
  pairError: (code: string) => string;
  schedulerOff: string;
}

const WORDS: Record<SummaryLang, Words> = {
  en: {
    title: (f, t) => `ScrapForAI summary, ${f} to ${t}`,
    headline: (c, n) =>
      `${n} target(s), ${c.red} red. ${c.broke} broke, ${c.fixed} fixed, ${c.stillFailing} still failing; ${c.flaky} flaky; ${c.perfAlerts} slower; ${c.a11yNew} new accessibility finding(s); ${c.snapshots} snapshot(s), ${c.screensChanged} screen(s) changed.`,
    quiet: 'Nothing broke in this period.',
    section: { health: 'Health by target', regressions: 'Regressions', flaky: 'Flaky', performance: 'Slower than baseline', accessibility: 'Accessibility', evolution: 'Evolution', notes: 'Notes' },
    status: { red: 'RED', yellow: 'YELLOW', green: 'GREEN', empty: 'EMPTY' },
    kind: { broke: 'broke', fixed: 'fixed', 'still-failing': 'still failing', intermittent: 'failed now and then' },
    none: 'none',
    more: (n) => `... and ${n} more`,
    routinesLine: (t, f, va, vf) => `${t} routine(s), ${f} failing; vault: ${va} active, ${vf} failing`,
    runs: (r, f) => `${r} run(s), ${f} failed`,
    since: 'since',
    build: 'build',
    previousBuild: 'last good build',
    step: 'step',
    quarantined: 'quarantined, not counted',
    score: 'score',
    suggest: { quarantine: 'suggests quarantine', release: 'suggests release' },
    slower: (s, b, r) => `${s}: ${b} ms -> ${r} ms`,
    suspect: 'suspect build',
    a11y: (n, f, s) => `${n} new, ${f} fixed, over ${s} screen comparison(s)`,
    a11yNotComparable: (n) => `${n} screen(s) not comparable (another standard or scope)`,
    pair: (f, t) => `${f} -> ${t}`,
    pairCounts: (c, a, r, u) => `${c} changed, ${a} added, ${r} removed${u > 0 ? `, ${u} unknown` : ''}`,
    unexpected: (n) => `${n} unexpected change(s)`,
    notClassified: 'no declared changes',
    incomplete: 'partial snapshot',
    firstSnapshot: (b) => `${b}: first snapshot (baseline)`,
    pairError: (c) => `could not be compared (${c})`,
    schedulerOff: 'Scheduler not running in this server.',
  },
  pt: {
    title: (f, t) => `Resumo do ScrapForAI, ${f} a ${t}`,
    headline: (c, n) =>
      `${n} alvo(s), ${c.red} vermelho(s). ${c.broke} quebraram, ${c.fixed} corrigidas, ${c.stillFailing} seguem falhando; ${c.flaky} instáveis; ${c.perfAlerts} mais lentas; ${c.a11yNew} achado(s) novo(s) de acessibilidade; ${c.snapshots} snapshot(s), ${c.screensChanged} tela(s) mudaram.`,
    quiet: 'Nada quebrou neste período.',
    section: { health: 'Saúde por alvo', regressions: 'Regressões', flaky: 'Instáveis', performance: 'Mais lentas que a linha de base', accessibility: 'Acessibilidade', evolution: 'Evolução', notes: 'Notas' },
    status: { red: 'VERMELHO', yellow: 'AMARELO', green: 'VERDE', empty: 'VAZIO' },
    kind: { broke: 'quebrou', fixed: 'corrigida', 'still-failing': 'segue falhando', intermittent: 'falhou às vezes' },
    none: 'nenhuma',
    more: (n) => `... e mais ${n}`,
    routinesLine: (t, f, va, vf) => `${t} rotina(s), ${f} falhando; cofre: ${va} ativos, ${vf} falhando`,
    runs: (r, f) => `${r} execução(ões), ${f} falharam`,
    since: 'desde',
    build: 'build',
    previousBuild: 'último build bom',
    step: 'step',
    quarantined: 'em quarentena, não conta',
    score: 'pontuação',
    suggest: { quarantine: 'sugere quarentena', release: 'sugere liberar' },
    slower: (s, b, r) => `${s}: ${b} ms -> ${r} ms`,
    suspect: 'build suspeito',
    a11y: (n, f, s) => `${n} novos, ${f} corrigidos, em ${s} comparação(ões) de tela`,
    a11yNotComparable: (n) => `${n} tela(s) não comparáveis (outro padrão ou escopo)`,
    pair: (f, t) => `${f} -> ${t}`,
    pairCounts: (c, a, r, u) => `${c} mudaram, ${a} novas, ${r} removidas${u > 0 ? `, ${u} desconhecidas` : ''}`,
    unexpected: (n) => `${n} mudança(s) inesperada(s)`,
    notClassified: 'sem mudanças declaradas',
    incomplete: 'snapshot parcial',
    firstSnapshot: (b) => `${b}: primeiro snapshot (linha de base)`,
    pairError: (c) => `não pôde ser comparado (${c})`,
    schedulerOff: 'O agendador não está rodando neste servidor.',
  },
  es: {
    title: (f, t) => `Resumen de ScrapForAI, ${f} a ${t}`,
    headline: (c, n) =>
      `${n} objetivo(s), ${c.red} en rojo. ${c.broke} se rompieron, ${c.fixed} corregidas, ${c.stillFailing} siguen fallando; ${c.flaky} inestables; ${c.perfAlerts} más lentas; ${c.a11yNew} hallazgo(s) nuevo(s) de accesibilidad; ${c.snapshots} snapshot(s), ${c.screensChanged} pantalla(s) cambiaron.`,
    quiet: 'Nada se rompió en este período.',
    section: { health: 'Salud por objetivo', regressions: 'Regresiones', flaky: 'Inestables', performance: 'Más lentas que la línea base', accessibility: 'Accesibilidad', evolution: 'Evolución', notes: 'Notas' },
    status: { red: 'ROJO', yellow: 'AMARILLO', green: 'VERDE', empty: 'VACÍO' },
    kind: { broke: 'se rompió', fixed: 'corregida', 'still-failing': 'sigue fallando', intermittent: 'falló a veces' },
    none: 'ninguna',
    more: (n) => `... y ${n} más`,
    routinesLine: (t, f, va, vf) => `${t} rutina(s), ${f} fallando; bóveda: ${va} activos, ${vf} fallando`,
    runs: (r, f) => `${r} ejecución(es), ${f} fallaron`,
    since: 'desde',
    build: 'build',
    previousBuild: 'último build bueno',
    step: 'step',
    quarantined: 'en cuarentena, no cuenta',
    score: 'puntaje',
    suggest: { quarantine: 'sugiere cuarentena', release: 'sugiere liberar' },
    slower: (s, b, r) => `${s}: ${b} ms -> ${r} ms`,
    suspect: 'build sospechoso',
    a11y: (n, f, s) => `${n} nuevos, ${f} corregidos, en ${s} comparación(es) de pantalla`,
    a11yNotComparable: (n) => `${n} pantalla(s) no comparables (otro estándar o alcance)`,
    pair: (f, t) => `${f} -> ${t}`,
    pairCounts: (c, a, r, u) => `${c} cambiaron, ${a} nuevas, ${r} eliminadas${u > 0 ? `, ${u} desconocidas` : ''}`,
    unexpected: (n) => `${n} cambio(s) inesperado(s)`,
    notClassified: 'sin cambios declarados',
    incomplete: 'snapshot parcial',
    firstSnapshot: (b) => `${b}: primer snapshot (línea base)`,
    pairError: (c) => `no se pudo comparar (${c})`,
    schedulerOff: 'El planificador no está corriendo en este servidor.',
  },
};

const NOTE_WORDS: Record<SummaryLang, Record<string, string>> = {
  en: {},
  pt: {
    'Health, flakiness and performance alerts are the state when the summary was made (their own windows), not only this period.':
      'Saúde, instabilidade e alertas de desempenho são o estado no momento do resumo (com as janelas de cada um), não só deste período.',
    'The scheduler is not running in this server: schedules are stored but nothing fires.': 'O agendador não está rodando neste servidor: os agendamentos estão guardados, mas nada dispara.',
    'Some targets had more snapshot pairs than the summary lists.': 'Alguns alvos tinham mais pares de snapshots do que o resumo lista.',
  },
  es: {
    'Health, flakiness and performance alerts are the state when the summary was made (their own windows), not only this period.':
      'Salud, inestabilidad y alertas de rendimiento son el estado al hacer el resumen (con las ventanas de cada uno), no solo de este período.',
    'The scheduler is not running in this server: schedules are stored but nothing fires.': 'El planificador no está corriendo en este servidor: las programaciones están guardadas pero nada se dispara.',
    'Some targets had more snapshot pairs than the summary lists.': 'Algunos objetivos tenían más pares de snapshots de los que lista el resumen.',
  },
};

const day = (iso: string): string => iso.slice(0, 10);
const ratio = (value: number | undefined): string => (value === undefined ? '' : ` (x${value.toFixed(2)})`);

/** The lines of each section, in order, without headings. Shared by the Markdown file and the webhook message. */
export function summarySections(report: SummaryReport, lang: SummaryLang): Array<{ key: keyof Words['section']; title: string; lines: string[] }> {
  const w = WORDS[lang];

  const health = report.health.targets.map((target) => {
    const head = `${w.status[target.status]} ${target.id}${target.environment ? ` (${target.environment})` : ''}: ${w.routinesLine(target.routines, target.failing, target.vault.active, target.vault.failing)}`;
    return [head, ...target.reasons.map((reason) => `  - ${reason}`)].join('\n');
  });
  if (!report.health.schedulerRunning) health.push(w.schedulerOff);

  const regressions = report.regressions.items.map((item) => {
    const parts = [`${item.routineId} [${item.targetProfile}]: ${w.kind[item.kind]}`, w.runs(item.runs, item.failed)];
    if (item.since && item.kind !== 'intermittent') parts.push(`${w.since} ${item.since.slice(0, 16).replace('T', ' ')}`);
    if (item.build) parts.push(`${w.build} ${item.build}`);
    if (item.kind === 'broke' && item.previousBuild) parts.push(`${w.previousBuild} ${item.previousBuild}`);
    if (item.failedStep) parts.push(`${w.step} ${item.failedStep}`);
    if (item.quarantined) parts.push(w.quarantined);
    return parts.join(', ');
  });

  const flaky = report.flaky.map((item) =>
    [`${item.routineId}${item.targetProfile ? ` [${item.targetProfile}]` : ''}`, item.score === undefined ? undefined : `${w.score} ${item.score.toFixed(2)}`, item.suggestion ? w.suggest[item.suggestion.action] : undefined, item.quarantined ? w.quarantined : undefined]
      .filter((part): part is string => part !== undefined)
      .join(', '),
  );

  const performance = report.performance.map(
    (alert) => `${alert.routineId}${alert.targetProfile ? ` [${alert.targetProfile}]` : ''} ${w.slower(alert.series, Math.round(alert.baselineMs), Math.round(alert.recentMs))}${ratio(alert.ratio)}${alert.suspectBuild ? `, ${w.suspect} ${alert.suspectBuild}` : ''}`,
  );

  const a = report.accessibility;
  const accessibility = a.screensCompared === 0 && a.notComparable === 0 ? [] : [w.a11y(a.new, a.fixed, a.screensCompared), ...(a.notComparable > 0 ? [w.a11yNotComparable(a.notComparable)] : [])];

  const evolution: string[] = [];
  for (const item of report.evolution) {
    for (const build of item.firstSnapshots) evolution.push(`${item.target}: ${w.firstSnapshot(build)}`);
    for (const pair of item.pairs) {
      if (pair.error || !pair.counts) {
        evolution.push(`${item.target} ${w.pair(pair.from, pair.to)}: ${w.pairError(pair.error ?? 'unknown')}`);
        continue;
      }
      const c = pair.counts;
      const parts = [w.pairCounts(c.screensChanged, c.screensAdded, c.screensRemoved, c.screensUnknown), pair.classified ? w.unexpected(c.unexpected) : w.notClassified];
      if (pair.accessibility && (pair.accessibility.new > 0 || pair.accessibility.fixed > 0)) parts.push(w.a11y(pair.accessibility.new, pair.accessibility.fixed, pair.accessibility.screensCompared));
      if (pair.complete === false) parts.push(w.incomplete);
      evolution.push(`${item.target} ${w.pair(pair.from, pair.to)}: ${parts.join('; ')}`);
    }
  }

  const notes = report.notes.map((note) => NOTE_WORDS[lang][note] ?? note);
  return [
    { key: 'health', title: w.section.health, lines: health },
    { key: 'regressions', title: w.section.regressions, lines: regressions },
    { key: 'flaky', title: w.section.flaky, lines: flaky },
    { key: 'performance', title: w.section.performance, lines: performance },
    { key: 'accessibility', title: w.section.accessibility, lines: accessibility },
    { key: 'evolution', title: w.section.evolution, lines: evolution },
    { key: 'notes', title: w.section.notes, lines: notes },
  ];
}

export function summaryTitle(report: SummaryReport, lang: SummaryLang): string {
  return WORDS[lang].title(day(report.period.from), day(report.period.to));
}

export function summaryHeadline(report: SummaryReport, lang: SummaryLang): string {
  const w = WORDS[lang];
  const line = w.headline(report.counts, report.health.totals.targets);
  return report.counts.broke === 0 && report.counts.stillFailing === 0 ? `${line} ${w.quiet}` : line;
}

/** The file a `summary` schedule writes (and `GET /v1/summary` returns as `markdown`). Ids come from safe-name schemas; nothing here is HTML. */
export function renderSummaryMarkdown(report: SummaryReport, lang: SummaryLang): string {
  const w = WORDS[lang];
  const out = [`# ${summaryTitle(report, lang)}`, '', summaryHeadline(report, lang), ''];
  if (report.targets) out.push(`_${report.targets.join(', ')}_`, '');
  for (const section of summarySections(report, lang)) {
    out.push(`## ${section.title}`, '');
    if (section.lines.length === 0) out.push(`- ${w.none}`);
    for (const line of section.lines) {
      const [first, ...rest] = line.split('\n');
      out.push(`- ${first}`, ...rest.map((sub) => `  ${sub}`));
    }
    out.push('');
  }
  out.push(`<sub>${report.generatedAt}</sub>`, '');
  return out.join('\n');
}

export const MESSAGE_LINES_PER_FIELD = 8;

/** The webhook message (T3.3 presets render it). Empty sections are left out; each field holds at most a few lines. */
export function summaryReportMessage(report: SummaryReport, lang: SummaryLang): Message {
  const w = WORDS[lang];
  const fields: Field[] = [];
  for (const section of summarySections(report, lang)) {
    if (section.lines.length === 0 || section.key === 'notes') continue;
    const shown = section.lines.slice(0, MESSAGE_LINES_PER_FIELD);
    const value = [...shown, ...(section.lines.length > shown.length ? [w.more(section.lines.length - shown.length)] : [])].join('\n');
    fields.push({ name: section.title, value });
  }
  const bad = report.counts.red > 0 || report.counts.broke > 0 || report.counts.stillFailing > 0;
  return { kind: 'summary', severity: bad ? 'bad' : 'info', title: summaryTitle(report, lang), text: summaryHeadline(report, lang), fields, at: report.generatedAt };
}
