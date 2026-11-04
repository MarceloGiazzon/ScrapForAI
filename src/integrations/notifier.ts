import { listAllCredentialValues } from '../vault/credentials/credentialVault.js';
import type { Schedule, ScheduleHistoryEntry } from '../schemas/schedule.schema.js';
import { type Delivery, type Webhook } from '../schemas/webhook.schema.js';
import { occurrencesBetween, parseCron } from '../scheduler/cron.js';
import type { SettledEvent } from '../scheduler/scheduler.js';
import { getState, listSchedules } from '../scheduler/scheduleStore.js';
import { deliverJson, type DeliverOptions } from './deliver.js';
import { changeMessage, type Message, summaryMessage, type SummaryRow, testMessage } from './message.js';
import { renderPayload } from './presets.js';
import { findLeak, scrubText } from './scrub.js';
import { decideChange, type Verdict, verdictOf } from './transitions.js';
import { getWebhook, getWebhookState, listWebhooks, resolveWebhookUrl, type StoredWebhook, updateWebhookState } from './webhookStore.js';

/**
 * T3.3 notifier. Two entry points called by the scheduler runtime:
 *   - `notifySettled`: a scheduled run ended -> tell each webhook of `schedule.notify` IF its verdict changed;
 *   - `sendDueSummaries`: once a day per webhook that asked for it.
 * plus `sendTest` for `POST /v1/webhooks/:id/test`.
 *
 * Nothing here can fail a run: a webhook that is down, forbidden or misconfigured is recorded in its own delivery log and nowhere else.
 */

export interface NotifyDeps {
  deliver?: DeliverOptions;
  now?: () => number;
}

const SUBJECT_PREFIX = 'schedule:';
const SUMMARY_RETRY_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export function targetLabel(schedule: Schedule): string {
  const { target } = schedule;
  switch (target.kind) {
    case 'routine':
      return `routine ${target.routineId}${target.version === undefined ? '' : ` v${target.version}`}`;
    case 'suite':
      return `suite "${target.suite.name}"`;
    case 'vault':
      return target.tags ? `regression vault (${target.tags.join(', ')})` : 'regression vault';
    case 'evolutionSnapshot':
      return `evolution snapshot ${target.targetProfile}`;
    case 'summary':
      return `summary (${target.periodDays} day(s)${target.targets ? `, ${target.targets.join(', ')}` : ''})`;
  }
}

/** Cleans every string of the message, renders it for the preset, checks the payload once more, and posts it. Records the delivery. */
async function send(stored: StoredWebhook, message: Message, kind: Delivery['kind'], subject: string | undefined, deps: NotifyDeps): Promise<Delivery> {
  const { webhook } = stored;
  const now = (deps.now ?? Date.now)();
  const record = async (delivery: Omit<Delivery, 'at' | 'kind' | 'subject'>): Promise<Delivery> => {
    const full: Delivery = { at: new Date(now).toISOString(), kind, ...(subject ? { subject } : {}), ...delivery };
    await updateWebhookState(webhook.id, (state) => void state.deliveries.push(full));
    return full;
  };

  const url = await resolveWebhookUrl(webhook.id);
  if (!url) return record({ status: 'failed', reason: 'no URL is stored for this webhook' });

  const vaultValues = await listAllCredentialValues();
  const clean = (text: string): string => scrubText(text, vaultValues).text;
  const scrubbed: Message = {
    ...message,
    title: clean(message.title),
    text: clean(message.text),
    fields: message.fields.map((field) => ({ name: clean(field.name), value: scrubText(field.value, vaultValues, 1200).text })),
    ...(message.subject ? { subject: clean(message.subject) } : {}),
  };

  const payload = renderPayload(webhook.preset, scrubbed);
  const leak = findLeak(payload, vaultValues);
  if (leak) return record({ status: 'blocked', reason: `the message still contained ${leak} after cleaning; nothing was sent` });

  const outcome = await deliverJson(url, payload, deps.deliver);
  return record({ status: outcome.status, ...(outcome.httpStatus === undefined ? {} : { httpStatus: outcome.httpStatus }), attempts: outcome.attempts, ...(outcome.reason ? { reason: outcome.reason } : {}) });
}

