import { env } from '../config/env.js';
import { getSnapshotRun, startSnapshot, waitForSnapshotRun } from '../evolution/snapshotRunner.js';
import { expandIncludes } from '../library/includeExpander.js';
import { getRoutine } from '../library/routineLibrary.js';
import { runLibraryRoutine } from '../library/routineService.js';
import { jobQueue, maxSessionsFor } from '../runner/jobSlots.js';
import { snapshotBodySchema } from '../schemas/evolution.schema.js';
import type { Schedule } from '../schemas/schedule.schema.js';
import { type SuiteRequest, suiteRequestSchema } from '../schemas/suiteRequest.schema.js';
import { getSuite, planSuite, startSuite, waitForSuite } from '../orchestrator/suiteRunner.js';
import type { Dispatched, Dispatcher, RunRef, Settled, SettledFacts } from './scheduler.js';

/**
 * T3.2: starts what a schedule points at. Scheduled runs go through the same queue as everything else, with the lowest priority (`scheduled`),
 * and never use `evaluate`/`watch` (arbitrary page JavaScript, unattended) unless SCHEDULED_ALLOW_EVALUATE=true.
 */

const WAIT_SLICE_MS = 30_000;

type StepLike = { action?: string };
const usesEvaluate = (steps: unknown): boolean => Array.isArray(steps) && (steps as StepLike[]).some((step) => step.action === 'evaluate' || step.action === 'watch');

/** Does this routine (includes expanded) run evaluate/watch? */
async function routineUsesEvaluate(id: string, version: number | undefined): Promise<boolean> {
  const routine = await getRoutine(id, version);
  if (!routine) return false; // the run itself reports a missing routine
  const expanded = await expandIncludes({ steps: routine.steps, teardown: routine.teardown, parameters: routine.parameters ?? [] }, { targetProfile: routine.targetProfile });
  return usesEvaluate(expanded.steps) || usesEvaluate(expanded.teardown);
}

