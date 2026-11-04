import { parseArgs } from 'node:util';

import type { CliOutput } from '../schemas/cliOutput.schema.js'; // type only: no runtime import of the config-loading schemas
import { CLI_SCHEMA_VERSION } from './version.js';

/**
 * `scrapforai` command line (T1.7). It talks to the REST API exactly as the MCP server does, and exists
 * for what a terminal, a CI job or a ledger guard needs: a stable `--json` and a trustworthy exit code.
 *
 *   0  everything passed
 *   1  a test failed (a run or a suite came back red)
 *   2  anything else: API unreachable/refusing, bad arguments, a run that could not execute, a timeout
 */

export type ExitCode = 0 | 1 | 2;

export interface CliConfig {
  baseUrl: string;
  apiKey: string;
  requestTimeoutMs: number;
}

export interface CliIo {
  /** stdout. With --json this receives exactly one JSON object and nothing else. */
  out: (text: string) => void;
  /** stderr: progress and human errors. */
  err: (text: string) => void;
  /** Reads all of stdin (for `suite -`). */
  readStdin?: () => Promise<string>;
  /** Reads a file (for `suite file.json`). Injected so tests need no disk. */
  readFile?: (path: string) => Promise<string>;
  /** Writes a binary file (for `evidence export --out`). */
  writeFile?: (path: string, data: Buffer) => Promise<void>;
  /** True if the path is an existing directory (for `evidence verify <folder|jobId>`). */
  isDirectory?: (path: string) => Promise<boolean>;
  fetch?: typeof fetch;
  /** Aborted on Ctrl-C: a running suite is cancelled. */
  signal?: AbortSignal;
}

class CliError extends Error {
  constructor(
    readonly type: string,
    message: string,
  ) {
    super(message);
  }
}

const USAGE = `scrapforai <command> [options]

Commands
  run <routineId> [--version N] [--target id] [--credential set] [--var k=v]... [--retention ephemeral|standard] [--profile full|functional]
      [--seed s] [--sample N]   (replay or pick the generated values of a routine with parameters; the seed is in the result)
  suite <file.json|-> [--timeout-seconds N] [--no-wait]
  shrink --from-job <jobId> | <routineId> --seed s --sample N  [--max-runs N] [--max-seconds N] [--profile functional] [--no-wait]
                                    (smallest input that still fails; exit 0 when found, 2 otherwise)
  differential <routineId>... --left <targetProfile> --right <targetProfile> [--left-credential set] [--right-credential set] [--left-build b] [--right-build b]
               [--left-label l] [--right-label l] [--var k=v]... [--profile functional] [--retention standard] [--time-ratio N] [--no-wait] [--timeout-seconds N]
  differential --from-jobs <leftJobId> <rightJobId> [--time-ratio N]
                                    (the same routines against two targets, or two runs that already happened, and what differs: step status, extracted values,
                                     new console errors, network shape, time. Exit 0 same, 1 different, 2 a side could not run. The routine must open its target with goto "$targetUrl")
  schedules list | show <id> | run-now <id>     (stored schedules, their next occurrences and history; run-now needs SCHEDULER_ENABLED)
  webhooks list | show <id> | test <id>        (notification channels: where a schedule says "it broke" / "it is fixed"; test sends a harmless message, exit 2 if it did not arrive)
  perf list | alerts | show <routineId> [--version N] [--profile full|functional] [--fail-on-alert]
                                    (how long each step takes over time: baseline = median of the last 20 green runs, alert when the last 3 are >30% slower; --fail-on-alert exits 1)
  flaky list | show <routineId> [--version N] [--profile full|functional] [--fail-on-suggestion]
                                    (how often a routine changes between pass and fail on the same version and build: score over the last 20 runs; it only SUGGESTS quarantine, a person saves the new status; --fail-on-suggestion exits 1)
  health [--target <id>] [--fail-on-red]
                                    (the state of every target profile in one read: routines, trend, flaky, slower, vault, schedules; exit 0 unless --fail-on-red and a target is red)
  routines list
  routines lint <routineId|file.json|-> [--target id] [--strict]
                                    (the authoring conventions as code: GX001 login submit without a gate (error), GX002 login without logout teardown, WT001 fixed wait, SEL001 positional selector;
                                     exit 1 on an error, or on any finding with --strict; a routine can accept a finding with lintSuppress { rule, reason })
  runs show <jobId> [--full]
  pin <jobId> --reason "..." [--ref ref] [--keep-trace]
  report <jobId|suiteRunId> --out <file> [--format html|pdf] [--lang en|pt|es]
                                    (homologation report: header, verdict, steps, screenshots, signature of the evidence)
  evidence verify <folder|jobId> [--public-key file.pem] [--expected-key-id id]
                                    (a folder is checked locally, no server; exit 1 if it does not verify)
  evidence export <jobId> --out <file.zip>   (pinned evidence + signed manifest + public key, verifiable offline)
  evidence chain [--deep]           (integrity of every signed manifest of this installation)
  vault list [--status ACTIVE,...] [--tags a,b] [--surface s]
  vault show <ITEM-ID>
  vault export                      (deterministic snapshot of the whole vault, for the ledger guard)
  vault run <ITEM-ID> [--build-id b]
  vault run --impact [--changed-files <file|->] [--surface s]... [--fail-fast] [--build-id b]
                                    (whole vault, items most likely to break first; same exit codes as 'suite')
  vault confirm-green <ITEM-ID> [--build-id b]
  permissions run <matrixId> [--build-id b] [--retention ephemeral|standard] [--timeout-seconds N] [--no-wait]
                                    (role x probe permission matrix; exit 1 on an unmet expectation or an unexpected gain of access)
  permissions show <runId>
  evolution snapshot <target> [--build-id b] [--screens a,b] [--no-screenshots] [--accessibility [--a11y-standard wcag2aa|wcag2a|wcag21aa|wcag22aa]] [--force] [--allow-partial] [--settle-ms N] [--timeout-seconds N] [--no-wait]
                                    (per catalogue screen: value-free inventory + screenshot into SYSTEM_EVOLUTION_DIR/<target>/<date>_<build>/,
                                     committed to git when that directory is a repository; exit 0 complete, 2 anything else)
  evolution list <target>           (the snapshots stored for a target, oldest first)
  evolution diff <target> [--from ref] [--to ref] [--write] [--narrative-file <file|->]
                                    (what changed between two builds, default the last two; ref = build id, 'latest' or 'previous'.
                                     --write puts CHANGES.md next to the newer snapshot; a narrative is labelled AI-generated.
                                     Exit 1 when the newer build declared its expected changes and others happened)
  evolution timeline <target> [--screen id] [--key control] [--since YYYY-MM-DD] [--limit N]
                                    (when each control appeared, changed or went away)
  evolution expected <target> <buildId> [--file <expected.json|->]
                                    (show, or with --file declare, the changes a build is supposed to contain)

Global options
  --json         one machine-readable JSON object on stdout (cliSchema ${CLI_SCHEMA_VERSION})
  --url <url>    API base URL (default: SCRAPFORAI_MCP_BASE_URL or http://127.0.0.1:<PORT>)
  -h, --help

Exit codes: 0 passed, 1 a test failed, 2 anything else (API down, bad usage, run could not execute).
The API key is read from SCRAPFORAI_API_KEY / .env, never from the command line.
`;

interface ApiResponse {
  status: number;
  body: unknown;
}

function isJobResult(payload: unknown): payload is Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }
  const status = (payload as Record<string, unknown>).status;
  return status === 'passed' || status === 'failed';
}

function errorOf(response: ApiResponse): CliError {
  const error = (response.body as { error?: { type?: string; message?: string; details?: Array<{ path: string; message: string }> } } | undefined)?.error;
  const details = error?.details?.map((detail) => `${detail.path}: ${detail.message}`).join('; ');
  const message = error?.message ?? `the API answered HTTP ${response.status}`;
  return new CliError(error?.type ?? 'HttpError', details ? `${message} (${details})` : message);
}

