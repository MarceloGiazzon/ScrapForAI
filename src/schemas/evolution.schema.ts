import { z } from 'zod';

import { ACCESSIBILITY_STANDARDS } from './accessibility.schema.js';
import { buildIdSchema, safeName } from './explorationRequest.schema.js';

/** T4.4: system-evolution snapshots (one folder per target and build). */

export const SNAPSHOT_ID_PATTERN = /^evo_[A-Za-z0-9_-]{1,40}$/;

export const snapshotBodySchema = z
  .object({
    targetProfile: safeName,
    // Without it the build comes from the profile's buildInfo probe (T3.1); "unknown" is never idempotent.
    buildId: buildIdSchema.optional(),
    // Only these catalogue screens (default: all of them).
    screens: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,52}$/)).min(1).max(500).optional(),
    // false for environments with real data: no screenshot is taken, only the value-free inventory.
    screenshots: z.boolean().default(true),
    // The same build already has a snapshot: refused (409) unless force replaces it.
    force: z.boolean().default(false),
    // Some screens could not be captured: refused unless allowPartial writes the rest and says what is missing.
    allowPartial: z.boolean().default(false),
    // Wait after opening a screen before reading it (client-rendered apps).
    settleMs: z.number().int().min(0).max(30_000).default(500),
    // T7.5: also audit every screen with axe-core and keep the result as that build's accessibility baseline (screens/<id>.a11y.json).
    accessibility: z.boolean().default(false),
    accessibilityStandard: z.enum(ACCESSIBILITY_STANDARDS).default('wcag2aa'),
  })
  .strict();
export type SnapshotBody = z.infer<typeof snapshotBodySchema>;

export const snapshotScreenStateSchema = z
  .object({
    screenId: z.string(),
    name: z.string(),
    status: z.enum(['pending', 'captured', 'error']),
    jobId: z.string().optional(),
    errorType: z.string().optional(),
    errorMessage: z.string().optional(),
    counts: z.object({ fields: z.number(), actions: z.number(), grids: z.number(), unkeyed: z.number() }).optional(),
    screenshot: z.boolean().optional(),
    // T7.5: violations found by the audit (absent when the snapshot did not audit, or this screen's audit is missing).
    accessibility: z.object({ rules: z.number(), elements: z.number() }).optional(),
  })
  .strict();

export const snapshotRunStateSchema = z
  .object({
    snapshotId: z.string().regex(SNAPSHOT_ID_PATTERN),
    targetProfile: z.string(),
    buildId: z.string().optional(),
    buildIdSource: z.enum(['provided', 'probe', 'unknown']).optional(),
    status: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted']),
    createdAt: z.string(),
    finishedAt: z.string().optional(),
    sessions: z.number().int(),
    screens: z.array(snapshotScreenStateSchema),
    // Folder written, relative to SYSTEM_EVOLUTION_DIR (`<target>/<date>_<build>`).
    folder: z.string().optional(),
    git: z.object({ repository: z.boolean(), committed: z.boolean(), commit: z.string().optional(), note: z.string().optional() }).strict().optional(),
    warnings: z.array(z.string()).default([]),
    // failed/interrupted: why nothing (or not everything) was written.
    reason: z.string().optional(),
    // 0 written and complete, 2 anything else (this is not a test verdict).
    exitCode: z.union([z.literal(0), z.literal(2)]).optional(),
  })
  .strict();
export type SnapshotRunState = z.infer<typeof snapshotRunStateSchema>;

/** `snapshot.json` inside each snapshot folder: what was captured, when, on which build, with a digest per file. */
export const snapshotManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    targetProfile: z.string(),
    environment: z.string(),
    buildId: z.string(),
    buildIdSource: z.enum(['provided', 'probe', 'unknown']),
    createdAt: z.string(),
    screenshots: z.boolean(),
    complete: z.boolean(),
    // T7.5: present when the snapshot audited accessibility; a screen whose audit is missing simply has no `accessibility` entry (the run state says why).
    accessibility: z.object({ standard: z.enum(ACCESSIBILITY_STANDARDS), axeVersion: z.string() }).strict().optional(),
    screens: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          inventory: z.string(),
          inventorySha256: z.string(),
          screenshot: z.string().optional(),
          screenshotSha256: z.string().optional(),
          accessibility: z.string().optional(),
          accessibilitySha256: z.string().optional(),
          jobId: z.string(),
        })
        .strict(),
    ),
    notCaptured: z.array(z.object({ id: z.string(), reason: z.string() }).strict()),
  })
  .strict();
export type SnapshotManifest = z.infer<typeof snapshotManifestSchema>;
