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
  run <routineId> [--version N] [--target id] [--credential set] [--var k=v]... [--retention ephemeral|standard]
  suite <file.json|-> [--timeout-seconds N] [--no-wait]
  routines list
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

  return async function api(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = config.requestTimeoutMs): Promise<ApiResponse> {
    let response: Response;
    try {
      response = await doFetch(new URL(path, config.baseUrl), {
        method,
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
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
  const lines = [`Suite "${state.name}" (${state.suiteRunId}): ${state.status}`];

  for (const variant of state.variants as Array<Record<string, any>>) {
    const detail = variant.errorType ? `  ${variant.errorType}: ${variant.errorMessage ?? ''}` : variant.notRunReason ? `  (${variant.notRunReason})` : '';
    lines.push(`  ${mark[variant.status] ?? variant.status}  ${variant.variantKey}${variant.jobId ? `  ${variant.jobId}` : ''}${detail}`);
  }

  const c = state.counts;
  lines.push(`  ${c.passed} passed, ${c.failed} failed, ${c.error} error, ${c.notRun} not run`);
  if (state.verdict) {
    lines.push(`Verdict: ${String(state.verdict).toUpperCase()} (exit ${state.exitCode}) - ${state.verdictReason ?? ''}`);
  }
  if (state.teardownFailures) {
    lines.push(`warning: ${state.teardownFailures} run(s) passed but their teardown failed`);
  }
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
    command = command === 'routines' || command === 'runs' || command === 'vault' || command === 'evidence' || command === 'permissions' ? `${command} ${second ?? ''}`.trim() : command;
    const rest = argv.slice(command.includes(' ') ? 2 : 1);

    const common = { json: { type: 'boolean' }, url: { type: 'string' } } as const;
    if (command === 'run') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { ...common, version: { type: 'string' }, target: { type: 'string' }, credential: { type: 'string' }, var: { type: 'string', multiple: true }, retention: { type: 'string' } },
      });
      asJson = values.json === true;
      const config2 = values.url ? { ...config, baseUrl: values.url } : config;
      const api = createApi(config2, io);

      const [routineId] = positionals;
      if (!routineId || positionals.length !== 1) throw new CliError('UsageError', 'usage: scrapforai run <routineId> [options]');
      if (values.version !== undefined && !/^[1-9]\d{0,8}$/.test(values.version)) throw new CliError('UsageError', '--version must be a positive integer');
      if (values.retention !== undefined && values.retention !== 'ephemeral' && values.retention !== 'standard') throw new CliError('UsageError', '--retention must be ephemeral or standard');

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
