import type { BugSignature } from '../schemas/bugReport.schema.js';
import type { ReportLang } from '../schemas/integration.schema.js';
import { fenced, inlineCode, titleSafe } from './markdownSafe.js';

/**
 * T9.1: turns the facts of a failed run into the title and Markdown body of an issue. PURE: no I/O, no configuration. The one thing it is given
 * that it cannot do itself is `clean`, the function that hides vault values, secret shapes and personal data in a string (the service passes the
 * real one; a test passes a marker to prove EVERY string that comes from outside goes through it). Strings that are ours (ids with a fixed shape,
 * timestamps, version numbers, the signature hash) are not cleaned: they cannot carry a value, and the personal-data detectors would only damage them.
 */

export interface HistoryPoint {
  jobId: string;
  at: string;
  buildId?: string;
  version?: number;
}

export interface BugFacts {
  jobId: string;
  scenarioName: string;
  startedAt: string;
  durationMs: number;
  buildId?: string;
  buildIdSource?: string;
  routine?: { id: string; version: number };
  /** `functional` runs have no screenshot or trace. */
  runProfile?: string;
  application?: string;
  environment?: string;
  platform?: string;
  targetProfile?: string;
  /** Origin + path of the page under test, already stripped of its query and fragment. */
  address: string;
  failure: { stepId: string; stepIndex: number; action: string; label?: string; errorType: string; errorMessage: string; actor?: string };
  steps: Array<{ index: number; id?: string; action: string; label?: string; status: string; actor?: string }>;
  consoleErrors: string[];
  networkFailures: string[];
  parameters?: { seed: string; sample: number; rows: Array<{ name: string; value: string; source: string; synthetic: boolean }> };
  shrink?: {
    shrinkId: string;
    outcome: string;
    summary?: string;
    minimal: Record<string, string>;
    boundaries: Array<{ parameter: string; fails: string; passes: string; precision: string }>;
    minimalJobId?: string;
  };
  /** Evidence-only "since when" (the data a later bisect, T3.6, starts from): NOT a diagnosis. */
  since?: { lastGreen?: HistoryPoint; firstRed?: HistoryPoint; buildChanged?: boolean };
  /** A command line that repeats the run. */
  replay?: string;
  evidence: { location: 'ephemeral' | 'pinned' };
  recurrenceOf?: { id: string; issueUrl?: string };
  signature: BugSignature;
}

export type Clean = (text: string, maxLength?: number) => string;

interface Strings {
  title: (subject: string, step: string, errorType: string) => string;
  summaryRoutine: (routine: string, version: number, step: string, action: string, errorType: string) => string;
  summaryScenario: (scenario: string, step: string, action: string, errorType: string) => string;
  recurrence: (id: string, issue: string | undefined) => string;
  where: string;
  application: string;
  environment: string;
  platform: string;
  targetProfile: string;
  address: string;
  build: string;
  buildSource: Record<string, string>;
  run: string;
  started: string;
  duration: string;
  failure: string;
  step: string;
  actor: string;
  error: string;
  since: string;
  lastPass: string;
  firstFail: string;
  buildChanged: (from: string, to: string) => string;
  buildSame: string;
  buildUnknown: string;
  sinceNote: string;
  shrink: string;
  smallest: string;
  failsAt: string;
  passesAt: string;
  shrinkNote: string;
  testData: string;
  seed: string;
  sample: string;
  synthetic: string;
  reproduce: string;
  reproduceNote: string;
  steps: string;
  stepsCut: (shown: number, total: number) => string;
  consoleErrors: string;
  networkFailures: string;
  evidence: string;
  evidenceEphemeral: string;
  evidencePinned: string;
  screenshot: string;
  none: string;
  footer: (hash: string) => string;
  truncated: string;
}

