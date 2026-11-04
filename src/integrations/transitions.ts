/**
 * T3.3: WHEN to speak. A webhook is told about a change, never about every run:
 *   ok  -> bad   : "broken"
 *   bad -> ok    : "recovered"
 *   ok  -> ok, bad -> bad (even with a different failure): silence
 *   nothing known yet: a first result that is bad is news ("broken", flagged as the first observation); a first result that is ok is not.
 * What the channel "knows" is the verdict of its last SUCCESSFUL delivery, so a message that could not be sent is tried again at the
 * next run instead of being lost.
 *
 * Outcomes that are not a verdict (an overlap skipped, occurrences missed during downtime, still running) never reach this function.
 */

export type Verdict = 'ok' | 'bad';
export type ChangeKind = 'broken' | 'recovered';

/** `passed` is ok. A failed run, a run that could not execute and a target the scheduler refuses to run (evaluate) mean the schedule is not proving anything. */
export function verdictOf(outcome: string): Verdict | undefined {
  if (outcome === 'passed') return 'ok';
  if (outcome === 'failed' || outcome === 'error' || outcome === 'skipped-evaluate') return 'bad';
  return undefined;
}

export interface Change {
  kind: ChangeKind;
  /** No verdict was known for this subject: the channel is hearing about it for the first time. */
  first: boolean;
}

export function decideChange(known: Verdict | undefined, current: Verdict): Change | undefined {
  if (known === undefined) return current === 'bad' ? { kind: 'broken', first: true } : undefined;
  if (known === current) return undefined;
  return { kind: current === 'bad' ? 'broken' : 'recovered', first: false };
}
