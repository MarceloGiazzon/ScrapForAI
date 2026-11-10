import fs from 'node:fs/promises';
import path from 'node:path';

import { checkSignature } from '../evidence/signature.js';
import { loadPublicKey } from '../evidence/signingKey.js';
import { EvidenceError } from '../evidence/pin.js';
import { findJobDir, JOB_ID_PATTERN, resolveJobFile } from '../evidence/locate.js';
import { readManifest } from '../evidence/manifest.js';
import { getSuite, SUITE_ID_PATTERN } from '../orchestrator/suiteRunner.js';
import { createPlaywrightContext } from '../runner/playwrightContext.js';
import { accessibilityResultSchema } from '../schemas/accessibility.schema.js';
import type { ExplorationResult } from '../schemas/explorationResult.schema.js';
import { piiReportSchema } from '../schemas/pii.schema.js';
import { getTarget } from '../targets/targetStore.js';
import type { ReportLang } from './i18n.js';
import { type IntegrityInfo, renderRunReport, renderSuiteReport, type ReportStep, type SuiteAuditSummary, type SuiteReportData } from './render.js';
import { readFileRetry } from '../storage/transientIo.js';

const MAX_SCREENSHOTS = 12;
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;

async function readJson<T>(jobId: string, name: string): Promise<T | undefined> {
  const file = resolveJobFile(jobId, name);
  if (!file) return undefined;
  try {
    return JSON.parse(await readFileRetry(file, 'utf8')) as T;
  } catch (error) {
    // The caller turns this into "evidence not found"; without this line a file that is there but unreadable looks the same as one that expired.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      process.stderr.write(`[evidence] ${name} of ${jobId} could not be read: ${code ?? (error instanceof Error ? error.message : String(error))}\n`);
    }
    return undefined;
  }
}

async function integrityOf(jobId: string): Promise<IntegrityInfo> {
  const job = findJobDir(jobId);
  const stored = job ? await readManifest(job.dir).catch(() => undefined) : undefined;
  if (!job || !stored) {
    return { state: 'none' };
  }
  if (job.location !== 'pinned') {
    return { state: 'unsigned', signature: 'unsigned' };
  }

  const { publicKeyPem, keyId } = await loadPublicKey();
  const check = checkSignature(stored.manifest, publicKeyPem);
  return {
    state: 'pinned',
    signature: check.status === 'valid' ? 'valid' : check.status === 'unsigned' ? 'unsigned' : 'invalid',
    keyId: check.status === 'unsigned' ? undefined : keyId,
    manifestSha256: stored.sha256,
    ...(stored.manifest.chain ? { chainSequence: stored.manifest.chain.sequence } : {}),
    ...(stored.manifest.pin ? { pinnedAt: stored.manifest.pin.pinnedAt, pinReason: stored.manifest.pin.reason } : {}),
  };
}

const toSteps = (steps: ExplorationResult['steps'] | undefined): ReportStep[] =>
  (steps ?? []).map((step) => ({
    index: step.index,
    id: step.id,
    label: step.label,
    description: step.description,
    ...(step.actor ? { actor: step.actor } : {}),
    ...(step.branch === undefined ? {} : { branch: step.branch }),
    ...(step.branches ? { branches: step.branches } : {}),
    action: step.action,
    status: step.status,
    durationMs: step.durationMs,
    ...(step.error ? { error: step.error } : {}),
  }));

