import path from 'node:path';

import { summariesDir } from '../config/paths.js';
import { sendSummaryReport } from '../integrations/notifier.js';
import { scrubText } from '../integrations/scrub.js';
import type { Schedule } from '../schemas/schedule.schema.js';
import type { Settled } from '../scheduler/scheduler.js';
import { writeFileAtomic } from '../storage/atomicWrite.js';
import { listAllCredentialValues } from '../vault/credentials/credentialVault.js';
import { renderSummaryMarkdown, summaryReportMessage } from './summaryAnalysis.js';
import { getSummary } from './summaryService.js';

/**
 * T9.3: what a `summary` schedule does when it fires. No browser and no queue: it reads the stores, writes the file (when asked) and sends the
 * message to every enabled webhook of `notify`. Outcome: `passed` when everything that was asked for was delivered; `error` when the summary
 * could not be built, or a webhook did not get it (the file, if any, is still written and the message says so). A summary is not a test:
 * there is no `failed`.
 */

/** `<local date>_<HHMM>` in the schedule's time zone, so a person finds "Monday's" summary under Monday's date. */
export function summaryFileStem(occurrenceMs: number, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(occurrenceMs))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}_${parts.hour}${parts.minute}`;
}

export interface SummaryRunDeps {
  deliver?: { retryDelayMs?: number };
}

export async function runSummarySchedule(schedule: Schedule, occurrenceIso: string, deps: SummaryRunDeps = {}): Promise<Settled> {
  const { target } = schedule;
  if (target.kind !== 'summary') return { outcome: 'error', message: 'not a summary schedule' };

  let report;
  try {
    report = await getSummary({ to: new Date(occurrenceIso), days: target.periodDays, ...(target.targets ? { targets: target.targets } : {}) });
  } catch (error) {
    return { outcome: 'error', message: `the summary could not be built: ${error instanceof Error ? error.name : 'Error'}` };
  }

  const notes: string[] = [];
  let fileWritten: string | undefined;
  if (target.file) {
    try {
      const stem = summaryFileStem(Date.parse(occurrenceIso), schedule.timezone);
      const dir = path.join(summariesDir(), schedule.id);
      const vaultValues = await listAllCredentialValues();
      // The words are ours and the ids come from safe-name schemas; the scrub is a second fence (a routine title is free text).
      const markdown = scrubText(renderSummaryMarkdown(report, target.lang), vaultValues, 1_000_000).text;
      const json = scrubText(`${JSON.stringify(report, null, 2)}\n`, vaultValues, 5_000_000).text;
      await writeFileAtomic(path.join(dir, `${stem}.json`), json);
      await writeFileAtomic(path.join(dir, `${stem}.md`), markdown);
      fileWritten = `${schedule.id}/${stem}.md`;
    } catch (error) {
      notes.push(`the file could not be written (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
    }
  }

  const deliveries = await sendSummaryReport(schedule, (lang) => summaryReportMessage(report, lang), deps);
  const notSent = deliveries.filter((item) => item.delivery.status !== 'sent');
  for (const item of notSent) notes.push(`webhook ${item.webhookId}: ${item.delivery.status}${item.delivery.reason ? ` (${item.delivery.reason})` : ''}`);
  const sent = deliveries.length - notSent.length;

  const c = report.counts;
  const facts = {
    counts: { red: c.red, broke: c.broke, fixed: c.fixed, stillFailing: c.stillFailing, flaky: c.flaky, perfAlerts: c.perfAlerts, a11yNew: c.a11yNew, screensChanged: c.screensChanged },
  };
  const delivered = [fileWritten ? `file ${fileWritten}` : undefined, deliveries.length > 0 ? `${sent}/${deliveries.length} webhook(s)` : undefined].filter(Boolean).join(', ');
  const message = `${delivered || 'nothing delivered'}${notes.length > 0 ? `; ${notes.join('; ')}` : ''}`.slice(0, 500);

  const failedSomething = notes.length > 0 || (!fileWritten && deliveries.length === 0);
  return { outcome: failedSomething ? 'error' : 'passed', message, facts };
}
