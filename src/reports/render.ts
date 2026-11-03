import { type ReportLang, STRINGS, type Strings } from './i18n.js';

/**
 * T2.7 report rendering. Pure and self-contained: no configuration, no file access, no network. Screenshots
 * arrive as data URIs, so the HTML is a single file that prints identically anywhere and can be turned into
 * a PDF by any browser. EVERYTHING that comes from a run is escaped; the page has a CSP that forbids scripts
 * and any network load.
 */

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

export interface ReportStep {
  index: number;
  id?: string;
  label?: string;
  description?: string;
  action: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  error?: { type: string; message: string };
}

export interface IntegrityInfo {
  /** 'pinned': signed and kept. 'unsigned': still in the artifact root. 'none': no evidence anymore. */
  state: 'pinned' | 'unsigned' | 'none';
  signature?: 'valid' | 'invalid' | 'unsigned';
  keyId?: string;
  manifestSha256?: string;
  chainSequence?: number;
  pinnedAt?: string;
  pinReason?: string;
}

export interface RunReportData {
  jobId: string;
  status: 'passed' | 'failed';
  scenarioName?: string;
  targetUrl: string;
  environment?: string;
  application?: string;
  buildId?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  executor: string;
  routine?: { id: string; version: number };
  error?: { type: string; message: string };
  failedStepIndex?: number;
  steps: ReportStep[];
  teardown?: ReportStep[];
  teardownStatus?: 'passed' | 'failed';
  screenshots: Array<{ name: string; dataUri: string }>;
  consoleCount: number;
  consoleErrors: string[];
  networkCount: number;
  networkFailures: string[];
  integrity: IntegrityInfo;
  generatedAt: string;
}

export interface SuiteReportData {
  suiteRunId: string;
  name: string;
  status: string;
  verdict?: 'green' | 'red' | 'infra-error';
  verdictReason?: string;
  exitCode?: number;
  createdAt: string;
  finishedAt?: string;
  counts: { passed: number; failed: number; error: number; notRun: number };
  total: number;
  teardownFailures?: number;
  buildId?: string;
  executor: string;
  variants: Array<{
    variantKey: string;
    routineId: string;
    routineVersion: number;
    status: string;
    jobId?: string;
    durationMs?: number;
    errorType?: string;
    errorMessage?: string;
    notRunReason?: string;
  }>;
  keyId?: string;
  generatedAt: string;
}

const CSS = `
@page { size: A4; margin: 16mm 14mm; }
* { box-sizing: border-box; }
body { font: 12px/1.45 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1a1a1a; margin: 0; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 22px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #ccc; break-after: avoid; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid #e3e3e3; vertical-align: top; }
th { background: #f4f4f4; font-weight: 600; }
.meta th { width: 28%; background: none; color: #555; font-weight: 500; }
.badge { display: inline-block; padding: 3px 12px; border-radius: 4px; color: #fff; font-weight: 700; letter-spacing: .04em; }
.passed, .green { background: #1b7f3b; } .failed, .red { background: #b3261e; } .error, .infra-error { background: #8a5a00; } .notRun, .skipped { background: #666; }
.cell-passed { color: #1b7f3b; font-weight: 600; } .cell-failed { color: #b3261e; font-weight: 600; } .cell-error { color: #8a5a00; font-weight: 600; }
.mono { font-family: Consolas, "SFMono-Regular", monospace; font-size: 11px; word-break: break-all; }
.err { background: #fdecea; border-left: 3px solid #b3261e; padding: 6px 10px; margin: 8px 0; }
.warn { background: #fff4e0; border-left: 3px solid #8a5a00; padding: 6px 10px; margin: 8px 0; }
.ok { background: #e8f5ec; border-left: 3px solid #1b7f3b; padding: 6px 10px; margin: 8px 0; }
figure { margin: 8px 0; break-inside: avoid; } figure img { max-width: 100%; border: 1px solid #ccc; } figcaption { color: #555; font-size: 11px; }
.footer { margin-top: 24px; border-top: 2px solid #1a1a1a; padding-top: 8px; break-inside: avoid; }
small, .muted { color: #666; }
tr { break-inside: avoid; }
`;

function page(s: Strings, title: string, body: string): string {
  return `<!doctype html>
<html lang="${s.htmlLang}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${esc(title)}</title><style>${CSS}</style></head><body>
${body}
</body></html>`;
}

const statusLabel = (s: Strings, status: string): string =>
  ({ passed: s.passed, failed: s.failed, error: s.error, notRun: s.notRun, skipped: s.notRun, green: s.green, red: s.red, 'infra-error': s.infraError })[status] ?? status;

const seconds = (ms: number | undefined): string => (ms === undefined ? '' : `${(ms / 1000).toFixed(1)} s`);

