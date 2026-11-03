import { createHash } from 'node:crypto';

import { type CronSpec, occurrencesBetween } from './cron.js';

/**
 * T3.2: which occurrences of a schedule are due now, and what to do with them. Pure (no clock, no I/O): the engine passes `nowMs`.
 *
 * Everything in (cursor, now] whose jittered time has come is "ready". At most ONE run is made for a batch of ready occurrences: the latest.
 * The earlier ones were missed (the server was down, or asleep, or a tick was late) and are recorded as such, never replayed one by one.
 */

/** A stable pseudo-random delay in [0, jitterSeconds] for this (schedule, occurrence): the same occurrence always gets the same one. */
export function jitterMs(scheduleId: string, occurrenceMs: number, jitterSeconds: number): number {
  if (jitterSeconds <= 0) return 0;
  const digest = createHash('sha256').update(`${scheduleId}|${occurrenceMs}`).digest();
  return digest.readUInt32BE(0) % (jitterSeconds * 1000 + 1);
}

export interface TickDecision {
  /** The occurrence to run, if any. */
  fire?: { at: number; recovered: boolean };
  /** Ready occurrences that will not be run (older than `fire`). */
  missed: number[];
  /** Where the cursor moves: the latest ready occurrence. Unchanged when nothing is ready. */
  cursor: number;
  /** The occurrence list was cut at the limit: more were missed than are listed. */
  truncated: boolean;
}

export function decideTick(input: {
  id: string;
  spec: CronSpec;
  timeZone: string;
  jitterSeconds: number;
  cursorMs: number;
  nowMs: number;
  /** A run later than this after its scheduled time counts as a recovery (default: 2 minutes). */
  graceMs?: number;
}): TickDecision {
  // An occurrence's jitter is at most jitterSeconds, so anything up to now - jitter is a candidate; the exact check is below.
  const found = occurrencesBetween(input.spec, input.cursorMs, input.nowMs, input.timeZone, 1000);
  const ready: number[] = [];
  for (const instant of found.instants) {
    if (instant + jitterMs(input.id, instant, input.jitterSeconds) > input.nowMs) break; // later ones are later still
    ready.push(instant);
  }

  if (ready.length === 0) return { missed: [], cursor: input.cursorMs, truncated: false };

  const latest = ready[ready.length - 1]!;
  const lateness = input.nowMs - (latest + jitterMs(input.id, latest, input.jitterSeconds));
  return {
    fire: { at: latest, recovered: lateness > (input.graceMs ?? 120_000) },
    missed: ready.slice(0, -1),
    cursor: latest,
    truncated: found.truncated,
  };
}
