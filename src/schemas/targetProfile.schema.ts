import { z } from 'zod';

import { safeName } from './explorationRequest.schema.js';

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
    // Screen catalogue (T4.2). The element shape is defined by that task.
    screens: z.array(z.record(z.string(), z.unknown())).max(500).default([]),
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
