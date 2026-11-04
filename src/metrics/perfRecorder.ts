import type { ExplorationResult } from '../schemas/explorationResult.schema.js';
import type { PerfRecord, PerfStep } from './perfAnalysis.js';
import { appendPerfRecord } from './perfStore.js';

/**
 * T3.4: turns a finished run of a library routine into one line of its series. Best effort and silent: a metric that cannot be written never fails a
 * run (the same rule as the build probe). Teardown steps are not recorded (cleanup time is not the routine's speed).
 *
 * Not recorded: a run with `parameterValues` (a shrink probe: inputs chosen to be extreme, many in a row) and a run that has no steps.
 */

export function perfRecordOf(result: ExplorationResult): PerfRecord | undefined {
  if (!result.routine || result.steps.length === 0) return undefined;

  let env = 'unknown';
  try {
    env = new URL(result.targetUrl).origin;
  } catch {
    /* keep unknown */
  }

  const steps: PerfStep[] = result.steps.map((step) => ({
    id: step.id ?? `#${step.index}`,
    durationMs: Math.max(0, Math.round(step.durationMs)),
    status: step.status === 'passed' ? 'passed' : step.status === 'failed' ? 'failed' : 'skipped',
  }));

  return {
    jobId: result.jobId,
    at: result.startedAt,
    version: result.routine.version,
    profile: result.profile ?? 'full',
    env,
    ...(result.buildId ? { buildId: result.buildId } : {}),
    status: result.status,
    durationMs: Math.max(0, Math.round(result.durationMs)),
    steps,
  };
}

export async function recordRunMetrics(result: ExplorationResult, options: { fixedParameters?: boolean } = {}): Promise<void> {
  try {
    if (options.fixedParameters) return;
    const record = perfRecordOf(result);
    if (record && result.routine) await appendPerfRecord(result.routine.id, record);
  } catch (error) {
    process.stderr.write(`[metrics] could not record the run ${result.jobId}: ${error instanceof Error ? error.name : 'error'}\n`);
  }
}