function createApi(config: CliConfig, io: CliIo) {
  const doFetch = io.fetch ?? fetch;

  return async function api(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, timeoutMs = config.requestTimeoutMs): Promise<ApiResponse> {
    let response: Response;
    try {
      response = await doFetch(new URL(path, config.baseUrl), {
        method,
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}),
        },
        ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new CliError('ApiTimeout', `the API did not answer within ${Math.round(timeoutMs / 1000)}s (${config.baseUrl})`);
      }
      throw new CliError('ApiUnreachable', `cannot reach the ScrapForAI API at ${config.baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }

    return { status: response.status, body: await response.json().catch(() => undefined) };
  };
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function formatRun(result: Record<string, any>): { json: CliOutput & { command: 'run' }; text: string; exitCode: ExitCode } {
  const steps: Array<{ status: string; action?: string }> = result.steps ?? [];
  const failed = steps.filter((step) => step.status === 'failed').length;
  const passedRun = result.status === 'passed';
  const label = result.routine ? `${result.routine.id}@v${result.routine.version}` : (result.scenarioName ?? 'run');

  const summary = {
    jobId: result.jobId as string,
    status: result.status as 'passed' | 'failed',
    durationMs: result.durationMs as number,
    ...(result.routine ? { routine: result.routine } : {}),
    steps: { total: steps.length, passed: steps.filter((step) => step.status === 'passed').length, failed },
    ...(result.failedStepIndex === undefined ? {} : { failedStepIndex: result.failedStepIndex as number }),
    ...(result.error ? { error: { type: result.error.type as string, message: result.error.message as string } } : {}),
    ...(result.teardownStatus ? { teardownStatus: result.teardownStatus as 'passed' | 'failed' } : {}),
    screenshots: (result.evidence?.screenshots ?? []).length as number,
  };

  const lines = [`${passedRun ? 'PASSED' : 'FAILED'}  ${label}  ${summary.jobId}  ${seconds(summary.durationMs)}  (${summary.steps.passed}/${summary.steps.total} steps)`];
  if (!passedRun && result.error) {
    const where = result.failedStepIndex === undefined ? '' : `step ${Number(result.failedStepIndex) + 1}${steps[result.failedStepIndex]?.action ? ` (${steps[result.failedStepIndex]!.action})` : ''}: `;
    lines.push(`  ${where}${result.error.type}: ${result.error.message}`);
  }
  if (result.teardownStatus === 'failed') {
    lines.push('  warning: the teardown failed; test data may have been left behind');
  }

  const exitCode: ExitCode = passedRun ? 0 : 1;
  return { json: { cliSchema: CLI_SCHEMA_VERSION, command: 'run', exitCode, result: summary }, text: `${lines.join('\n')}\n`, exitCode };
}

function formatSuite(state: Record<string, any>): string {
  const mark: Record<string, string> = { passed: 'PASS ', failed: 'FAIL ', error: 'ERROR', notRun: 'SKIP ', pending: '...  ', running: 'RUN  ' };
  const lines = [`Suite "${state.name}" (${state.suiteRunId}): ${state.status}${state.seed ? `  seed ${state.seed}` : ''}`];

  for (const variant of state.variants as Array<Record<string, any>>) {
    const detail = variant.errorType ? `  ${variant.errorType}: ${variant.errorMessage ?? ''}` : variant.notRunReason ? `  (${variant.notRunReason})` : '';
    const tags = `${variant.quarantined ? '  [quarantined: not counted]' : ''}${variant.passedOnRetry ? '  [passed on a new attempt]' : ''}`;
    lines.push(`  ${mark[variant.status] ?? variant.status}  ${variant.variantKey}${variant.jobId ? `  ${variant.jobId}` : ''}${tags}${detail}`);
    // T3.5: the failed attempt stays visible next to the one that decided.
    if (Array.isArray(variant.attempts) && variant.attempts.length > 1) {
      for (const attempt of variant.attempts as Array<Record<string, any>>) {
        lines.push(`        attempt ${attempt.attempt}: ${attempt.status}  ${attempt.jobId}${attempt.errorType ? `  ${attempt.errorType}` : ''}`);
      }
    }
    // T5.4: the samples table: what each run was fed, and what it extracted.
    const values = (record: unknown): string =>
      Object.entries((record ?? {}) as Record<string, string>)
        .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
        .join(' ');
    if (variant.parameters && Object.keys(variant.parameters).length > 0) lines.push(`        params: ${values(variant.parameters)}`);
    if (variant.extracted) lines.push(`        extracted: ${values(variant.extracted)}`);
  }

  // T3.5: the counts are those of the variants that count; the quarantined ones ran, and are told apart.
  const counted = (state.variants as Array<Record<string, any>>).filter((variant) => !variant.quarantined);
  const c = Object.fromEntries(['passed', 'failed', 'error', 'notRun'].map((status) => [status, counted.filter((variant) => variant.status === status).length]));
  lines.push(`  ${c.passed} passed, ${c.failed} failed, ${c.error} error, ${c.notRun} not run`);
  if (state.quarantine) {
    const q = state.quarantine;
    lines.push(`  quarantined, not in the verdict: ${q.total} ran - ${q.passed} passed, ${q.failed} failed, ${q.error} error`);
  }
  if (state.verdict) {
    lines.push(`Verdict: ${String(state.verdict).toUpperCase()} (exit ${state.exitCode}) - ${state.verdictReason ?? ''}`);
  }
  if (state.teardownFailures) {
    lines.push(`warning: ${state.teardownFailures} run(s) passed but their teardown failed`);
  }
  return `${lines.join('\n')}\n`;
}

function formatShrink(state: Record<string, any>): string {
  const lines = [`Shrink ${state.shrinkId} of ${state.routine ? `${state.routine.id}@v${state.routine.version}` : 'a routine'}: ${state.outcome ?? state.status} (${state.runs} run(s))`];
  if (state.summary) lines.push(`  ${state.summary}`);
  if (state.result?.minimalJobId) lines.push(`  proof: ${state.result.minimalJobId} (save it with: vault add-from-run, type SCENARIO)`);
  if (state.replay) lines.push(`  replay: run ${state.replay.routineId} --version ${state.replay.version} with parameterValues ${JSON.stringify(state.replay.parameterValues)}`);
  if (state.error) lines.push(`  error: ${state.error}`);
  return `${lines.join('\n')}\n`;
}

function formatDifferential(state: Record<string, any>): string {
  const labels = (state.labels ?? { left: 'left', right: 'right' }) as { left: string; right: string };
  const lines = [`Differential ${state.differentialId}: ${labels.left} x ${labels.right} - ${state.verdict ?? state.status}`];
  if (state.reason) lines.push(`  ${state.reason}`);
  for (const warning of (state.warnings ?? []) as string[]) lines.push(`  warning: ${warning}`);
  for (const pair of (state.pairs ?? []) as Array<Record<string, any>>) {
    const head = `  ${pair.routineId}@v${pair.version}: `;
    if (pair.outcome === 'same') lines.push(`${head}same`);
    else if (pair.outcome === 'infra-error') lines.push(`${head}could not run - ${pair.error ?? ''}`);
    else if (pair.outcome === 'different') {
      lines.push(`${head}DIFFERENT - ${pair.comparison?.headline ?? ''}`);
      for (const line of (pair.lines ?? []) as string[]) lines.push(`      ${line}`);
      for (const line of (pair.timeLines ?? []) as string[]) lines.push(`      time: ${line}`);
    } else lines.push(`${head}not run`);
  }
  return `${lines.join('\n')}\n`;
}

function formatCompare(result: Record<string, any>): string {
  const lines = [`Compared ${result.left.jobId} (${result.left.status}) with ${result.right.jobId} (${result.right.status}): ${result.verdict}`];
  if (result.comparison?.headline) lines.push(`  ${result.comparison.headline}`);
  for (const line of (result.lines ?? []) as string[]) lines.push(`    ${line}`);
  for (const line of (result.timeLines ?? []) as string[]) lines.push(`    time: ${line}`);
  for (const note of (result.notes ?? []) as string[]) lines.push(`  note: ${note}`);
  return `${lines.join('\n')}\n`;
}

function formatSnapshot(state: Record<string, any>): string {
  const lines = [`Snapshot ${state.snapshotId} of "${state.targetProfile}": ${state.status}${state.buildId ? `  build ${state.buildId} (${state.buildIdSource})` : ''}`];
  for (const screen of state.screens as Array<Record<string, any>>) {
    const counts = screen.counts
      ? `  ${screen.counts.fields} field(s), ${screen.counts.actions} action(s), ${screen.counts.grids} grid(s)${screen.counts.unkeyed ? `, ${screen.counts.unkeyed} unkeyed` : ''}`
      : '';
    const a11y = screen.accessibility ? `, accessibility: ${screen.accessibility.elements} violation(s)` : '';
    const detail = screen.status === 'error' ? `  ${screen.errorType ?? ''}: ${screen.errorMessage ?? ''}` : `${counts}${counts ? a11y : ''}`;
    lines.push(`  ${screen.status === 'captured' ? 'OK   ' : screen.status === 'error' ? 'ERROR' : '...  '}  ${screen.screenId}${detail}`);
  }
  if (state.folder) lines.push(`  written to ${state.folder}`);
  if (state.git?.committed) lines.push(`  committed ${state.git.commit}`);
  else if (state.git?.repository) lines.push(`  not committed${state.git.note ? `: ${state.git.note}` : ''}`);
  for (const warning of (state.warnings ?? []) as string[]) lines.push(`  warning: ${warning}`);
  if (state.reason) lines.push(`  ${state.reason}`);
  return `${lines.join('\n')}\n`;
}

function formatMatrix(state: Record<string, any>): string {
  const lines = [`Permission matrix "${state.matrixId}" (${state.runId}): ${state.status}${state.buildId ? `  build ${state.buildId}` : ''}`];
  const cells = state.cells as Array<Record<string, any>>;
  const probes = [...new Set(cells.map((cell) => String(cell.probeId)))];
  const roles = [...new Set(cells.map((cell) => String(cell.role)))];
  const word = (cell: Record<string, any>): string => {
    const answer = cell.outcome === 'allowed' && cell.state ? String(cell.state) : String(cell.outcome);
    return cell.matches === false ? `${answer}!=${cell.expected}` : answer;
  };
  const columns = probes.map((probe) =>
    Math.max(probe.length, ...cells.filter((cell) => cell.probeId === probe).map((cell) => word(cell).length)),
  );
  const width = Math.max(4, ...roles.map((role) => role.length));
  lines.push(`  ${'role'.padEnd(width)}  ${probes.map((probe, i) => probe.padEnd(columns[i]!)).join('  ')}`);
  for (const role of roles) {
    const row = probes.map((probe, i) => {
      const cell = cells.find((c) => c.role === role && c.probeId === probe);
      return (cell ? word(cell) : '-').padEnd(columns[i]!);
    });
    lines.push(`  ${role.padEnd(width)}  ${row.join('  ')}`);
  }
  for (const cell of cells.filter((c) => c.outcome === 'error')) {
    lines.push(`  ERROR  ${cell.role} / ${cell.probeId}: ${cell.errorType ?? ''} ${cell.errorMessage ?? ''}`.trimEnd());
  }
  for (const change of (state.changes ?? []) as Array<Record<string, any>>) {
    lines.push(`  ${change.alert ? 'ALERT ' : 'change'}  ${change.role} / ${change.probeId}: ${change.from} -> ${change.to} (${change.change})`);
  }
  if (state.comparedTo) {
    lines.push(`  compared with ${state.comparedTo.runId} (${state.comparedTo.createdAt}${state.comparedTo.buildId ? `, build ${state.comparedTo.buildId}` : ''})`);
  }
  if (state.verdict) {
    lines.push(`Verdict: ${String(state.verdict).toUpperCase()} (exit ${state.exitCode}) - ${state.verdictReason ?? ''}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function runCli(argv: string[], config: CliConfig, io: CliIo): Promise<ExitCode> {
  let command = argv[0] ?? '';
  let asJson = argv.includes('--json');

  const emit = (output: CliOutput, text: string): void => {
    io.out(asJson ? `${JSON.stringify(output)}\n` : text);
  };

  try {
    if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
      io.out(USAGE);
      return argv.length === 0 ? 2 : 0;
    }

    const second = argv[1] && !argv[1].startsWith('-') ? argv[1] : undefined;
    command = command === 'routines' || command === 'runs' || command === 'vault' || command === 'evidence' || command === 'permissions' || command === 'evolution' || command === 'schedules' || command === 'webhooks' || command === 'perf' || command === 'flaky' ? `${command} ${second ?? ''}`.trim() : command;
    const rest = argv.slice(command.includes(' ') ? 2 : 1);

    const common = { json: { type: 'boolean' }, url: { type: 'string' } } as const;
    if (command === 'run') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { ...common, version: { type: 'string' }, target: { type: 'string' }, credential: { type: 'string' }, var: { type: 'string', multiple: true }, retention: { type: 'string' }, profile: { type: 'string' }, seed: { type: 'string' }, sample: { type: 'string' } },
      });
      asJson = values.json === true;
      const config2 = values.url ? { ...config, baseUrl: values.url } : config;
      const api = createApi(config2, io);

      const [routineId] = positionals;
      if (!routineId || positionals.length !== 1) throw new CliError('UsageError', 'usage: scrapforai run <routineId> [options]');
      if (values.version !== undefined && !/^[1-9]\d{0,8}$/.test(values.version)) throw new CliError('UsageError', '--version must be a positive integer');
      if (values.retention !== undefined && values.retention !== 'ephemeral' && values.retention !== 'standard') throw new CliError('UsageError', '--retention must be ephemeral or standard');
      if (values.profile !== undefined && values.profile !== 'full' && values.profile !== 'functional') throw new CliError('UsageError', '--profile must be full or functional');

      if (values.sample !== undefined && !/^\d{1,7}$/.test(values.sample)) throw new CliError('UsageError', '--sample must be a non-negative integer');
      if (values.seed !== undefined && (values.seed.length < 1 || values.seed.length > 100)) throw new CliError('UsageError', '--seed must be 1 to 100 characters');

      const variables: Record<string, string> = {};
      for (const pair of values.var ?? []) {
        const at = pair.indexOf('=');
        if (at < 1) throw new CliError('UsageError', `--var expects name=value, got "${pair}"`);
        variables[pair.slice(0, at)] = pair.slice(at + 1);
      }

      const body = {
        ...(Object.keys(variables).length > 0 ? { variables } : {}),
        ...(values.credential ? { credentialSet: values.credential } : {}),
        ...(values.target ? { targetProfile: values.target } : {}),
        ...(values.retention ? { retention: values.retention } : {}),
        ...(values.profile ? { profile: values.profile } : {}),
        ...(values.seed ? { seed: values.seed } : {}),
        ...(values.sample !== undefined ? { sample: Number(values.sample) } : {}),
      };
      const query = values.version ? `?version=${values.version}` : '';
      const response = await api('POST', `/v1/routines/${encodeURIComponent(routineId)}/run${query}`, body);

      // A red run is a normal, successful API call: HTTP 500 but with a full result body.
      if (!(response.status === 200 || isJobResult(response.body))) throw errorOf(response);

      const formatted = formatRun(response.body as Record<string, any>);
      emit(formatted.json, formatted.text);
      return formatted.exitCode;
    }

    if (command === 'permissions run' || command === 'permissions show') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { ...common, 'build-id': { type: 'string' }, retention: { type: 'string' }, 'timeout-seconds': { type: 'string' }, 'no-wait': { type: 'boolean' } },
      });
      asJson = values.json === true;
      const api = createApi(values.url ? { ...config, baseUrl: values.url } : config, io);
      const [id] = positionals;

      if (command === 'permissions show') {
        if (!id || positionals.length !== 1) throw new CliError('UsageError', 'usage: scrapforai permissions show <runId>');
        const response = await api('GET', `/v1/permissions/runs/${encodeURIComponent(id)}`);
        if (response.status !== 200) throw errorOf(response);
        const state = response.body as Record<string, any>;
        if (state.status === 'running') {
          emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'permissions show', exitCode: 2, result: state as never }, formatMatrix(state));
          return 2;
        }
        const exitCode = (state.exitCode ?? 2) as ExitCode;
        emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'permissions show', exitCode, result: state as never }, formatMatrix(state));
        return exitCode;
      }

      if (!id || positionals.length !== 1) throw new CliError('UsageError', 'usage: scrapforai permissions run <matrixId> [options]');
      if (values.retention !== undefined && values.retention !== 'ephemeral' && values.retention !== 'standard') {
        throw new CliError('UsageError', '--retention must be ephemeral or standard');
      }
      const timeoutSeconds = values['timeout-seconds'] === undefined ? 3600 : Number(values['timeout-seconds']);
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1) throw new CliError('UsageError', '--timeout-seconds must be a positive number');

      const started = await api('POST', `/v1/permissions/${encodeURIComponent(id)}/run`, {
        ...(values['build-id'] ? { buildId: values['build-id'] } : {}),
        ...(values.retention ? { retention: values.retention } : {}),
      });
      if (started.status !== 202) throw errorOf(started);
      const accepted = started.body as { runId: string; matrixId: string; status: string; cells: number; sessions: number };

      if (values['no-wait']) {
        const { runId, matrixId, status, cells, sessions } = accepted;
        emit(
          { cliSchema: CLI_SCHEMA_VERSION, command: 'permissions run', exitCode: 0, result: { runId, matrixId, status, cells, sessions } },
          `Matrix run started: ${runId} (${cells} cells, ${sessions} sessions). Poll with: GET /v1/permissions/runs/${runId}\n`,
        );
        return 0;
      }

      io.err(`[${accepted.runId}] started: ${accepted.cells} cell(s) in ${accepted.sessions} session(s)\n`);
      const deadline = Date.now() + timeoutSeconds * 1000;
      for (;;) {
        if (io.signal?.aborted) {
          await api('POST', `/v1/permissions/runs/${accepted.runId}/cancel`).catch(() => undefined);
          throw new CliError('Cancelled', `interrupted; the matrix run ${accepted.runId} was cancelled`);
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new CliError(
            'MatrixWaitTimeout',
            `the matrix run ${accepted.runId} did not finish within ${timeoutSeconds}s; it keeps running (GET /v1/permissions/runs/${accepted.runId})`,
          );
        }
        const poll = await api('GET', `/v1/permissions/runs/${accepted.runId}?wait=${Math.min(50, Math.max(1, Math.floor(remaining / 1000)))}`, undefined, 70_000);
        if (poll.status !== 200) throw errorOf(poll);
        const state = poll.body as Record<string, any>;
        if (state.status !== 'running') {
          emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'permissions run', exitCode: state.exitCode as ExitCode, result: state as never }, formatMatrix(state));
          return state.exitCode as ExitCode;
        }
      }
    }

    if (command === 'evolution diff' || command === 'evolution timeline' || command === 'evolution expected') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          ...common,
          from: { type: 'string' },
          to: { type: 'string' },
          write: { type: 'boolean' },
          'narrative-file': { type: 'string' },
          screen: { type: 'string' },
          key: { type: 'string' },
          since: { type: 'string' },
          limit: { type: 'string' },
          file: { type: 'string' },
        },
      });
      asJson = values.json === true;
      const api = createApi(values.url ? { ...config, baseUrl: values.url } : config, io);
      const [target, buildId] = positionals;
      const readSource = async (source: string, what: string): Promise<string> => {
        try {
          return source === '-'
            ? await (io.readStdin ?? (async () => { throw new Error('stdin is not available'); }))()
            : await (io.readFile ?? (async () => { throw new Error('files are not available'); }))(source);
        } catch (error) {
          throw new CliError('UsageError', `cannot read ${what} "${source}": ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      const query = (pairs: Record<string, string | undefined>): string => {
        const text = new URLSearchParams(Object.entries(pairs).filter((pair): pair is [string, string] => pair[1] !== undefined)).toString();
        return text ? `?${text}` : '';
      };

      if (command === 'evolution timeline') {
        if (!target || positionals.length !== 1) throw new CliError('UsageError', 'usage: scrapforai evolution timeline <target> [--screen id] [--key control] [--since YYYY-MM-DD] [--limit N]');
        const response = await api('GET', `/v1/evolution/${encodeURIComponent(target)}/timeline${query({ screen: values.screen, key: values.key, since: values.since, limit: values.limit })}`);
        if (response.status !== 200) throw errorOf(response);
        const answer = response.body as Record<string, any>;
        const lines = (answer.events as Array<Record<string, any>>).map((event) => `${String(event.createdAt).slice(0, 10)}  ${String(event.buildId).padEnd(14)}  [${event.screen}]  ${event.text}`);
        if (answer.control) {
          const control = answer.control as Record<string, any>;
          lines.push(
            control.firstSeenIn
              ? `"${control.key}": first seen in ${control.firstSeenIn.buildId} (${String(control.firstSeenIn.createdAt).slice(0, 10)})${control.firstSeenIn.isFirstSnapshot ? ', the first snapshot: earlier history is unknown' : ''}; ${control.presentInLatest ? `present now on ${control.screen}` : 'not present in the latest snapshot'}`
              : `"${control.key}": never seen in any snapshot`,
          );
        }
        if (answer.truncated) lines.push('... more events than shown (--limit)');
        if ((answer.events as unknown[]).length === 0 && !answer.control) lines.push(`No changes recorded across ${answer.snapshots} snapshot(s).`);
        emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'evolution timeline', exitCode: 0, result: answer as never }, `${lines.join('\n')}\n`);
        return 0;
      }

      if (command === 'evolution expected') {
        if (!target || !buildId || positionals.length !== 2) throw new CliError('UsageError', 'usage: scrapforai evolution expected <target> <buildId> [--file <expected.json|->]');
        const path = `/v1/evolution/${encodeURIComponent(target)}/expected/${encodeURIComponent(buildId)}`;
        let response: ApiResponse;
        if (values.file !== undefined) {
          let declared: unknown;
          try {
            declared = JSON.parse(await readSource(values.file, 'the expected-changes file'));
          } catch (error) {
            if (error instanceof CliError) throw error;
            throw new CliError('UsageError', `"${values.file}" is not valid JSON`);
          }
          response = await api('PUT', path, declared);
        } else {
          response = await api('GET', path);
        }
        if (response.status !== 200) throw errorOf(response);
        const declared = response.body as { buildId: string; expected: Array<Record<string, any>> };
        const text = `Build ${declared.buildId} declares ${declared.expected.length} expected change(s):\n${declared.expected.map((entry) => `  ${entry.screen}  ${entry.kind}${entry.path ? `  ${entry.path}` : ''}${entry.ref || entry.note ? `  (${[entry.ref, entry.note].filter(Boolean).join(': ')})` : ''}`).join('\n')}\n`;
        emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'evolution expected', exitCode: 0, result: response.body as never }, text);
        return 0;
      }

      // evolution diff
      if (!target || positionals.length !== 1) throw new CliError('UsageError', 'usage: scrapforai evolution diff <target> [--from ref] [--to ref] [--write] [--narrative-file <file|->]');
      const narrative = values['narrative-file'] === undefined ? undefined : await readSource(values['narrative-file'], 'the narrative file');
      const diffResponse = await api('GET', `/v1/evolution/${encodeURIComponent(target)}/diff${query({ from: values.from, to: values.to })}`);
      if (diffResponse.status !== 200) throw errorOf(diffResponse);
      const diff = diffResponse.body as Record<string, any>;

      let note = '';
      if (values.write || narrative !== undefined) {
        const written = await api('POST', `/v1/evolution/${encodeURIComponent(target)}/changes`, {
          ...(values.from ? { from: values.from } : {}),
          ...(values.to ? { to: values.to } : {}),
          ...(narrative !== undefined ? { narrative } : {}),
        });
        if (written.status !== 200) throw errorOf(written);
        const info = written.body as { file: string; git: { repository: boolean; committed: boolean; commit?: string } };
        note = `\nWritten to ${info.file}${info.git.committed ? ` (committed ${info.git.commit})` : info.git.repository ? ' (unchanged, nothing to commit)' : ''}\n`;
      }

      // Exit 1 only when the newer build DECLARED its changes and something else changed: an unplanned change is a finding.
      const exitCode: ExitCode = diff.classified === true && diff.counts.unexpected > 0 ? 1 : 0;
      emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'evolution diff', exitCode, result: diff as never }, `${String(diff.markdown)}${note}`);
      return exitCode;
    }

    if (command === 'evolution snapshot' || command === 'evolution list') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          ...common,
          'build-id': { type: 'string' },
          screens: { type: 'string' },
          'no-screenshots': { type: 'boolean' },
          accessibility: { type: 'boolean' },
          'a11y-standard': { type: 'string' },
          force: { type: 'boolean' },
          'allow-partial': { type: 'boolean' },
          'settle-ms': { type: 'string' },
          'timeout-seconds': { type: 'string' },
          'no-wait': { type: 'boolean' },
        },
      });
      asJson = values.json === true;
      const api = createApi(values.url ? { ...config, baseUrl: values.url } : config, io);
      const [target] = positionals;

      if (command === 'evolution list') {
        if (!target || positionals.length !== 1) throw new CliError('UsageError', 'usage: scrapforai evolution list <target>');
        const response = await api('GET', `/v1/evolution/${encodeURIComponent(target)}`);
        if (response.status !== 200) throw errorOf(response);
        const listing = response.body as { targetProfile: string; snapshots: Array<Record<string, any>> };
        const text = listing.snapshots.length
          ? `${listing.snapshots.map((s) => `${s.name}  build ${s.buildId}  ${s.screens} screen(s)${s.complete ? '' : `  PARTIAL (${s.notCaptured} not captured)`}`).join('\n')}\n`
          : `No snapshots for "${listing.targetProfile}".\n`;
        emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'evolution list', exitCode: 0, result: listing as never }, text);
        return 0;
      }

      if (!target || positionals.length !== 1) throw new CliError('UsageError', 'usage: scrapforai evolution snapshot <target> [options]');
      const timeoutSeconds = values['timeout-seconds'] === undefined ? 3600 : Number(values['timeout-seconds']);
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1) throw new CliError('UsageError', '--timeout-seconds must be a positive number');
      const settleMs = values['settle-ms'] === undefined ? undefined : Number(values['settle-ms']);
      if (settleMs !== undefined && (!Number.isInteger(settleMs) || settleMs < 0)) throw new CliError('UsageError', '--settle-ms must be a non-negative integer');
      const screens = values.screens ? values.screens.split(',').map((id) => id.trim()).filter(Boolean) : undefined;
      if (values.screens !== undefined && (!screens || screens.length === 0)) throw new CliError('UsageError', '--screens expects a comma-separated list of screen ids');

      const started = await api('POST', '/v1/evolution/snapshots', {
        targetProfile: target,
        ...(values['build-id'] ? { buildId: values['build-id'] } : {}),
        ...(screens ? { screens } : {}),
        ...(values['no-screenshots'] ? { screenshots: false } : {}),
        ...(values.accessibility ? { accessibility: true } : {}),
        ...(values['a11y-standard'] ? { accessibilityStandard: values['a11y-standard'] } : {}),
        ...(values.force ? { force: true } : {}),
        ...(values['allow-partial'] ? { allowPartial: true } : {}),
        ...(settleMs !== undefined ? { settleMs } : {}),
      });
      if (started.status !== 202) throw errorOf(started);
      const accepted = started.body as { snapshotId: string; targetProfile: string; status: string; screens: number; sessions: number };

      if (values['no-wait']) {
        emit(
          { cliSchema: CLI_SCHEMA_VERSION, command: 'evolution snapshot', exitCode: 0, result: accepted },
          `Snapshot started: ${accepted.snapshotId} (${accepted.screens} screens, ${accepted.sessions} sessions). Poll with: GET /v1/evolution/snapshots/${accepted.snapshotId}\n`,
        );
        return 0;
      }

      io.err(`[${accepted.snapshotId}] started: ${accepted.screens} screen(s) in ${accepted.sessions} session(s)\n`);
      const deadline = Date.now() + timeoutSeconds * 1000;
      for (;;) {
        if (io.signal?.aborted) {
          await api('POST', `/v1/evolution/snapshots/${accepted.snapshotId}/cancel`).catch(() => undefined);
          throw new CliError('Cancelled', `interrupted; the snapshot ${accepted.snapshotId} was cancelled and nothing was written`);
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new CliError(
            'SnapshotWaitTimeout',
            `the snapshot ${accepted.snapshotId} did not finish within ${timeoutSeconds}s; it keeps running (GET /v1/evolution/snapshots/${accepted.snapshotId})`,
          );
        }
        const poll = await api('GET', `/v1/evolution/snapshots/${accepted.snapshotId}?wait=${Math.min(50, Math.max(1, Math.floor(remaining / 1000)))}`, undefined, 70_000);
        if (poll.status !== 200) throw errorOf(poll);
        const state = poll.body as Record<string, any>;
        if (state.status !== 'running') {
          const exitCode = (state.exitCode ?? 2) as ExitCode;
          emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'evolution snapshot', exitCode, result: state as never }, formatSnapshot(state));
          return exitCode;
        }
      }
    }

    if (command === 'suite') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { ...common, 'timeout-seconds': { type: 'string' }, 'no-wait': { type: 'boolean' } },
      });
      asJson = values.json === true;
      const api = createApi(values.url ? { ...config, baseUrl: values.url } : config, io);

      const [source] = positionals;
      if (!source || positionals.length !== 1) throw new CliError('UsageError', 'usage: scrapforai suite <file.json|-> [options]');
      const timeoutSeconds = values['timeout-seconds'] === undefined ? 3600 : Number(values['timeout-seconds']);
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1) throw new CliError('UsageError', '--timeout-seconds must be a positive number');

      let raw: string;
      try {
        raw = source === '-' ? await (io.readStdin ?? (async () => { throw new Error('stdin is not available'); }))() : await (io.readFile ?? (async () => { throw new Error('files are not available'); }))(source);
      } catch (error) {
        throw new CliError('UsageError', `cannot read the suite definition "${source}": ${error instanceof Error ? error.message : String(error)}`);
      }

      let definition: unknown;
      try {
        definition = JSON.parse(raw);
      } catch {
        throw new CliError('UsageError', `"${source}" is not valid JSON`);
      }

      const started = await api('POST', '/v1/suites', definition);
      if (started.status !== 202) throw errorOf(started);
      const { suiteRunId, status, total } = started.body as { suiteRunId: string; status: string; total: number };

      if (values['no-wait']) {
        emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'suite', exitCode: 0, result: { suiteRunId, status, total } }, `Suite started: ${suiteRunId} (${total} runs). Poll with: GET /v1/suites/${suiteRunId}\n`);
        return 0;
      }

      io.err(`[${suiteRunId}] started: ${total} run(s)
`);
      const deadline = Date.now() + timeoutSeconds * 1000;
      let lastLine = '';
      for (;;) {
        if (io.signal?.aborted) {
          const cancelled = await api('POST', `/v1/suites/${suiteRunId}/cancel`).catch(() => undefined);
          const final = cancelled?.status === 200 ? (cancelled.body as Record<string, any>) : undefined;
          if (final) emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'suite', exitCode: 2, result: final as never }, formatSuite(final));
          else throw new CliError('Cancelled', `interrupted; the suite ${suiteRunId} may still be running`);
          return 2;
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new CliError('SuiteWaitTimeout', `the suite ${suiteRunId} did not finish within ${timeoutSeconds}s; it keeps running (GET /v1/suites/${suiteRunId})`);
        }

        const poll = await api('GET', `/v1/suites/${suiteRunId}?wait=${Math.min(50, Math.max(1, Math.floor(remaining / 1000)))}`, undefined, 70_000);
        if (poll.status !== 200) throw errorOf(poll);

        const state = poll.body as Record<string, any>;
        if (state.status !== 'running') {
          emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'suite', exitCode: state.exitCode as ExitCode, result: state as never }, formatSuite(state));
          return state.exitCode as ExitCode;
        }

        const c = state.counts;
        const line = `[${suiteRunId}] ${c.passed + c.failed + c.error + c.notRun}/${state.total} done (${c.failed} failed, ${c.error} error, ${c.running} running)`;
        if (line !== lastLine) {
          io.err(`${line}\n`);
          lastLine = line;
        }
      }
    }

    if (command === 'schedules list' || command === 'schedules show' || command === 'schedules run-now') {
      // T3.2: read the schedules, or start one now. Creating and editing them is `PUT /v1/schedules/:id` (a person's decision, not a flag).
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: common });
      asJson = values.json === true;
      const api = createApi(values.url ? { ...config, baseUrl: values.url } : config, io);
      const [id] = positionals;

      if (command === 'schedules list') {
        if (positionals.length !== 0) throw new CliError('UsageError', 'usage: scrapforai schedules list');
        const response = await api('GET', '/v1/schedules');
        if (response.status !== 200) throw errorOf(response);
        const body = response.body as { schedulerRunning: boolean; schedules: Array<Record<string, any>> };
        const lines = body.schedules.map(
          (item) => `${item.schedule.enabled ? 'on ' : 'off'}  ${item.schedule.id}  ${item.schedule.cron} (${item.schedule.timezone})  ${item.schedule.target.kind}  next ${item.next[0] ?? '-'}${item.running ? `  RUNNING ${item.running.id}` : ''}${item.lastRun ? `  last ${item.lastRun.outcome}` : ''}`,
        );
        const text = `${body.schedulerRunning ? 'Scheduler: running in this server' : 'Scheduler: NOT running in this server (SCHEDULER_ENABLED=false)'}\n${lines.length === 0 ? 'No schedules.' : lines.join('\n')}\n`;
        emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'schedules list', exitCode: 0, result: body as never }, text);
        return 0;
      }

      if (!id || positionals.length !== 1) throw new CliError('UsageError', `usage: scrapforai ${command} <scheduleId>`);
      if (command === 'schedules show') {
        const response = await api('GET', `/v1/schedules/${encodeURIComponent(id)}`);
        if (response.status !== 200) throw errorOf(response);
        const body = response.body as Record<string, any>;
        const lines = [
          `${body.schedule.id}: ${body.schedule.enabled ? 'enabled' : 'DISABLED'}  ${body.schedule.cron} (${body.schedule.timezone})  ${JSON.stringify(body.schedule.target)}`,
          `  next: ${(body.next as string[]).join(', ') || '-'}`,
          ...(body.running ? [`  running: ${body.running.kind} ${body.running.id} since ${body.running.startedAt}`] : []),
          ...((body.history ?? []) as Array<Record<string, any>>).slice(0, 10).map((entry) => `  ${entry.at}  ${entry.outcome}${entry.count > 1 ? ` x${entry.count}` : ''}${entry.recovered ? ' (recovery)' : ''}${entry.manual ? ' (manual)' : ''}${entry.run ? `  ${entry.run.id}` : ''}${entry.message ? `  ${entry.message}` : ''}`),
        ];
        emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'schedules show', exitCode: 0, result: body as never }, `${lines.join('\n')}\n`);
        return 0;
      }

      const started = await api('POST', `/v1/schedules/${encodeURIComponent(id)}/run-now`);
      if (started.status !== 202) throw errorOf(started);
      const entry = started.body as Record<string, any>;
      emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'schedules run-now', exitCode: 0, result: entry as never }, `${entry.outcome}${entry.run ? `: ${entry.run.kind} ${entry.run.id}` : ''}${entry.message ? ` - ${entry.message}` : ''}\n`);
      return 0;
    }

    if (command === 'perf list' || command === 'perf alerts' || command === 'perf show') {
      // T3.4: read-only. The series is recorded by the server on every run of a library routine.
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { ...common, version: { type: 'string' }, profile: { type: 'string' }, 'fail-on-alert': { type: 'boolean' } } });
      asJson = values.json === true;
      const api = createApi(values.url ? { ...config, baseUrl: values.url } : config, io);
      const failOnAlert = values['fail-on-alert'] === true;
      const ms = (value: number | undefined): string => (value === undefined ? '-' : `${Math.round(value)} ms`);
      const alertLine = (alert: Record<string, any>): string =>
        `ALERT ${alert.routineId} ${alert.series}: ${ms(alert.baselineMs)} -> ${ms(alert.recentMs)}${alert.ratio ? ` (x${alert.ratio})` : ''}${alert.suspectBuild ? `  new build in the slow runs: ${alert.suspectBuild}` : ''}`;

      if (command === 'perf list') {
        if (positionals.length !== 0) throw new CliError('UsageError', 'usage: scrapforai perf list');
        const response = await api('GET', '/v1/metrics/routines');
        if (response.status !== 200) throw errorOf(response);
        const body = response.body as { routines: Array<Record<string, any>> };
        const lines = body.routines.map((item) => `${item.alerts.length > 0 ? 'ALERT' : '     '}  ${item.routineId}  ${item.greenRuns}/${item.runs} green  run ${ms(item.run?.baselineMs)} -> ${ms(item.run?.recentMs)}${item.run?.note ? `  (${item.run.note})` : ''}`);
        const exitCode: ExitCode = failOnAlert && body.routines.some((item) => item.alerts.length > 0) ? 1 : 0;
        emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'perf list', exitCode, result: body as never }, `${lines.length === 0 ? 'No performance data yet.' : lines.join('\n')}\n`);
        return exitCode;
      }

      if (command === 'perf alerts') {
        if (positionals.length !== 0) throw new CliError('UsageError', 'usage: scrapforai perf alerts [--fail-on-alert]');
        const response = await api('GET', '/v1/metrics/alerts');
        if (response.status !== 200) throw errorOf(response);
        const body = response.body as { count: number; alerts: Array<Record<string, any>> };
        const exitCode: ExitCode = failOnAlert && body.count > 0 ? 1 : 0;
        emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'perf alerts', exitCode, result: body as never }, `${body.count === 0 ? 'No performance alerts.' : body.alerts.map(alertLine).join('\n')}\n`);
        return exitCode;
      }

      const [routineId] = positionals;
      if (!routineId || positionals.length !== 1) throw new CliError('UsageError', 'usage: scrapforai perf show <routineId> [--version N] [--profile full|functional] [--fail-on-alert]');
      if (values.profile !== undefined && values.profile !== 'full' && values.profile !== 'functional') throw new CliError('UsageError', '--profile must be full or functional');
      const version = values.version === undefined ? undefined : Number(values.version);
      if (version !== undefined && (!Number.isInteger(version) || version < 1)) throw new CliError('UsageError', '--version must be a positive integer');
      const query = new URLSearchParams({ limit: '1', ...(version === undefined ? {} : { version: String(version) }), ...(values.profile ? { profile: values.profile } : {}) });
      const response = await api('GET', `/v1/metrics/routines/${encodeURIComponent(routineId)}?${query.toString()}`);
      if (response.status !== 200) throw errorOf(response);
      const body = response.body as Record<string, any>;
      const population = body.population as Record<string, any> | undefined;
      const row = (series: Record<string, any>): string =>
        `${series.alert ? 'ALERT' : '     '}  ${String(series.id).padEnd(24)} ${String(series.samples).padStart(4)} runs  ${ms(series.baselineMs).padStart(9)} -> ${ms(series.recentMs).padStart(9)}${series.ratio ? `  x${series.ratio}` : ''}${series.suspectBuild ? `  build ${series.suspectBuild}` : ''}${series.note ? `  (${series.note})` : ''}`;
      const lines = [
        `${body.routineId}${population ? `: version ${population.version}, ${population.profile}, ${population.env}` : ''}  (${body.greenRuns}/${body.runs} green runs)`,
        ...(body.run ? [row(body.run)] : []),
        ...(body.steps as Array<Record<string, any>>).map(row),
      ];
      const exitCode: ExitCode = failOnAlert && (body.alerts as string[]).length > 0 ? 1 : 0;
      emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'perf show', exitCode, result: body as never }, `${lines.join('\n')}\n`);
      return exitCode;
    }

    if (command === 'flaky list' || command === 'flaky show') {
      // T3.5: read-only. Flakiness is computed from the series the server records on every run of a library routine; quarantine is only suggested.
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { ...common, version: { type: 'string' }, profile: { type: 'string' }, 'fail-on-suggestion': { type: 'boolean' } } });
      asJson = values.json === true;
      const api = createApi(values.url ? { ...config, baseUrl: values.url } : config, io);
      const failOnSuggestion = values['fail-on-suggestion'] === true;
      const score = (item: Record<string, any>): string => (item.score === undefined ? '  -  ' : Number(item.score).toFixed(2));
      const suggestionText = (item: Record<string, any>): string => (item.suggestion ? `  -> ${String(item.suggestion.action).toUpperCase()}: ${item.suggestion.reason}` : '');

      if (command === 'flaky list') {
        if (positionals.length !== 0) throw new CliError('UsageError', 'usage: scrapforai flaky list [--fail-on-suggestion]');
        const response = await api('GET', '/v1/metrics/flaky');
        if (response.status !== 200) throw errorOf(response);
        const body = response.body as { suggestions: number; routines: Array<Record<string, any>> };
        const lines = body.routines.map((item) => `${item.suggestion ? 'SUGGEST' : '       '}  ${score(item)}  ${String(item.status ?? '?').padEnd(11)} ${item.routineId}  ${item.transitions} change(s) in ${item.runs} run(s)${item.note ? `  (${item.note})` : ''}${suggestionText(item)}`);
        const exitCode: ExitCode = failOnSuggestion && body.suggestions > 0 ? 1 : 0;
        emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'flaky list', exitCode, result: body as never }, `${lines.length === 0 ? 'No runs recorded yet.' : lines.join('\n')}\n`);
        return exitCode;
      }

      const [routineId] = positionals;
      if (!routineId || positionals.length !== 1) throw new CliError('UsageError', 'usage: scrapforai flaky show <routineId> [--version N] [--profile full|functional] [--fail-on-suggestion]');
      if (values.profile !== undefined && values.profile !== 'full' && values.profile !== 'functional') throw new CliError('UsageError', '--profile must be full or functional');
      const version = values.version === undefined ? undefined : Number(values.version);
      if (version !== undefined && (!Number.isInteger(version) || version < 1)) throw new CliError('UsageError', '--version must be a positive integer');
      const query = new URLSearchParams({ ...(version === undefined ? {} : { version: String(version) }), ...(values.profile ? { profile: values.profile } : {}) });
      const response = await api('GET', `/v1/metrics/flaky/${encodeURIComponent(routineId)}${query.size > 0 ? `?${query.toString()}` : ''}`);
      if (response.status !== 200) throw errorOf(response);
      const body = response.body as Record<string, any>;
      const population = body.population as Record<string, any> | undefined;
      const strip = (body.results as Array<Record<string, any>>).map((result) => (result.status === 'passed' ? '.' : 'X')).join('');
      const lines = [
        `${body.routineId} (${body.status ?? 'status unknown'})${population ? `: version ${population.version}, ${population.profile}, ${population.env}` : ''}`,
        `  score ${score(body)}  (${body.transitions} change(s) in ${body.comparablePairs} comparable pair(s), ${body.runs} run(s), ${body.failed} failed; threshold ${body.thresholds.threshold})`,
        ...(body.skippedAtBuildChange > 0 ? [`  ${body.skippedAtBuildChange} pair(s) not compared: the build changed between them`] : []),
        ...(body.recoveredOnRetry > 0 ? [`  ${body.recoveredOnRetry} time(s) failed and then passed on the automatic new attempt`] : []),
        `  runs (oldest first): ${strip}   (. passed, X failed)`,
        ...(body.note ? [`  ${body.note}`] : []),
        ...(body.suggestion ? [`  ${String(body.suggestion.action).toUpperCase()}: ${body.suggestion.reason}`] : []),
      ];
      const exitCode: ExitCode = failOnSuggestion && body.suggestion ? 1 : 0;
      emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'flaky show', exitCode, result: body as never }, `${lines.join('\n')}\n`);
      return exitCode;
    }

    if (command === 'health') {
      // T3.7: read-only. The same report the web console shows; a red target is information unless the guard opts in with --fail-on-red.
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { ...common, target: { type: 'string' }, 'fail-on-red': { type: 'boolean' } } });
      asJson = values.json === true;
      if (positionals.length !== 0) throw new CliError('UsageError', 'usage: scrapforai health [--target <id>] [--fail-on-red]');
      const api = createApi(values.url ? { ...config, baseUrl: values.url } : config, io);
      const response = await api('GET', `/v1/health${values.target ? `?target=${encodeURIComponent(values.target)}` : ''}`);
      if (response.status !== 200) throw errorOf(response);
      const body = response.body as { schedulerRunning: boolean; totals: Record<string, number>; targets: Array<Record<string, any>> };
      const lines: string[] = [];
      for (const target of body.targets) {
        lines.push(`${String(target.status).toUpperCase().padEnd(5)} ${target.id}${target.environment ? ` (${target.environment})` : ''}`);
        const counts = Object.entries(target.routines.counts as Record<string, number>).filter(([, count]) => count > 0).map(([state, count]) => `${count} ${state}`);
        lines.push(`        routines: ${target.routines.total === 0 ? 'none' : counts.join(', ')}; vault: ${target.vault.total === 0 ? 'none' : `${target.vault.passing} passing, ${target.vault.failing} failing, ${target.vault.notRun} not run`}; schedules: ${target.schedules.length}`);
        for (const reason of target.reasons as string[]) lines.push(`        - ${reason}`);
        for (const routine of (target.routines.list as Array<Record<string, any>>).filter((item) => item.state === 'failing' || item.state === 'flaky' || item.state === 'slower')) {
          lines.push(`        ${String(routine.state).padEnd(8)} ${routine.id} v${routine.version}${routine.trend && routine.trend !== 'unknown' ? ` (${routine.trend})` : ''}`);
        }
      }
      if (!body.schedulerRunning) lines.push('Scheduler: NOT running in this server (SCHEDULER_ENABLED=false)');
      const exitCode: ExitCode = values['fail-on-red'] === true && body.totals.red! > 0 ? 1 : 0;
      emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'health', exitCode, result: body as never }, `${lines.length === 0 ? 'No target profile yet.' : lines.join('\n')}\n`);
      return exitCode;
    }

    if (command === 'webhooks list' || command === 'webhooks show' || command === 'webhooks test') {
      // T3.3: read the channels, or send a test message. Creating and editing them is `PUT /v1/webhooks/:id` (the URL is a secret and goes
      // to the server's credential vault: it is never a command-line argument, which would end up in shell history).
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: common });
      asJson = values.json === true;
      const api = createApi(values.url ? { ...config, baseUrl: values.url } : config, io);
      const [id] = positionals;

      if (command === 'webhooks list') {
        if (positionals.length !== 0) throw new CliError('UsageError', 'usage: scrapforai webhooks list');
        const response = await api('GET', '/v1/webhooks');
        if (response.status !== 200) throw errorOf(response);
        const body = response.body as { webhooks: Array<Record<string, any>> };
        const lines = body.webhooks.map(
          (item) =>
            `${item.webhook.enabled ? 'on ' : 'off'}  ${item.webhook.id}  ${item.webhook.preset}/${item.webhook.lang}  ${item.urlOrigin ?? 'NO URL'}${item.originAllowed ? '' : '  (ORIGIN NOT ALLOWED)'}  schedules: ${item.schedules.join(',') || '-'}${item.lastDelivery ? `  last ${item.lastDelivery.kind} ${item.lastDelivery.status}` : ''}`,
        );
        emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'webhooks list', exitCode: 0, result: body as never }, `${lines.length === 0 ? 'No webhooks.' : lines.join('\n')}\n`);
        return 0;
      }

      if (!id || positionals.length !== 1) throw new CliError('UsageError', `usage: scrapforai ${command} <webhookId>`);
      if (command === 'webhooks show') {
        const response = await api('GET', `/v1/webhooks/${encodeURIComponent(id)}`);
        if (response.status !== 200) throw errorOf(response);
        const body = response.body as Record<string, any>;
        const lines = [
          `${body.webhook.id}: ${body.webhook.enabled ? 'enabled' : 'DISABLED'}  ${body.webhook.preset}/${body.webhook.lang}  events ${body.webhook.events.join(',')}${body.webhook.dailySummary ? `  daily summary ${body.webhook.dailySummary.at} (${body.webhook.dailySummary.timezone})` : ''}`,
          `  destination: ${body.urlOrigin ?? 'NO URL STORED'}${body.originAllowed ? '' : '  <- not in ALLOWED_NOTIFY_ORIGINS: nothing is delivered'}`,
          `  schedules: ${(body.schedules as string[]).join(', ') || '-'}`,
          ...Object.entries(body.known as Record<string, { verdict: string; since: string }>).map(([subject, value]) => `  knows: ${subject} is ${value.verdict} since ${value.since}`),
          ...((body.deliveries ?? []) as Array<Record<string, any>>).slice(0, 10).map((delivery) => `  ${delivery.at}  ${delivery.kind}  ${delivery.status}${delivery.httpStatus ? ` HTTP ${delivery.httpStatus}` : ''}${delivery.reason ? `  ${delivery.reason}` : ''}`),
        ];
        emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'webhooks show', exitCode: 0, result: body as never }, `${lines.join('\n')}\n`);
        return 0;
      }

      // 200 = it arrived, 502 = it did not (the body is the delivery either way).
      const sent = await api('POST', `/v1/webhooks/${encodeURIComponent(id)}/test`);
      if (sent.status !== 200 && sent.status !== 502) throw errorOf(sent);
      const delivery = sent.body as Record<string, any>;
      const exitCode: ExitCode = sent.status === 200 ? 0 : 2;
      emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'webhooks test', exitCode, result: delivery as never }, `${delivery.status}${delivery.httpStatus ? ` (HTTP ${delivery.httpStatus})` : ''}${delivery.reason ? `: ${delivery.reason}` : ''}\n`);
      return exitCode;
    }

    if (command === 'differential') {
      // T6.3: the same routines on two targets (or two runs already made) and what differs. Exit 0 same, 1 different, 2 anything else.
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          ...common,
          left: { type: 'string' },
          right: { type: 'string' },
          'left-credential': { type: 'string' },
          'right-credential': { type: 'string' },
          'left-build': { type: 'string' },
          'right-build': { type: 'string' },
          'left-label': { type: 'string' },
          'right-label': { type: 'string' },
          var: { type: 'string', multiple: true },
          profile: { type: 'string' },
          retention: { type: 'string' },
          'time-ratio': { type: 'string' },
          'from-jobs': { type: 'boolean' },
          'timeout-seconds': { type: 'string' },
          'no-wait': { type: 'boolean' },
        },
      });
      asJson = values.json === true;
      const api = createApi(values.url ? { ...config, baseUrl: values.url } : config, io);

      let tolerance: Record<string, unknown> = {};
      if (values['time-ratio'] !== undefined) {
        const timeRatio = Number(values['time-ratio']);
        if (!Number.isFinite(timeRatio) || timeRatio < 1.1 || timeRatio > 100) throw new CliError('UsageError', '--time-ratio must be a number from 1.1 to 100');
        tolerance = { tolerance: { timeRatio } };
      }

      if (values['from-jobs']) {
        if (positionals.length !== 2) throw new CliError('UsageError', 'usage: scrapforai differential --from-jobs <leftJobId> <rightJobId>');
        const compared = await api('POST', '/v1/differentials/compare', { leftJobId: positionals[0], rightJobId: positionals[1], ...tolerance });
        if (compared.status !== 200) throw errorOf(compared);
        const result = compared.body as Record<string, any>;
        const exitCode: ExitCode = result.verdict === 'same' ? 0 : 1;
        emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'differential', exitCode, result: result as never }, formatCompare(result));
        return exitCode;
      }

      if (positionals.length === 0 || !values.left || !values.right) {
        throw new CliError('UsageError', 'usage: scrapforai differential <routineId>... --left <targetProfile> --right <targetProfile>   or   scrapforai differential --from-jobs <leftJobId> <rightJobId>');
      }
      if (values.profile !== undefined && values.profile !== 'full' && values.profile !== 'functional') throw new CliError('UsageError', '--profile must be full or functional');
      if (values.retention !== undefined && values.retention !== 'ephemeral' && values.retention !== 'standard') throw new CliError('UsageError', '--retention must be ephemeral or standard');
      const variables: Record<string, string> = {};
      for (const pair of values.var ?? []) {
        const at = pair.indexOf('=');
        if (at < 1) throw new CliError('UsageError', `--var expects name=value, got "${pair}"`);
        variables[pair.slice(0, at)] = pair.slice(at + 1);
      }
      const side = (which: 'left' | 'right') => {
        const credential = which === 'left' ? values['left-credential'] : values['right-credential'];
        const build = which === 'left' ? values['left-build'] : values['right-build'];
        const label = which === 'left' ? values['left-label'] : values['right-label'];
        return {
          targetProfile: which === 'left' ? values.left! : values.right!,
          ...(credential ? { credentialSet: credential } : {}),
          ...(build ? { buildId: build } : {}),
          ...(label ? { label } : {}),
        };
      };
      const body = {
        routines: positionals.map((routineId) => ({ routineId })),
        left: side('left'),
        right: side('right'),
        ...(Object.keys(variables).length > 0 ? { variables } : {}),
        ...(values.profile ? { profile: values.profile } : {}),
        ...(values.retention ? { retention: values.retention } : {}),
        ...tolerance,
      };

      const started = await api('POST', '/v1/differentials', body);
      if (started.status !== 202) throw errorOf(started);
      const { differentialId } = started.body as { differentialId: string };
      if (values['no-wait']) {
        emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'differential', exitCode: 0, result: { differentialId } as never }, `Differential run started: ${differentialId}. Poll with: GET /v1/differentials/${differentialId}\n`);
        return 0;
      }

      for (const warning of ((started.body as Record<string, any>).warnings ?? []) as string[]) io.err(`warning: ${warning}\n`);
      io.err(`[${differentialId}] started\n`);
      const timeoutSeconds = values['timeout-seconds'] === undefined ? 3600 : Number(values['timeout-seconds']);
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1) throw new CliError('UsageError', '--timeout-seconds must be a positive number');
      const deadline = Date.now() + timeoutSeconds * 1000;
      let lastLine = '';
      for (;;) {
        if (io.signal?.aborted) {
          const cancelled = await api('POST', `/v1/differentials/${differentialId}/cancel`).catch(() => undefined);
          const final = cancelled?.status === 200 ? (cancelled.body as Record<string, any>) : undefined;
          if (final) emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'differential', exitCode: 2, result: final as never }, formatDifferential(final));
          else throw new CliError('Cancelled', `interrupted; the differential run ${differentialId} may still be running`);
          return 2;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new CliError('DifferentialWaitTimeout', `the differential run ${differentialId} did not finish within ${timeoutSeconds}s; it keeps running (GET /v1/differentials/${differentialId})`);

        const poll = await api('GET', `/v1/differentials/${differentialId}?wait=${Math.min(50, Math.max(1, Math.floor(remaining / 1000)))}`, undefined, 70_000);
        if (poll.status !== 200) throw errorOf(poll);
        const state = poll.body as Record<string, any>;
        if (state.status !== 'running') {
          const exitCode = (state.exitCode ?? 2) as ExitCode;
          emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'differential', exitCode, result: state as never }, formatDifferential(state));
          return exitCode;
        }
        const c = state.counts as Record<string, number>;
        const line = `[${differentialId}] ${c.same} same, ${c.different} different, ${c.infraError} could not run, ${c.notRun} to go`;
        if (line !== lastLine) {
          io.err(`${line}\n`);
          lastLine = line;
        }
      }
    }

    if (command === 'shrink') {
      // T5.6: the smallest input that still fails. Exit 0 only when the search ended with a minimal answer; 2 otherwise (not a test verdict).
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          ...common,
          'from-job': { type: 'string' },
          version: { type: 'string' },
          seed: { type: 'string' },
          sample: { type: 'string' },
          target: { type: 'string' },
          credential: { type: 'string' },
          var: { type: 'string', multiple: true },
          profile: { type: 'string' },
          'build-id': { type: 'string' },
          'max-runs': { type: 'string' },
          'max-seconds': { type: 'string' },
          'timeout-seconds': { type: 'string' },
          'no-wait': { type: 'boolean' },
        },
      });
      asJson = values.json === true;
      const api = createApi(values.url ? { ...config, baseUrl: values.url } : config, io);

      const [routineId] = positionals;
      const fromJob = values['from-job'];
      if (positionals.length > 1 || (fromJob === undefined) === (routineId === undefined)) {
        throw new CliError('UsageError', 'usage: scrapforai shrink --from-job <jobId>   or   scrapforai shrink <routineId> --seed s --sample N   [--max-runs N] [--max-seconds N]');
      }
      const integer = (name: string, text: string | undefined, min: number, max: number): number | undefined => {
        if (text === undefined) return undefined;
        if (!/^\d{1,7}$/.test(text) || Number(text) < min || Number(text) > max) throw new CliError('UsageError', `--${name} must be an integer from ${min} to ${max}`);
        return Number(text);
      };
      const variables: Record<string, string> = {};
      for (const pair of values.var ?? []) {
        const at = pair.indexOf('=');
        if (at < 1) throw new CliError('UsageError', `--var expects name=value, got "${pair}"`);
        variables[pair.slice(0, at)] = pair.slice(at + 1);
      }
      if (values.profile !== undefined && values.profile !== 'full' && values.profile !== 'functional') throw new CliError('UsageError', '--profile must be full or functional');

      const body = {
        ...(fromJob === undefined ? { routineId, seed: values.seed, sample: integer('sample', values.sample, 0, 1_000_000), ...(values.version === undefined ? {} : { version: integer('version', values.version, 1, 1_000_000) }) } : { fromJobId: fromJob }),
        ...(values.target ? { targetProfile: values.target } : {}),
        ...(values.credential ? { credentialSet: values.credential } : {}),
        ...(Object.keys(variables).length > 0 ? { variables } : {}),
        ...(values.profile ? { profile: values.profile } : {}),
        ...(values['build-id'] ? { buildId: values['build-id'] } : {}),
        ...(values['max-runs'] === undefined ? {} : { maxShrinkRuns: integer('max-runs', values['max-runs'], 1, 200) }),
        ...(values['max-seconds'] === undefined ? {} : { maxShrinkSeconds: integer('max-seconds', values['max-seconds'], 10, 3600) }),
      };

      const started = await api('POST', '/v1/shrinks', body);
      if (started.status !== 202) throw errorOf(started);
      const { shrinkId } = started.body as { shrinkId: string };
      if (values['no-wait']) {
        emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'shrink', exitCode: 0, result: { shrinkId } as never }, `Shrink started: ${shrinkId}. Poll with: GET /v1/shrinks/${shrinkId}\n`);
        return 0;
      }

      io.err(`[${shrinkId}] started\n`);
      const timeoutSeconds = values['timeout-seconds'] === undefined ? 3700 : Number(values['timeout-seconds']);
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1) throw new CliError('UsageError', '--timeout-seconds must be a positive number');
      const deadline = Date.now() + timeoutSeconds * 1000;
      let lastLine = '';
      for (;;) {
        if (io.signal?.aborted) {
          const cancelled = await api('POST', `/v1/shrinks/${shrinkId}/cancel`).catch(() => undefined);
          const final = cancelled?.status === 200 ? (cancelled.body as Record<string, any>) : undefined;
          if (final) emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'shrink', exitCode: 2, result: final as never }, formatShrink(final));
          else throw new CliError('Cancelled', `interrupted; the shrink ${shrinkId} may still be running`);
          return 2;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new CliError('ShrinkWaitTimeout', `the shrink ${shrinkId} did not finish within ${timeoutSeconds}s; it keeps running (GET /v1/shrinks/${shrinkId})`);

        const poll = await api('GET', `/v1/shrinks/${shrinkId}?wait=${Math.min(50, Math.max(1, Math.floor(remaining / 1000)))}`, undefined, 70_000);
        if (poll.status !== 200) throw errorOf(poll);
        const state = poll.body as Record<string, any>;
        if (state.status !== 'running') {
          const exitCode: ExitCode = state.outcome === 'minimal' || state.outcome === 'independent' ? 0 : 2;
          emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'shrink', exitCode, result: state as never }, formatShrink(state));
          return exitCode;
        }
        const line = `[${shrinkId}] ${state.runs} run(s); smallest failing so far: ${Object.entries(state.currentValues ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')}`;
        if (line !== lastLine) {
          io.err(`${line}\n`);
          lastLine = line;
        }
      }
    }

    if (command === 'routines list') {
      const { values } = parseArgs({ args: rest, options: common });
      asJson = values.json === true;
      const api = createApi(values.url ? { ...config, baseUrl: values.url } : config, io);
      const response = await api('GET', '/v1/routines');
      if (response.status !== 200) throw errorOf(response);

      const { routines } = response.body as { routines: Array<Record<string, any>> };
      const text = routines.length === 0 ? 'No routines saved.\n' : `${routines.map((r) => `${r.id}  v${r.version}  ${r.status}  ${r.targetProfile}  ${r.title}${r.tags?.length ? `  [${r.tags.join(', ')}]` : ''}`).join('\n')}\n`;
      emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'routines list', exitCode: 0, result: { routines } as never }, text);
      return 0;
    }

    if (command === 'routines lint') {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { ...common, target: { type: 'string' }, strict: { type: 'boolean' } } });
      asJson = values.json === true;
      const source = positionals[0];
      if (!source) throw new CliError('Usage', 'routines lint needs a routine id, a .json file or - for stdin');
      const api = createApi(values.url ? { ...config, baseUrl: values.url } : config, io);

      let content: Record<string, any>;
      let routineId: string | undefined;
      if (source === '-' || source.endsWith('.json')) {
        const raw = source === '-' ? await (io.readStdin ?? (async () => { throw new Error('stdin is not available'); }))() : await (io.readFile ?? (async () => { throw new Error('files are not available'); }))(source);
        try {
          content = JSON.parse(raw) as Record<string, any>;
        } catch {
          throw new CliError('Usage', 'the input is not valid JSON');
        }
      } else {
        const stored = await api('GET', `/v1/routines/${encodeURIComponent(source)}`);
        if (stored.status !== 200) throw errorOf(stored);
        content = (stored.body as { routine: Record<string, any> }).routine;
        routineId = source;
      }

      const targetProfile = values.target ?? content.targetProfile;
      if (!targetProfile || !Array.isArray(content.steps)) throw new CliError('Usage', 'the input needs steps and a targetProfile (or pass --target)');
      const response = await api('POST', '/v1/routines/lint', {
        targetProfile,
        steps: content.steps,
        ...(content.teardown ? { teardown: content.teardown } : {}),
        ...(content.lintSuppress ? { lintSuppress: content.lintSuppress } : {}),
        ...(routineId ? { routineId } : {}),
      });
      if (response.status !== 200) throw errorOf(response);

      const { findings, suppressed } = response.body as { findings: Array<Record<string, any>>; suppressed: Array<Record<string, any>> };
      const line = (item: Record<string, any>, prefix: string) => `${prefix}  ${item.rule}  ${item.path}${item.stepId ? ` (${item.stepId})` : ''}: ${item.message}${item.suggestion ? `\n         -> ${item.suggestion}` : ''}`;
      const lines = [
        ...findings.map((item) => line(item, item.severity === 'error' ? 'ERROR  ' : 'warning')),
        ...suppressed.map((item) => `accepted  ${item.rule}  ${item.path}: ${item.reason}`),
      ];
      const failed = findings.some((item) => item.severity === 'error') || (values.strict === true && findings.length > 0);
      const exitCode: ExitCode = failed ? 1 : 0;
      emit(
        { cliSchema: CLI_SCHEMA_VERSION, command: 'routines lint', exitCode, result: { findings, suppressed } as never },
        `${lines.length === 0 ? 'No findings.' : lines.join('\n')}\n`,
      );
      return exitCode;
    }

    if (command === 'runs show') {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { ...common, full: { type: 'boolean' } } });
      asJson = values.json === true;
      const api = createApi(values.url ? { ...config, baseUrl: values.url } : config, io);
      const [jobId] = positionals;
      if (!jobId || positionals.length !== 1) throw new CliError('UsageError', 'usage: scrapforai runs show <jobId> [--full]');

      const response = await api('GET', `/v1/runs/${encodeURIComponent(jobId)}`);
      if (response.status !== 200) throw errorOf(response);

      const { summary, evidenceAvailable, detail } = response.body as { summary: Record<string, any>; evidenceAvailable: boolean; detail?: unknown };
      const text =
        [
          `${String(summary.status).toUpperCase()}  ${summary.scenarioName ?? '(no name)'}  ${summary.jobId}  ${seconds(summary.durationMs)}`,
          `  retention: ${summary.retention}${summary.pinned ? ` (pinned${summary.pinRef ? `: ${summary.pinRef}` : ''})` : ''}; evidence ${evidenceAvailable ? 'available' : 'expired'}`,
          ...(summary.errorType ? [`  ${summary.errorType}: ${summary.errorMessage ?? ''}`] : []),
        ].join('\n') + '\n';
      emit(
        { cliSchema: CLI_SCHEMA_VERSION, command: 'runs show', exitCode: 0, result: { summary, evidenceAvailable, ...(values.full ? { detail } : {}) } as never },
        text,
      );
      return 0;
    }

    if (command === 'pin') {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { ...common, reason: { type: 'string' }, ref: { type: 'string' }, 'keep-trace': { type: 'boolean' } } });
      asJson = values.json === true;
      const api = createApi(values.url ? { ...config, baseUrl: values.url } : config, io);
      const [jobId] = positionals;
      if (!jobId || positionals.length !== 1 || !values.reason) throw new CliError('UsageError', 'usage: scrapforai pin <jobId> --reason "..." [--ref ref] [--keep-trace]');

      const response = await api('POST', `/v1/runs/${encodeURIComponent(jobId)}/pin`, {
        reason: values.reason,
        ...(values.ref ? { ref: values.ref } : {}),
        ...(values['keep-trace'] ? { keepTrace: true } : {}),
      });
      if (response.status !== 200) throw errorOf(response);

      const pin = response.body as Record<string, any>;
      emit(
        { cliSchema: CLI_SCHEMA_VERSION, command: 'pin', exitCode: 0, result: pin as never },
        `${pin.alreadyPinned ? 'Already pinned' : 'Pinned'}: ${pin.jobId} (${pin.files} files, ${pin.bytes} bytes${pin.traceDiscarded ? ', trace discarded' : ''})\n`,
      );
      return 0;
    }

    if (command === 'report') {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { ...common, out: { type: 'string' }, format: { type: 'string' }, lang: { type: 'string' } } });
      asJson = values.json === true;
      const base = values.url ? { ...config, baseUrl: values.url } : config;
      const [id] = positionals;
      const format = values.format ?? 'html';
      const lang = values.lang ?? 'en';

      if (!id || positionals.length !== 1 || !values.out) throw new CliError('UsageError', 'usage: scrapforai report <jobId|suiteRunId> --out <file> [--format html|pdf] [--lang en|pt|es]');
      if (format !== 'html' && format !== 'pdf') throw new CliError('UsageError', '--format must be html or pdf');
      if (lang !== 'en' && lang !== 'pt' && lang !== 'es') throw new CliError('UsageError', '--lang must be en, pt or es');
      if (!id.startsWith('job_') && !id.startsWith('suite_')) throw new CliError('UsageError', 'the id must be a jobId (job_...) or a suiteRunId (suite_...)');
      if (!io.writeFile) throw new CliError('CliFailure', 'writing files is not available here');

      const doFetch = io.fetch ?? fetch;
      let response: Response;
      try {
        response = await doFetch(new URL(`/v1/${id.startsWith('job_') ? 'runs' : 'suites'}/${encodeURIComponent(id)}/report?format=${format}&lang=${lang}`, base.baseUrl), {
          headers: { authorization: `Bearer ${base.apiKey}` },
          // A PDF starts a browser; allow for it on top of the usual API timeout.
          signal: AbortSignal.timeout(base.requestTimeoutMs + 60_000),
        });
      } catch (error) {
        throw new CliError('ApiUnreachable', `cannot reach the ScrapForAI API at ${base.baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (response.status !== 200) throw errorOf({ status: response.status, body: await response.json().catch(() => undefined) });

      const bytes = Buffer.from(await response.arrayBuffer());
      await io.writeFile(values.out, bytes);
      emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'report', exitCode: 0, result: { id, format, lang, path: values.out, bytes: bytes.length } }, `Report written to ${values.out} (${bytes.length} bytes, ${format}, ${lang})\n`);
      return 0;
    }

    if (['evidence verify', 'evidence export', 'evidence chain'].includes(command)) {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { ...common, out: { type: 'string' }, 'public-key': { type: 'string' }, 'expected-key-id': { type: 'string' }, deep: { type: 'boolean' } },
      });
      asJson = values.json === true;
      const base = values.url ? { ...config, baseUrl: values.url } : config;
      const api = createApi(base, io);
      const [target] = positionals;

      if (command === 'evidence chain') {
        if (positionals.length !== 0) throw new CliError('UsageError', 'usage: scrapforai evidence chain [--deep]');
        const response = await api('GET', `/v1/evidence/chain${values.deep ? '?deep=1' : ''}`);
        if (response.status !== 200) throw errorOf(response);

        const chain = response.body as Record<string, any>;
        const lines = [`${chain.ok ? 'CHAIN OK' : 'CHAIN BROKEN'}  ${chain.signed} signed manifest(s), highest sequence ${chain.highestSequence}, key ${String(chain.keyId).slice(0, 16)}...`];
        for (const problem of chain.problems as Array<Record<string, any>>) lines.push(`  ${problem.kind}: ${problem.detail}`);
        if (chain.unsigned.length > 0) lines.push(`  not signed (pinned before signing existed): ${chain.unsigned.join(', ')}`);
        const exitCode: ExitCode = chain.ok ? 0 : 1;
        emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'evidence chain', exitCode, result: chain as never }, `${lines.join('\n')}\n`);
        return exitCode;
      }

      if (command === 'evidence export') {
        if (!target || positionals.length !== 1 || !values.out) throw new CliError('UsageError', 'usage: scrapforai evidence export <jobId> --out <file.zip>');
        if (!io.writeFile) throw new CliError('CliFailure', 'writing files is not available here');

        const doFetch = io.fetch ?? fetch;
        let response: Response;
        try {
          response = await doFetch(new URL(`/v1/runs/${encodeURIComponent(target)}/export`, base.baseUrl), {
            headers: { authorization: `Bearer ${base.apiKey}` },
            signal: AbortSignal.timeout(base.requestTimeoutMs),
          });
        } catch (error) {
          throw new CliError('ApiUnreachable', `cannot reach the ScrapForAI API at ${base.baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (response.status !== 200) throw errorOf({ status: response.status, body: await response.json().catch(() => undefined) });

        const zip = Buffer.from(await response.arrayBuffer());
        await io.writeFile(values.out, zip);
        const keyId = response.headers.get('x-scrapforai-key-id') ?? undefined;
        emit(
          { cliSchema: CLI_SCHEMA_VERSION, command: 'evidence export', exitCode: 0, result: { jobId: target, path: values.out, bytes: zip.length, ...(keyId ? { keyId } : {}) } },
          `Exported ${target} to ${values.out} (${zip.length} bytes)${keyId ? `\nSigning key id: ${keyId}\nVerify elsewhere: scrapforai evidence verify <unzipped folder> --expected-key-id ${keyId}` : ''}\n`,
        );
        return 0;
      }

      // evidence verify <folder|jobId>
      if (!target || positionals.length !== 1) throw new CliError('UsageError', 'usage: scrapforai evidence verify <folder|jobId> [--public-key file.pem] [--expected-key-id id]');
      if (values['expected-key-id'] !== undefined && !/^[0-9a-f]{64}$/.test(values['expected-key-id'])) throw new CliError('UsageError', '--expected-key-id must be a 64-character hex key id');

      const isFolder = io.isDirectory ? await io.isDirectory(target) : false;
      let verification: Record<string, any>;

      if (isFolder) {
        let publicKeyPem: string | undefined;
        if (values['public-key']) {
          try {
            publicKeyPem = await (io.readFile ?? (async () => { throw new Error('files are not available'); }))(values['public-key']);
          } catch (error) {
            throw new CliError('UsageError', `cannot read the public key "${values['public-key']}": ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        // Imported here, not at the top: verification needs no configuration, and neither should a --help.
        const { verifyEvidenceDir } = await import('../evidence/verify.js');
        try {
          verification = { source: 'folder', ...(await verifyEvidenceDir(target, { publicKeyPem, expectedKeyId: values['expected-key-id'] })) };
        } catch (error) {
          throw new CliError('NotEvidence', error instanceof Error ? error.message : String(error));
        }
      } else {
        const response = await api('GET', `/v1/runs/${encodeURIComponent(target)}/manifest`);
        if (response.status !== 200) throw errorOf(response);

        const body = response.body as Record<string, any>;
        const reasons: string[] = (body.verification.problems as Array<{ path: string; problem: string }>).map((p) => `${p.path}: ${p.problem}`);
        if (body.signature.status === 'unsigned') reasons.push(body.location === 'pinned' ? 'the manifest is not signed' : 'not signed: only pinned evidence is signed');
        if (body.signature.status === 'invalid') reasons.push(`the signature is invalid (${body.signature.reason})`);
        const keyTrusted = values['expected-key-id'] === undefined ? undefined : body.signature.status === 'valid' && body.signature.keyId === values['expected-key-id'];
        if (keyTrusted === false) reasons.push('the signing key is not the expected one');

        verification = {
          source: 'server', ok: reasons.length === 0, jobId: body.manifest.jobId, manifestSha256: body.manifestSha256,
          files: { ok: body.verification.ok, checked: body.verification.checked, problems: body.verification.problems },
          signature: body.signature, chain: body.manifest.chain ?? null, reasons, ...(keyTrusted === undefined ? {} : { keyTrusted }),
        };
      }

      const lines = [`${verification.ok ? 'VERIFIED' : 'NOT VERIFIED'}  ${verification.jobId}  (${verification.source === 'folder' ? 'checked locally' : 'checked by the server'}; ${verification.files.checked} files, signature ${verification.signature.status}${verification.chain ? `, chain #${verification.chain.sequence}` : ''})`];
      for (const reason of verification.reasons as string[]) lines.push(`  ${reason}`);
      if (verification.ok && verification.keySource === 'bundle' && verification.keyTrusted === undefined) {
        lines.push('  note: the key came from the folder itself. Pass --expected-key-id (from the owner) to also prove who signed it.');
      }
      const exitCode: ExitCode = verification.ok ? 0 : 1;
      emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'evidence verify', exitCode, result: verification as never }, `${lines.join('\n')}\n`);
      return exitCode;
    }

    if (command.startsWith('vault ') && ['vault list', 'vault show', 'vault export', 'vault run', 'vault confirm-green'].includes(command)) {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          ...common,
          status: { type: 'string' },
          tags: { type: 'string' },
          surface: { type: 'string', multiple: true },
          'build-id': { type: 'string' },
          impact: { type: 'boolean' },
          'changed-files': { type: 'string' },
          'fail-fast': { type: 'boolean' },
          'timeout-seconds': { type: 'string' },
        },
      });
      asJson = values.json === true;
      const base = values.url ? { ...config, baseUrl: values.url } : config;
      const api = createApi(base, io);
      const [itemId] = positionals;
      const needsId = command === 'vault show' || command === 'vault confirm-green' || (command === 'vault run' && !values.impact);
      if (needsId ? !itemId || positionals.length !== 1 : positionals.length !== 0) {
        throw new CliError('UsageError', `usage: scrapforai ${command}${needsId ? ' <ITEM-ID>' : ''} [options]  (see --help)`);
      }
      if (values['build-id'] !== undefined && !/^[\w.+\-/]+$/.test(values['build-id'])) throw new CliError('UsageError', '--build-id has characters that are not allowed');

      if (command === 'vault list' || command === 'vault export') {
        const query = new URLSearchParams();
        if (command === 'vault list') {
          if (values.status) query.set('status', values.status);
          if (values.tags) query.set('tags', values.tags);
          if (values.surface?.[0]) query.set('surface', values.surface[0]);
        }
        const response = await api('GET', command === 'vault export' ? '/v1/vault/export' : `/v1/vault${query.size ? `?${query}` : ''}`);
        if (response.status !== 200) throw errorOf(response);

        const body = response.body as { items: Array<Record<string, any>>; count?: number };
        const text =
          body.items.length === 0
            ? 'The regression vault is empty.\n'
            : `${body.items.map((item) => `${item.id}  ${item.status}  ${item.severity ?? '-'}  ${item.surface}  ${item.provenRed ? 'RED' : 'no-red'}/${item.firstGreen ? 'GREEN' : 'no-green'}  ${item.title}`).join('\n')}\n`;
        emit({ cliSchema: CLI_SCHEMA_VERSION, command: command as 'vault list', exitCode: 0, result: body as never }, text);
        return 0;
      }

      if (command === 'vault show') {
        const response = await api('GET', `/v1/vault/${encodeURIComponent(itemId!)}`);
        if (response.status !== 200) throw errorOf(response);

        const item = response.body as Record<string, any>;
        const text =
          [
            `${item.id}  ${item.status}  ${item.type}  ${item.severity ?? '-'}  ${item.title}`,
            `  surface: ${item.surface}; routine: ${item.routine.id}@v${item.routine.version}${item.ledgerRef ? `; ledger: ${item.ledgerRef}` : ''}`,
            `  RED:   ${item.provenRed ? `${item.provenRed.jobId}${item.provenRed.buildId ? ` (build ${item.provenRed.buildId})` : ''}` : `not captured - ${item.redNotCapturedReason}`}`,
            `  GREEN: ${item.firstGreen ? `${item.firstGreen.jobId}${item.firstGreen.buildId ? ` (build ${item.firstGreen.buildId})` : ''}` : 'not confirmed yet'}`,
            `  last run: ${item.lastRun ? `${item.lastRun.status} (${item.lastRun.jobId} at ${item.lastRun.at})` : 'never'}`,
          ].join('\n') + '\n';
        emit({ cliSchema: CLI_SCHEMA_VERSION, command: 'vault show', exitCode: 0, result: item as never }, text);
        return 0;
      }

      if (command === 'vault run' && values.impact) {
        // The whole vault as a suite, most-likely-to-break first. Same wait loop, verdict and exit codes as `suite`.
        let changedFiles: string[] | undefined;
        if (values['changed-files']) {
          const source = values['changed-files'];
          let raw: string;
          try {
            raw = source === '-' ? await (io.readStdin ?? (async () => { throw new Error('stdin is not available'); }))() : await (io.readFile ?? (async () => { throw new Error('files are not available'); }))(source);
          } catch (error) {
            throw new CliError('UsageError', `cannot read the changed files list "${source}": ${error instanceof Error ? error.message : String(error)}`);
          }
          changedFiles = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        }

        const definition = {
          name: 'vault (by impact)',
          items: [{ vault: { ...(values.status ? { status: values.status.split(',') } : {}), ...(values.tags ? { tags: values.tags.split(',') } : {}) } }],
          order: 'impact',
          impact: { ...(changedFiles ? { changedFiles } : {}), ...(values.surface ? { surfaces: values.surface } : {}) },
          ...(values['build-id'] ? { buildId: values['build-id'] } : {}),
          ...(values['fail-fast'] ? { failFast: true } : {}),
        };

        return runCli(
          ['suite', '-', ...(asJson ? ['--json'] : []), ...(values.url ? ['--url', values.url] : []), ...(values['timeout-seconds'] ? ['--timeout-seconds', values['timeout-seconds']] : [])],
          config,
          { ...io, readStdin: async () => JSON.stringify(definition) },
        );
      }

      // vault run <id> | vault confirm-green <id>
      const confirm = command === 'vault confirm-green';
      const response = await api('POST', `/v1/vault/${encodeURIComponent(itemId!)}/${confirm ? 'confirm-green' : 'run'}`, values['build-id'] ? { buildId: values['build-id'] } : {});
      const body = response.body as Record<string, any>;
      const hasOutcome = body && typeof body === 'object' && body.result && body.item;
      if (!hasOutcome) throw errorOf(response);

      const passed = body.result.status === 'passed';
      const text = confirm
        ? body.confirmed
          ? `CONFIRMED  ${body.item.id}: firstGreen = ${body.item.firstGreen?.jobId}\n`
          : `STILL RED  ${body.item.id}: ${body.result.error?.type ?? 'failed'}: ${body.result.error?.message ?? ''} (item unchanged)\n`
        : `${passed ? 'PASSED' : 'FAILED'}  ${body.item.id}  ${body.result.jobId}  ${seconds(body.result.durationMs)}${passed ? '' : `  ${body.result.error?.type ?? ''}: ${body.result.error?.message ?? ''}`}\n`;
      const exitCode: ExitCode = passed ? 0 : 1;
      emit({ cliSchema: CLI_SCHEMA_VERSION, command: command as 'vault run', exitCode, result: { ...(confirm ? { confirmed: body.confirmed === true } : {}), item: body.item, result: body.result } as never }, text);
      return exitCode;
    }

    throw new CliError('UsageError', `unknown command "${argv[0]}". Run scrapforai --help`);
  } catch (error) {
    const known = error instanceof CliError ? error : new CliError(error instanceof Error && (error.name === 'TypeError' || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) ? 'UsageError' : 'CliFailure', error instanceof Error ? error.message : String(error));
    if (asJson) {
      io.out(`${JSON.stringify({ cliSchema: CLI_SCHEMA_VERSION, command, exitCode: 2, error: { type: known.type, message: known.message } } satisfies CliOutput)}\n`);
    } else {
      io.err(`error: ${known.type}: ${known.message}\n`); // human errors go to stderr, never mixed into stdout
    }
    return 2;
  }
}
