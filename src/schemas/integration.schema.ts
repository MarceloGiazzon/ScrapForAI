import { z } from 'zod';

import { safeName } from './explorationRequest.schema.js';

/**
 * T9.1: an integration is a place a bug report can be sent to (today: GitHub Issues). Like a webhook it is something this server sends data OUT to, so:
 *   - the API token is a secret: it lives in the credential vault as the set `integration-<id>` (field `token`, bound to the API origin) and no read path returns it;
 *   - the API origin must be in ALLOWED_INTEGRATION_ORIGINS, at save and again at every send;
 *   - what it does on its own is `onScheduledFailure`, and the default is `draft`: a report is prepared and a person approves the sending.
 */

export const integrationKindSchema = z.enum(['github']);
export const reportLangSchema = z.enum(['en', 'pt', 'es']);

/** The id is part of the vault set id (`integration-<id>`, max 80). */
export const integrationIdSchema = safeName.refine((value) => value.length <= 60, { message: 'integration id is at most 60 characters' });

/** owner/name as GitHub spells them. No path tricks: this goes into a request URL. */
export const githubRepoSchema = z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/, 'repo must be "owner/name"').refine((value) => !value.split('/').some((part) => part === '.' || part === '..'), {
  message: 'repo must be "owner/name"',
});

/** A label is configuration, never taken from a page. Commas and control characters are left out so it stays one label. */
const labelSchema = z.string().min(1).max(50).regex(/^[^,\u0000-\u001F\u007F]+$/, 'a label has no commas or control characters');

export const integrationSchema = z
  .object({
    id: integrationIdSchema,
    kind: integrationKindSchema.default('github'),
    enabled: z.boolean().default(true),
    repo: githubRepoSchema,
    /** `https://api.github.com`, or a GitHub Enterprise Server `https://host/api/v3`. Its ORIGIN must be in ALLOWED_INTEGRATION_ORIGINS. */
    apiBaseUrl: z.string().url().max(300).default('https://api.github.com'),
    labels: z.array(labelSchema).max(10).default(['scrapforai']),
    /** Target profiles whose failures go here. Empty = any. */
    targetProfiles: z.array(safeName).max(50).default([]),
    /**
     * What a scheduled run that FAILED does by itself. `ignore`: nothing. `draft` (default): a report is prepared, a person approves it.
     * `send`: the report is also sent, with no one in the loop (opt-in; the same scrub, leak check and origin check apply).
     */
    onScheduledFailure: z.enum(['ignore', 'draft', 'send']).default('draft'),
    lang: reportLangSchema.default('en'),
    notes: z.string().max(500).optional(),
  })
  .strict();

/** PUT /v1/integrations/:id. `token` is write-only; omitted on an update it keeps the stored one (required to create). */
export const integrationWriteSchema = integrationSchema
  .omit({ id: true })
  .extend({ token: z.string().min(8).max(500).optional() })
  .strict();

export type Integration = z.infer<typeof integrationSchema>;
export type IntegrationWrite = z.infer<typeof integrationWriteSchema>;
export type ReportLang = z.infer<typeof reportLangSchema>;
