import { z } from 'zod';

import { runSummarySchema } from '../history/runSummary.js';
import { snapshotRunStateSchema } from './evolution.schema.js';
import { matrixRunStateSchema } from './permissionMatrix.schema.js';
import { scheduleHistoryEntrySchema, scheduleSchema } from './schedule.schema.js';
import { shrinkStateSchema } from './shrink.schema.js';
import { suiteStateSchema } from './suiteRequest.schema.js';

/**
 * T1.7 contract of `scrapforai ... --json`. The NPDev ledger guards (T2.4) and CI scripts parse this,
 * so it is versioned: `cliSchema` changes only on a BREAKING change, and fields are only ever added.
 *
 * Exactly one JSON object per invocation, on stdout. Exit codes: 0 green, 1 a test failed (red),
 * 2 anything else (API unreachable or refusing, bad arguments, a run that could not execute).
 */
export { CLI_SCHEMA_VERSION } from '../cli/version.js';
import { CLI_SCHEMA_VERSION } from '../cli/version.js';

const exitCode = z.union([z.literal(0), z.literal(1), z.literal(2)]);
const header = { cliSchema: z.literal(CLI_SCHEMA_VERSION) };

export const cliRunResultSchema = z
  .object({
    jobId: z.string(),
    status: z.enum(['passed', 'failed']),
    durationMs: z.number(),
    routine: z.object({ id: z.string(), version: z.number(), sha256: z.string() }).optional(),
    steps: z.object({ total: z.number(), passed: z.number(), failed: z.number() }),
    failedStepIndex: z.number().optional(),
    error: z.object({ type: z.string(), message: z.string() }).optional(),
    teardownStatus: z.enum(['passed', 'failed']).optional(),
    screenshots: z.number(),
  })
  .strict();

export const cliRoutinesResultSchema = z
  .object({
    routines: z.array(
      z.object({ id: z.string(), version: z.number(), title: z.string(), status: z.string(), tags: z.array(z.string()), targetProfile: z.string(), sha256: z.string() }).passthrough(),
    ),
  })
  .strict();

export const cliRunsShowResultSchema = z
  .object({ summary: runSummarySchema, evidenceAvailable: z.boolean(), detail: z.unknown().optional() })
  .strict();

export const cliPinResultSchema = z
  .object({
    jobId: z.string(),
    alreadyPinned: z.boolean(),
    pinnedAt: z.string(),
    ref: z.string().optional(),
    files: z.number(),
    bytes: z.number(),
    traceDiscarded: z.boolean(),
    integrityBaseline: z.enum(['run', 'pin']),
    manifestSha256: z.string().length(64),
  })
  .strict();

/** `vault list` / `vault show` / `vault export`: items are passed through as the API returns them (schema: regressionItem.schema.ts). */
export const cliVaultListSchema = z.object({ items: z.array(z.object({ id: z.string() }).passthrough()) }).strict();
export const cliVaultShowSchema = z.object({ id: z.string() }).passthrough();
export const cliVaultExportSchema = z.object({ exportedAt: z.string(), count: z.number(), items: z.array(z.object({ id: z.string() }).passthrough()) }).strict();
/** `vault run <id>` / `vault confirm-green <id>`: the item after the run and the run's outcome. */
export const cliVaultRunSchema = z
  .object({
    confirmed: z.boolean().optional(),
    item: z.object({ id: z.string() }).passthrough(),
    result: z.object({ jobId: z.string(), status: z.enum(['passed', 'failed']), durationMs: z.number() }).passthrough(),
  })
  .strict();

/** `evidence verify`: ok=false (exit 1) means the evidence does not check out; the reasons say why. */
export const cliEvidenceVerifySchema = z
  .object({
    ok: z.boolean(),
    jobId: z.string(),
    source: z.enum(['folder', 'server']),
    manifestSha256: z.string(),
    files: z.object({ ok: z.boolean(), checked: z.number(), problems: z.array(z.object({ path: z.string(), problem: z.string() })) }).strict(),
    signature: z.object({ status: z.string() }).passthrough(),
    keySource: z.string().optional(),
    keyTrusted: z.boolean().optional(),
    chain: z.object({ sequence: z.number(), previousManifestSha256: z.string().nullable() }).nullable(),
    reasons: z.array(z.string()),
  })
  .strict();
export const cliEvidenceExportSchema = z.object({ jobId: z.string(), path: z.string(), bytes: z.number(), keyId: z.string().optional() }).strict();
export const cliEvidenceChainSchema = z
  .object({ ok: z.boolean(), keyId: z.string(), deep: z.boolean(), entries: z.number(), signed: z.number(), unsigned: z.array(z.string()), highestSequence: z.number(), problems: z.array(z.object({ kind: z.string(), detail: z.string() }).passthrough()) })
  .strict();

/** `report`: the file written. */
export const cliReportSchema = z.object({ id: z.string(), format: z.enum(['html', 'pdf']), lang: z.enum(['en', 'pt', 'es']), path: z.string(), bytes: z.number() }).strict();