/** Self-contained HTML report of one run (screenshots embedded). Needs the evidence to still exist. */
export async function buildRunReport(jobId: string, lang: ReportLang): Promise<string> {
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new EvidenceError(400, 'ValidationError', 'Invalid job id');
  }

  const result = await readJson<ExplorationResult>(jobId, 'result.json');
  if (!result) {
    throw new EvidenceError(404, 'EvidenceNotFound', `No evidence for ${jobId}: it expired (ARTIFACT_RETENTION_HOURS) or never existed. Pin runs you need to report on.`);
  }

  const request = await readJson<{ targetProfile?: string }>(jobId, 'request.json');
  const profile = request?.targetProfile ? await getTarget(request.targetProfile).catch(() => undefined) : undefined;

  const screenshots: Array<{ name: string; dataUri: string; actor?: string }> = [];
  for (const shot of result.evidence.screenshots.slice(0, MAX_SCREENSHOTS)) {
    const file = resolveJobFile(jobId, `screenshots/${path.basename(shot.path)}`);
    if (!file) continue;
    const data = await readFileRetry(file).catch(() => undefined);
    if (data && data.length <= MAX_SCREENSHOT_BYTES) {
      screenshots.push({ name: shot.name, dataUri: `data:image/png;base64,${data.toString('base64')}`, ...(shot.actor ? { actor: shot.actor } : {}) });
    }
  }

  // T7.4/T7.5: the audits are recognised by their shape (`kind: 'accessibility-audit'`), not by name; nothing else in `extracted` reaches the report.
  const accessibility = Object.entries(result.extracted ?? {}).flatMap(([name, value]) => {
    const parsed = accessibilityResultSchema.safeParse(value);
    return parsed.success ? [{ name, result: parsed.data }] : [];
  });

  // T7.8: the run's own scan (options.piiScan) and every scanForPii step, recognised by shape (`kind: 'pii-scan'`).
  const privacy = [
    ...(result.pii ? [{ name: 'run', report: result.pii }] : []),
    ...Object.entries(result.extracted ?? {}).flatMap(([name, value]) => {
      const parsed = piiReportSchema.safeParse(value);
      return parsed.success ? [{ name, report: parsed.data }] : [];
    }),
  ];

  // T7.2/T7.3: what the run changed on purpose, so a report never passes a simulated condition off as the real one. Faults are grouped (same request, same effect).
  const faultGroups = new Map<string, { method: string; pathname: string; detail: string; count: number }>();
  for (const entry of result.evidence.routing ?? []) {
    if (entry.handledBy !== 'fault') continue;
    const detail = entry.detail ?? entry.action;
    const key = `${entry.method} ${entry.origin}${entry.pathname} ${detail}`;
    const group = faultGroups.get(key);
    if (group) group.count += 1;
    else faultGroups.set(key, { method: entry.method, pathname: entry.pathname, detail, count: 1 });
  }
  const clock = result.clock ?? [];
  const simulated = clock.length > 0 || faultGroups.size > 0 ? { clock, faults: [...faultGroups.values()] } : undefined;

  const describeNetwork =(item: ExplorationResult['evidence']['networkFailures'][number]): string =>
    `${item.method} ${item.origin}${item.pathname} ${item.failureText ?? item.status ?? ''}`.trim();

  return renderRunReport(
    {
      jobId: result.jobId,
      status: result.status,
      scenarioName: result.scenarioName,
      targetUrl: result.targetUrl,
      application: profile?.name,
      platform: profile?.platform,
      environment: profile?.environment,
      buildId: result.buildId,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
      executor: result.caller?.source ?? 'ScrapForAI',
      ...(result.routine ? { routine: { id: result.routine.id, version: result.routine.version } } : {}),
      ...(result.error ? { error: result.error } : {}),
      failedStepIndex: result.failedStepIndex,
      steps: toSteps(result.steps),
      ...(result.teardown ? { teardown: toSteps(result.teardown) } : {}),
      teardownStatus: result.teardownStatus,
      ...(result.parameters
        ? {
            parameters: {
              seed: result.parameters.seed,
              sample: result.parameters.sample,
              rows: Object.entries(result.parameters.values).map(([name, value]) => ({
                name,
                value,
                source: result.parameters!.sources[name]?.source ?? 'case',
                synthetic: result.parameters!.synthetic?.includes(name) ?? false,
              })),
            },
          }
        : {}),
      ...(result.tables && result.tables.length > 0
        ? {
            tables: result.tables.map((table) => ({
              ...table,
              // The row is the run's sample, wrapping past the last row (like any `cases`); unknown when the run recorded no sample.
              ...(result.parameters ? { row: (result.parameters.sample % table.rows) + 1 } : {}),
            })),
          }
        : {}),
      ...(simulated ? { simulated } : {}),
      ...(accessibility.length > 0 ? { accessibility } : {}),
      ...(privacy.length > 0 ? { privacy } : {}),
      screenshots,
      consoleCount: result.evidence.console.length,
      consoleErrors: result.evidence.consoleErrors.map((entry) => entry.text),
      networkCount: result.evidence.network.length,
      networkFailures: result.evidence.networkFailures.map(describeNetwork),
      integrity: await integrityOf(jobId),
      generatedAt: new Date().toISOString(),
    },
    lang,
  );
}

