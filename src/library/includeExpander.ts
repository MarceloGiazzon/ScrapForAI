import { env } from '../config/env.js';
import { renameVariables } from '../oracle/expression.js';
import { RequestResolutionError } from '../runner/resolutionError.js';
import { type ExplorationStep, explorationRequestSchema, type RunnableStep } from '../schemas/explorationRequest.schema.js';
import { type Parameter, sanitizeParameterName } from '../schemas/parameters.schema.js';
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
  /**
   * Parameters declared by the INCLUDED routines (T5.3), renamed `<include path>_<name>` (dots become underscores) so two includes of the
   * same routine, or an include and its includer, never collide. The steps already use the new names.
   */
  parameters: Parameter[];
}

interface Context {
  /** Routine ids currently being expanded, outermost first: how cycles are detected. */
  stack: string[];
  /** 1 when the stack starts with the routine being saved: it is the root, not an include level. */
  rootOffset: number;
  targetProfile: string | undefined;
  includes: IncludedRoutineRef[];
  /** Parameters declared by included routines, renamed (shared by every level). */
  parameters: Parameter[];
  /**
   * Parameter names visible in the routine being expanded -> their global name. Only that routine's OWN declarations: an included
   * routine does not see its includer's parameters (it could not be saved on its own if it did). Empty at the root, where names are global.
   */
  scope: Map<string, string>;
}

/** A step of an included routine that draws from one of ITS parameters now draws from the renamed one. */
function withScopedParameter(step: RunnableStep, scope: Map<string, string>): RunnableStep {
  // T5.5: a formula of an included routine reads ITS parameters by their declared name; follow the rename.
  if (step.action === 'assertEquals' && 'expr' in step.expected && scope.size > 0) {
    const expr = renameVariables(step.expected.expr, scope);
    return expr === step.expected.expr ? step : ({ ...step, expected: { expr } } as RunnableStep);
  }
  const name = (step as { valueFromParameter?: string }).valueFromParameter;
  const renamed = name === undefined ? undefined : scope.get(name);
  return renamed === undefined ? step : ({ ...step, valueFromParameter: renamed } as RunnableStep);
}

function prefixed(step: RunnableStep, prefix: string): RunnableStep {
  if (prefix === '') {
    return step;
  }

  const copy = { ...step } as RunnableStep & { id?: string; sinceStepId?: string; untilStep?: string };
  if (copy.id !== undefined) {
    copy.id = `${prefix}.${copy.id}`;
  }
  // waitForElapsed names an earlier step of the SAME routine, so it follows the rename.
  if (copy.action === 'waitForElapsed') {
    copy.sinceStepId = `${prefix}.${copy.sinceStepId}`;
  }
  // So does the end of a fault (T7.2): "untilStep" is a later step of the same routine.
  if (copy.action === 'injectFault' && copy.untilStep !== undefined) {
    copy.untilStep = `${prefix}.${copy.untilStep}`;
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
      out.push(prefixed(withScopedParameter(step as RunnableStep, context.scope), prefix));
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
    // T5.3: the included routine's own parameters, renamed after the include so they cannot collide.
    const scope = new Map<string, string>();
    for (const own of routine.parameters ?? []) {
      const global = sanitizeParameterName(`${childPrefix}_${own.name}`);
      scope.set(own.name, global);
      context.parameters.push({ ...own, name: global });
    }
    const childContext: Context = { ...context, stack: [...context.stack, step.routineId], scope };

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
  // An included routine declares its OWN parameters (renamed after the include in the result); it cannot use its includer's.
  input: { steps: ExplorationStep[]; teardown?: ExplorationStep[]; parameters?: unknown[] },
  options: { targetProfile?: string; selfId?: string } = {},
): Promise<ExpandedSteps> {
  const context: Context = {
    stack: options.selfId === undefined ? [] : [options.selfId],
    rootOffset: options.selfId === undefined ? 0 : 1,
    targetProfile: options.targetProfile,
    includes: [],
    parameters: [],
    scope: new Map(),
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
    ...(input.parameters || context.parameters.length > 0 ? { parameters: [...(input.parameters ?? []), ...context.parameters] } : {}),
  });
  if (!check.success) {
    throw new IncludeError(
      400,
      'ExpandedRoutineInvalid',
      `The routine is not valid once includes are expanded: ${check.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    );
  }

  return { steps: main.steps, teardown, includes: context.includes, parameters: context.parameters };
}
