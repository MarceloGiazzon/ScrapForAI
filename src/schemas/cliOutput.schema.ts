import { z } from 'zod';

import { runSummarySchema } from '../history/runSummary.js';
import { attemptSchema, bugReportSchema } from './bugReport.schema.js';
import { snapshotRunStateSchema } from './evolution.schema.js';
import { integrationSchema } from './integration.schema.js';
import { matrixRunStateSchema } from './permissionMatrix.schema.js';
import { scheduleHistoryEntrySchema, scheduleSchema } from './schedule.schema.js';
import { shrinkStateSchema } from './shrink.schema.js';
import { suiteStateSchema } from './suiteRequest.schema.js';
import { deliverySchema, webhookSchema } from './webhook.schema.js';

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

const cliLintFindingSchema = z.object({ rule: z.string(), severity: z.enum(['error', 'warning']), path: z.string(), message: z.string() }).passthrough();
export const cliRoutinesLintSchema = z
  .object({ findings: z.array(cliLintFindingSchema), suppressed: z.array(cliLintFindingSchema.extend({ reason: z.string() })) })
  .strict();

export const cliRoutinesResultSchema = z
  .object({
    routines: z.array(
      z.object({ id: z.string(), version: z.number(), title: z.string(), status: z.string(), tags: z.array(z.string()), targetProfile: z.string(), sha256: z.string() }).passthrough(),
    ),
  })
  .strict();

/** T5.5: tables of cases (`tables list|show|save`). The CSV is in `show`/`save` as the stored table; `--out` writes it to a file. */
const cliTableSchema = z.object({ id: z.string(), version: z.number(), columns: z.array(z.string()), rowCount: z.number(), sha256: z.string(), csv: z.string() }).passthrough();
export const cliTablesListSchema = z
  .object({ tables: z.array(z.object({ id: z.string(), version: z.number(), columns: z.array(z.string()), rowCount: z.number(), sha256: z.string() }).passthrough()) })
  .strict();
export const cliTablesShowSchema = z.object({ table: cliTableSchema, versions: z.array(z.number()), file: z.string().optional() }).strict();
export const cliTablesSaveSchema = z.object({ table: cliTableSchema, created: z.boolean() }).strict();

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

/** `webhooks list|show|test` (T3.3). Never a URL: only its origin. */
const cliWebhookViewSchema = z
  .object({
    webhook: webhookSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    hasUrl: z.boolean(),
    urlOrigin: z.string().optional(),
    originAllowed: z.boolean(),
    schedules: z.array(z.string()),
    lastDelivery: deliverySchema.optional(),
    known: z.record(z.string(), z.object({ verdict: z.string(), since: z.string() }).strict()).optional(),
    deliveries: z.array(deliverySchema).optional(),
  })
  .strict();
export const cliWebhooksListSchema = z.object({ webhooks: z.array(cliWebhookViewSchema) }).strict();

/** `integrations list|show|test` (T9.1). Never a token: only whether there is one. */
const cliIntegrationViewSchema = z
  .object({ integration: integrationSchema, createdAt: z.string(), updatedAt: z.string(), hasToken: z.boolean(), apiOrigin: z.string(), originAllowed: z.boolean() })
  .strict();
export const cliIntegrationsListSchema = z.object({ integrations: z.array(cliIntegrationViewSchema) }).strict();
export const cliIntegrationViewResultSchema = cliIntegrationViewSchema;
export const cliIntegrationTestSchema = z.object({ ok: z.boolean(), reason: z.string().optional(), httpStatus: z.number().optional(), issuesEnabled: z.boolean().optional() }).strict();

/** `bug-report create|list|show|send|dismiss|resolve` (T9.1). A list row is the report without its body, attempts and occurrences. */
export const cliBugReportCreateSchema = z.object({ report: bugReportSchema, created: z.boolean(), refreshed: z.boolean() }).strict();
export const cliBugReportListSchema = z.object({ bugReports: z.array(z.object({ id: z.string(), status: z.string(), title: z.string(), occurrenceCount: z.number() }).passthrough()) }).strict();
export const cliBugReportSendSchema = z.object({ status: z.enum(['sent', 'failed', 'blocked']), attempt: attemptSchema, report: bugReportSchema }).strict();

/** `perf list|alerts|show` (T3.4): passed through as the API returns them (shapes: metrics/perfAnalysis.ts, perfService.ts). */
export const cliPerfListSchema = z.object({ routines: z.array(z.object({ routineId: z.string(), runs: z.number(), greenRuns: z.number(), alerts: z.array(z.unknown()) }).passthrough()) }).strict();
export const cliPerfAlertsSchema = z.object({ count: z.number(), alerts: z.array(z.object({ routineId: z.string(), series: z.string(), baselineMs: z.number(), recentMs: z.number() }).passthrough()) }).strict();
export const cliPerfShowSchema = z
  .object({ routineId: z.string(), runs: z.number(), greenRuns: z.number(), steps: z.array(z.object({ id: z.string(), alert: z.boolean() }).passthrough()), alerts: z.array(z.string()) })
  .passthrough();

/** `flaky list|show` (T3.5): passed through as the API returns them (shapes: metrics/flakyAnalysis.ts, flakyService.ts). */
export const cliFlakyListSchema = z
  .object({ count: z.number(), suggestions: z.number(), routines: z.array(z.object({ routineId: z.string(), runs: z.number(), transitions: z.number(), flaky: z.boolean() }).passthrough()) })
  .passthrough();
export const cliFlakyShowSchema = z.object({ routineId: z.string(), runs: z.number(), transitions: z.number(), flaky: z.boolean(), results: z.array(z.unknown()) }).passthrough();