const EN: Strings = {
  title: (subject, step, errorType) => `${subject} failed at step ${step}: ${errorType}`,
  summaryRoutine: (routine, version, step, action, errorType) => `Routine ${routine} (v${version}) failed at step ${step} (${action}) with ${errorType}.`,
  summaryScenario: (scenario, step, action, errorType) => `The run ${scenario} failed at step ${step} (${action}) with ${errorType}.`,
  recurrence: (id, issue) => `This failure was marked as resolved before (report ${id}${issue ? `, ${issue}` : ''}) and has come back.`,
  where: 'Where',
  application: 'Application',
  environment: 'Environment',
  platform: 'Platform',
  targetProfile: 'Target profile',
  address: 'Page',
  build: 'Build',
  buildSource: { provided: 'given by the caller', probe: 'read from the application', unknown: 'could not be read' },
  run: 'Run',
  started: 'Started',
  duration: 'Duration',
  failure: 'What failed',
  step: 'Step',
  actor: 'Actor',
  error: 'Error',
  since: 'Since when (from the run history)',
  lastPass: 'Last passing run',
  firstFail: 'First failing run after it',
  buildChanged: (from, to) => `The build changed between them: ${from} -> ${to}.`,
  buildSame: 'Both runs report the same build.',
  buildUnknown: 'The build of one of them is not known.',
  sinceNote: 'This is the window in which it broke, from the recorded runs. It is not a diagnosis.',
  shrink: 'Smallest failing input',
  smallest: 'Smallest input that still fails',
  failsAt: 'fails at',
  passesAt: 'passes at',
  shrinkNote: 'Found by shrinking the failing sample (every claim was observed in a real run).',
  testData: 'Test data of this run',
  seed: 'Seed',
  sample: 'Sample',
  synthetic: 'synthetic identity document: dev/QA only',
  reproduce: 'How to repeat it',
  reproduceNote: 'The values above come from the seed and sample, so the same command draws the same input.',
  steps: 'Steps',
  stepsCut: (shown, total) => `${shown} of ${total} steps shown.`,
  consoleErrors: 'Console errors',
  networkFailures: 'Network failures',
  evidence: 'Evidence',
  evidenceEphemeral: 'The evidence of this run is temporary and may already be gone: pin it if you need it.',
  evidencePinned: 'The evidence of this run is pinned.',
  screenshot: 'The screenshot is not attached: an image cannot be checked for personal data. It is in the run evidence.',
  none: 'none',
  footer: (hash) => `Prepared by ScrapForAI. Secrets and personal data were masked before this left the server. Failure signature ${hash}.`,
  truncated: '(the rest of the report was left out to fit the size limit)',
};

const PT: Strings = {
  title: (subject, step, errorType) => `${subject} falhou no passo ${step}: ${errorType}`,
  summaryRoutine: (routine, version, step, action, errorType) => `A rotina ${routine} (v${version}) falhou no passo ${step} (${action}) com ${errorType}.`,
  summaryScenario: (scenario, step, action, errorType) => `A execução ${scenario} falhou no passo ${step} (${action}) com ${errorType}.`,
  recurrence: (id, issue) => `Esta falha já tinha sido marcada como resolvida (relatório ${id}${issue ? `, ${issue}` : ''}) e voltou.`,
  where: 'Onde',
  application: 'Aplicação',
  environment: 'Ambiente',
  platform: 'Plataforma',
  targetProfile: 'Perfil de alvo',
  address: 'Página',
  build: 'Build',
  buildSource: { provided: 'informado por quem chamou', probe: 'lido da aplicação', unknown: 'não foi possível ler' },
  run: 'Execução',
  started: 'Início',
  duration: 'Duração',
  failure: 'O que falhou',
  step: 'Passo',
  actor: 'Ator',
  error: 'Erro',
  since: 'Desde quando (pelo histórico de execuções)',
  lastPass: 'Última execução que passou',
  firstFail: 'Primeira execução que falhou depois dela',
  buildChanged: (from, to) => `O build mudou entre as duas: ${from} -> ${to}.`,
  buildSame: 'As duas execuções informam o mesmo build.',
  buildUnknown: 'O build de uma delas não é conhecido.',
  sinceNote: 'É a janela em que quebrou, pelas execuções registradas. Não é um diagnóstico.',
  shrink: 'Menor entrada que falha',
  smallest: 'Menor entrada que ainda falha',
  failsAt: 'falha com',
  passesAt: 'passa com',
  shrinkNote: 'Encontrada reduzindo a amostra que falhou (cada afirmação foi observada numa execução real).',
  testData: 'Dados de teste desta execução',
  seed: 'Semente',
  sample: 'Amostra',
  synthetic: 'documento de identidade sintético: só para dev/QA',
  reproduce: 'Como repetir',
  reproduceNote: 'Os valores acima vêm da semente e da amostra, então o mesmo comando sorteia a mesma entrada.',
  steps: 'Passos',
  stepsCut: (shown, total) => `${shown} de ${total} passos mostrados.`,
  consoleErrors: 'Erros do console',
  networkFailures: 'Falhas de rede',
  evidence: 'Evidência',
  evidenceEphemeral: 'A evidência desta execução é temporária e pode já ter sumido: fixe-a (pin) se precisar dela.',
  evidencePinned: 'A evidência desta execução está fixada (pinned).',
  screenshot: 'A captura de tela não vai anexada: uma imagem não pode ser verificada quanto a dados pessoais. Ela está na evidência da execução.',
  none: 'nenhum',
  footer: (hash) => `Preparado pelo ScrapForAI. Segredos e dados pessoais foram mascarados antes de sair do servidor. Assinatura da falha ${hash}.`,
  truncated: '(o restante do relatório foi omitido para caber no limite de tamanho)',
};