// ---- a scheduled run ended ----------------------------------------------------------------------------------------------------------------

export async function notifySettled(event: SettledEvent, deps: NotifyDeps = {}): Promise<Delivery[]> {
  const verdict = verdictOf(event.outcome);
  // T9.3: a summary schedule's message IS the summary (sent by the schedule itself); "the summary is broken" is not news for a channel.
  if (!verdict || event.schedule.notify.length === 0 || event.schedule.target.kind === 'summary') return [];

  const subject = `${SUBJECT_PREFIX}${event.schedule.id}`;
  const sent: Delivery[] = [];

  for (const webhookId of new Set(event.schedule.notify)) {
    try {
      const stored = await getWebhook(webhookId);
      if (!stored || !stored.webhook.enabled) continue;
      const delivery = await tellOne(stored, subject, verdict, event, deps);
      if (delivery) sent.push(delivery);
    } catch {
      // A broken webhook must not stop the next one, nor the scheduler. Its own log says what happened when it got that far.
    }
  }
  return sent;
}

async function tellOne(stored: StoredWebhook, subject: string, verdict: Verdict, event: SettledEvent, deps: NotifyDeps): Promise<Delivery | undefined> {
  const { webhook } = stored;
  const state = await getWebhookState(webhook.id);
  const known = state.subjects[subject];
  const change = decideChange(known?.verdict, verdict);

  const remember = (): Promise<unknown> =>
    updateWebhookState(webhook.id, (current) => {
      const previous = current.subjects[subject];
      // `since` is when the CURRENT verdict began as far as this channel is concerned: a failure that turns into another kind of failure keeps it.
      current.subjects[subject] = { verdict, outcome: event.outcome, since: previous?.verdict === verdict ? previous.since : event.finishedAt };
    });

  if (!change || !webhook.events.includes(change.kind)) {
    await remember();
    return undefined;
  }

  const facts = event.facts;
  const message = changeMessage({
    kind: change.kind,
    first: change.first,
    lang: webhook.lang,
    scheduleId: event.schedule.id,
    targetLabel: targetLabel(event.schedule),
    outcome: event.outcome,
    ...(event.message ? { detail: event.message } : {}),
    at: event.finishedAt,
    ...(known && change.kind === 'recovered' ? { badSince: known.since } : {}),
    ...(facts?.buildId ? { buildId: facts.buildId } : {}),
    ...(facts?.runId ? { runId: facts.runId } : event.run ? { runId: event.run.id } : {}),
    ...(facts?.failures ? { failures: facts.failures } : {}),
    ...(facts?.counts ? { counts: facts.counts } : {}),
  });

  const delivery = await send(stored, message, change.kind, subject, deps);
  // Only a message that arrived changes what the channel knows; otherwise the next run tries again.
  if (delivery.status === 'sent') await remember();
  return delivery;
}

// ---- daily summary --------------------------------------------------------------------------------------------------------------------------

/** The latest summary time at or before `nowMs` within the last day, in the webhook's time zone. Pure but for the clock argument. */
export function dueSummaryInstant(webhook: Webhook, nowMs: number): number | undefined {
  if (!webhook.dailySummary) return undefined;
  const [hh, mm] = webhook.dailySummary.at.split(':').map(Number);
  const spec = parseCron(`${mm} ${hh} * * *`);
  const { instants } = occurrencesBetween(spec, nowMs - DAY_MS - 3_600_000, nowMs, webhook.dailySummary.timezone);
  return instants[instants.length - 1];
}

/** The verdict a schedule has NOW and since when, from its own history (newest last). */
export function currentStreak(history: ScheduleHistoryEntry[]): { verdict?: Verdict; since?: string } {
  let verdict: Verdict | undefined;
  let since: string | undefined;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i]!;
    const entryVerdict = verdictOf(entry.outcome);
    if (!entryVerdict) continue;
    if (verdict === undefined) verdict = entryVerdict;
    if (entryVerdict !== verdict) break;
    since = entry.finishedAt ?? entry.at;
  }
  return { ...(verdict ? { verdict } : {}), ...(since ? { since } : {}) };
}

