import { env } from '../config/env.js';
import { getTarget } from '../targets/targetStore.js';
import { firstOverflow, JobQueue } from '../orchestrator/jobQueue.js';
import { sessionCredentialSets } from './actors.js';

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
 *
 * T6.4: a run with actors holds one session per credential set it uses, all together (`sessionCredentialSets`). More actors on one set
 * than the profile allows can never run, which is a 400 up front rather than a wait.
 */
export async function acquireInteractiveSlot(request: {
  credentialSet?: string | undefined;
  actors?: Record<string, { credentialSet?: string | undefined }> | undefined;
  targetProfile?: string | undefined;
}): Promise<InteractiveSlot> {
  const lockKeys = sessionCredentialSets(request);
  const maxPerLock = lockKeys.length === 0 ? 1 : await maxSessionsFor(request.targetProfile);
  const overflow = firstOverflow(lockKeys, maxPerLock);
  if (overflow) {
    return {
      ok: false,
      status: 400,
      type: 'TooManySessionsForCredential',
      message: `Credential set "${overflow.lockKey}" is used by ${overflow.wanted} actors of this run but the target profile allows ${maxPerLock} simultaneous session(s) (flags.maxSessionsPerCredential)`,
    };
  }

  const acquired = jobQueue.tryAcquire({ priority: 'interactive', lockKeys, maxPerLock });

  if (acquired.ok) {
    return acquired;
  }

  return acquired.reason === 'lock'
    ? {
        ok: false,
        status: 409,
        type: 'CredentialInUse',
        message: `Credential set "${[...new Set(lockKeys)].join('", "')}" is already in use by another run and allows no more simultaneous sessions. Retry when it finishes.`,
      }
    : { ok: false, status: 429, type: 'TooManyRequests', message: 'Too many exploration jobs are already running' };
}
