import { RequestResolutionError } from '../runner/resolutionError.js';
import { listSchedules } from '../scheduler/scheduleStore.js';
import { assertTimeZone, CronError } from '../scheduler/cron.js';
import { type Delivery, type Webhook, webhookWriteSchema } from '../schemas/webhook.schema.js';
import { getLiveAllowedOrigins } from '../config/env.js';
import { assertNotifyUrl, NotifyOriginError } from './notifyPolicy.js';
import { sendTest } from './notifier.js';
import { deleteWebhook, getWebhook, getWebhookState, listWebhooks, putWebhook, saveWebhookUrl, type StoredWebhook, webhookUrlOrigin } from './webhookStore.js';

export class WebhookError extends RequestResolutionError {}

/** What a read returns. NEVER the URL: only its origin, which is not secret (it is in ALLOWED_NOTIFY_ORIGINS). */
export interface WebhookView {
  webhook: Webhook;
  createdAt: string;
  updatedAt: string;
  hasUrl: boolean;
  urlOrigin?: string;
  /** The stored URL's origin is (still) in ALLOWED_NOTIFY_ORIGINS. When false, nothing is delivered. */
  originAllowed: boolean;
  /** Schedules that notify this webhook. */
  schedules: string[];
  lastDelivery?: Delivery;
}

async function view(stored: StoredWebhook): Promise<WebhookView> {
  const { webhook } = stored;
  const origin = await webhookUrlOrigin(webhook.id);
  const state = await getWebhookState(webhook.id);
  const schedules = (await listSchedules()).filter((item) => item.schedule.notify.includes(webhook.id)).map((item) => item.schedule.id);
  return {
    webhook,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    hasUrl: origin !== undefined,
    ...(origin ? { urlOrigin: origin } : {}),
    originAllowed: origin !== undefined && getLiveAllowedOrigins('ALLOWED_NOTIFY_ORIGINS').includes(origin),
    schedules,
    ...(state.deliveries.length > 0 ? { lastDelivery: state.deliveries[state.deliveries.length - 1]! } : {}),
  };
}

export async function listWebhookViews(): Promise<WebhookView[]> {
  return Promise.all((await listWebhooks()).map(view));
}

export async function getWebhookView(id: string): Promise<(WebhookView & { known: Record<string, { verdict: string; since: string }>; deliveries: Delivery[] }) | undefined> {
  const stored = await getWebhook(id);
  if (!stored) return undefined;
  const state = await getWebhookState(id);
  return {
    ...(await view(stored)),
    known: Object.fromEntries(Object.entries(state.subjects).map(([subject, value]) => [subject, { verdict: value.verdict, since: value.since }])),
    deliveries: [...state.deliveries].reverse(),
  };
}

/** Validates, stores the URL in the credential vault and the rest as the definition. A URL outside ALLOWED_NOTIFY_ORIGINS is refused here, not at 03:00. */
export async function saveWebhookDefinition(id: string, body: unknown, nowMs = Date.now()): Promise<{ view: WebhookView; created: boolean }> {
  const { url, ...rest } = webhookWriteSchema.parse(body);
  const webhook: Webhook = { id, ...rest };

  try {
    if (webhook.dailySummary) assertTimeZone(webhook.dailySummary.timezone);
  } catch (error) {
    if (error instanceof CronError) throw new WebhookError(400, 'InvalidWebhook', error.message);
    throw error;
  }

  if (url !== undefined) {
    try {
      assertNotifyUrl(url);
    } catch (error) {
      if (error instanceof NotifyOriginError) throw new WebhookError(400, error.name, error.message);
      throw error;
    }
  } else if ((await webhookUrlOrigin(id)) === undefined) {
    throw new WebhookError(400, 'WebhookUrlRequired', 'url is required when creating a webhook');
  }

  if (url !== undefined) await saveWebhookUrl(id, url);
  const { stored, created } = await putWebhook(webhook, new Date(nowMs).toISOString());
  return { view: await view(stored), created };
}

export async function removeWebhook(id: string): Promise<boolean> {
  const stored = await getWebhook(id);
  if (!stored) return false;
  const users = (await listSchedules()).filter((item) => item.schedule.notify.includes(id)).map((item) => item.schedule.id);
  if (users.length > 0) throw new WebhookError(409, 'WebhookInUse', `Schedule(s) ${users.join(', ')} notify this webhook; remove it from their "notify" first`);
  return deleteWebhook(id);
}

/** POST /v1/webhooks/:id/test. The delivery is recorded in the webhook's log like any other. */
export async function testWebhook(id: string): Promise<Delivery | undefined> {
  return sendTest(id);
}

/** For the schedule save: every id in `notify` must be a stored webhook. */
export async function assertWebhooksExist(ids: string[]): Promise<void> {
  for (const id of new Set(ids)) {
    if (!(await getWebhook(id))) throw new WebhookError(404, 'WebhookNotFound', `Webhook "${id}" does not exist (PUT /v1/webhooks/${id} first)`);
  }
}
