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
 *
 * Single process by design, like the run history and the session store.
 */

export type JobPriority = 'interactive' | 'suite' | 'scheduled';

const RANK: Record<JobPriority, number> = { interactive: 0, suite: 1, scheduled: 2 };

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
  maxPerLock?: number;
  /** Aborting while the task is still waiting rejects it with JobCancelledError. A running task is not interrupted. */
  signal?: AbortSignal;
}

export type AcquireResult = { ok: true; release: () => void } | { ok: false; reason: 'capacity' | 'lock' };

interface Waiting {
  rank: number;
  seq: number;
  lockKey?: string;
  maxPerLock: number;
  start: () => void;
  cancel: (error: Error) => void;
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

  private check(rank: number, lockKey: string | undefined, maxPerLock: number): 'ok' | 'capacity' | 'lock' {
    if (this.running >= this.slotLimitFor(rank)) {
      return 'capacity';
    }

    if (lockKey !== undefined && (this.locks.get(lockKey) ?? 0) >= maxPerLock) {
      return 'lock';
    }

    return 'ok';
  }

  private take(lockKey: string | undefined): () => void {
    this.running += 1;
    if (lockKey !== undefined) {
      this.locks.set(lockKey, (this.locks.get(lockKey) ?? 0) + 1);
    }

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.running -= 1;
      if (lockKey !== undefined) {
        const left = (this.locks.get(lockKey) ?? 1) - 1;
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
  tryAcquire(options: { priority?: JobPriority; lockKey?: string; maxPerLock?: number } = {}): AcquireResult {
    const rank = RANK[options.priority ?? 'interactive'];
    const verdict = this.check(rank, options.lockKey, options.maxPerLock ?? 1);
    return verdict === 'ok' ? { ok: true, release: this.take(options.lockKey) } : { ok: false, reason: verdict };
  }

  /** Waits for a slot (and the lock), runs `task`, releases. */
  run<T>(task: () => Promise<T>, options: RunOptions): Promise<T> {
    if (options.signal?.aborted) {
      return Promise.reject(new JobCancelledError());
    }

    return new Promise<T>((resolve, reject) => {
      const entry: Waiting = {
        rank: RANK[options.priority],
        seq: this.seq++,
        lockKey: options.lockKey,
        maxPerLock: options.maxPerLock ?? 1,
        start: () => {
          options.signal?.removeEventListener('abort', onAbort);
          const release = this.take(options.lockKey);
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
        .find((item) => this.check(item.rank, item.lockKey, item.maxPerLock) === 'ok');

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