/** `suite --no-wait`: the suite was accepted and is running; nothing to judge yet. */
export const cliSuiteStartedSchema = z.object({ suiteRunId: z.string(), status: z.string(), total: z.number() }).strict();

/** `permissions run --no-wait`: accepted and running (T6.1). */
export const cliMatrixStartedSchema = z.object({ runId: z.string(), matrixId: z.string(), status: z.string(), cells: z.number(), sessions: z.number() }).strict();

export const cliSnapshotStartedSchema = z
  .object({ snapshotId: z.string(), targetProfile: z.string(), status: z.string(), screens: z.number(), sessions: z.number() })
  .strict();

/** `schedules list|show`: a schedule with its next occurrences and what happened lately. */
const cliScheduleViewSchema = z
  .object({
    schedule: scheduleSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    next: z.array(z.string()),
    running: z.object({ kind: z.string(), id: z.string(), startedAt: z.string() }).strict().optional(),
    lastRun: scheduleHistoryEntrySchema.optional(),
    counts: z.record(z.string(), z.number()),
    history: z.array(scheduleHistoryEntrySchema).optional(),
    schedulerRunning: z.boolean().optional(),
  })
  .strict();
export const cliSchedulesListSchema = z.object({ schedulerRunning: z.boolean(), schedules: z.array(cliScheduleViewSchema) }).strict();

/** `shrink --no-wait`. */
export const cliShrinkStartedSchema = z.object({ shrinkId: z.string() }).strict();

/** `evolution list`: the snapshots stored for a target, oldest first. */
export const cliEvolutionListSchema = z
  .object({
    targetProfile: z.string(),
    snapshots: z.array(
      z.object({ folder: z.string(), name: z.string(), buildId: z.string(), createdAt: z.string(), complete: z.boolean(), screens: z.number(), notCaptured: z.number() }).strict(),
    ),
  })
  .strict();

/** `evolution diff` / `timeline` / `expected`: passed through as the API returns them (schemas: evolution/compare.ts, evolutionService.ts, expectedChanges.schema.ts). */
export const cliEvolutionDiffSchema = z
  .object({
    targetProfile: z.string(),
    from: z.object({ buildId: z.string(), createdAt: z.string(), complete: z.boolean() }).passthrough(),
    to: z.object({ buildId: z.string(), createdAt: z.string(), complete: z.boolean() }).passthrough(),
    screens: z.array(z.object({ id: z.string(), name: z.string(), status: z.string() }).passthrough()),
    counts: z.object({ changes: z.number(), expected: z.number(), unexpected: z.number() }).passthrough(),
    classified: z.boolean(),
    markdown: z.string(),
  })
  .passthrough();
export const cliEvolutionTimelineSchema = z
  .object({ targetProfile: z.string(), snapshots: z.number(), builds: z.array(z.unknown()), events: z.array(z.unknown()), truncated: z.boolean() })
  .passthrough();
export const cliEvolutionExpectedSchema = z.object({ buildId: z.string(), expected: z.array(z.unknown()) }).passthrough();

const success = <C extends string, R extends z.ZodTypeAny>(command: C, result: R) =>
  z.object({ ...header, command: z.literal(command), exitCode, result }).strict();

/** The invocation could not do its job at all: no `result`, only why. Always exit 2. */
export const cliErrorOutputSchema = z
  .object({
    ...header,
    command: z.string(),
    exitCode: z.literal(2),
    error: z.object({ type: z.string(), message: z.string() }).strict(),
  })
  .strict();

export const cliOutputSchema = z.union([
  success('run', cliRunResultSchema),
  success('suite', z.union([suiteStateSchema, cliSuiteStartedSchema])),
  success('routines list', cliRoutinesResultSchema),
  success('runs show', cliRunsShowResultSchema),
  success('pin', cliPinResultSchema),
  success('report', cliReportSchema),
  success('evidence verify', cliEvidenceVerifySchema),
  success('evidence export', cliEvidenceExportSchema),
  success('evidence chain', cliEvidenceChainSchema),
  success('vault list', cliVaultListSchema),
  success('vault show', cliVaultShowSchema),
  success('vault export', cliVaultExportSchema),
  success('vault run', cliVaultRunSchema),
  success('vault confirm-green', cliVaultRunSchema),
  success('permissions run', z.union([matrixRunStateSchema, cliMatrixStartedSchema])),
  success('permissions show', matrixRunStateSchema),
  success('evolution snapshot', z.union([snapshotRunStateSchema, cliSnapshotStartedSchema])),
  success('schedules list', cliSchedulesListSchema),
  success('schedules show', cliScheduleViewSchema),
  success('schedules run-now', scheduleHistoryEntrySchema),
  success('shrink', z.union([shrinkStateSchema, cliShrinkStartedSchema])),
  success('evolution list', cliEvolutionListSchema),
  success('evolution diff', cliEvolutionDiffSchema),
  success('evolution timeline', cliEvolutionTimelineSchema),
  success('evolution expected', cliEvolutionExpectedSchema),
  cliErrorOutputSchema,
]);

export type CliOutput = z.infer<typeof cliOutputSchema>;
