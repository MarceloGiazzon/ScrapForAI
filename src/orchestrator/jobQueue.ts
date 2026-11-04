/**
 * T1.6 in-memory job queue: one pool of MAX_PARALLEL_JOBS browser slots shared by every way of
 * starting a run, with priorities and per-credential locks.
 *
 *  - Priority: interactive > suite > scheduled. A free slot goes to the highest-priority waiting task
 *    that can start; ties are FIFO. Suites and scheduled runs may not take the last
 *    `reservedForInteractive` slots, so an ad-hoc request is not locked out by a long suite.
 *  - Locks: at most `maxPerLock` running tasks per lock key. The key is a credential set id, which is
 *    how the "one session per account" rule of GeneXus applications is enforced (a second login with
 *    the same user kills the first session). A task blocked on a lock never blocks tasks behind it.
 *    A task with several actors (T6.4) holds ALL its keys at once (`lockKeys`): it starts only when every one is free, so
 *    two jobs can never each hold half of what the other needs. A key listed twice is two sessions on one account and
 *    counts twice against `maxPerLock`.
 *
 * Single process by design, like the run history and the session store.
 */

export type JobPriority = 'interactive' | 'suite' | 'scheduled';

const RANK: Record<JobPriority, number> = { interactive: 0, suite: 1, scheduled: 2 };

/** A task asks for more simultaneous sessions on one credential than `maxPerLock` allows: it could never start, so it is refused instead of queued. */
export class LockUnsatisfiableError extends Error {
  constructor(
    public readonly lockKey: string,
    public readonly wanted: number,
    public readonly allowed: number,
  ) {
    super(`Credential set "${lockKey}" is used by ${wanted} actors of one run but the target profile allows ${allowed} simultaneous session(s) (flags.maxSessionsPerCredential)`);
    this.name = 'LockUnsatisfiable';
  }
}

