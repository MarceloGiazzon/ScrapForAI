import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { bugReportRequestSchema } from '../schemas/bugReport.schema.js';
import { buildCatalogPrompt, type CatalogPromptProfile } from './catalogPrompt.js';
import { domInspectionRequestSchema } from '../schemas/domInspectionRequest.schema.js';
import { mcpExplorationRequestSchema, safeName } from '../schemas/explorationRequest.schema.js';
import { mcpSaveRoutineSchema, routineRunBodySchema } from '../schemas/libraryRoutine.schema.js';
import { addFromRunSchema, confirmGreenSchema, ITEM_ID_PATTERN, itemStatusSchema, itemTypeSchema } from '../schemas/regressionItem.schema.js';
import { matrixRunBodySchema, permissionMatrixObjectSchema } from '../schemas/permissionMatrix.schema.js';
import { differentialCompareRequestSchema, differentialRequestSchema } from '../schemas/differential.schema.js';
import { shrinkRequestSchema } from '../schemas/shrink.schema.js';
import { suiteRequestSchema } from '../schemas/suiteRequest.schema.js';
import { getJson, inspectDom, postJson, putJson, runExploration, ScrapForAiRequestError } from './client.js';

const server = new McpServer(
  { name: 'scrapforai', version: '1.0.0' },
  {
    instructions:
      'Tools for driving and inspecting allowlisted web pages through the ScrapForAI Playwright runner. ' +
      'Call inspect_dom first to discover forms/controls/selectors on a page, then use those selectors to ' +
      'author a run_exploration routine. Target URLs must be on the ScrapForAI server allowlist or every ' +
      'call will fail with TargetUrlNotAllowed. ' +
      'Secrets: never write a password or token into a routine. Call list_credential_sets to see the ' +
      'server-side credential sets (names, bound origins and field names only, never values), pass the ' +
      'chosen id as "credentialSet", and reference its fields from steps with valueFromCredential. ' +
      'Recommended flow: list_targets -> inspect_dom -> run_exploration -> save_routine (fromJobId) -> later run_routine / run_suite. ' +
      'Bugs you reproduce and fix become permanent proof: vault_add_from_run (RED pinned) -> fix -> vault_confirm_green (GREEN pinned); ' +
      'vault_run re-checks them, most-likely-to-break first. ' +
      'Call list_targets to see named target profiles and pass one as "targetProfile". ' +
      'Once a routine works, keep it: save_routine with fromJobId (or steps) stores it as an immutable ' +
      'version in the routine library; list_routines / get_routine / run_routine reuse it without re-authoring. ' +
      'Put login in its own routine and "include" it; put cleanup in "teardown" so it runs even when a step fails. ' +
      'To test a calculation with known answers, keep the cases in a table (save_case_table, list_case_tables): parameters fromTable and assertEquals expected.table read one row per sample. ' +
      'For "which role can do what", use a permission matrix: save_permission_matrix -> run_permission_matrix -> get_permission_matrix_result. ' +
      'To describe a target\'s screens, use the prompt propose_screen_catalog: you propose a catalogue, a person approves and saves it. ' +
      'Schedules and webhooks (list_schedules, list_webhooks) are read-only here; get_performance shows which step got slower and in which build: a person creates them, because they run browsers and send data out unattended. ' +
      'A failed run can become a draft issue with draft_bug_report (cleaned of secrets and personal data; one report per failure, the same failure again is counted); ' +
      'you cannot send it: a person approves it, because that is what leaves the server. ' +
      'To see how a system evolved between builds, use evolution_diff (two builds) and evolution_query (when did X appear); snapshots themselves are taken by a person or CI.',
  },
);

function toToolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function toErrorResult(error: unknown) {
  const text =
    error instanceof ScrapForAiRequestError
      ? `${error.type}: ${error.message}`
      : error instanceof Error
        ? error.message
        : 'Unknown error calling ScrapForAI';

  return { isError: true, content: [{ type: 'text' as const, text }] };
}

