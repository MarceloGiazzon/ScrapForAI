import { randomBytes } from 'node:crypto';

import { findJobDir, resolveJobFile } from '../evidence/locate.js';
import { createGithubIssue } from '../integrations/githubIssues.js';
import { getIntegration, listIntegrations, resolveIntegrationToken, type StoredIntegration } from '../integrations/integrationStore.js';
import { findLeak, scrubText } from '../integrations/scrub.js';
import { readPerfRecords } from '../metrics/perfStore.js';
import { RequestResolutionError } from '../runner/resolutionError.js';
import type { Attempt, BugReport, BugReportRequest, BugReportStatus, Occurrence } from '../schemas/bugReport.schema.js';
import type { ExplorationResult } from '../schemas/explorationResult.schema.js';
import type { ReportLang } from '../schemas/integration.schema.js';
import { maskUrl } from '../security/piiDetectors.js';
import { getShrink, SHRINK_ID_PATTERN, signatureOf } from '../shrink/shrinkService.js';
import { readFileRetry } from '../storage/transientIo.js';
import { getTarget } from '../targets/targetStore.js';
import { listAllCredentialValues } from '../vault/credentials/credentialVault.js';
import { type BugFacts, type Clean, renderIssue } from './render.js';
import { bugSignature } from './signature.js';
import { sinceWhen } from './since.js';
import { findBySignature, getBugReport, withBugReportLock, writeBugReport } from './store.js';

/**
 * T9.1 bug reports. `draftBugReport` reads a FAILED run's evidence (and, if asked, a finished shrink of it), builds the facts, renders the issue and
 * stores it as a draft; the same failure again (same routine, step and error type) adds an occurrence to the report that already exists.
 * `sendBugReport` is the only thing here that leaves the server, and only for a draft, only to an integration, only after the text is cleaned
 * and checked once more. No browser is started and no run is changed.
 */

export class BugReportError extends RequestResolutionError {}

const MAX_OCCURRENCES = 50;
const MAX_ATTEMPTS = 20;

export interface FailureEvidence {
  result: ExplorationResult;
  request: { targetProfile?: string; credentialSet?: string };
  location: 'ephemeral' | 'pinned';
}