async function suiteUsesEvaluate(request: SuiteRequest): Promise<string | undefined> {
  const seen = new Set<string>();
  for (const variant of await planSuite(request)) {
    const key = `${variant.state.routineId}@${variant.state.routineVersion}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (await routineUsesEvaluate(variant.state.routineId, variant.state.routineVersion)) return key;
  }
  return undefined;
}

const refused = (routine: string): Dispatched => ({
  started: false,
  outcome: 'skipped-evaluate',
  message: `${routine} uses evaluate/watch, which scheduled runs may not use (SCHEDULED_ALLOW_EVALUATE is off)`,
});

const MAX_FACT_FAILURES = 5;

/** T3.3: what a notification may say about a finished suite: ids, counts and which variants went wrong (never values). */
function suiteFacts(state: NonNullable<Awaited<ReturnType<typeof getSuite>>>): SettledFacts {
  const failures = state.variants
    .filter((variant) => variant.status === 'failed' || variant.status === 'error')
    .slice(0, MAX_FACT_FAILURES)
    .map((variant) => `${variant.variantKey}: ${variant.errorType ?? variant.status}`);
  return {
    runId: state.suiteRunId,
    ...(state.request.buildId ? { buildId: state.request.buildId } : {}),
    counts: { passed: state.counts.passed, failed: state.counts.failed, error: state.counts.error, notRun: state.counts.notRun },
    ...(failures.length > 0 ? { failures } : {}),
  };
}

function suiteSettled(state: NonNullable<Awaited<ReturnType<typeof getSuite>>>): Settled | undefined {
  if (state.status === 'running') return undefined;
  const facts = suiteFacts(state);
  if (state.verdict === 'green') return { outcome: 'passed', ...(state.verdictReason ? { message: state.verdictReason } : {}), facts };
  if (state.verdict === 'red') return { outcome: 'failed', ...(state.verdictReason ? { message: state.verdictReason } : {}), facts };
  return { outcome: 'error', message: state.verdictReason ?? `suite ${state.status}`, facts };
}

async function untilSuiteEnds(id: string): Promise<Settled> {
  for (;;) {
    const state = await waitForSuite(id, WAIT_SLICE_MS);
    if (!state) return { outcome: 'error', message: `suite ${id} disappeared` };
    const settled = suiteSettled(state);
    if (settled) return settled;
  }
}

async function startSuiteTarget(request: SuiteRequest): Promise<Dispatched> {
  if (!env.SCHEDULED_ALLOW_EVALUATE) {
    const offender = await suiteUsesEvaluate(request);
    if (offender) return refused(offender);
  }
  const state = await startSuite(request);
  return { started: true, run: { kind: 'suite', id: state.suiteRunId }, done: untilSuiteEnds(state.suiteRunId) };
}

export function createDispatcher(): Dispatcher {
  return {
    async start(schedule: Schedule, occurrenceIso: string): Promise<Dispatched> {
      const { target } = schedule;
      const label = `${schedule.id} @ ${occurrenceIso}`;

      switch (target.kind) {
        case 'routine': {
          const routine = await getRoutine(target.routineId, target.version);
          if (!routine) return { started: false, outcome: 'error', message: `routine "${target.routineId}" does not exist` };
          if (!env.SCHEDULED_ALLOW_EVALUATE && (await routineUsesEvaluate(routine.id, routine.version))) return refused(`routine "${routine.id}" v${routine.version}`);

          const credentialSet = target.credentialSet ?? routine.credentialSet;
          const maxPerLock = await maxSessionsFor(target.targetProfile ?? routine.targetProfile);
          const run = jobQueue.run(
            () =>
              runLibraryRoutine(routine.id, routine.version, {
                ...(target.credentialSet ? { credentialSet: target.credentialSet } : {}),
                ...(target.targetProfile ? { targetProfile: target.targetProfile } : {}),
                ...(target.profile ? { profile: target.profile } : {}),
                ...(target.buildId ? { buildId: target.buildId } : {}),
                caller: { source: 'schedule', correlationId: schedule.id, metadata: { occurrence: occurrenceIso } },
              }),
            { priority: 'scheduled', lockKey: credentialSet, maxPerLock },
          );
          // The job id is only known when the run ends; until then the schedule id identifies it.
          const ref: RunRef = { kind: 'run', id: `${label}` };
          const done = run.then((result): Settled => {
            ref.id = result.jobId;
            const failedStep = result.failedStepIndex === undefined ? undefined : result.steps[result.failedStepIndex];
            const failure = result.error ? `${failedStep?.id ? `step ${failedStep.id}` : failedStep ? `step ${failedStep.index}` : 'run'}: ${result.error.type}: ${result.error.message}` : undefined;
            return {
              outcome: result.status === 'passed' ? 'passed' : 'failed',
              message: result.status === 'passed' ? result.jobId : `${result.jobId}: ${result.error?.type ?? 'failed'}`,
              facts: { runId: result.jobId, ...(result.buildId ? { buildId: result.buildId } : {}), ...(failure && result.status !== 'passed' ? { failures: [failure] } : {}) },
            };
          });
          return { started: true, run: ref, done };
        }
        case 'suite':
          return startSuiteTarget(suiteRequestSchema.parse({ ...target.suite, name: target.suite.name }));
        case 'vault':
          return startSuiteTarget(
            suiteRequestSchema.parse({
              name: `vault (${schedule.id})`,
              items: [{ vault: { status: ['ACTIVE'], ...(target.tags ? { tags: target.tags } : {}) } }],
              ...(target.buildId ? { buildId: target.buildId } : {}),
            }),
          );
        case 'evolutionSnapshot': {
          const state = await startSnapshot(snapshotBodySchema.parse({ targetProfile: target.targetProfile, ...(target.buildId ? { buildId: target.buildId } : {}) }));
          const done = (async (): Promise<Settled> => {
            for (;;) {
              const current = await waitForSnapshotRun(state.snapshotId, WAIT_SLICE_MS);
              if (!current) return { outcome: 'error', message: `snapshot ${state.snapshotId} disappeared` };
              if (current.status !== 'running') {
                // A snapshot is not a test: "complete" is passed, anything else could not be done.
                return current.status === 'completed' ? { outcome: 'passed' } : { outcome: 'error', message: current.reason ?? `snapshot ${current.status}` };
              }
            }
          })();
          return { started: true, run: { kind: 'snapshot', id: state.snapshotId }, done };
        }
      }
    },

    async settledState(run: RunRef): Promise<Settled | undefined> {
      if (run.kind === 'suite') {
        const state = await getSuite(run.id);
        return state ? suiteSettled(state) : undefined;
      }
      if (run.kind === 'snapshot') {
        const state = await getSnapshotRun(run.id);
        if (!state || state.status === 'running') return undefined;
        return state.status === 'completed' ? { outcome: 'passed' } : { outcome: 'error', message: state.reason ?? `snapshot ${state.status}` };
      }
      return undefined; // a routine run lived only in the process that died
    },
  };
}
