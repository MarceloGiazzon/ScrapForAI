import { JOB_ID_PATTERN } from '../evidence/locate.js';
import { listIntegrations } from '../integrations/integrationStore.js';
import { getSuite } from '../orchestrator/suiteRunner.js';
import type { SettledEvent } from '../scheduler/scheduler.js';
import type { BugReport } from '../schemas/bugReport.schema.js';
import { BugReportError, draftBugReport, loadFailure, sendBugReport } from './service.js';

/**
 * T9.1, "when it fails": a SCHEDULED run that ended `failed` (after its own new attempt) prepares a bug report by itself, but ONLY when an enabled
 * integration serves the run's target profile and has not chosen `ignore`. No integration, no files: this is not something every install asked for.
 * What the integration says decides what happens next: `draft` (default) leaves a draft for a person to approve; `send` sends it, with no one in
 * the loop (opt-in). Never throws: a bug report must not disturb the scheduler, and a problem is a line on stderr.
 *
 * What is NOT reported by itself:
 *   - a run that could not execute (outcome `error`): that is the platform, not a bug in the application;
 *   - a quarantined variant, a variant that passed on a new attempt, and a run that drew generated values (an edge value fails ON PURPOSE).
 *     A person can still draft any of them by hand.
 */

const MAX_REPORTS_PER_EVENT = 10;

export interface AutoDraftResult {
  jobId: string;
  reportId?: string;
  created?: boolean;
  sent?: boolean;
  skipped?: string;
}

async function jobIdsOf(event: SettledEvent): Promise<string[]> {
  const run = event.run;
  if (!run) return [];
  if (run.kind === 'run') return JOB_ID_PATTERN.test(run.id) ? [run.id] : [];
  if (run.kind !== 'suite') return [];
  const suite = await getSuite(run.id);
  if (!suite) return [];
  return suite.variants
    .filter((variant) => variant.status === 'failed' && !variant.quarantined && !variant.passedOnRetry && variant.sample === undefined && variant.jobId !== undefined)
    .map((variant) => variant.jobId!)
    .slice(0, MAX_REPORTS_PER_EVENT);
}

export async function autoDraftBugReports(event: SettledEvent): Promise<AutoDraftResult[]> {
  if (event.outcome !== 'failed') return [];
  const integrations = (await listIntegrations()).filter(({ integration }) => integration.enabled && integration.onScheduledFailure !== 'ignore');
  if (integrations.length === 0) return [];

  const results: AutoDraftResult[] = [];
  for (const jobId of await jobIdsOf(event)) {
    try {
      const { result, request } = await loadFailure(jobId);
      if (result.parameters) {
        results.push({ jobId, skipped: 'the run drew generated values (edge values fail on purpose)' });
        continue;
      }
      const profile = request.targetProfile;
      const serving = integrations.filter(({ integration }) => integration.targetProfiles.length === 0 || (profile !== undefined && integration.targetProfiles.includes(profile)));
      const chosen = serving[0]?.integration; // a report goes to ONE tracker: the first (by id) that serves its profile
      if (!chosen) {
        results.push({ jobId, skipped: 'no integration serves this target profile' });
        continue;
      }

      const drafted = await draftBugReport({ fromJobId: jobId, lang: chosen.lang }, { via: 'schedule' });
      const outcome: AutoDraftResult = { jobId, reportId: drafted.report.id, created: drafted.created };

      if (chosen.onScheduledFailure === 'send' && shouldSend(drafted.report)) {
        const sent = await sendBugReport(drafted.report.id, { integrationId: chosen.id }).catch((error: unknown) => {
          if (!(error instanceof BugReportError)) throw error;
          return undefined;
        });
        outcome.sent = sent?.report.status === 'sent';
      }
      results.push(outcome);
    } catch (error) {
      process.stderr.write(`[bug-report] could not draft a report for ${jobId}: ${error instanceof Error ? error.name : 'error'}\n`);
      results.push({ jobId, skipped: error instanceof Error ? error.name : 'error' });
    }
  }
  return results;
}

/** A draft that was blocked because the text still held a secret is not retried by itself: it needs a person to look. */
function shouldSend(report: BugReport): boolean {
  return report.status === 'draft' && report.attempts[report.attempts.length - 1]?.status !== 'blocked';
}