/** The keys a task holds, counted: ['a','a','b'] -> a:2, b:1. */
export function countLockKeys(keys: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

/** The first key that wants more sessions than `maxPerLock`, if any. */
export function firstOverflow(keys: readonly string[], maxPerLock: number): { lockKey: string; wanted: number } | undefined {
  for (const [lockKey, wanted] of countLockKeys(keys)) {
    if (wanted > maxPerLock) return { lockKey, wanted };
  }
  return undefined;
}

export class JobCancelledError extends Error {
  constructor(message = 'Job was cancelled before it started') {
    super(message);
    this.name = 'JobCancelled';
  }
}

export interface QueueLimits {
  /** Total concurrent runs (MAX_PARALLEL_JOBS). */
  max: number;
  /** Slots that only interactive work may use. Always leaves at least one slot for the others. */
  reservedForInteractive: number;
}

export interface RunOptions {
  priority: JobPriority;
  /** Concurrency domain, e.g. a credential set id. Tasks with the same key are limited by `maxPerLock`. */
  lockKey?: string;
  /** T6.4: more keys held together with `lockKey` (one per actor session). All or nothing; a repeat counts again. */
  lockKeys?: readonly string[];
  maxPerLock?: number;
  /** Aborting while the task is still waiting rejects it with JobCancelledError. A running task is not interrupted. */
  signal?: AbortSignal;
}

export type AcquireResult = { ok: true; release: () => void } | { ok: false; reason: 'capacity' | 'lock' };

interface Waiting {
  rank: number;
  seq: number;
  lockKeys: readonly string[];
  maxPerLock: number;
  start: () => void;
  cancel: (error: Error) => void;
}

function keysOf(options: { lockKey?: string | undefined; lockKeys?: readonly string[] | undefined }): readonly string[] {
  return [...(options.lockKey === undefined ? [] : [options.lockKey]), ...(options.lockKeys ?? [])];
}

export class JobQueue {
  private running = 0;
  private readonly locks = new Map<string, number>();
  private waiting: Waiting[] = [];
  private seq = 0;

  constructor(private readonly limits: () => QueueLimits) {}

  private slotLimitFor(rank: number): number {
    const { max, reservedForInteractive } = this.limits();
    return rank === 0 ? max : Math.max(1, max - Math.min(reservedForInteractive, max - 1));
  }

  private check(rank: number, lockKeys: readonly string[], maxPerLock: number): 'ok' | 'capacity' | 'lock' {
    if (this.running >= this.slotLimitFor(rank)) {
      return 'capacity';
    }

    for (const [lockKey, wanted] of countLockKeys(lockKeys)) {
      if ((this.locks.get(lockKey) ?? 0) + wanted > maxPerLock) {
        return 'lock';
      }
    }

    return 'ok';
  }

  private take(lockKeys: readonly string[]): () => void {
    this.running += 1;
    for (const [lockKey, wanted] of countLockKeys(lockKeys)) {
      this.locks.set(lockKey, (this.locks.get(lockKey) ?? 0) + wanted);
    }

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.running -= 1;
      for (const [lockKey, wanted] of countLockKeys(lockKeys)) {
        const left = (this.locks.get(lockKey) ?? wanted) - wanted;
        if (left <= 0) {
          this.locks.delete(lockKey);
        } else {
          this.locks.set(lockKey, left);
        }
      }
      this.pump();
    };
  }

  /**
   * Non-waiting acquire, for synchronous HTTP runs that answer 429/409 instead of queueing. Fails if no
   * slot is free OR the credential lock is taken.
   */
  tryAcquire(options: { priority?: JobPriority; lockKey?: string | undefined; lockKeys?: readonly string[]; maxPerLock?: number } = {}): AcquireResult {
    const rank = RANK[options.priority ?? 'interactive'];
    const keys = keysOf(options);
    const verdict = this.check(rank, keys, options.maxPerLock ?? 1);
    return verdict === 'ok' ? { ok: true, release: this.take(keys) } : { ok: false, reason: verdict };
  }

  /** Waits for a slot (and the lock), runs `task`, releases. */
  run<T>(task: () => Promise<T>, options: RunOptions): Promise<T> {
    if (options.signal?.aborted) {
      return Promise.reject(new JobCancelledError());
    }

    const keys = keysOf(options);
    const overflow = firstOverflow(keys, options.maxPerLock ?? 1);
    if (overflow) {
      // It would wait for ever: no moment exists in which `wanted` sessions of one credential are allowed.
      return Promise.reject(new LockUnsatisfiableError(overflow.lockKey, overflow.wanted, options.maxPerLock ?? 1));
    }

    return new Promise<T>((resolve, reject) => {
      const entry: Waiting = {
        rank: RANK[options.priority],
        seq: this.seq++,
        lockKeys: keys,
        maxPerLock: options.maxPerLock ?? 1,
        start: () => {
          options.signal?.removeEventListener('abort', onAbort);
          const release = this.take(keys);
          // Release BEFORE settling: whoever awaits this run may immediately ask for the same slot or
          // credential lock, and must not find it still taken. (Promise.resolve().then also keeps a
          // synchronous throw from `task` inside the promise chain.)
          Promise.resolve()
            .then(task)
            .then(
              (value) => {
                release();
                resolve(value);
              },
              (error: unknown) => {
                release();
                reject(error);
              },
            );
        },
        cancel: reject,
      };

      const onAbort = (): void => {
        this.waiting = this.waiting.filter((item) => item !== entry);
        reject(new JobCancelledError());
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      this.waiting.push(entry);
      this.pump();
    });
  }

  private pump(): void {
    for (;;) {
      const next = [...this.waiting]
        .sort((a, b) => a.rank - b.rank || a.seq - b.seq)
        .find((item) => this.check(item.rank, item.lockKeys, item.maxPerLock) === 'ok');

      if (!next) {
        return;
      }

      this.waiting = this.waiting.filter((item) => item !== next);
      next.start();
    }
  }

  stats(): { running: number; waiting: number; locks: Record<string, number> } {
    return { running: this.running, waiting: this.waiting.length, locks: Object.fromEntries(this.locks) };
  }
}