function metaRow(label: string, value: string | undefined, fallback: string): string {
  return `<tr><th>${esc(label)}</th><td>${value === undefined || value === '' ? `<span class="muted">${esc(fallback)}</span>` : value}</td></tr>`;
}

function stepRows(s: Strings, steps: ReportStep[]): string {
  return steps
    .map((step) => {
      const name = step.label ?? step.description ?? step.id ?? '';
      const detail = step.error ? `<span class="cell-failed">${esc(step.error.type)}</span>: ${esc(clip(step.error.message, 400))}` : '';
      return `<tr><td>${step.index + 1}</td><td><b>${esc(step.action)}</b>${name ? `<br><small>${esc(clip(name, 120))}</small>` : ''}</td><td class="cell-${step.status === 'skipped' ? 'error' : step.status}">${esc(statusLabel(s, step.status))}</td><td>${step.durationMs} ms</td><td>${detail}</td></tr>`;
    })
    .join('');
}

function integrityBlock(s: Strings, info: IntegrityInfo): string {
  if (info.state === 'none') {
    return `<div class="warn">${esc(s.notPinned)}</div>`;
  }

  const rows: string[] = [];
  if (info.keyId) rows.push(metaRow(s.keyId, `<span class="mono">${esc(info.keyId)}</span>`, s.unknown));
  if (info.manifestSha256) rows.push(metaRow(s.manifestHash, `<span class="mono">${esc(info.manifestSha256)}</span>`, s.unknown));
  if (info.chainSequence !== undefined) rows.push(metaRow(s.chainPosition, `#${esc(info.chainSequence)}`, s.unknown));

  const verdict =
    info.signature === 'valid'
      ? `<div class="ok">${esc(s.signatureValid)}</div>`
      : info.signature === 'invalid'
        ? `<div class="err"><b>${esc(s.signatureInvalid)}</b></div>`
        : `<div class="warn">${esc(s.notSigned)}</div>`;

  return `${verdict}${rows.length ? `<table class="meta">${rows.join('')}</table>` : ''}
<p class="muted">${esc(s.proves)} ${esc(s.doesNotProve)}<br>${esc(s.verifyHint)}</p>`;
}

export function renderRunReport(data: RunReportData, lang: ReportLang): string {
  const s = STRINGS[lang];
  const failedStep = data.failedStepIndex === undefined ? undefined : data.steps[data.failedStepIndex];
  const failureShot = data.screenshots.find((shot) => shot.name === 'failure');

  const body = `
<h1>${esc(s.title)}</h1>
<p><span class="badge ${data.status}">${esc(statusLabel(s, data.status))}</span> &nbsp; <span class="muted">${esc(data.scenarioName ?? data.jobId)}</span></p>

<h2>${esc(s.summary)}</h2>
<table class="meta">
${metaRow(s.application, data.application ? esc(data.application) : esc(data.targetUrl), s.unknown)}
${metaRow(s.environment, data.environment ? esc(data.environment) : undefined, s.unknown)}
${metaRow(s.build, data.buildId ? esc(data.buildId) : undefined, s.unknown)}
${metaRow(s.date, esc(data.startedAt), s.unknown)}
${metaRow(s.executor, esc(data.executor), s.unknown)}
${metaRow(s.routine, data.routine ? esc(`${data.routine.id} v${data.routine.version}`) : undefined, s.unknown)}
${metaRow(s.run, `<span class="mono">${esc(data.jobId)}</span>`, s.unknown)}
${metaRow(s.duration, esc(seconds(data.durationMs)), s.unknown)}
</table>
${
  data.status === 'failed' && data.error
    ? `<div class="err"><b>${esc(data.error.type)}</b>${failedStep ? ` (${esc(s.step)} ${failedStep.index + 1}, ${esc(failedStep.action)})` : ''}: ${esc(clip(data.error.message, 600))}</div>`
    : ''
}
${data.teardownStatus === 'failed' ? `<div class="warn">${esc(s.teardownFailed)}</div>` : ''}

<h2>${esc(s.steps)}</h2>
<table><tr><th>${esc(s.step)}</th><th>${esc(s.action)}</th><th>${esc(s.status)}</th><th>${esc(s.time)}</th><th>${esc(s.detail)}</th></tr>${stepRows(s, data.steps)}</table>
${data.teardown?.length ? `<h2>${esc(s.teardown)}</h2><table><tr><th>${esc(s.step)}</th><th>${esc(s.action)}</th><th>${esc(s.status)}</th><th>${esc(s.time)}</th><th>${esc(s.detail)}</th></tr>${stepRows(s, data.teardown)}</table>` : ''}

${failureShot ? `<h2>${esc(s.failureEvidence)}</h2><figure><img src="${esc(failureShot.dataUri)}" alt="failure"><figcaption>failure</figcaption></figure>` : ''}
${
  data.screenshots.filter((shot) => shot !== failureShot).length
    ? `<h2>${esc(s.screenshots)}</h2>${data.screenshots
        .filter((shot) => shot !== failureShot)
        .map((shot) => `<figure><img src="${esc(shot.dataUri)}" alt="${esc(shot.name)}"><figcaption>${esc(shot.name)}</figcaption></figure>`)
        .join('')}`
    : ''
}

<h2>${esc(s.console)} / ${esc(s.network)}</h2>
<table class="meta">
<tr><th>${esc(s.console)}</th><td>${data.consoleCount}</td></tr>
<tr><th>${esc(s.consoleErrors)}</th><td>${data.consoleErrors.length ? data.consoleErrors.slice(0, 10).map((line) => `<div class="mono">${esc(clip(line, 300))}</div>`).join('') : esc(s.none)}</td></tr>
<tr><th>${esc(s.network)}</th><td>${data.networkCount}</td></tr>
<tr><th>${esc(s.networkFailures)}</th><td>${data.networkFailures.length ? data.networkFailures.slice(0, 10).map((line) => `<div class="mono">${esc(clip(line, 300))}</div>`).join('') : esc(s.none)}</td></tr>
</table>

<div class="footer">
<h2 style="margin-top:0">${esc(s.integrity)}</h2>
${integrityBlock(s, data.integrity)}
<p class="muted">${esc(s.generated)}: ${esc(data.generatedAt)}</p>
</div>`;

  return page(s, `${s.title} ${data.jobId}`, body);
}