async function readJob<T>(jobId: string, name: 'result.json' | 'request.json'): Promise<T | undefined> {
  const file = resolveJobFile(jobId, name);
  if (!file) return undefined;
  try {
    return JSON.parse(await readFileRetry(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** The evidence of a run that FAILED. 404 when it expired (pin what you will report on), 409 when the run did not fail. */
export async function loadFailure(jobId: string): Promise<FailureEvidence> {
  const job = findJobDir(jobId);
  const result = job ? await readJob<ExplorationResult>(jobId, 'result.json') : undefined;
  if (!job || !result) {
    throw new BugReportError(404, 'EvidenceNotFound', `No evidence for ${jobId}: it expired (ARTIFACT_RETENTION_HOURS) or never existed. Pin runs you need to report on.`);
  }
  if (result.status !== 'failed') throw new BugReportError(409, 'RunNotFailed', `Run ${jobId} did not fail (status: ${result.status}); there is nothing to report`);
  const request = (await readJob<FailureEvidence['request']>(jobId, 'request.json')) ?? {};
  return { result, request, location: job.location === 'pinned' ? 'pinned' : 'ephemeral' };
}

const addressOf = (raw: string): string => {
  try {
    const url = new URL(raw);
    return maskUrl(`${url.origin}${url.pathname}`);
  } catch {
    return 'unknown';
  }
};

const describeNetwork = (item: ExplorationResult['evidence']['networkFailures'][number]): string => `${item.method} ${item.origin}${item.pathname} ${item.failureText ?? item.status ?? ''}`.trim();

function failureOf(result: ExplorationResult): BugFacts['failure'] {
  const index = result.failedStepIndex;
  const step = index === undefined ? undefined : result.steps[index];
  return {
    stepId: step?.id ?? (index === undefined ? 'run' : `#${index}`),
    stepIndex: index ?? -1,
    action: step?.action ?? 'run',
    ...(step?.label ? { label: step.label } : {}),
    errorType: step?.error?.type ?? result.error?.type ?? 'unknown',
    errorMessage: step?.error?.message ?? result.error?.message ?? '(no message)',
    ...(step?.actor ? { actor: step.actor } : {}),
  };
}

/** The shrink of this failure, if one was named. It must be finished and be about the SAME failure, or it would mislead. */
async function shrinkFacts(shrinkId: string, failure: BugFacts['failure'], result: ExplorationResult): Promise<NonNullable<BugFacts['shrink']>> {
  if (!SHRINK_ID_PATTERN.test(shrinkId)) throw new BugReportError(400, 'ValidationError', 'Invalid shrink id');
  const state = await getShrink(shrinkId);
  if (!state) throw new BugReportError(404, 'ShrinkNotFound', `Shrink ${shrinkId} does not exist`);
  if (state.status === 'running') throw new BugReportError(409, 'ShrinkRunning', `Shrink ${shrinkId} is still running; draft the report when it ends`);
  if (!state.result) throw new BugReportError(409, 'ShrinkHasNoResult', `Shrink ${shrinkId} ended without a result (${state.outcome ?? state.status})`);
  if (state.routine && result.routine && state.routine.id !== result.routine.id) {
    throw new BugReportError(409, 'ShrinkDoesNotMatch', `Shrink ${shrinkId} is about routine ${state.routine.id}, not ${result.routine.id}`);
  }
  if (state.signature && (state.signature.stepId !== failure.stepId || state.signature.errorType !== failure.errorType)) {
    throw new BugReportError(409, 'ShrinkDoesNotMatch', `Shrink ${shrinkId} is about another failure (${state.signature.stepId}: ${state.signature.errorType})`);
  }
  return {
    shrinkId,
    outcome: state.outcome ?? state.result.status,
    ...(state.summary ? { summary: state.summary } : {}),
    minimal: state.result.minimal,
    boundaries: state.result.boundaries,
    ...(state.result.minimalJobId ? { minimalJobId: state.result.minimalJobId } : {}),
  };
}

async function buildFacts(evidence: FailureEvidence, shrinkId: string | undefined): Promise<BugFacts> {
  const { result, request, location } = evidence;
  const failure = failureOf(result);
  const profile = request.targetProfile ? await getTarget(request.targetProfile).catch(() => undefined) : undefined;

  let env = 'unknown';
  try {
    env = new URL(result.targetUrl).origin;
  } catch {
    /* keep unknown */
  }
  const since = result.routine
    ? sinceWhen(await readPerfRecords(result.routine.id).catch(() => []), {
        jobId: result.jobId,
        at: result.startedAt,
        ...(result.buildId ? { buildId: result.buildId } : {}),
        version: result.routine.version,
        env,
        profile: result.profile ?? 'full',
      })
    : undefined;

  const replayParts = result.routine
    ? [
        'scrapforai run',
        result.routine.id,
        `--version ${result.routine.version}`,
        ...(request.targetProfile ? [`--target ${request.targetProfile}`] : []),
        ...(request.credentialSet ? [`--credential ${request.credentialSet}`] : []),
        ...(result.parameters ? [`--seed ${result.parameters.seed}`, `--sample ${result.parameters.sample}`] : []),
      ]
    : undefined;

  const signature = bugSignature({ ...(result.routine ? { routineId: result.routine.id } : {}), scenarioName: result.scenarioName ?? 'unnamed run', stepId: failure.stepId, ...(failure.action === 'run' ? {} : { action: failure.action }), errorType: failure.errorType });
  // The shrink's own notion of "the same failure" and ours must agree; this is the one place that would show if they ever drift apart.
  const shrinkSignature = signatureOf(result);
  if (shrinkSignature && (shrinkSignature.stepId !== failure.stepId || shrinkSignature.errorType !== failure.errorType)) {
    throw new BugReportError(500, 'SignatureMismatch', 'The failure signature disagrees with the shrink signature');
  }

  return {
    jobId: result.jobId,
    scenarioName: result.scenarioName ?? 'unnamed run',
    startedAt: result.startedAt,
    durationMs: result.durationMs,
    ...(result.buildId ? { buildId: result.buildId } : {}),
    ...(result.buildIdSource ? { buildIdSource: result.buildIdSource } : {}),
    ...(result.routine ? { routine: { id: result.routine.id, version: result.routine.version } } : {}),
    ...(result.profile ? { runProfile: result.profile } : {}),
    ...(profile ? { application: profile.name, environment: profile.environment, platform: profile.platform } : {}),
    ...(request.targetProfile ? { targetProfile: request.targetProfile } : {}),
    address: addressOf(result.targetUrl),
    failure,
    steps: result.steps.map((step) => ({ index: step.index, ...(step.id ? { id: step.id } : {}), action: step.action, ...(step.label ? { label: step.label } : {}), status: step.status, ...(step.actor ? { actor: step.actor } : {}) })),
    consoleErrors: result.evidence.consoleErrors.map((entry) => entry.text),
    networkFailures: result.evidence.networkFailures.map(describeNetwork),
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
    ...(shrinkId ? { shrink: await shrinkFacts(shrinkId, failure, result) } : {}),
    ...(since ? { since } : {}),
    ...(replayParts ? { replay: replayParts.join(' ') } : {}),
    evidence: { location },
    signature,
  };
}

/** A `clean` for the renderer that counts what it had to hide. */
async function makeCleaner(): Promise<{ clean: Clean; redactions: () => number; vaultValues: string[] }> {
  const vaultValues = await listAllCredentialValues();
  let redactions = 0;
  return {
    vaultValues,
    redactions: () => redactions,
    clean: (text, maxLength = 300) => {
      const scrubbed = scrubText(text, vaultValues, maxLength);
      redactions += scrubbed.redactions;
      return scrubbed.text;
    },
  };
}

export interface DraftOutcome {
  report: BugReport;
  /** A new report was made. False: the failure already had one. */
  created: boolean;
  /** An existing DRAFT was rebuilt from this run (a person asked for it by hand). */
  refreshed: boolean;
}

export interface DraftOptions {
  via: Occurrence['via'];
  nowMs?: number;
}

function addOccurrence(report: BugReport, occurrence: Occurrence): void {
  if (report.occurrences.some((item) => item.jobId === occurrence.jobId)) return;
  report.occurrences.push(occurrence);
  report.occurrenceCount += 1;
  // The first one is the run the draft was built from; keep it and the newest ones.
  if (report.occurrences.length > MAX_OCCURRENCES) report.occurrences.splice(1, report.occurrences.length - MAX_OCCURRENCES);
}

export async function draftBugReport(request: BugReportRequest, options: DraftOptions): Promise<DraftOutcome> {
  const evidence = await loadFailure(request.fromJobId);
  const built = await buildFacts(evidence, request.shrinkId);
  const { result } = evidence;
  const nowIso = new Date(options.nowMs ?? Date.now()).toISOString();
  const lang: ReportLang = request.lang ?? 'en';
  const occurrence: Occurrence = {
    jobId: result.jobId,
    at: result.startedAt,
    ...(result.buildId ? { buildId: result.buildId } : {}),
    ...(evidence.request.targetProfile ? { targetProfile: evidence.request.targetProfile } : {}),
    via: options.via,
  };

  return withBugReportLock(async () => {
    const existing = await findBySignature(built.signature.hash);

    // The same open failure: it has a report already.
    if (existing && existing.status !== 'resolved') {
      if (existing.status === 'draft' && options.via === 'manual') {
        // A person asked for this run by hand and the draft is still unsent: it now describes THIS run (the earlier occurrences are kept).
        const { clean, redactions } = await makeCleaner();
        const earlier = existing.recurrenceOf ? await getBugReport(existing.recurrenceOf).catch(() => undefined) : undefined;
        const rendered = renderIssue({ ...built, ...(existing.recurrenceOf ? { recurrenceOf: { id: existing.recurrenceOf, ...(earlier?.issue?.url ? { issueUrl: earlier.issue.url } : {}) } } : {}) }, lang, clean);
        const refreshed: BugReport = {
          ...existing,
          updatedAt: nowIso,
          lang,
          source: { jobId: result.jobId, ...(request.shrinkId ? { shrinkId: request.shrinkId } : {}) },
          ...(evidence.request.targetProfile ? { targetProfile: evidence.request.targetProfile } : {}),
          title: rendered.title,
          body: rendered.body,
          redactions: redactions(),
        };
        addOccurrence(refreshed, occurrence);
        await writeBugReport(refreshed);
        return { report: refreshed, created: false, refreshed: true };
      }
      const updated: BugReport = { ...existing, updatedAt: nowIso, occurrences: [...existing.occurrences] };
      addOccurrence(updated, occurrence);
      await writeBugReport(updated);
      return { report: updated, created: false, refreshed: false };
    }

    // New, or back after being resolved.
    const recurrence = existing?.status === 'resolved' ? { id: existing.id, ...(existing.issue?.url ? { issueUrl: existing.issue.url } : {}) } : undefined;
    const { clean, redactions } = await makeCleaner();
    const rendered = renderIssue({ ...built, ...(recurrence ? { recurrenceOf: recurrence } : {}) }, lang, clean);
    const report: BugReport = {
      id: `bug_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`,
      status: 'draft',
      createdAt: nowIso,
      updatedAt: nowIso,
      lang,
      signature: built.signature,
      source: { jobId: result.jobId, ...(request.shrinkId ? { shrinkId: request.shrinkId } : {}) },
      ...(evidence.request.targetProfile ? { targetProfile: evidence.request.targetProfile } : {}),
      title: rendered.title,
      body: rendered.body,
      redactions: redactions(),
      occurrenceCount: 1,
      occurrences: [occurrence],
      attempts: [],
      ...(existing?.status === 'resolved' ? { recurrenceOf: existing.id } : {}),
    };
    await writeBugReport(report);
    return { report, created: true, refreshed: false };
  });
}

// ---- sending --------------------------------------------------------------------------------------------------------------------------------

const sending = new Set<string>();

export interface SendOutcome {
  report: BugReport;
  attempt: Attempt;
}

/** The integration a report goes to when the caller names none: exactly one enabled integration that serves its target profile. */
export async function chooseIntegration(report: BugReport): Promise<StoredIntegration> {
  const all = (await listIntegrations()).filter(({ integration }) => integration.enabled);
  const serving = all.filter(({ integration }) => integration.targetProfiles.length === 0 || (report.targetProfile !== undefined && integration.targetProfiles.includes(report.targetProfile)));
  if (serving.length === 1) return serving[0]!;
  if (serving.length === 0) throw new BugReportError(400, 'IntegrationRequired', 'No enabled integration serves this report: create one (PUT /v1/integrations/:id) or name one');
  throw new BugReportError(400, 'IntegrationRequired', `Several integrations could take this report (${serving.map((item) => item.integration.id).join(', ')}): name one with integrationId`);
}

export async function sendBugReport(id: string, options: { integrationId?: string; nowMs?: number } = {}): Promise<SendOutcome> {
  // Taken BEFORE anything is read: a second call either finds this one in flight, or runs after it has written `sent` and finds that. Checking
  // the status first and taking the guard later would let a call that read `draft` earlier send the same report twice.
  if (sending.has(id)) throw new BugReportError(409, 'SendInProgress', 'This report is being sent right now');
  sending.add(id);
  try {
    const initial = await getBugReport(id);
    if (!initial) throw new BugReportError(404, 'BugReportNotFound', 'Bug report not found');
    if (initial.status !== 'draft') {
      throw new BugReportError(409, 'BugReportNotDraft', initial.status === 'sent' ? `Already sent${initial.issue ? ` as issue #${initial.issue.number} ${initial.issue.url}`.trimEnd() : ''}` : `This report is ${initial.status}; only a draft can be sent`);
    }

    let stored: StoredIntegration | undefined;
    if (options.integrationId) {
      stored = await getIntegration(options.integrationId);
      if (!stored) throw new BugReportError(404, 'IntegrationNotFound', `Integration "${options.integrationId}" does not exist`);
      if (!stored.integration.enabled) throw new BugReportError(409, 'IntegrationDisabled', `Integration "${options.integrationId}" is disabled`);
    } else {
      stored = await chooseIntegration(initial);
    }
    const { integration } = stored;

    const attempt = await attemptSend(initial, integration, options.nowMs ?? Date.now());
    return withBugReportLock(async () => {
      // Re-read: occurrences may have been added while the request was in flight.
      const current = (await getBugReport(id)) ?? initial;
      const next: BugReport = { ...current, updatedAt: attempt.at, attempts: [...current.attempts, attempt.record].slice(-MAX_ATTEMPTS) };
      if (attempt.issue) {
        next.status = 'sent';
        next.issue = { integrationId: integration.id, number: attempt.issue.number, url: attempt.issue.url, sentAt: attempt.at };
      }
      await writeBugReport(next);
      return { report: next, attempt: attempt.record };
    });
  } finally {
    sending.delete(id);
  }
}

async function attemptSend(report: BugReport, integration: StoredIntegration['integration'], nowMs: number): Promise<{ at: string; record: Attempt; issue?: { number: number; url: string } }> {
  const at = new Date(nowMs).toISOString();
  const record = (status: Attempt['status'], extra: Partial<Attempt> = {}): { at: string; record: Attempt } => ({ at, record: { at, integrationId: integration.id, status, ...extra } });

  // Cleaned once more with the vault AS IT IS NOW (a secret added since the draft was made is hidden too), then checked: if a secret is still in the payload, nothing leaves.
  const vaultValues = await listAllCredentialValues();
  const title = scrubText(report.title, vaultValues, 250).text;
  const body = scrubText(report.body, vaultValues, Number.MAX_SAFE_INTEGER).text;
  const leak = findLeak({ title, body, labels: integration.labels }, vaultValues);
  if (leak) return record('blocked', { reason: `the report still contained ${leak} after cleaning; nothing was sent` });

  const secret = await resolveIntegrationToken(integration.id);
  if (!secret) return record('failed', { reason: 'no token is stored for this integration' });
  let apiOrigin: string;
  try {
    apiOrigin = new URL(integration.apiBaseUrl).origin;
  } catch {
    return record('failed', { reason: 'the integration API address is not valid' });
  }
  if (secret.boundOrigin !== apiOrigin) return record('failed', { reason: 'the stored token is bound to another origin than the API address; nothing was sent' });

  const outcome = await createGithubIssue({ apiBaseUrl: integration.apiBaseUrl, repo: integration.repo, token: secret.token }, { title, body, labels: integration.labels });
  if (!outcome.ok) return record('failed', { reason: outcome.reason, ...(outcome.httpStatus === undefined ? {} : { httpStatus: outcome.httpStatus }) });
  return { ...record('sent', outcome.issue.number === 0 ? { reason: 'the issue was created, but its address could not be read from the reply' } : {}), issue: outcome.issue };
}

// ---- a person's decisions ---------------------------------------------------------------------------------------------------------------------

async function transition(id: string, from: BugReportStatus[], to: BugReportStatus, note: string | undefined, nowMs: number): Promise<BugReport> {
  return withBugReportLock(async () => {
    const report = await getBugReport(id);
    if (!report) throw new BugReportError(404, 'BugReportNotFound', 'Bug report not found');
    if (!from.includes(report.status)) throw new BugReportError(409, 'InvalidTransition', `A ${report.status} report cannot become ${to}`);
    const next: BugReport = { ...report, status: to, updatedAt: new Date(nowMs).toISOString(), ...(note ? { note: scrubText(note, await listAllCredentialValues(), 500).text } : {}) };
    await writeBugReport(next);
    return next;
  });
}

/** "Not worth an issue": later occurrences of the failure are only counted. */
export const dismissBugReport = (id: string, note?: string, nowMs = Date.now()): Promise<BugReport> => transition(id, ['draft'], 'dismissed', note, nowMs);

/** "Fixed": if the failure comes back it gets a NEW report that points at this one. */
export const resolveBugReport = (id: string, note?: string, nowMs = Date.now()): Promise<BugReport> => transition(id, ['draft', 'sent', 'dismissed'], 'resolved', note, nowMs);