const ES: Strings = {
  title: (subject, step, errorType) => `${subject} falló en el paso ${step}: ${errorType}`,
  summaryRoutine: (routine, version, step, action, errorType) => `La rutina ${routine} (v${version}) falló en el paso ${step} (${action}) con ${errorType}.`,
  summaryScenario: (scenario, step, action, errorType) => `La ejecución ${scenario} falló en el paso ${step} (${action}) con ${errorType}.`,
  recurrence: (id, issue) => `Esta falla ya se había marcado como resuelta (informe ${id}${issue ? `, ${issue}` : ''}) y volvió.`,
  where: 'Dónde',
  application: 'Aplicación',
  environment: 'Ambiente',
  platform: 'Plataforma',
  targetProfile: 'Perfil de destino',
  address: 'Página',
  build: 'Build',
  buildSource: { provided: 'informado por quien llamó', probe: 'leído de la aplicación', unknown: 'no se pudo leer' },
  run: 'Ejecución',
  started: 'Inicio',
  duration: 'Duración',
  failure: 'Qué falló',
  step: 'Paso',
  actor: 'Actor',
  error: 'Error',
  since: 'Desde cuándo (según el historial de ejecuciones)',
  lastPass: 'Última ejecución que pasó',
  firstFail: 'Primera ejecución que falló después',
  buildChanged: (from, to) => `El build cambió entre ambas: ${from} -> ${to}.`,
  buildSame: 'Ambas ejecuciones informan el mismo build.',
  buildUnknown: 'No se conoce el build de una de ellas.',
  sinceNote: 'Es la ventana en que se rompió, según las ejecuciones registradas. No es un diagnóstico.',
  shrink: 'Menor entrada que falla',
  smallest: 'Menor entrada que todavía falla',
  failsAt: 'falla con',
  passesAt: 'pasa con',
  shrinkNote: 'Encontrada reduciendo la muestra que falló (cada afirmación se observó en una ejecución real).',
  testData: 'Datos de prueba de esta ejecución',
  seed: 'Semilla',
  sample: 'Muestra',
  synthetic: 'documento de identidad sintético: solo para dev/QA',
  reproduce: 'Cómo repetirlo',
  reproduceNote: 'Los valores de arriba salen de la semilla y la muestra, así que el mismo comando sortea la misma entrada.',
  steps: 'Pasos',
  stepsCut: (shown, total) => `${shown} de ${total} pasos mostrados.`,
  consoleErrors: 'Errores de la consola',
  networkFailures: 'Fallas de red',
  evidence: 'Evidencia',
  evidenceEphemeral: 'La evidencia de esta ejecución es temporal y puede que ya no exista: fíjela (pin) si la necesita.',
  evidencePinned: 'La evidencia de esta ejecución está fijada (pinned).',
  screenshot: 'La captura de pantalla no se adjunta: una imagen no puede revisarse en busca de datos personales. Está en la evidencia de la ejecución.',
  none: 'ninguno',
  footer: (hash) => `Preparado por ScrapForAI. Secretos y datos personales se enmascararon antes de salir del servidor. Firma de la falla ${hash}.`,
  truncated: '(el resto del informe se omitió para caber en el límite de tamaño)',
};

