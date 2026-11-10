import { z } from 'zod';

import { USER_ID_MESSAGE, USER_ID_PATTERN } from '../team/roles.js';
import { safeName } from './explorationRequest.schema.js';

const userId = z.string().regex(USER_ID_PATTERN, USER_ID_MESSAGE);

const httpOrigin = z
  .string()
  .url()
  .max(2048)
  .refine((value) => /^https?:\/\//i.test(value), { message: 'boundOrigins must be http(s) URLs' })
  .transform((value) => new URL(value).origin);

/**
 * Write-side body for POST/PUT /v1/credentials/:id. `values` is write-only: no read path
 * (API, MCP, log, result, history) ever returns it.
 *
 * `values` is optional so PUT can update tags/origins without resending secrets; the vault
 * rejects a create (no existing set) that has no values.
 */
export const credentialSetWriteSchema = z
  .object({
    boundOrigins: z
      .array(httpOrigin)
      .min(1)
      .max(20)
      .transform((origins) => [...new Set(origins)]),
    values: z.record(safeName, z.string().min(1).max(5000)).optional(),
    tags: z.array(z.string().min(1).max(80)).max(50).default([]),
    notes: z.string().max(500).optional(),
    /**
     * Who may USE the set in a run (a user id of the team). Omitted: the stored list is kept (a PUT that only fixes an origin must never
     * open a restricted set); `null`: the restriction is removed (anyone who can run may use it, as before); a list: exactly those users,
     * and admins always. An EMPTY list restricts the set to admins. Not a secret: it is metadata, shown to admins.
     */
    allowedUsers: z
      .array(userId)
      .max(200)
      .transform((users) => [...new Set(users)])
      .nullable()
      .optional(),
  })
  .strict()
  .refine((body) => body.values === undefined || Object.keys(body.values).length > 0, {
    path: ['values'],
    message: 'values must contain at least one field',
  });

/** What reads return: metadata only, field NAMES but never values. */
export const credentialSetMetaSchema = z
  .object({
    id: safeName,
    boundOrigins: z.array(z.string().url()).min(1),
    fields: z.array(safeName).min(1),
    tags: z.array(z.string()),
    notes: z.string().optional(),
    /** True when a list of allowed users is set (admins always may use the set). Everyone sees this. */
    restricted: z.boolean(),
    /** The list itself: only an admin's read carries it (the route removes it for anyone else). */
    allowedUsers: z.array(z.string()).optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    lastUsedAt: z.string().optional(),
  })
  .strict();

export type CredentialSetWrite = z.infer<typeof credentialSetWriteSchema>;
export type CredentialSetMeta = z.infer<typeof credentialSetMetaSchema>;
