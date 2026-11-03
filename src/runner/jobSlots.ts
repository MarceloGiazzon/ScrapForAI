import { env } from '../config/env.js';
import { getTarget } from '../targets/targetStore.js';
import { JobQueue } from '../orchestrator/jobQueue.js';

/**
 * The process-wide job queue (T1.6): the single pool behind MAX_PARALLEL_JOBS. Synchronous HTTP runs
 * take slots from it without waiting (they answer 429/409); suites wait in it by priority.
 */
export const jobQueue = new JobQueue(() => ({
  max: env.MAX_PARALLEL_JOBS,
  reservedForInteractive: env.INTERACTIVE_RESERVED_SLOTS,
}));

/** How many simultaneous sessions a credential set may have for a given target profile (default 1). */
export async function maxSessionsFor(targetProfile: string | undefined): Promise<number> {
  if (targetProfile === undefined) {
    return 1;
  }

  const profile = await getTarget(targetProfile).catch(() => undefined);
  return profile?.flags.maxSessionsPerCredential ?? 1;
}

export type InteractiveSlot =
  | { ok: true; release: () => void }
  | { ok: false; status: number; type: string; message: string };

/**
 * For the synchronous endpoints: a slot now or a clear refusal, never a wait.
 *  - no free slot            -> 429 TooManyRequests (unchanged behaviour);
 *  - credential lock taken   -> 409 CredentialInUse: another run (often a suite) is logged in with the
 *    same credential set and a second session would end it (T1.2 sets + GeneXus single-session rule).
 */
export async function acquireInteractiveSlot(request: { credentialSet?: string; targetProfile?: string }): Promise<InteractiveSlot> {
  const lockKey = request.credentialSet;
  const acquired = jobQueue.tryAcquire({
    priority: 'interactive',
    lockKey,
    maxPerLock: lockKey === undefined ? 1 : await maxSessionsFor(request.targetProfile),
  });

  if (acquired.ok) {
    return acquired;
  }

  return acquired.reason === 'lock'
    ? {
        ok: false,
        status: 409,
        type: 'CredentialInUse',
        message: `Credential set "${lockKey}" is already in use by another run and allows no more simultaneous sessions. Retry when it finishes.`,
      }
    : { ok: false, status: 429, type: 'TooManyRequests', message: 'Too many exploration jobs are already running' };
}
