import type { NotifyLang } from '../schemas/webhook.schema.js';
import type { ChangeKind } from './transitions.js';

/**
 * T3.3: the message a webhook carries, independent of the chat product (presets.ts turns it into Slack/Teams/Chat/JSON).
 * Pure. Strings come from facts of a run, so the caller scrubs them (scrub.ts) before sending; the words here are fixed.
 */

export type Severity = 'bad' | 'good' | 'info';
export interface Field {
  name: string;
  value: string;
}
export interface Message {
  kind: ChangeKind | 'summary' | 'test';
  severity: Severity;
  title: string;
  text: string;
  fields: Field[];
  /** ISO instant the message is about. */
  at: string;
  subject?: string;
}

interface Words {
  broken: (subject: string) => string;
  recovered: (subject: string) => string;
  firstObservation: string;
  testTitle: string;
  testText: string;
  summaryTitle: (date: string) => string;
  summaryLine: (total: number, ok: number, bad: number, unknown: number) => string;
  noSchedules: string;
  field: Record<'schedule' | 'target' | 'outcome' | 'build' | 'run' | 'detail' | 'failures' | 'counts' | 'since' | 'failingSince' | 'last24h' | 'preset' | 'sentBy', string>;
  outcome: Record<string, string>;
  failingSince: (since: string) => string;
  passing: string;
  failing: string;
  noRuns: string;
}

const WORDS: Record<NotifyLang, Words> = {
  en: {
    broken: (s) => `${s} is failing`,
    recovered: (s) => `${s} is passing again`,
    firstObservation: 'First result seen by this channel.',
    testTitle: 'ScrapForAI test message',
    testText: 'If you can read this, the webhook works. Nothing is wrong.',
    summaryTitle: (d) => `ScrapForAI daily summary, ${d}`,
    summaryLine: (t, ok, bad, u) => `${t} schedule(s): ${ok} passing, ${bad} failing${u > 0 ? `, ${u} with no result yet` : ''}.`,
    noSchedules: 'No schedule reports to this webhook.',
    field: { schedule: 'Schedule', target: 'Target', outcome: 'Outcome', build: 'Build', run: 'Run', detail: 'Detail', failures: 'Failures', counts: 'Counts', since: 'Since', failingSince: 'Failing since', last24h: 'Last 24 h', preset: 'Preset', sentBy: 'Sent by' },
    outcome: { passed: 'passed', failed: 'failed', error: 'could not run', 'skipped-evaluate': 'not run (uses evaluate/watch)' },
    failingSince: (s) => `failing since ${s}`,
    passing: 'passing',
    failing: 'failing',
    noRuns: 'no runs',
  },
  pt: {
    broken: (s) => `${s} começou a falhar`,
    recovered: (s) => `${s} voltou a passar`,
    firstObservation: 'Primeiro resultado que este canal recebe.',
    testTitle: 'Mensagem de teste do ScrapForAI',
    testText: 'Se você leu isto, o webhook funciona. Nada está errado.',
    summaryTitle: (d) => `Resumo diário do ScrapForAI, ${d}`,
    summaryLine: (t, ok, bad, u) => `${t} agendamento(s): ${ok} passando, ${bad} falhando${u > 0 ? `, ${u} sem resultado ainda` : ''}.`,
    noSchedules: 'Nenhum agendamento informa a este webhook.',
    field: { schedule: 'Agendamento', target: 'Alvo', outcome: 'Resultado', build: 'Build', run: 'Execução', detail: 'Detalhe', failures: 'Falhas', counts: 'Contagem', since: 'Desde', failingSince: 'Falhando desde', last24h: 'Últimas 24 h', preset: 'Preset', sentBy: 'Enviado por' },
    outcome: { passed: 'passou', failed: 'falhou', error: 'não pôde executar', 'skipped-evaluate': 'não executou (usa evaluate/watch)' },
    failingSince: (s) => `falhando desde ${s}`,
    passing: 'passando',
    failing: 'falhando',
    noRuns: 'sem execuções',
  },
  es: {
    broken: (s) => `${s} empezó a fallar`,
    recovered: (s) => `${s} volvió a pasar`,
    firstObservation: 'Primer resultado que recibe este canal.',
    testTitle: 'Mensaje de prueba de ScrapForAI',
    testText: 'Si puede leer esto, el webhook funciona. No pasa nada.',
    summaryTitle: (d) => `Resumen diario de ScrapForAI, ${d}`,
    summaryLine: (t, ok, bad, u) => `${t} programación(es): ${ok} pasando, ${bad} fallando${u > 0 ? `, ${u} sin resultado aún` : ''}.`,
    noSchedules: 'Ninguna programación informa a este webhook.',
    field: { schedule: 'Programación', target: 'Objetivo', outcome: 'Resultado', build: 'Build', run: 'Ejecución', detail: 'Detalle', failures: 'Fallos', counts: 'Conteo', since: 'Desde', failingSince: 'Fallando desde', last24h: 'Últimas 24 h', preset: 'Preset', sentBy: 'Enviado por' },
    outcome: { passed: 'pasó', failed: 'falló', error: 'no pudo ejecutarse', 'skipped-evaluate': 'no se ejecutó (usa evaluate/watch)' },
    failingSince: (s) => `fallando desde ${s}`,
    passing: 'pasando',
    failing: 'fallando',
    noRuns: 'sin ejecuciones',
  },
};