export async function summaryRows(webhookId: string, nowMs: number): Promise<SummaryRow[]> {
  const rows: SummaryRow[] = [];
  for (const { schedule } of await listSchedules()) {
    if (!schedule.notify.includes(webhookId)) continue;
    const history = (await getState(schedule.id))?.history ?? [];
    const last24h: Record<string, number> = {};
    for (const entry of history) {
      if (entry.outcome === 'started' || Date.parse(entry.at) < nowMs - DAY_MS) continue;
      last24h[entry.outcome] = (last24h[entry.outcome] ?? 0) + (entry.count ?? 1);
    }
    rows.push({ scheduleId: schedule.id, ...currentStreak(history), last24h });
  }
  return rows;
}

const localDate = (ms: number, timeZone: string): string => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

/** Sends the daily summary of every webhook whose time has come since its last one. At most one per webhook per day; a failure is retried after 10 minutes. */
export async function sendDueSummaries(deps: NotifyDeps = {}): Promise<Delivery[]> {
  const nowMs = (deps.now ?? Date.now)();
  const sent: Delivery[] = [];

  for (const stored of await listWebhooks()) {
    const { webhook } = stored;
    if (!webhook.enabled || !webhook.dailySummary) continue;
    try {
      const due = dueSummaryInstant(webhook, nowMs);
      if (due === undefined) continue;
      const state = await getWebhookState(webhook.id);
      if (state.lastSummaryAt && Date.parse(state.lastSummaryAt) >= due) continue;
      if (state.lastSummaryAttemptAt && Date.parse(state.lastSummaryAttemptAt) > due && nowMs - Date.parse(state.lastSummaryAttemptAt) < SUMMARY_RETRY_MS) continue;

      const message = summaryMessage(webhook.lang, localDate(due, webhook.dailySummary.timezone), new Date(due).toISOString(), await summaryRows(webhook.id, nowMs));
      const delivery = await send(stored, message, 'summary', undefined, deps);
      sent.push(delivery);
      await updateWebhookState(webhook.id, (current) => {
        if (delivery.status === 'sent') {
          current.lastSummaryAt = new Date(due).toISOString();
          delete current.lastSummaryAttemptAt;
        } else {
          current.lastSummaryAttemptAt = new Date(nowMs).toISOString();
        }
      });
    } catch {
      // See notifySettled.
    }
  }
  return sent;
}

// ---- periodic summary (T9.3) -----------------------------------------------------------------------------------------------------------------

/**
 * Sends a `summary` schedule's report to every enabled webhook it names, each in the webhook's own language (`build(lang)` makes the message).
 * Goes through the same cleaning, leak check and egress policy as every other message. Disabled or deleted webhooks are skipped, not failed.
 */
export async function sendSummaryReport(schedule: Schedule, build: (lang: Webhook['lang']) => Message, deps: NotifyDeps = {}): Promise<Array<{ webhookId: string; delivery: Delivery }>> {
  const out: Array<{ webhookId: string; delivery: Delivery }> = [];
  for (const webhookId of new Set(schedule.notify)) {
    try {
      const stored = await getWebhook(webhookId);
      if (!stored || !stored.webhook.enabled) continue;
      out.push({ webhookId, delivery: await send(stored, build(stored.webhook.lang), 'summary', `summary:${schedule.id}`, deps) });
    } catch (error) {
      out.push({ webhookId, delivery: { at: new Date((deps.now ?? Date.now)()).toISOString(), kind: 'summary', status: 'failed', reason: error instanceof Error ? error.name : 'error' } });
    }
  }
  return out;
}

// ---- test message ---------------------------------------------------------------------------------------------------------------------------

/** Sends a harmless message to see that the URL, the origin allowlist and the preset work. Allowed even when the webhook is disabled. */
export async function sendTest(webhookId: string, deps: NotifyDeps = {}): Promise<Delivery | undefined> {
  const stored = await getWebhook(webhookId);
  if (!stored) return undefined;
  const at = new Date((deps.now ?? Date.now)()).toISOString();
  return send(stored, testMessage(stored.webhook.lang, stored.webhook.preset, at), 'test', undefined, deps);
}