export function renderSuiteReport(data: SuiteReportData, lang: ReportLang): string {
  const s = STRINGS[lang];
  const verdict = data.verdict ?? 'infra-error';

  const rows = data.variants
    .map((variant) => {
      const detail = variant.errorType ? `${esc(variant.errorType)}: ${esc(clip(variant.errorMessage ?? '', 300))}` : variant.notRunReason ? `<span class="muted">${esc(clip(variant.notRunReason, 200))}</span>` : '';
      return `<tr><td class="mono">${esc(variant.variantKey)}<br><small>${esc(variant.routineId)} v${variant.routineVersion}</small></td><td class="cell-${variant.status === 'passed' ? 'passed' : variant.status === 'failed' ? 'failed' : 'error'}">${esc(statusLabel(s, variant.status))}</td><td>${esc(seconds(variant.durationMs))}</td><td class="mono">${esc(variant.jobId ?? '')}</td><td>${detail}</td></tr>`;
    })
    .join('');

  const body = `
<h1>${esc(s.suiteTitle)}</h1>
<p><span class="badge ${verdict}">${esc(statusLabel(s, verdict))}</span> &nbsp; <span class="muted">${esc(data.name)}</span></p>

<h2>${esc(s.summary)}</h2>
<table class="meta">
${metaRow('Suite', `<span class="mono">${esc(data.suiteRunId)}</span>`, s.unknown)}
${metaRow(s.build, data.buildId ? esc(data.buildId) : undefined, s.unknown)}
${metaRow(s.date, esc(data.createdAt), s.unknown)}
${metaRow(s.executor, esc(data.executor), s.unknown)}
${metaRow(s.verdict, esc(`${statusLabel(s, verdict)}${data.exitCode === undefined ? '' : ` (exit ${data.exitCode})`}${data.verdictReason ? ` - ${data.verdictReason}` : ''}`), s.unknown)}
${metaRow(s.totalRuns, esc(`${data.total}: ${data.counts.passed} ${s.passed}, ${data.counts.failed} ${s.failed}, ${data.counts.error} ${s.error}, ${data.counts.notRun} ${s.notRun}`), s.unknown)}
</table>
${data.teardownFailures ? `<div class="warn">${esc(s.teardownFailed)} (${data.teardownFailures})</div>` : ''}

<h2>${esc(s.variants)}</h2>
<table><tr><th>${esc(s.variant)}</th><th>${esc(s.status)}</th><th>${esc(s.duration)}</th><th>${esc(s.run)}</th><th>${esc(s.detail)}</th></tr>${rows}</table>

<div class="footer">
<h2 style="margin-top:0">${esc(s.integrity)}</h2>
${data.keyId ? metaRow(s.keyId, `<span class="mono">${esc(data.keyId)}</span>`, s.unknown).replace('<tr>', '<table class="meta"><tr>').replace('</tr>', '</tr></table>') : ''}
<p class="muted">${esc(s.proves)} ${esc(s.doesNotProve)}<br>${esc(s.verifyHint)}</p>
<p class="muted">${esc(s.generated)}: ${esc(data.generatedAt)}</p>
</div>`;

  return page(s, `${s.suiteTitle} ${data.suiteRunId}`, body);
}
