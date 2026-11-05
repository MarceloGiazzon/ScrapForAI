/**
 * T6.5: a `parallel` step holds BRANCHES -- lists of steps that run at the same time, one actor each. Everything that reads "the steps of a
 * request" (which actors it uses, whether it injects faults, what a lint must scan, which generators it draws from...) has to see INSIDE the
 * branches, or a secret / a fault / a login hides in one. This is the one place that knows that shape.
 *
 * PURE: no configuration, no I/O, no schema import (the schema file imports this one).
 */

export const PARALLEL_ACTION = 'parallel';

type Branches = readonly (readonly object[])[];

/** The branches of a `parallel` step; none for any other step. */
export function branchesOf(step: object): Branches {
  const candidate = step as { action?: unknown; branches?: unknown };
  return candidate.action === PARALLEL_ACTION && Array.isArray(candidate.branches) ? (candidate.branches as Branches) : [];
}

export const isParallelStep = (step: object): boolean => (step as { action?: unknown }).action === PARALLEL_ACTION;

/** Every step of the list, containers included: a `parallel` block, then the steps of its branches (branch 0 first). */
export function* walkSteps<T extends object>(steps: readonly T[]): Generator<T> {
  for (const step of steps) {
    yield step;
    for (const branch of branchesOf(step)) yield* walkSteps(branch as readonly T[]);
  }
}

/** `walkSteps` with the path to each step (`['steps', 3, 'branches', 1, 0]`), for validation messages that point at the exact step. */
export function* walkWithPath<T extends object>(steps: readonly T[], path: ReadonlyArray<string | number>): Generator<{ step: T; path: Array<string | number> }> {
  for (const [index, step] of steps.entries()) {
    yield { step, path: [...path, index] };
    for (const [b, branch] of branchesOf(step).entries()) yield* walkWithPath(branch as readonly T[], [...path, index, 'branches', b]);
  }
}

/** The steps that act on a page: `walkSteps` without the `parallel` containers themselves. */
export function* leafSteps<T extends object>(steps: readonly T[]): Generator<Exclude<T, { action: 'parallel' }>> {
  for (const step of walkSteps(steps)) {
    if (!isParallelStep(step)) yield step as Exclude<T, { action: 'parallel' }>;
  }
}

/** Does any step of the list, branches included, satisfy the predicate? */
export function someStep<T extends object>(steps: readonly T[], predicate: (step: Exclude<T, { action: 'parallel' }>) => boolean): boolean {
  for (const step of leafSteps(steps)) if (predicate(step)) return true;
  return false;
}

/** Steps in the list counting each `parallel` block as one plus the steps of its branches: what MAX_STEPS_PER_JOB limits. */
export function countSteps(steps: readonly object[]): number {
  let total = 0;
  for (const _ of walkSteps(steps)) total += 1;
  return total;
}

/**
 * Maps every leaf step and keeps the `parallel` structure. `slot` names where a step sits ("s3" = fourth step; "s3b1_0" = first step of the
 * second branch of that block): the stable name an implicit parameter of an inline generator gets when the step has no id.
 */
export function mapLeaves<T extends object>(steps: readonly T[], fn: (step: T, slot: string) => T, slot = 's'): T[] {
  return steps.map((step, index) => {
    if (!isParallelStep(step)) return fn(step, `${slot}${index}`);
    const branches = branchesOf(step).map((branch, b) => mapLeaves(branch as readonly T[], fn, `${slot}${index}b${b}_`));
    return { ...step, branches } as T;
  });
}

/**
 * The name under which a step writes into `extracted`, or undefined. Every step that extracts something has a `name` (screenshots have one too,
 * but a file is not an extracted value, and it is told apart per actor). Two branches of one block writing the same name would let a race decide
 * the value, so that is refused up front.
 */
export function extractedNameOf(step: object): string | undefined {
  const candidate = step as { action?: unknown; name?: unknown };
  return typeof candidate.name === 'string' && candidate.action !== 'screenshot' && candidate.action !== PARALLEL_ACTION ? candidate.name : undefined;
}

/** Every name a step writes into `extracted`: its own, plus the `extract` entries of an `httpRequest` (T5.7). */
export function extractedNamesOf(step: object): string[] {
  const own = extractedNameOf(step);
  const entries = (step as { action?: unknown; extract?: unknown }).extract;
  const extra = (step as { action?: unknown }).action === 'httpRequest' && Array.isArray(entries) ? entries.flatMap((entry: { name?: unknown }) => (typeof entry?.name === 'string' ? [entry.name] : [])) : [];
  return [...(own === undefined ? [] : [own]), ...extra];
}