/** `health` (T3.7): passed through as the API returns it (shape: health/healthAnalysis.ts, HealthReport). */
export const cliHealthSchema = z
  .object({
    generatedAt: z.string(),
    schedulerRunning: z.boolean(),
    totals: z.object({ targets: z.number(), red: z.number(), yellow: z.number(), green: z.number(), empty: z.number() }).passthrough(),
    targets: z.array(z.object({ id: z.string(), status: z.enum(['red', 'yellow', 'green', 'empty']), reasons: z.array(z.string()) }).passthrough()),
  })
  .passthrough();

/** `summary` (T9.3): passed through as the API returns it (shape: summary/summaryAnalysis.ts, SummaryReport, plus `markdown`). */
export const cliSummarySchema = z
  .object({
    kind: z.literal('scrapforai-summary'),
    period: z.object({ from: z.string(), to: z.string(), days: z.number() }).passthrough(),
    counts: z.record(z.string(), z.number()),
    markdown: z.string(),
  })
  .passthrough();

/** `differential --no-wait`. */
export const cliDifferentialStartedSchema = z.object({ differentialId: z.string() }).strict();

/** `differential` (T6.3): the state of a differential run, passed through as the API returns it (shape: differential/differentialService.ts). */
export const cliDifferentialStateSchema = z
  .object({
    differentialId: z.string(),
    status: z.enum(['running', 'completed', 'cancelled', 'interrupted']),
    labels: z.object({ left: z.string(), right: z.string() }).strict(),
    counts: z.object({ total: z.number(), same: z.number(), different: z.number(), infraError: z.number(), notRun: z.number() }).strict(),
    pairs: z.array(z.object({ routineId: z.string(), version: z.number(), state: z.string() }).passthrough()),
    verdict: z.enum(['same', 'different', 'infra-error']).optional(),
    exitCode: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  })
  .passthrough();

/** `differential --from-jobs`: two runs that already happened, compared. */
export const cliDifferentialCompareSchema = z
    .object({ left: z.object({ jobId: z.string() }).passthrough(), right: z.object({ jobId: z.string() }).passthrough(), verdict: z.enum(['same', 'different']), comparison: z.object({ equivalent: z.boolean() }).passthrough(), notes: z.array(z.string()) })
  .passthrough();

/** `shrink --no-wait`. */
export const cliShrinkStartedSchema = z.object({ shrinkId: z.string() }).strict();

/** `manual build --no-wait`. */
export const cliManualStartedSchema = z.object({ buildRunId: z.string(), targetProfile: z.string(), status: z.string(), routines: z.number(), skipped: z.array(z.unknown()) }).strict();

/** `manual build` (the finished state, see manual/manualService.ts ManualBuildState) and `manual show` (manual.json plus its folder): passed through as the API returns them. */
export const cliManualBuildStateSchema = z
  .object({ buildRunId: z.string(), targetProfile: z.string(), status: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted']), routines: z.array(z.unknown()), skipped: z.array(z.unknown()) })
  .passthrough();
export const cliManualShowSchema = z
  .object({ targetProfile: z.string(), buildId: z.string(), createdAt: z.string(), folder: z.string(), figures: z.array(z.unknown()), changes: z.object({ firstBuild: z.boolean() }).passthrough() })
  .passthrough();

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

/** `users ...`, `audit` (T10.1) and `pack ...` (T10.2). A key appears only in the answer of the command that makes it. */
const cliTeamResultSchema = z.object({}).passthrough();

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
  success('routines lint', cliRoutinesLintSchema),
  success('tables list', cliTablesListSchema),
  success('tables show', cliTablesShowSchema),
  success('tables save', cliTablesSaveSchema),
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
  success('webhooks list', cliWebhooksListSchema),
  success('webhooks show', cliWebhookViewSchema),
  success('webhooks test', deliverySchema),
  success('integrations list', cliIntegrationsListSchema),
  success('integrations show', cliIntegrationViewResultSchema),
  success('integrations test', cliIntegrationTestSchema),
  success('bug-report create', cliBugReportCreateSchema),
  success('bug-report list', cliBugReportListSchema),
  success('bug-report show', bugReportSchema),
  success('bug-report send', cliBugReportSendSchema),
  success('bug-report dismiss', bugReportSchema),
  success('bug-report resolve', bugReportSchema),
  success('perf list', cliPerfListSchema),
  success('perf alerts', cliPerfAlertsSchema),
  success('perf show', cliPerfShowSchema),
  success('flaky list', cliFlakyListSchema),
  success('flaky show', cliFlakyShowSchema),
  success('health', cliHealthSchema),
  success('summary', cliSummarySchema),
  success('shrink', z.union([shrinkStateSchema, cliShrinkStartedSchema])),
  success('differential', z.union([cliDifferentialStateSchema, cliDifferentialCompareSchema, cliDifferentialStartedSchema])),
  success('manual build', z.union([cliManualBuildStateSchema, cliManualStartedSchema])),
  success('manual show', cliManualShowSchema),
  success('evolution list', cliEvolutionListSchema),
  success('evolution diff', cliEvolutionDiffSchema),
  success('evolution timeline', cliEvolutionTimelineSchema),
  success('evolution expected', cliEvolutionExpectedSchema),
  success('pack apply', cliTeamResultSchema),
  success('pack build', cliTeamResultSchema),
  success('users list', cliTeamResultSchema),
  success('users create', cliTeamResultSchema),
  success('users set', cliTeamResultSchema),
  success('users delete', cliTeamResultSchema),
  success('users key-create', cliTeamResultSchema),
  success('users key-revoke', cliTeamResultSchema),
  success('audit', cliTeamResultSchema),
  success('audit verify', cliTeamResultSchema),
  cliErrorOutputSchema,
]);

export type CliOutput = z.infer<typeof cliOutputSchema>;
