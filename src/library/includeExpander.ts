import { env } from '../config/env.js';
import { RequestResolutionError } from '../runner/resolutionError.js';
import { type ExplorationStep, explorationRequestSchema, type RunnableStep } from '../schemas/explorationRequest.schema.js';
import { getRoutine } from './routineLibrary.js';

/**
 * T1.4 include expansion. `include { routineId, version? }` is replaced, before the run, by the
 * steps of that library routine, with ids prefixed by the include's id ("login.submit"). The runner
 * only ever executes the expanded, include-free lists.
 */

export const MAX_INCLUDE_DEPTH = 3;

export class IncludeError extends RequestResolutionError {}

export interface IncludedRoutineRef {
  routineId: string;
  version: number;
  sha256: string;
}

export interface ExpandedSteps {
  steps: RunnableStep[];
  teardown: RunnableStep[];
  includes: IncludedRoutineRef[];
}

interface Context {
  /** Routine ids currently being expanded, outermost first: how cycles are detected. */
  stack: string[];
  /** 1 when the stack starts with the routine being saved: it is the root, not an include level. */
  rootOffset: number;
  targetProfile: string | undefined;
  includes: IncludedRoutineRef[];
}

function prefixed(step: RunnableStep, prefix: string): RunnableStep {
  if (prefix === '') {
    return step;
  }

  const copy = { ...step } as RunnableStep & { id?: string; sinceStepId?: string };
  if (copy.id !== undefined) {
    copy.id = `${prefix}.${copy.id}`;
  }
  // waitForElapsed names an earlier step of the SAME routine, so it follows the rename.
  if (copy.action === 'waitForElapsed') {
    copy.sinceStepId = `${prefix}.${copy.sinceStepId}`;
  }

  return copy;
}

/**
 * Expands one list. `deferred` collects, per direct include, the teardown that include brings with it
 * (its own teardown first, then those of ITS includes in reverse order), so the caller can order them.
 */
async function expandList(
  steps: ExplorationStep[],
  context: Context,
  prefix: string,
  collectTeardown: boolean,
): Promise<{ steps: RunnableStep[]; deferred: RunnableStep[][] }> {
  const out: RunnableStep[] = [];
  const deferred: RunnableStep[][] = [];

  for (const step of steps) {
    if (step.action !== 'include') {
      out.push(prefixed(step, prefix));
      continue;
    }

    const depth = context.stack.length - context.rootOffset + 1;
    if (depth > MAX_INCLUDE_DEPTH) {
      throw new IncludeError(400, 'IncludeDepthExceeded', `Includes nest deeper than ${MAX_INCLUDE_DEPTH} levels: ${[...context.stack, step.routineId].join(' -> ')}`);
    }

    if (context.stack.includes(step.routineId)) {
      throw new IncludeError(400, 'IncludeCycle', `Include cycle: ${[...context.stack, step.routineId].join(' -> ')}`);
    }

    const routine = await getRoutine(step.routineId, step.version);
    if (!routine) {
      throw new IncludeError(
        404,
        'IncludedRoutineNotFound',
        step.version === undefined ? `Included routine "${step.routineId}" does not exist` : `Included routine "${step.routineId}" has no version ${step.version}`,
      );
    }

    if (routine.status === 'retired') {
      throw new IncludeError(409, 'IncludedRoutineRetired', `Included routine "${step.routineId}" v${routine.version} is retired`);
    }

    // An include is a reusable fragment of ONE application; it must not drag a run onto another app.
    if (context.targetProfile !== undefined && routine.targetProfile !== context.targetProfile) {
      throw new IncludeError(
        400,
        'IncludeTargetProfileMismatch',
        `Included routine "${step.routineId}" belongs to target profile "${routine.targetProfile}", not "${context.targetProfile}"`,
      );
    }

    context.includes.push({ routineId: routine.id, version: routine.version, sha256: routine.sha256 });

    const childPrefix = [prefix, step.id ?? step.routineId].filter(Boolean).join('.');
    const childContext: Context = { ...context, stack: [...context.stack, step.routineId] };

    const body = await expandList(routine.steps, childContext, childPrefix, collectTeardown);
    out.push(...body.steps);

    if (collectTeardown) {
      const ownTeardown = routine.teardown ? (await expandList(routine.teardown, childContext, childPrefix, false)).steps : [];
      // Defer order: the routine's own teardown first (it may need what its includes set up), then the
      // teardown of its includes, last-included first.
      deferred.push([...ownTeardown, ...[...body.deferred].reverse().flat()]);
    }
  }

  return { steps: out, deferred };
}

/**
 * Expands `steps` and `teardown`. The teardown of the result is: the routine's own teardown, then the
 * teardown of each included routine, last-included first (like deferred calls).
 *
 * Throws IncludeError (a RequestResolutionError) for cycles, depth, missing/retired routines, a target
 * profile mismatch, or an expanded routine that is no longer valid (duplicate ids, too many steps).
 *
 * `selfId` is the id of the routine being SAVED, so a routine that includes itself, directly or
 * through others, is refused at save time rather than at run time.
 */
export async function expandIncludes(
  // `parameters` (T5.3): what the including run/routine declares, so the expanded steps may use `valueFromParameter`.
  // An included routine's steps can use the includer's parameters; they cannot bring their own.
  input: { steps: ExplorationStep[]; teardown?: ExplorationStep[]; parameters?: unknown[] },
  options: { targetProfile?: string; selfId?: string } = {},
): Promise<ExpandedSteps> {
  const context: Context = {
    stack: options.selfId === undefined ? [] : [options.selfId],
    rootOffset: options.selfId === undefined ? 0 : 1,
    targetProfile: options.targetProfile,
    includes: [],
  };

  const main = await expandList(input.steps, context, '', true);
  const ownTeardown = input.teardown ? (await expandList(input.teardown, context, '', false)).steps : [];
  const teardown = [...ownTeardown, ...[...main.deferred].reverse().flat()];

  if (main.steps.length + teardown.length > env.MAX_STEPS_PER_JOB) {
    throw new IncludeError(
      400,
      'ExpandedRoutineTooLong',
      `After expanding includes the run has ${main.steps.length + teardown.length} steps (steps + teardown); MAX_STEPS_PER_JOB is ${env.MAX_STEPS_PER_JOB}`,
    );
  }

  // The expanded lists must satisfy the same rules as a hand-written request: unique ids (two includes of
  // the same routine need distinct include ids), waitForElapsed references, evaluate gating.
  const check = explorationRequestSchema.safeParse({
    targetProfile: options.targetProfile ?? 'expanded',
    steps: main.steps.length > 0 ? main.steps : input.steps,
    ...(teardown.length > 0 ? { teardown } : {}),
    ...(input.parameters ? { parameters: input.parameters } : {}),
  });
  if (!check.success) {
    throw new IncludeError(
      400,
      'ExpandedRoutineInvalid',
      `The routine is not valid once includes are expanded: ${check.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    );
  }

  return { steps: main.steps, teardown, includes: context.includes };
}
