import { z } from 'zod';

import { diffConfigSchema } from './diffConfig.schema.js';
import { safeName } from './explorationRequest.schema.js';
import { HTTP_METHODS } from './httpMethods.js';
import { piiPolicySchema } from './piiPolicy.schema.js';

/**
 * One entry of the screen catalogue (T4.2, minimal shape, enough for T6.2 direct-URL probing).
 *  - `reach.url`: absolute http(s) URL or a path starting with "/" (resolved against baseUrl). T6.2 opens it directly.
 *  - `reach.routineId`: a screen only reachable by a routine; it is kept in the catalogue but T6.2 cannot probe it.
 *  - `offeredTo`: the roles (credential sets) whose MENU shows this screen. When present, a role not listed that
 *    nevertheless gets the page by URL is an access-control alert. Absent = the catalogue makes no claim about the menu.
 */
export const screenSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,52}$/, 'screen id: [a-zA-Z0-9_-]{1,52}'),
    name: z.string().min(1).max(160),
    reach: z.union([
      z
        .object({
          url: z
            .string()
            .min(1)
            .max(2048)
            .refine((value) => value.startsWith('/') || /^https?:\/\//i.test(value), { message: 'url must be absolute (http/https) or start with "/"' }),
        })
        .strict(),
      z.object({ routineId: safeName, version: z.number().int().positive().optional() }).strict(),
    ]),
    credentialSet: safeName.optional(),
    offeredTo: z.array(safeName).max(50).optional(),
  })
  .strict();
export type Screen = z.infer<typeof screenSchema>;

/**
 * T1.1 target profile: "which app, in which environment, under which rules".
 *
 * A profile NEVER widens the allowlist: baseUrl must already be in ALLOWED_TARGET_ORIGINS or the
 * save is refused (see targetStore). Fields consumed by later tasks (loginRoutine T8.1, buildInfo
 * T3.1, surfaces T2.3, screens T4.2) are accepted now so profiles written today stay valid.
 */
export const targetProfileSchema = z
  .object({
    id: safeName,
    name: z.string().min(1).max(160),
    platform: z.enum(['generic', 'genexus', 'npdev']).default('generic'),
    environment: z.enum(['dev', 'qa', 'staging']),
    baseUrl: z.string().url().max(2048),
    // Vault credential sets (T1.2) a run against this profile may use.
    credentialSets: z.array(safeName).max(50).default([]),
    loginRoutine: safeName.optional(),
    // T8.1: the "login gate" (genexus conventions, 1): where the app must be once the login is done. With platform `genexus`, a run that uses a
    // credential set gets `loginRoutine` included automatically, followed by a wait for this URL fragment, so a login that did not complete fails
    // HERE and not as a confusing timeout later.
    loginGate: z
      .object({
        urlContains: z.string().min(1).max(500),
        timeoutMs: z.number().int().min(1000).max(60_000).default(15_000),
      })
      .strict()
      .optional(),
    buildInfo: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('httpHeader'), header: z.string().min(1).max(200) }).strict(),
        z.object({ kind: z.literal('selectorText'), url: z.string().max(2048), selector: z.string().min(1).max(500) }).strict(),
        z.object({ kind: z.literal('jsonEndpoint'), url: z.string().max(2048), jsonPath: z.string().min(1).max(500) }).strict(),
        z.object({ kind: z.literal('provided') }).strict(),
      ])
      .optional(),
    noiseFilters: z
      .array(z.object({ networkFailureTextContains: z.string().min(1).max(500), reason: z.string().min(1).max(500) }).strict())
      .max(100)
      .default([]),
    // surface name -> file globs (T2.3)
    surfaces: z.record(z.string().min(1).max(120), z.array(z.string().min(1).max(500)).max(200)).default({}),
    // Screen catalogue (T4.2).
    screens: z.array(screenSchema).max(500).default([]),
    // What counts as noise when two renders of this app are compared (T4.1).
    diff: diffConfigSchema.optional(),
    // What counts as expected when the PII hunt (T7.8) finds something in this application, and how serious each kind is here (T7.9).
    pii: piiPolicySchema.optional(),
    // T5.7: what an `httpRequest` step may do against this application. Absent = GET and HEAD only; POST/PUT/PATCH/DELETE change data, so the profile lists them.
    http: z.object({ allowedMethods: z.array(z.enum(HTTP_METHODS)).min(1).max(HTTP_METHODS.length) }).strict().optional(),
    flags: z
      .object({
        allowDestructive: z.boolean().default(false),
        allowFaults: z.boolean().default(false),
        maxSessionsPerCredential: z.number().int().min(1).max(10).default(1),
      })
      .strict()
      .default({ allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 }),
  })
  .strict();

export type TargetProfile = z.infer<typeof targetProfileSchema>;
