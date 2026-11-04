import { guidanceFor } from '../a11y/platformGuidance.js';
import type { AccessibilityFinding, AccessibilityResult } from '../schemas/accessibility.schema.js';
import { IMPACTS } from '../schemas/accessibility.schema.js';
import type { PiiReport } from '../schemas/pii.schema.js';
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
  /** T6.4: the actor that ran the step, when the step named one. */
  actor?: string;
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
  /** T5.3: what the run's parameters took (only when it used any). */
  parameters?: { seed: string; sample: number; rows: Array<{ name: string; value: string; source: string; synthetic: boolean }> };
  /** T7.2/T7.3: what the run changed on purpose: the browser's clock, and requests answered wrongly. Only when it did either. */
  simulated?: {
    clock: Array<{ mode: 'fixed' | 'install'; time: string; fastForwardMs?: number }>;
    faults: Array<{ method: string; pathname: string; detail: string; count: number }>;
  };
  /** T7.4/T7.5: the accessibility audits the run made (one per `auditAccessibility` step), with what changed since their baseline when they had one. */
  accessibility?: Array<{ name: string; result: AccessibilityResult }>;
  /** T7.8: the privacy scans of the run (`options.piiScan` and every `scanForPii` step). A finding never carries the value. */
  privacy?: Array<{ name: string; report: PiiReport }>;
  screenshots: Array<{ name: string; dataUri: string; actor?: string }>;
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
    /** T3.5 */
    quarantined?: boolean;
    passedOnRetry?: boolean;
    attempts?: Array<{ attempt: number; jobId: string; status: string; errorType?: string; errorMessage?: string }>;
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
.imp { display: inline-block; padding: 1px 8px; border-radius: 3px; color: #fff; font-size: 11px; font-weight: 700; }
.imp-critical { background: #7a0f0a; } .imp-serious { background: #b3261e; } .imp-moderate { background: #8a5a00; } .imp-minor { background: #666; }
.sev-high { background: #b3261e; } .sev-medium { background: #8a5a00; } .sev-low { background: #5b6b7a; } .sev-info { background: #888; }
.adjust { color: #333; } .adjust small { display: block; color: #666; margin-bottom: 2px; }
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
      return `<tr><td>${step.index + 1}</td><td>${step.actor ? `<span class="muted">${esc(step.actor)}</span> ` : ''}<b>${esc(step.action)}</b>${name ? `<br><small>${esc(clip(name, 120))}</small>` : ''}</td><td class="cell-${step.status === 'skipped' ? 'error' : step.status}">${esc(statusLabel(s, step.status))}</td><td>${step.durationMs} ms</td><td>${detail}</td></tr>`;
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

/**
 * A generated value as text a person can read safely: control characters and the Unicode bidirectional controls (a right-to-left
 * override would reorder the text around it) are shown as \uXXXX instead of being obeyed. HTML escaping is done by esc() on top.
 */
export function printable(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function parametersBlock(s: Strings, parameters: NonNullable<RunReportData['parameters']>): string {
  const rows = parameters.rows
    .map(
      (row) =>
        `<tr><td class="mono">${esc(row.name)}</td><td class="mono">${esc(clip(printable(row.value), 200)) || `<span class="muted">(${esc(s.none)})</span>`}${row.synthetic ? ` <span class="badge failed" style="background:#7a5a00">${esc(s.syntheticTag)}</span>` : ''}</td><td>${esc(row.source)}</td></tr>`,
    )
    .join('');
  const synthetic = parameters.rows.some((row) => row.synthetic);
  return `<h2>${esc(s.testData)}</h2>
<table class="meta"><tr><th>${esc(s.seed)}</th><td class="mono">${esc(parameters.seed)}</td></tr><tr><th>${esc(s.sample)}</th><td>${esc(parameters.sample)}</td></tr></table>
<table><tr><th>${esc(s.parameter)}</th><th>${esc(s.value)}</th><th>${esc(s.origin)}</th></tr>${rows}</table>
<p class="muted">${esc(s.replayHint)}</p>
${synthetic ? `<div class="warn">${esc(s.syntheticNote)}</div>` : ''}`;
}

/** 90061000 -> "1 d 1 h 1 min 1 s". Units are the same in en/pt/es. */
export function humanSpan(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const parts: string[] = [];
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  if (days) parts.push(`${days} d`);
  if (hours) parts.push(`${hours} h`);
  if (minutes) parts.push(`${minutes} min`);
  if (secs) parts.push(`${secs} s`);
  return parts.join(' ');
}

/** T7.2/T7.3: a run under a simulated clock or with broken answers says so, in words, before the steps. Everything is escaped. */
function simulatedBlock(s: Strings, simulated: NonNullable<RunReportData['simulated']>): string {
  const clock = simulated.clock
    .map((entry) => {
      const forward = entry.fastForwardMs === undefined ? '' : `, ${esc(s.clockForward)} ${esc(humanSpan(entry.fastForwardMs))}`;
      return `<li>${esc(entry.mode === 'fixed' ? s.clockFixed : s.clockInstall)} <span class="mono">${esc(entry.time)}</span>${forward}</li>`;
    })
    .join('');
  const faults = simulated.faults
    .map((fault) => `<tr><td class="mono">${esc(fault.method)} ${esc(clip(fault.pathname, 200))}</td><td>${esc(fault.detail)}</td><td>${esc(fault.count)}</td></tr>`)
    .join('');
  return `<h2>${esc(s.simulatedTitle)}</h2>
${clock ? `<ul>${clock}</ul><div class="warn">${esc(s.clockNote)}</div>` : ''}
${faults ? `<table><tr><th>${esc(s.faultRequest)}</th><th>${esc(s.faultDone)}</th><th>${esc(s.faultCount)}</th></tr>${faults}</table><p class="muted">${esc(s.faultsNote)}</p>` : ''}`;
}

const MAX_A11Y_ROWS = 40;
const MAX_A11Y_ROWS_NO_BASELINE = 20;

/** Rows of findings. `withGuidance`: the platform note (T7.7) for the rule, in the report's language. */
function findingRows(s: Strings, lang: ReportLang, findings: AccessibilityFinding[], withGuidance: boolean): string {
  return findings
    .map((finding) => {
      const note = withGuidance ? guidanceFor(finding.ruleId, lang) : undefined;
      return `<tr><td><span class="imp imp-${esc(finding.impact)}">${esc(finding.impact)}</span></td><td><b class="mono">${esc(finding.ruleId)}</b><br><small>${esc(clip(finding.help, 160))}${finding.wcag.length ? ` (WCAG ${esc(finding.wcag.join(', '))})` : ''}</small></td><td class="mono">${esc(clip(printable(finding.targetKey), 200))}</td>${withGuidance ? `<td class="adjust">${note ? `<small>${esc(note.title)}</small>${esc(note.platform)}` : '<span class="muted">-</span>'}</td>` : ''}</tr>`;
    })
    .join('');
}

function findingTable(s: Strings, lang: ReportLang, findings: AccessibilityFinding[], limit: number, withGuidance: boolean): string {
  const shown = findings.slice(0, limit);
  return `<table><tr><th>${esc(s.a11yImpact)}</th><th>${esc(s.a11yRule)}</th><th>${esc(s.a11yElement)}</th>${withGuidance ? `<th>${esc(s.a11yAdjust)}</th>` : ''}</tr>${findingRows(s, lang, shown, withGuidance)}</table>${
    findings.length > shown.length ? `<p class="muted">… ${findings.length - shown.length}</p>` : ''
  }`;
}

/**
 * T7.4/T7.5/T7.7. With a baseline the report shows what is NEW and what was FIXED, not the whole list: on a legacy application the whole list has hundreds of
 * rows and nobody acts on it. Without one it says so and shows only the most serious findings. Every finding that has a platform note carries it.
 */
function accessibilityBlock(s: Strings, lang: ReportLang, items: NonNullable<RunReportData['accessibility']>): string {
  return items
    .map(({ result }) => {
      const c = result.counts;
      const baseline = result.baseline;
      const meta = `<table class="meta">
<tr><th>${esc(s.a11yStandard)}</th><td>${esc(result.standard)} · axe-core ${esc(result.axeVersion)}</td></tr>
<tr><th>${esc(s.a11yTitle)}</th><td>${esc(c.elements)} ${esc(s.a11yCounts)} / ${esc(c.rules)} · ${IMPACTS.slice()
        .reverse()
        .map((impact) => `${esc(impact)} ${c[impact]}`)
        .join(' · ')}</td></tr>
${baseline ? `<tr><th>${esc(s.a11yBaseline)}</th><td>${esc(baseline.screen)} · ${esc(s.build)} ${esc(baseline.buildId)} (${esc(baseline.createdAt.slice(0, 10))})</td></tr>` : ''}
</table>`;

      const parts: string[] = [meta];
      let guided = false;

      if (baseline) {
        if (baseline.axeVersionChanged) parts.push(`<div class="warn">${esc(s.a11yAxeChanged)} (${esc(baseline.axeVersionChanged.before)} → ${esc(baseline.axeVersionChanged.after)})</div>`);
        if (baseline.new.length === 0 && baseline.fixed.length === 0) {
          parts.push(`<div class="ok">${esc(s.a11yNothingNew)} (${esc(s.a11yUnchanged)}: ${baseline.unchanged})</div>`);
        }
        if (baseline.new.length > 0) {
          guided = true;
          parts.push(`<h3>${esc(s.a11yNew)} (${baseline.new.length})</h3>${findingTable(s, lang, baseline.new, MAX_A11Y_ROWS, true)}`);
        }
        if (baseline.fixed.length > 0) {
          parts.push(`<h3>${esc(s.a11yFixed)} (${baseline.fixed.length})</h3>${findingTable(s, lang, baseline.fixed, MAX_A11Y_ROWS, false)}`);
        }
        if (baseline.new.length + baseline.fixed.length > 0) parts.push(`<p class="muted">${esc(s.a11yUnchanged)}: ${baseline.unchanged}</p>`);
        if (baseline.incomplete) parts.push(`<div class="warn">${esc(s.a11yCut)}</div>`);
      } else if (result.findings.length === 0) {
        parts.push(`<div class="ok">${esc(s.a11yNone)}</div>`);
      } else {
        guided = true;
        const severe = [...result.findings].sort((a, b) => IMPACTS.indexOf(b.impact) - IMPACTS.indexOf(a.impact));
        parts.push(`<div class="warn">${esc(s.a11yNoBaseline)}</div><h3>${esc(s.a11yTopOnly)}</h3>${findingTable(s, lang, severe, MAX_A11Y_ROWS_NO_BASELINE, true)}`);
        if (result.truncated) parts.push(`<div class="warn">${esc(s.a11yCut)}</div>`);
      }

      const review = result.needsReview.length;
      if (review > 0) parts.push(`<p class="muted">${review} ${esc(s.a11yNeedsReview)}: ${esc(result.needsReview.slice(0, 8).map((rule) => rule.ruleId).join(', '))}</p>`);
      if (guided) parts.push(`<p class="muted">${esc(s.a11yGuidanceNote)}</p>`);
      return parts.join('\n');
    })
    .join('\n');
}

const MAX_PII_ROWS = 60;

/**
 * T7.8. What a scan found, most severe first, with the masked sample and the place; and what it LOOKED at, so an empty list is never read as "checked
 * everywhere". Everything is escaped; a location comes from a page and may hold anything, so it is clipped and printable-ised.
 */
function privacyBlock(s: Strings, items: NonNullable<RunReportData['privacy']>): string {
  return items
    .map(({ name, report }) => {
      const c = report.counts;
      const rows = report.findings
        .slice(0, MAX_PII_ROWS)
        .map(
          (f) =>
            `<tr><td><span class="imp sev-${esc(f.severity)}">${esc(f.severity)}</span></td><td><b class="mono">${esc(f.detector)}</b><br><small>${esc(f.surface)}</small></td><td class="mono">${esc(clip(printable(f.location), 220))}</td><td class="mono">${esc(clip(printable(f.maskedSample), 60))}</td><td>${esc(f.count)}</td></tr>`,
        )
        .join('');
      const looked = report.scanned;
      const lookedText = `URLs ${looked.urls} · console ${looked.console} · bodies ${looked.responseBodies}${looked.responseBodiesSkipped ? ` (+${looked.responseBodiesSkipped} skipped)` : ''} · storage ${looked.storageEntries} · cookies ${looked.jarEntries} · hidden inputs ${looked.hiddenInputs}`;
      const suppressed = (report.suppressed ?? [])
        .map((x) => `<tr><td class="mono">${esc(x.detector)} / ${esc(x.surface)}</td><td class="mono">${esc(clip(printable(x.location), 160))}</td><td>${esc(x.reason)}</td><td>${esc(x.until)}</td></tr>`)
        .join('');
      return [
        `<p class="muted">${esc(name)} · ${esc(c.total)} · ${(['high', 'medium', 'low', 'info'] as const).map((level) => `${esc(level)} ${c.bySeverity[level]}`).join(' · ')}</p>`,
        c.total === 0 ? `<div class="ok">${esc(s.piiNone)}</div>` : `<table><tr><th>${esc(s.piiSeverity)}</th><th>${esc(s.piiDetector)} / ${esc(s.piiSurface)}</th><th>${esc(s.piiLocation)}</th><th>${esc(s.piiSample)}</th><th>${esc(s.piiTimes)}</th></tr>${rows}</table>`,
        report.findings.length > MAX_PII_ROWS ? `<p class="muted">… ${report.findings.length - MAX_PII_ROWS}</p>` : '',
        report.truncated ? `<div class="warn">${esc(s.piiCut)}</div>` : '',
        ...report.notes.map((note) => `<div class="warn">${esc(clip(printable(note), 200))}</div>`),
        suppressed ? `<h3>${esc(s.piiSuppressed)}</h3><table><tr><th>${esc(s.piiDetector)} / ${esc(s.piiSurface)}</th><th>${esc(s.piiLocation)}</th><th>${esc(s.piiReason)}</th><th>${esc(s.piiUntil)}</th></tr>${suppressed}</table>` : '',
        `<p class="muted">${esc(s.piiLooked)}: ${esc(lookedText)}</p>`,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');
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

${data.parameters ? parametersBlock(s, data.parameters) : ''}

${data.simulated ? simulatedBlock(s, data.simulated) : ''}

<h2>${esc(s.steps)}</h2>
<table><tr><th>${esc(s.step)}</th><th>${esc(s.action)}</th><th>${esc(s.status)}</th><th>${esc(s.time)}</th><th>${esc(s.detail)}</th></tr>${stepRows(s, data.steps)}</table>
${data.teardown?.length ? `<h2>${esc(s.teardown)}</h2><table><tr><th>${esc(s.step)}</th><th>${esc(s.action)}</th><th>${esc(s.status)}</th><th>${esc(s.time)}</th><th>${esc(s.detail)}</th></tr>${stepRows(s, data.teardown)}</table>` : ''}

${data.accessibility?.length ? `<h2>${esc(s.a11yTitle)}</h2>${accessibilityBlock(s, lang, data.accessibility)}` : ''}

${data.privacy?.length ? `<h2>${esc(s.piiTitle)}</h2><p class="muted">${esc(s.piiNote)}</p>${privacyBlock(s, data.privacy)}` : ''}

${failureShot ? `<h2>${esc(s.failureEvidence)}</h2><figure><img src="${esc(failureShot.dataUri)}" alt="failure"><figcaption>${failureShot.actor ? `${esc(failureShot.actor)} · ` : ''}failure</figcaption></figure>` : ''}
${
  data.screenshots.filter((shot) => shot !== failureShot).length
    ? `<h2>${esc(s.screenshots)}</h2>${data.screenshots
        .filter((shot) => shot !== failureShot)
        .map((shot) => `<figure><img src="${esc(shot.dataUri)}" alt="${esc(shot.name)}"><figcaption>${shot.actor ? `${esc(shot.actor)} · ` : ''}${esc(shot.name)}</figcaption></figure>`)
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

  const variantRows = (variants: SuiteReportData['variants']): string =>
    variants
      .map((variant) => {
        const detail = variant.errorType ? `${esc(variant.errorType)}: ${esc(clip(variant.errorMessage ?? '', 300))}` : variant.notRunReason ? `<span class="muted">${esc(clip(variant.notRunReason, 200))}</span>` : '';
        const tag = variant.passedOnRetry ? ` <small class="muted">(${esc(s.passedOnRetryTag)})</small>` : '';
        // Every attempt is shown, with its own run id: the new attempt does not replace the failure, it sits next to it.
        const attempts =
          variant.attempts && variant.attempts.length > 1
            ? variant.attempts
                .map(
                  (attempt) =>
                    `<tr><td class="muted" style="padding-left:18px"><small>${esc(s.attempt)} ${attempt.attempt}</small></td><td class="cell-${attempt.status === 'passed' ? 'passed' : 'failed'}"><small>${esc(statusLabel(s, attempt.status))}</small></td><td></td><td class="mono"><small>${esc(attempt.jobId)}</small></td><td><small>${attempt.errorType ? `${esc(attempt.errorType)}: ${esc(clip(attempt.errorMessage ?? '', 200))}` : ''}</small></td></tr>`,
                )
                .join('')
            : '';
        return `<tr><td class="mono">${esc(variant.variantKey)}<br><small>${esc(variant.routineId)} v${variant.routineVersion}</small></td><td class="cell-${variant.status === 'passed' ? 'passed' : variant.status === 'failed' ? 'failed' : 'error'}">${esc(statusLabel(s, variant.status))}${tag}</td><td>${esc(seconds(variant.durationMs))}</td><td class="mono">${esc(variant.jobId ?? '')}</td><td>${detail}</td></tr>${attempts}`;
      })
      .join('');
  const header = `<tr><th>${esc(s.variant)}</th><th>${esc(s.status)}</th><th>${esc(s.duration)}</th><th>${esc(s.run)}</th><th>${esc(s.detail)}</th></tr>`;

  // T3.5: quarantined variants ran but do not count: they get a table of their own, and the summary counts only the ones that do.
  const counted = data.variants.filter((variant) => !variant.quarantined);
  const quarantined = data.variants.filter((variant) => variant.quarantined);
  const countOf = (status: string): number => counted.filter((variant) => variant.status === status).length;
  const retried = counted.filter((variant) => variant.passedOnRetry).length;

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
${metaRow(s.totalRuns, esc(`${counted.length}: ${countOf('passed')} ${s.passed}, ${countOf('failed')} ${s.failed}, ${countOf('error')} ${s.error}, ${countOf('notRun')} ${s.notRun}${quarantined.length ? ` (+ ${quarantined.length} ${s.quarantinedTag})` : ''}`), s.unknown)}
</table>
${data.teardownFailures ? `<div class="warn">${esc(s.teardownFailed)} (${data.teardownFailures})</div>` : ''}
${retried > 0 ? `<div class="warn"><b>${retried}</b> ${esc(s.passedOnRetryTag)}. ${esc(s.passedOnRetryNote)}</div>` : ''}

<h2>${esc(s.variants)}</h2>
<table>${header}${variantRows(counted)}</table>

${
  quarantined.length > 0
    ? `<h2>${esc(s.quarantineTitle)}</h2>
<div class="warn">${esc(s.quarantineNote)}</div>
<table>${header}${variantRows(quarantined)}</table>`
    : ''
}

<div class="footer">
<h2 style="margin-top:0">${esc(s.integrity)}</h2>
${data.keyId ? metaRow(s.keyId, `<span class="mono">${esc(data.keyId)}</span>`, s.unknown).replace('<tr>', '<table class="meta"><tr>').replace('</tr>', '</tr></table>') : ''}
<p class="muted">${esc(s.proves)} ${esc(s.doesNotProve)}<br>${esc(s.verifyHint)}</p>
<p class="muted">${esc(s.generated)}: ${esc(data.generatedAt)}</p>
</div>`;

  return page(s, `${s.suiteTitle} ${data.suiteRunId}`, body);
}