const add = (fields: Field[], name: string, value: string | undefined): void => {
  if (value !== undefined && value !== '') fields.push({ name, value });
};

export interface ChangeInput {
  kind: ChangeKind;
  first: boolean;
  lang: NotifyLang;
  scheduleId: string;
  /** For example "routine crud v2", "suite nightly", "regression vault", "evolution snapshot app-dev". */
  targetLabel: string;
  outcome: string;
  detail?: string;
  at: string;
  /** For a recovery: when the channel was told it broke. */
  badSince?: string;
  buildId?: string;
  runId?: string;
  failures?: string[];
  counts?: Record<string, number>;
}

export function changeMessage(input: ChangeInput): Message {
  const words = WORDS[input.lang];
  const fields: Field[] = [];
  add(fields, words.field.schedule, input.scheduleId);
  add(fields, words.field.target, input.targetLabel);
  add(fields, words.field.outcome, words.outcome[input.outcome] ?? input.outcome);
  add(fields, words.field.build, input.buildId);
  add(fields, words.field.run, input.runId);
  add(fields, words.field.detail, input.detail);
  if (input.failures && input.failures.length > 0) add(fields, words.field.failures, input.failures.map((line) => `- ${line}`).join('\n'));
  if (input.counts) add(fields, words.field.counts, Object.entries(input.counts).filter(([, n]) => n > 0).map(([k, n]) => `${k}: ${n}`).join(', '));
  if (input.kind === 'recovered') add(fields, words.field.failingSince, input.badSince);

  return {
    kind: input.kind,
    severity: input.kind === 'broken' ? 'bad' : 'good',
    title: (input.kind === 'broken' ? words.broken : words.recovered)(input.scheduleId),
    text: input.first ? words.firstObservation : '',
    fields,
    at: input.at,
    subject: `schedule:${input.scheduleId}`,
  };
}

export interface SummaryRow {
  scheduleId: string;
  /** What the channel was last told (or the last verdict seen); undefined = nothing has run yet. */
  verdict?: 'ok' | 'bad';
  since?: string;
  /** Outcomes of the last 24 h, counted. */
  last24h: Record<string, number>;
}

export function summaryMessage(lang: NotifyLang, date: string, at: string, rows: SummaryRow[]): Message {
  const words = WORDS[lang];
  const ok = rows.filter((row) => row.verdict === 'ok').length;
  const bad = rows.filter((row) => row.verdict === 'bad').length;
  const fields: Field[] = rows.map((row) => {
    const counts = Object.entries(row.last24h)
      .filter(([, n]) => n > 0)
      .map(([outcome, n]) => `${n} ${words.outcome[outcome] ?? outcome}`)
      .join(', ');
    const state = row.verdict === 'bad' ? (row.since ? words.failingSince(row.since) : words.failing) : row.verdict === 'ok' ? words.passing : words.noRuns;
    return { name: row.scheduleId, value: `${state}${counts ? ` | ${words.field.last24h}: ${counts}` : ''}` };
  });

  return {
    kind: 'summary',
    severity: bad > 0 ? 'bad' : 'info',
    title: words.summaryTitle(date),
    text: rows.length === 0 ? words.noSchedules : words.summaryLine(rows.length, ok, bad, rows.length - ok - bad),
    fields,
    at,
  };
}

export function testMessage(lang: NotifyLang, preset: string, at: string): Message {
  const words = WORDS[lang];
  return { kind: 'test', severity: 'info', title: words.testTitle, text: words.testText, fields: [{ name: words.field.preset, value: preset }], at };
}