export const BUG_STRINGS: Record<ReportLang, Strings> = { en: EN, pt: PT, es: ES };

export const MAX_STEPS_LISTED = 40;
export const MAX_EVIDENCE_LINES = 10;
export const MAX_BODY_CHARS = 60_000;
const MAX_TITLE_CHARS = 140;
const MARKER = (hash: string): string => `<!-- scrapforai:bug-signature=${hash} -->`;

const STATUS_MARK: Record<string, string> = { passed: '✓', failed: '✗', skipped: '–' };

export interface RenderedIssue {
  title: string;
  body: string;
}

export function renderIssue(facts: BugFacts, lang: ReportLang, clean: Clean): RenderedIssue {
  const s = BUG_STRINGS[lang];
  // The length limit is enforced here too, not only by `clean`: one field must never be able to push the report past what an issue holds.
  const c = (text: string, max = 300): string => {
    const cleaned = clean(text, max);
    return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
  };
  const code = (text: string, max = 300): string => inlineCode(c(text, max));
  const { failure } = facts;

  const subject = facts.routine?.id ?? facts.scenarioName;
  const title = `[ScrapForAI] ${titleSafe(c(s.title(subject, failure.stepId, failure.errorType), 400), MAX_TITLE_CHARS - 13)}`;

  const lines: string[] = [];
  const add = (...more: string[]): void => void lines.push(...more);
  const section = (heading: string): void => add('', `## ${heading}`, '');

  // Summary. The sentence is made of code spans so a name from a page cannot become markup.
  add(
    facts.routine
      ? s.summaryRoutine(code(facts.routine.id), facts.routine.version, code(failure.stepId), code(failure.action), code(failure.errorType))
      : s.summaryScenario(code(facts.scenarioName), code(failure.stepId), code(failure.action), code(failure.errorType)),
  );
  if (facts.recurrenceOf) add('', `> ${s.recurrence(facts.recurrenceOf.id, facts.recurrenceOf.issueUrl)}`);

  section(s.where);
  if (facts.application) add(`- ${s.application}: ${code(facts.application, 120)}`);
  if (facts.environment) add(`- ${s.environment}: ${code(facts.environment, 60)}`);
  if (facts.platform) add(`- ${s.platform}: ${code(facts.platform, 60)}`);
  if (facts.targetProfile) add(`- ${s.targetProfile}: ${code(facts.targetProfile, 80)}`);
  add(`- ${s.address}: ${code(facts.address, 300)}`);
  const buildNote = facts.buildIdSource ? ` (${s.buildSource[facts.buildIdSource] ?? facts.buildIdSource})` : '';
  add(`- ${s.build}: ${facts.buildId ? `${code(facts.buildId, 100)}${buildNote}` : code('unknown')}`);
  add(`- ${s.run}: \`${facts.jobId}\``);
  add(`- ${s.started}: ${facts.startedAt}`);
  add(`- ${s.duration}: ${(facts.durationMs / 1000).toFixed(1)} s`);

  section(s.failure);
  add(`- ${s.step}: ${code(failure.stepId)} (${code(failure.action)}${failure.label ? `, ${code(failure.label, 120)}` : ''})`);
  if (failure.actor) add(`- ${s.actor}: ${code(failure.actor, 80)}`);
  add(`- ${s.error}: ${code(failure.errorType)}`, '', fenced(c(failure.errorMessage, 1200)));

  if (facts.since && (facts.since.lastGreen || facts.since.firstRed)) {
    const { lastGreen, firstRed, buildChanged } = facts.since;
    section(s.since);
    const point = (p: HistoryPoint): string => `\`${p.jobId}\`, ${p.at}${p.buildId ? `, ${s.build.toLowerCase()} ${code(p.buildId, 100)}` : ''}${p.version === undefined ? '' : `, v${p.version}`}`;
    if (lastGreen) add(`- ${s.lastPass}: ${point(lastGreen)}`);
    if (firstRed) add(`- ${s.firstFail}: ${point(firstRed)}`);
    if (lastGreen && firstRed) {
      if (buildChanged === true && lastGreen.buildId && firstRed.buildId) add(`- ${s.buildChanged(code(lastGreen.buildId, 100), code(firstRed.buildId, 100))}`);
      else if (buildChanged === false) add(`- ${s.buildSame}`);
      else add(`- ${s.buildUnknown}`);
    }
    add('', `_${s.sinceNote}_`);
  }

  if (facts.shrink && (Object.keys(facts.shrink.minimal).length > 0 || facts.shrink.summary)) {
    section(s.shrink);
    if (facts.shrink.summary) add(fenced(c(facts.shrink.summary, 400)), '');
    if (Object.keys(facts.shrink.minimal).length > 0) add(`${s.smallest}:`, '');
    for (const [name, value] of Object.entries(facts.shrink.minimal)) add(`- ${code(name, 80)} = ${code(value, 200)}`);
    for (const b of facts.shrink.boundaries) {
      add(`- ${code(b.parameter, 80)}: ${s.failsAt} ${code(b.fails, 200)}, ${s.passesAt} ${code(b.passes, 200)}`);
    }
    add('', `_${s.shrinkNote}_`);
  }

  if (facts.parameters && facts.parameters.rows.length > 0) {
    section(s.testData);
    add(`- ${s.seed}: ${code(facts.parameters.seed, 100)}`, `- ${s.sample}: ${facts.parameters.sample}`);
    for (const row of facts.parameters.rows) {
      add(`- ${code(row.name, 80)} = ${code(row.value, 200)} (${c(row.source, 40)}${row.synthetic ? `; ${s.synthetic}` : ''})`);
    }
  }

  if (facts.replay) {
    section(s.reproduce);
    add(fenced(c(facts.replay, 600), 'sh'));
    if (facts.parameters) add('', `_${s.reproduceNote}_`);
  }

  section(s.steps);
  const shown = facts.steps.slice(0, MAX_STEPS_LISTED);
  for (const step of shown) {
    const name = step.id ?? `#${step.index}`;
    add(`- ${STATUS_MARK[step.status] ?? '?'} ${step.index}. ${code(name, 80)} ${code(step.action, 40)}${step.label ? ` ${code(step.label, 100)}` : ''}${step.actor ? ` (${code(step.actor, 60)})` : ''}`);
  }
  if (facts.steps.length > shown.length) add('', `_${s.stepsCut(shown.length, facts.steps.length)}_`);

  const evidenceList = (heading: string, items: string[]): void => {
    section(heading);
    if (items.length === 0) {
      add(s.none);
      return;
    }
    add(fenced(items.slice(0, MAX_EVIDENCE_LINES).map((item) => c(item, 300).replace(/\s+/g, ' ')).join('\n')));
  };
  evidenceList(s.consoleErrors, facts.consoleErrors);
  evidenceList(s.networkFailures, facts.networkFailures);

  section(s.evidence);
  add(facts.evidence.location === 'pinned' ? s.evidencePinned : s.evidenceEphemeral, '', s.screenshot);

  const marker = MARKER(facts.signature.hash);
  const footer = ['', '---', `_${s.footer(facts.signature.hash)}_`, '', marker];
  let body = lines.join('\n');
  if (body.length + footer.join('\n').length > MAX_BODY_CHARS) {
    const room = MAX_BODY_CHARS - footer.join('\n').length - s.truncated.length - 4;
    body = `${body.slice(0, Math.max(0, room)).replace(/\n[^\n]*$/, '')}\n\n${s.truncated}`;
  }
  return { title, body: `${body}\n${footer.join('\n')}\n` };
}