/**
 * T7.4/T7.5: the accessibility audits of one run as the suite report keeps them (counts only), recognised by shape like in the run report.
 * `undefined` = the run's evidence is gone (unknown whether it audited); `[]` = it exists and made no audit.
 */
async function suiteAudits(jobId: string): Promise<SuiteAuditSummary[] | undefined> {
  const result = await readJson<Pick<ExplorationResult, 'extracted'>>(jobId, 'result.json');
  if (!result) return undefined;
  return Object.entries(result.extracted ?? {}).flatMap(([name, value]) => {
    const parsed = accessibilityResultSchema.safeParse(value);
    if (!parsed.success) return [];
    const audit = parsed.data;
    return [
      {
        name,
        standard: audit.standard,
        counts: { critical: audit.counts.critical, serious: audit.counts.serious, moderate: audit.counts.moderate, minor: audit.counts.minor },
        truncated: audit.truncated,
        ...(audit.baseline
          ? { baseline: { buildId: audit.baseline.buildId, new: audit.baseline.new.length, fixed: audit.baseline.fixed.length, incomplete: audit.baseline.incomplete } }
          : {}),
      },
    ];
  });
}

export async function buildSuiteReportHtml(suiteRunId: string, lang: ReportLang): Promise<string> {
  const state = SUITE_ID_PATTERN.test(suiteRunId) ? await getSuite(suiteRunId) : undefined;
  if (!state) {
    throw new EvidenceError(404, 'SuiteNotFound', 'Suite run not found');
  }
  if (state.status === 'running') {
    throw new EvidenceError(409, 'SuiteRunning', 'The suite is still running; a report of a half-finished suite would mislead. Wait for it to end.');
  }

  const { keyId } = await loadPublicKey();

  // The run of a variant is its last attempt (`variant.jobId`). A job id that does not look like one is never turned into a path.
  const variants: SuiteReportData['variants'] = [];
  for (const variant of state.variants) {
    const audits = variant.jobId && JOB_ID_PATTERN.test(variant.jobId) ? await suiteAudits(variant.jobId) : undefined;
    variants.push({
      ...variant,
      ...(audits && audits.length > 0 ? { accessibility: audits } : {}),
      ...(variant.jobId && audits === undefined ? { evidenceExpired: true } : {}),
    });
  }

  return renderSuiteReport(
    {
      suiteRunId: state.suiteRunId,
      name: state.name,
      status: state.status,
      verdict: state.verdict,
      verdictReason: state.verdictReason,
      exitCode: state.exitCode,
      createdAt: state.createdAt,
      finishedAt: state.finishedAt,
      counts: state.counts,
      total: state.total,
      teardownFailures: state.teardownFailures,
      buildId: state.request.buildId,
      executor: 'ScrapForAI',
      variants,
      keyId,
      generatedAt: new Date().toISOString(),
    },
    lang,
  );
}

/**
 * HTML -> PDF with the browser ScrapForAI already uses. The report is untrusted-ish text (it comes from a
 * page under test), so the page can load nothing: every request that is not a data: URL is aborted, and the
 * report itself carries a CSP without scripts.
 */
export async function htmlToPdf(html: string): Promise<Buffer> {
  const browser = await createPlaywrightContext(true, { width: 1000, height: 1400 });
  try {
    await browser.page.route('**/*', (route) => route.abort());
    await browser.page.setContent(html, { waitUntil: 'load' });
    return Buffer.from(await browser.page.pdf({ format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' } }));
  } finally {
    await browser.close();
  }
}
