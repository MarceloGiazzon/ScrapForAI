import { MAIN_ACTOR } from '../schemas/explorationRequest.schema.js';
import { leafSteps } from '../schemas/stepTree.js';

/**
 * T6.4 actors. An actor is one isolated browser context (cookies, storage, page) inside the run's single browser. Pure helpers, no I/O,
 * shared by the request resolution, the runner and the places that lock credentials.
 */

export { MAIN_ACTOR };

interface ActorStep {
  actor?: string | undefined;
}

/** The actor a step runs as: the one it names, else `main`. */
export function actorOf(step: ActorStep): string {
  return step.actor ?? MAIN_ACTOR;
}

/**
 * The actors that run at least one step (steps and teardown), in the order of their first step. Only these get a browser context, so a
 * declared actor nobody uses costs nothing, and a run whose steps all name an actor never opens an idle `main`.
 */
export function actorsInUse(request: { steps: readonly object[]; teardown?: readonly object[] | undefined }): string[] {
  const seen = new Set<string>();
  // The steps of a `parallel` block's branches count (T6.5), in order: branch 0 first.
  for (const step of leafSteps([...request.steps, ...(request.teardown ?? [])])) seen.add(actorOf(step as ActorStep));
  return [...seen];
}

/** True when some step names an actor other than `main`: the result then carries the evidence of each actor apart. */
export function isMultiActor(used: readonly string[]): boolean {
  return used.some((name) => name !== MAIN_ACTOR);
}

/**
 * The credential sets a run holds a session on: the run's own (`main`) plus one per declared actor that has one. A set used by two actors
 * is listed twice, because it is two simultaneous sessions of one account. Conservative on purpose: it counts every DECLARED actor, since
 * the queue decides before the includes are expanded and the steps are known.
 */
export function sessionCredentialSets(source: {
  credentialSet?: string | undefined;
  actors?: Record<string, { credentialSet?: string | undefined }> | undefined;
}): string[] {
  const sets: string[] = [];
  if (source.credentialSet !== undefined) sets.push(source.credentialSet);
  for (const actor of Object.values(source.actors ?? {})) {
    if (actor.credentialSet !== undefined) sets.push(actor.credentialSet);
  }
  return sets;
}

/** The name an item gets in a place shared by all actors (a screenshot file, a merged log line): main keeps its plain name. */
export function actorLabel(actor: string): string | undefined {
  return actor === MAIN_ACTOR ? undefined : actor;
}
