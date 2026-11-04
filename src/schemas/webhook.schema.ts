import { z } from 'zod';

import { safeName } from './explorationRequest.schema.js';

/**
 * T3.3: a webhook is a channel a schedule can tell about a CHANGE (green -> red, red -> green) and, optionally, a once-a-day summary.
 * The URL is a secret (a Slack/Teams/Chat webhook URL lets anyone post as the channel): it is stored in the credential vault as the set
 * `webhook-<id>`, field `url`, bound to its origin, and no read path ever returns it. Only its origin is shown.
 */

export const webhookPresetSchema = z.enum(['generic', 'slack', 'teams', 'googlechat']);
export const webhookEventSchema = z.enum(['broken', 'recovered']);
export const notifyLangSchema = z.enum(['en', 'pt', 'es']);

/** The id is part of the vault set id (`webhook-<id>`, max 80). */
export const webhookIdSchema = safeName.refine((value) => value.length <= 64, { message: 'webhook id is at most 64 characters' });

export const dailySummarySchema = z
  .object({
    /** Local wall-clock time, 24 h. */
    at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'at must be HH:MM (24 h)'),
    timezone: z.string().min(1).max(80).default('America/Montevideo'),
  })
  .strict();

export const webhookSchema = z
  .object({
    id: webhookIdSchema,
    preset: webhookPresetSchema.default('generic'),
    lang: notifyLangSchema.default('en'),
    enabled: z.boolean().default(true),
    /** Which changes are sent. A webhook that wants only "broken" lists just that. */
    events: z.array(webhookEventSchema).min(1).max(2).default(['broken', 'recovered']),
    dailySummary: dailySummarySchema.optional(),
    notes: z.string().max(500).optional(),
  })
  .strict();

/** PUT /v1/webhooks/:id. `url` is write-only; omitted on an update it keeps the stored one (required to create). */
export const webhookWriteSchema = webhookSchema
  .omit({ id: true })
  .extend({ url: z.string().url().max(2048).optional() })
  .strict();

export type Webhook = z.infer<typeof webhookSchema>;
export type WebhookWrite = z.infer<typeof webhookWriteSchema>;
export type WebhookPreset = z.infer<typeof webhookPresetSchema>;
export type NotifyLang = z.infer<typeof notifyLangSchema>;

/** Why a message was (not) sent. Never carries the URL or the response body. */
export const deliveryStatusSchema = z.enum(['sent', 'failed', 'blocked']);

export const deliverySchema = z
  .object({
    at: z.string(),
    kind: z.enum(['broken', 'recovered', 'summary', 'test']),
    subject: z.string().optional(),
    status: deliveryStatusSchema,
    httpStatus: z.number().int().optional(),
    attempts: z.number().int().optional(),
    reason: z.string().optional(),
  })
  .strict();

/** What a channel has been told: the last verdict it knows per subject (`schedule:<id>`), the last summary, and the recent deliveries. */
export const webhookStateSchema = z
  .object({
    webhookId: z.string(),
    subjects: z.record(z.string(), z.object({ verdict: z.enum(['ok', 'bad']), outcome: z.string(), since: z.string() }).strict()),
    lastSummaryAt: z.string().optional(),
    lastSummaryAttemptAt: z.string().optional(),
    deliveries: z.array(deliverySchema),
  })
  .strict();

export type Delivery = z.infer<typeof deliverySchema>;
export type WebhookState = z.infer<typeof webhookStateSchema>;