server.registerTool(
  'inspect_dom',
  {
    title: 'Inspect DOM',
    description:
      'Navigate to an allowlisted URL and return its forms, controls, selectors, labels, and (optionally) ' +
      'console/network evidence, without performing any actions. Use this to discover what is on a page ' +
      'before writing a run_exploration routine.',
    inputSchema: domInspectionRequestSchema,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => {
    try {
      return toToolResult(await inspectDom(args));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'run_exploration',
  {
    title: 'Run exploration routine',
    description:
      'Execute a multi-step browser automation routine (goto, click, fill, assert*, extractText, evaluate, ' +
      'watch, etc.) against an allowlisted target URL and return structured step results, extracted data, ' +
      'and evidence (screenshots, console, network, optional trace). Credentials come from the server-side ' +
      'vault via "credentialSet"; inline "credentials" are not accepted on this tool.',
    inputSchema: mcpExplorationRequestSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async (args) => {
    try {
      return toToolResult(await runExploration(args));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'list_credential_sets',
  {
    title: 'List credential sets',
    description:
      'List the server-side credential sets available to run_exploration via "credentialSet". Returns ids, ' +
      'bound origins, field names (for valueFromCredential), tags and notes. Secret values are never returned.',
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    try {
      return toToolResult(await getJson('/v1/credentials'));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'list_targets',
  {
    title: 'List target profiles',
    description:
      'List named target profiles (app, environment, base URL, allowed credential sets) usable as "targetProfile" ' +
      'in run_exploration. With a profile, targetUrl becomes optional.',
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    try {
      return toToolResult(await getJson('/v1/targets'));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'run_suite',
  {
    title: 'Run a suite of saved routines',
    description:
      'Start several saved routines at once, optionally multiplied by credentialSets (e.g. one per role) and ' +
      'targetProfiles (e.g. dev and qa). Returns IMMEDIATELY with a suiteRunId; the suite runs in the background. ' +
      'Then call get_suite_result with that id (use waitSeconds to wait). A credential set is never used by two ' +
      'runs at the same time. By default only routines with status "active" run; the others are listed as not run. ' +
      'failFast stops starting new runs at the first red one.',
    inputSchema: suiteRequestSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async (args) => {
    try {
      return toToolResult(await postJson('/v1/suites', args));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'get_suite_result',
  {
    title: 'Get a suite result',
    description:
      'State of a suite started with run_suite: per-variant status (pending/running/passed/failed/error/notRun, with jobId ' +
      'for the evidence) and, once finished, one verdict: green (exitCode 0), red (1: some run failed) or infra-error (2: some ' +
      'run could not execute, or nothing ran, or it was cancelled). waitSeconds (max 55) blocks until the suite ends, so you ' +
      'do not need to poll in a loop; call again if status is still "running".',
    inputSchema: z.object({ id: z.string().regex(/^suite_[A-Za-z0-9_-]{1,40}$/), waitSeconds: z.number().int().min(0).max(55).optional() }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ id, waitSeconds }) => {
    try {
      return toToolResult(await getJson(`/v1/suites/${encodeURIComponent(id)}${waitSeconds ? `?wait=${waitSeconds}` : ''}`));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'list_schedules',
  {
    title: 'List schedules',
    description:
      'The schedules stored on the server (cron + time zone + target: a routine, a suite, the regression vault or a system-evolution snapshot), ' +
      'each with its next occurrences, the run in progress, the last run and a count of outcomes (passed/failed/error/skipped-overlap/missed). ' +
      'schedulerRunning=false means the server was started without SCHEDULER_ENABLED, so nothing fires on its own. Read-only: schedules are ' +
      'created and changed by a person (PUT /v1/schedules/:id), because they start browsers unattended.',
    inputSchema: z.object({ id: safeName.optional() }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ id }) => {
    try {
      return toToolResult(await getJson(id ? `/v1/schedules/${encodeURIComponent(id)}` : '/v1/schedules'));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'list_webhooks',
  {
    title: 'List webhooks',
    description:
      'The notification channels stored on the server (Slack, Teams, Google Chat or generic JSON): preset, language, which changes they hear about ' +
      '(broken / recovered), an optional daily summary, the schedules that notify them and the last deliveries. A channel hears about a CHANGE of a ' +
      'schedule (green to red, red to green), never about every run. The URL is a secret kept in the server\'s credential vault and is never shown: ' +
      'only its origin is. Read-only: creating a webhook, changing it or sending a test is a person\'s decision (PUT /v1/webhooks/:id, ' +
      'POST /v1/webhooks/:id/test), because it sends data out of the server.',
    inputSchema: z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional() }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ id }) => {
    try {
      return toToolResult(await getJson(id ? `/v1/webhooks/${encodeURIComponent(id)}` : '/v1/webhooks'));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'draft_bug_report',
  {
    title: 'Draft a bug report from a failed run',
    description:
      'Turns a FAILED run (fromJobId, while its evidence exists: pin it if you need it later) into a DRAFT issue: title, where it happened (application, ' +
      'environment, build, page), the step and error, the steps, console and network failures, the smallest failing input when you pass the shrinkId of a ' +
      'finished shrink_failure of the same failure, the last passing run and the first failing one after it (and whether the build changed), and a command that ' +
      'repeats it. Everything that came from the page is cleaned first: vault values, secret shapes and personal data are masked, and it is placed in code ' +
      'blocks so it cannot mention anyone or link anything; the screenshot is never attached (an image cannot be checked for personal data). ONE report per ' +
      'failure signature (same routine, same step, same error type): the same failure again adds an occurrence to the report that exists, and the answer ' +
      'says created: false. This tool sends NOTHING and cannot: a person reads the draft and approves it (scrapforai bug-report send), because that is the ' +
      'one step that leaves the server. Use list_bug_reports to read it back.',
    inputSchema: bugReportRequestSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async (args) => {
    try {
      return toToolResult(await postJson('/v1/bug-reports', args));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'list_bug_reports',
  {
    title: 'List or read bug reports',
    description:
      'The bug report drafts on the server, newest first: status (draft = waiting for a person, sent = an issue exists, dismissed, resolved), the failure ' +
      'signature, how many times it happened and the issue number once it was sent. With id you get one in full, including the title and body exactly as ' +
      'they would be sent. Read-only: sending, dismissing and resolving are a person\'s decisions.',
    inputSchema: z.object({ id: z.string().regex(/^bug_[A-Za-z0-9_-]{1,40}$/).optional(), status: z.enum(['draft', 'sent', 'dismissed', 'resolved']).optional() }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ id, status }) => {
    try {
      return toToolResult(await getJson(id ? `/v1/bug-reports/${encodeURIComponent(id)}` : `/v1/bug-reports${status ? `?status=${status}` : ''}`));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'list_integrations',
  {
    title: 'List issue-tracker integrations',
    description:
      'Where bug reports can be sent (today: GitHub Issues): repository, labels, the target profiles each one serves and what it does on its own when a ' +
      'SCHEDULED run fails (ignore, draft = prepare a report for a person to approve [default], or send). The token is a secret in the server\'s credential ' +
      'vault and is never shown: only whether there is one. Read-only: creating an integration or testing it is a person\'s decision ' +
      '(PUT /v1/integrations/:id), because it sends data out of the server.',
    inputSchema: z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/).optional() }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ id }) => {
    try {
      return toToolResult(await getJson(id ? `/v1/integrations/${encodeURIComponent(id)}` : '/v1/integrations'));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'get_health',
  {
    title: 'Get health by target',
    description:
      'The state of every target profile in one read, to answer "where do things stand?" before choosing what to run. Per target: status (red = something that counts failed in its last ' +
      'run, a failing vault item or a schedule that failed; yellow = nothing failed but something needs a person: flaky, slower than its baseline, a quarantine suggestion, a schedule that ' +
      'cannot fire; green; empty = nothing has run yet) with the reasons; each library routine with its last run, streak, trend (older vs newer half of the last runs), flaky score and ' +
      'slower series; the regression vault (active passing/failing/not run; quarantined items are reported apart); and its schedules (state, last outcome, next occurrence). A quarantined ' +
      'routine never turns a target red. Schedules that start a suite or the whole vault are listed under `unscoped`. `schedulerRunning=false` means schedules are stored but nothing fires. ' +
      'It reads what other tools already record: it starts no run and changes no status. Pass `target` for one profile.',
    inputSchema: z.object({ target: safeName.optional() }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ target }) => {
    try {
      return toToolResult(await getJson(`/v1/health${target ? `?target=${encodeURIComponent(target)}` : ''}`));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'get_summary',
  {
    title: 'Get the periodic summary',
    description:
      'The summary a `summary` schedule sends (weekly by default), on demand: per target the health status and reasons (the state now); regressions of the period from the run ' +
      'series of library routines (broke = the last run failed after a pass, with the build where it broke and the last good build and the failing step; fixed; still failing; ' +
      'failed now and then), flaky routines and quarantine suggestions, steps slower than their baseline, new/fixed accessibility findings and screens changed between the ' +
      'evolution snapshots taken in the period (counts only; use evolution_diff for the details). Quarantined routines are listed but not counted. Ids, statuses, builds and counts ' +
      'only, never extracted values. `markdown` holds the same report as text in `lang`. Read-only: it starts no run.',
    inputSchema: z
      .object({ days: z.number().int().min(1).max(31).optional(), targets: z.array(safeName).min(1).max(50).optional(), lang: z.enum(['en', 'pt', 'es']).optional() })
      .strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ days, targets, lang }) => {
    try {
      const query = new URLSearchParams();
      if (days !== undefined) query.set('days', String(days));
      if (targets) query.set('target', targets.join(','));
      if (lang) query.set('lang', lang);
      const text = query.toString();
      return toToolResult(await getJson(`/v1/summary${text ? `?${text}` : ''}`));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'get_flakiness',
  {
    title: 'Get flakiness',
    description:
      'How often a library routine changes between pass and fail when nothing else changed. Score = pass<->fail changes between consecutive runs of the same routine version, ' +
      'profile and origin (a pair across a new build is NOT counted: that is a regression or a fix, not flakiness) / comparable pairs, over the last 20 runs; runs that drew generated ' +
      'values are left out. Without routineId: every routine with a series, the ones with a suggestion first. With routineId: the pass/fail strip (oldest first), the counts, how many ' +
      'times a failure was followed by a pass on the automatic new attempt of a scheduled run, and the suggestion. A suggestion is `quarantine` (a score at or above the threshold ' +
      'with at least 10 runs) or `release` (a quarantined routine whose last 10 runs all passed). It is only a suggestion: moving a routine to or from `quarantined` is a new ' +
      'version saved with save_routine by a person. A quarantined routine still runs in suites, but its result does not count towards the verdict. Read-only.',
    inputSchema: z.object({ routineId: safeName.optional(), version: z.number().int().positive().optional(), profile: z.enum(['full', 'functional']).optional() }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ routineId, version, profile }) => {
    try {
      if (!routineId) return toToolResult(await getJson('/v1/metrics/flaky'));
      const query = new URLSearchParams({ ...(version === undefined ? {} : { version: String(version) }), ...(profile ? { profile } : {}) });
      return toToolResult(await getJson(`/v1/metrics/flaky/${encodeURIComponent(routineId)}${query.size > 0 ? `?${query.toString()}` : ''}`));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'get_performance',
  {
    title: 'Get performance',
    description:
      'How long a library routine and each of its steps take over time. Without routineId: every routine with a series, its run-level baseline/recent times and its alerts. ' +
      'With routineId: the sparkline points per step (oldest first, with build ids), the baseline (median of the last 20 green runs before the last 3), the recent time ' +
      '(median of the last 3), the ratio, whether it is an ALERT (recent > baseline x 1.3 and at least 100 ms slower) and, for an alert, the new build seen in the slow runs ' +
      '(the usual suspect). Only green runs and passed steps count; a new routine version, the functional profile and another environment are separate populations ' +
      '(version/profile narrow the choice). Read-only.',
    inputSchema: z
      .object({ routineId: safeName.optional(), version: z.number().int().positive().optional(), profile: z.enum(['full', 'functional']).optional(), limit: z.number().int().min(1).max(500).optional() })
      .strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ routineId, version, profile, limit }) => {
    try {
      if (!routineId) return toToolResult(await getJson('/v1/metrics/routines'));
      const query = new URLSearchParams({ ...(version === undefined ? {} : { version: String(version) }), ...(profile ? { profile } : {}), ...(limit === undefined ? {} : { limit: String(limit) }) });
      return toToolResult(await getJson(`/v1/metrics/routines/${encodeURIComponent(routineId)}${query.size > 0 ? `?${query.toString()}` : ''}`));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'shrink_failure',
  {
    title: 'Shrink a failing sample to the smallest input',
    description:
      'A routine with parameters failed for some generated value (e.g. a suite row with qty=2500000). This replays it with smaller and smaller ' +
      'inputs and finds the smallest one that still fails THE SAME WAY: numbers by binary search between a neutral value and the failing one ' +
      '(down to "fails with qty=1000, passes with qty=999"), text by halving and removing characters, several parameters by delta debugging ' +
      '(which ones matter at all). Name the failure with fromJobId (a failed run of a library routine that used parameters) OR routineId + seed + ' +
      'sample. Returns a shrinkId AT ONCE; follow with get_shrink_result (waitSeconds). Budget: maxShrinkRuns (default 30) and maxShrinkSeconds. ' +
      'The result has minimalJobId: a run that really failed with the minimal values. To keep it as permanent proof call vault_add_from_run with ' +
      'that jobId and type "SCENARIO" (the parameters are saved FIXED at the minimal values), while the evidence still exists.',
    inputSchema: shrinkRequestSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async (args) => {
    try {
      return toToolResult(await postJson('/v1/shrinks', args));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'get_shrink_result',
  {
    title: 'Get a shrink result',
    description:
      'State of a search started with shrink_failure: runs so far, the smallest failing values found so far (currentValues) and, when finished, ' +
      'outcome (minimal, independent = the parameters are not the cause, not-reproduced = the failure does not repeat, budget/timeout/cancelled = ' +
      'stopped early with the best input so far), a one-line summary, result.boundaries (the exact "fails with / passes with" pairs) and replay ' +
      '(routine + parameterValues to run it again with run_routine). waitSeconds (max 55) blocks until it ends.',
    inputSchema: z.object({ id: z.string().regex(/^shrink_[A-Za-z0-9_-]{1,40}$/), waitSeconds: z.number().int().min(0).max(55).optional() }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ id, waitSeconds }) => {
    try {
      return toToolResult(await getJson(`/v1/shrinks/${encodeURIComponent(id)}${waitSeconds ? `?wait=${waitSeconds}` : ''}`));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'run_differential',
  {
    title: 'Run routines against two targets and compare',
    description:
      'The same library routines against TWO target profiles (dev x staging, Java x .NET generator, GeneXus 17 x 18, a canary x production) and what differs. ' +
      'left is the baseline, right the candidate. Each side may name its own credentialSet (a set of the profile of THAT side) and buildId. Compared: the status of each step, ' +
      'extracted values (with tolerance, via tolerance.diff), console errors NEW on the right, the SHAPE of the network (method + path with ids masked + status; never the origin) ' +
      'and the time per step (information only, never a difference). The routine must open its target with goto "$targetUrl" so each side follows the baseUrl of its own profile ' +
      '(a fixed address is opened on both sides; the response warns). The version of each routine is pinned when it starts. Returns a differentialId AT ONCE; follow with ' +
      'get_differential_result (waitSeconds). Verdict: same, different (a routine behaves differently on the two sides) or infra-error (a side could not run).',
    inputSchema: differentialRequestSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async (args) => {
    try {
      return toToolResult(await postJson('/v1/differentials', args));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'get_differential_result',
  {
    title: 'Get a differential run',
    description:
      'State of a run started with run_differential: per routine the two run ids and, once both ended, the comparison (steps, extracted, console, network, timing) with a ' +
      'headline; and the verdict (same, different, infra-error) with a reason. waitSeconds (max 55) blocks until it ends. Evidence of each run stays under its run id (get_run) while it exists.',
    inputSchema: z.object({ id: z.string().regex(/^diff_[A-Za-z0-9_-]{1,40}$/), waitSeconds: z.number().int().min(0).max(55).optional() }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ id, waitSeconds }) => {
    try {
      return toToolResult(await getJson(`/v1/differentials/${encodeURIComponent(id)}${waitSeconds ? `?wait=${waitSeconds}` : ''}`));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'compare_runs',
  {
    title: 'Compare two runs that already happened',
    description:
      'Compares two past runs of the same routine whose evidence still exists, for example before and after a deploy: run it, deploy, run it again, compare the two job ids. ' +
      'leftJobId is the baseline. Same comparison as run_differential (steps, extracted values, new console errors, network shape, time). Nothing runs. ' +
      'It says so when the two runs are not of the same routine version.',
    inputSchema: differentialCompareRequestSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (args) => {
    try {
      return toToolResult(await postJson('/v1/differentials/compare', args));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'get_run',
  {
    title: 'Get a past run',
    description:
      'Look up a run by jobId (from run_exploration, run_routine or a suite result): summary (status, duration, failing step, ' +
      'routine and version, suite and variant, retention, pinned) and whether its evidence still exists. Set full=true for the ' +
      'complete result.json (steps, extracted data, console and network evidence), which can be large.',
    inputSchema: z.object({ jobId: z.string().regex(/^job_[A-Za-z0-9_-]{1,64}$/), full: z.boolean().optional() }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ jobId, full }) => {
    try {
      const response = (await getJson(`/v1/runs/${encodeURIComponent(jobId)}`)) as { summary: unknown; evidenceAvailable: boolean; evidenceRetentionHours: number; detail?: unknown };
      return toToolResult(full ? response : { summary: response.summary, evidenceAvailable: response.evidenceAvailable, evidenceRetentionHours: response.evidenceRetentionHours });
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

const itemId = z.string().regex(ITEM_ID_PATTERN);

server.registerTool(
  'vault_list',
  {
    title: 'List regression-vault items',
    description:
      'List fixed bugs and hard scenarios kept as permanent proof: id, title, type, severity, status, surface, the routine that proves ' +
      'each one, whether the RED (provenRed) and the first GREEN (firstGreen) were captured, and the last run. Filter by status, type, tags, surface.',
    inputSchema: z
      .object({ status: z.array(itemStatusSchema).optional(), type: z.array(itemTypeSchema).optional(), tags: z.array(z.string()).optional(), surface: z.string().optional() })
      .strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ status, type, tags, surface }) => {
    const query = new URLSearchParams();
    if (status) query.set('status', status.join(','));
    if (type) query.set('type', type.join(','));
    if (tags) query.set('tags', tags.join(','));
    if (surface) query.set('surface', surface);
    try {
      return toToolResult(await getJson(`/v1/vault${query.size ? `?${query}` : ''}`));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'vault_show',
  {
    title: 'Show a regression-vault item',
    description: 'One item with its RED and GREEN evidence references (pinned job ids and manifest hashes) and last run.',
    inputSchema: z.object({ id: itemId }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ id }) => {
    try {
      return toToolResult(await getJson(`/v1/vault/${id}`));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'vault_add_from_run',
  {
    title: 'Keep a reproduced bug as permanent proof',
    description:
      'You just reproduced a bug: run_exploration FAILED because the application misbehaves. Pass that run\'s jobId. The routine is saved to the ' +
      'library, the failing run is pinned as the RED proof (it will not expire), and an ACTIVE item is created. Refuses a run that passed. ' +
      'The routine stays red until the bug is fixed; then call vault_confirm_green.',
    inputSchema: addFromRunSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async (args) => {
    try {
      return toToolResult(await postJson('/v1/vault/add-from-run', args));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'vault_confirm_green',
  {
    title: 'Confirm a fix with the vault item',
    description:
      'Run the item\'s routine against the fixed build. If it passes, that run is pinned as firstGreen. If it still fails, the item is left unchanged ' +
      'and the failure is returned (error StillRed). Pass buildId so the proof says which build it proves.',
    inputSchema: confirmGreenSchema.extend({ id: itemId }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async ({ id, ...body }) => {
    try {
      return toToolResult(await postJson(`/v1/vault/${id}/confirm-green`, body));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'vault_run',
  {
    title: 'Run regression-vault items',
    description:
      'With id: run that item\'s routine once and record lastRun. Without id: start a suite over the vault (ACTIVE items by default). With ' +
      'changedFiles (e.g. git diff --name-only) or surfaces, the items most likely to break run first and each result says why. Suites return ' +
      'a suiteRunId at once; follow with get_suite_result.',
    inputSchema: z
      .object({
        id: itemId.optional(),
        buildId: confirmGreenSchema.shape.buildId,
        changedFiles: z.array(z.string().min(1).max(500)).max(5000).optional(),
        surfaces: z.array(z.string().min(1)).max(100).optional(),
        status: z.array(itemStatusSchema).optional(),
        tags: z.array(z.string()).optional(),
        failFast: z.boolean().optional(),
      })
      .strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async ({ id, buildId, changedFiles, surfaces, status, tags, failFast }) => {
    try {
      if (id) {
        return toToolResult(await postJson(`/v1/vault/${id}/run`, buildId ? { buildId } : {}));
      }
      const impact = changedFiles || surfaces;
      return toToolResult(
        await postJson('/v1/suites', {
          name: impact ? 'vault (by impact)' : 'vault',
          items: [{ vault: { ...(status ? { status } : {}), ...(tags ? { tags } : {}) } }],
          ...(impact ? { order: 'impact', impact: { ...(changedFiles ? { changedFiles } : {}), ...(surfaces ? { surfaces } : {}) } } : {}),
          ...(buildId ? { buildId } : {}),
          ...(failFast ? { failFast } : {}),
        }),
      );
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

const versionField = z.number().int().positive().optional();

function routinePath(id: string, version: number | undefined, suffix = ''): string {
  const query = version === undefined ? '' : `?version=${version}`;
  return `/v1/routines/${encodeURIComponent(id)}${suffix}${query}`;
}

server.registerTool(
  'list_routines',
  {
    title: 'List saved routines',
    description: 'List routines in the versioned routine library: id, current version, title, status, tags, surface, target profile.',
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    try {
      return toToolResult(await getJson('/v1/routines'));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'get_routine',
  {
    title: 'Get a saved routine',
    description: 'Fetch a saved routine (steps included) at its current version, or at a specific immutable version.',
    inputSchema: z.object({ id: safeName, version: versionField }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ id, version }) => {
    try {
      return toToolResult(await getJson(routinePath(id, version)));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'list_case_tables',
  {
    title: 'List tables of cases',
    description:
      'Tables of cases stored on the server (CSV, one row per case): id, current version, columns, number of cases. With an id, returns that table (its CSV included), ' +
      'at its current version or at a pinned one. A parameter takes a column ({ name, fromTable: { id, version?, column } }) and assertEquals takes the expected cell ' +
      '({ expected: { table: { id, version?, column } } }); the run\'s `sample` is the row, so the inputs and the expected result of a row always go together.',
    inputSchema: z.object({ id: safeName.optional(), version: versionField }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ id, version }) => {
    try {
      return toToolResult(await getJson(id ? `/v1/tables/${encodeURIComponent(id)}${version ? `?version=${version}` : ''}` : '/v1/tables'));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'save_case_table',
  {
    title: 'Save a table of cases',
    description:
      'Store a table of cases as the next immutable version (the same CSV again makes no new version). The first row names the columns (letters, digits, _ and -); each ' +
      'other row is one case; "," or ";" separate cells (a spreadsheet saved in pt/es uses ";" and a decimal comma: set the step locale to match). At most 500 cases and ' +
      '20 columns. A secret in a cell is refused (422), like in a routine. Pin `version` in the references of a routine you want to reproduce later.',
    inputSchema: z.object({ id: safeName, title: z.string().min(1).max(200).optional(), csv: z.string().min(1).max(200_000) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ id, ...content }) => {
    try {
      return toToolResult(await putJson(`/v1/tables/${encodeURIComponent(id)}`, content));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'list_permission_matrices',
  {
    title: 'List permission matrices',
    description:
      'Saved permission matrices (roles = credential sets, x probes: open a URL, the state of a control, or run a routine), with their ' +
      'expectations. Also lists the latest runs of each one.',
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    try {
      const [matrices, runs] = await Promise.all([getJson('/v1/permissions'), getJson('/v1/permissions/runs?limit=50')]);
      return toToolResult({ ...(matrices as object), ...(runs as object) });
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'save_permission_matrix',
  {
    title: 'Save a permission matrix',
    description:
      'Store (or replace) a permission matrix: which roles (credential sets of the target profile) may open which URLs directly, see or use which ' +
      'controls, and run which routines. deniedWhen says how this app shows a denial (redirect to the login, a "not authorized" text, an HTTP ' +
      'status). Probe URLs may be paths ("/admin") resolved against the profile. "expected" (role -> probe -> allowed/denied/visible/hidden/' +
      'enabled/disabled) turns the matrix into a test; without it, each run is compared with the previous one and any NEW access is an alert. ' +
      'Needs a login routine (loginRoutine) that fills its fields with valueFromCredential, the same field names in every role.',
    inputSchema: z.object({ id: safeName, matrix: permissionMatrixObjectSchema }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ id, matrix }) => {
    try {
      return toToolResult(await putJson(`/v1/permissions/${id}`, matrix));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'run_permission_matrix',
  {
    title: 'Run a permission matrix',
    description:
      'Run every role x probe of a saved matrix in a real browser (one login per role, never two sessions of one role at once). Returns ' +
      'IMMEDIATELY with a runId; then call get_permission_matrix_result. Pass buildId so the result says which build it describes.',
    inputSchema: matrixRunBodySchema.extend({ id: safeName }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async ({ id, ...body }) => {
    try {
      return toToolResult(await postJson(`/v1/permissions/${id}/run`, body));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'get_permission_matrix_result',
  {
    title: 'Get a permission matrix result',
    description:
      'The role x probe table of a matrix run: each cell allowed/denied/error (controls: hidden/enabled/disabled), which deniedWhen rule matched, ' +
      'the expectation and whether it was met, the jobId for the evidence, and "changes" against the previous run (gainedAccess with alert=true ' +
      'means a role reached something nobody said it should). Verdict: green (0), red (1: an expectation failed or an unexpected gain of access), ' +
      'infra-error (2: a cell could not be answered). waitSeconds (max 55) blocks until the run ends.',
    inputSchema: z.object({ runId: z.string().regex(/^perm_[A-Za-z0-9_-]{1,40}$/), waitSeconds: z.number().int().min(0).max(55).optional() }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ runId, waitSeconds }) => {
    try {
      return toToolResult(await getJson(`/v1/permissions/runs/${encodeURIComponent(runId)}${waitSeconds ? `?wait=${waitSeconds}` : ''}`));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'save_routine',
  {
    title: 'Save a routine',
    description:
      'Store a routine in the library as an immutable version. Pass fromJobId (a run that PASSED, while its evidence ' +
      'still exists) to save exactly what worked, or pass steps. Identical content does not create a new version. ' +
      'Literal secrets are refused: use valueFromCredential with a credential set. targetProfile is required. ' +
      'Compose routines: a step { action: "include", routineId, version? } expands another saved routine in place ' +
      '(ids become "<includeId>.<stepId>"; max 3 levels, no cycles; pin version to be reproducible), and "teardown" ' +
      'steps always run after the steps, pass or fail, like finally (typical use: logout, delete test data).',
    inputSchema: mcpSaveRoutineSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ id, ...body }) => {
    try {
      return toToolResult(await putJson(`/v1/routines/${encodeURIComponent(id)}`, body));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'run_routine',
  {
    title: 'Run a saved routine',
    description:
      'Execute a saved routine at its current version, or pin a version to reproduce an older run. Per-run inputs only: ' +
      'variables, credentialSet override, caller. Returns the same structured result as run_exploration, tagged with the routine id and version.',
    inputSchema: routineRunBodySchema.extend({ id: safeName, version: versionField }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async ({ id, version, ...body }) => {
    try {
      return toToolResult(await postJson(routinePath(id, version, '/run'), body));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

const evolutionRef = z.string().min(1).max(120).describe("A build id, 'latest' or 'previous'");

server.registerTool(
  'evolution_diff',
  {
    title: 'What changed between two builds',
    description:
      'Compare two system-evolution snapshots of a target profile (default: the latest build against the one before it) and return, per ' +
      'screen, what appeared, disappeared or changed, in plain deterministic words (also as markdown). When the newer build declared its ' +
      'expected changes, each change is marked expected or unexpected: an unexpected one is a finding ("touched one screen, broke another"). ' +
      'A screen that could not be captured in one snapshot is "unknown", never "removed". ' +
      'To explain it, read the result and write a short summary; pass it as "narrative" to store it in CHANGES.md next to the newer snapshot, ' +
      'where it is labelled an AI-generated summary and never mixed into the deterministic part. Without "narrative" nothing is written.',
    inputSchema: z
      .object({
        targetProfile: safeName,
        from: evolutionRef.optional(),
        to: evolutionRef.optional(),
        narrative: z.string().max(20000).optional().describe('Your own summary of the diff, stored as an unverified AI section of CHANGES.md'),
      })
      .strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ targetProfile, from, to, narrative }) => {
    try {
      const query = new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString();
      const base = `/v1/evolution/${encodeURIComponent(targetProfile)}`;
      const diff = (await getJson(`${base}/diff${query ? `?${query}` : ''}`)) as Record<string, unknown>;
      if (narrative === undefined) return toToolResult(diff);
      const written = await postJson(`${base}/changes`, { ...(from ? { from } : {}), ...(to ? { to } : {}), narrative });
      return toToolResult({ ...diff, changesFile: written });
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'evolution_query',
  {
    title: 'Query the history of a system',
    description:
      'Answer questions about how a system evolved across its snapshots: "when did the field X appear?" (key), "what changed in screen Y?" ' +
      '(screen), "what changed since last month?" (since). Returns the builds that have a snapshot, the changes between consecutive ' +
      'snapshots oldest first, and, with "key", where that control is now and in which build it was first seen (if that is the very first ' +
      'snapshot, earlier history is unknown). For "between builds A and B" use evolution_diff.',
    inputSchema: z
      .object({
        targetProfile: safeName,
        screen: z.string().regex(/^[a-zA-Z0-9_-]{1,52}$/).optional().describe('Catalogue screen id'),
        key: z.string().min(1).max(200).optional().describe('Control key: a field, action or grid key as it appears in the inventory'),
        since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD'),
        limit: z.number().int().min(1).max(500).optional(),
      })
      .strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ targetProfile, screen, key, since, limit }) => {
    try {
      const query = new URLSearchParams({
        ...(screen ? { screen } : {}),
        ...(key ? { key } : {}),
        ...(since ? { since } : {}),
        ...(limit ? { limit: String(limit) } : {}),
      }).toString();
      return toToolResult(await getJson(`/v1/evolution/${encodeURIComponent(targetProfile)}/timeline${query ? `?${query}` : ''}`));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerPrompt(
  'propose_screen_catalog',
  {
    title: 'Propose a screen catalogue',
    description:
      'Guides you to explore a target profile read-only (inspect_dom / captureInventory) and PROPOSE its screen catalogue as JSON. ' +
      'A person reviews and saves it; you cannot.',
    argsSchema: {
      targetProfile: safeName.describe('Target profile id (see list_targets)'),
      focus: z.string().max(500).optional().describe('Optional: an area of the app to concentrate on'),
    },
  },
  async ({ targetProfile, focus }) => {
    let profile: CatalogPromptProfile | undefined;
    try {
      profile = (await getJson(`/v1/targets/${encodeURIComponent(targetProfile)}`)) as CatalogPromptProfile;
    } catch {
      profile = undefined;
    }
    return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: buildCatalogPrompt(targetProfile, profile, focus) } }] };
  },
);

try {
  const transport = new StdioServerTransport();
  await server.connect(transport);
} catch (error) {
  console.error('ScrapForAI MCP server failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
}
