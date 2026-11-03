import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { domInspectionRequestSchema } from '../schemas/domInspectionRequest.schema.js';
import { mcpExplorationRequestSchema, safeName } from '../schemas/explorationRequest.schema.js';
import { mcpSaveRoutineSchema, routineRunBodySchema } from '../schemas/libraryRoutine.schema.js';
import { addFromRunSchema, confirmGreenSchema, ITEM_ID_PATTERN, itemStatusSchema, itemTypeSchema } from '../schemas/regressionItem.schema.js';
import { matrixRunBodySchema, permissionMatrixObjectSchema } from '../schemas/permissionMatrix.schema.js';
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
      'For "which role can do what", use a permission matrix: save_permission_matrix -> run_permission_matrix -> get_permission_matrix_result.',
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

try {
  const transport = new StdioServerTransport();
  await server.connect(transport);
} catch (error) {
  console.error('ScrapForAI MCP server failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
}
