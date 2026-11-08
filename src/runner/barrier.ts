/**
 * `barrier` (T6.5 follow-up): a meeting point inside the branches of a `parallel` block. A branch that reaches a barrier waits until EVERY branch of the
 * block has reached it, then they all go on together. It narrows the gap between the racing actions to the time one step takes to start (milliseconds),
 * which `parallel` alone cannot do when the branches have different amounts of work before the racing step. Pure: no I/O, no browser, no configuration.
 *
 * A barrier never lets a branch go on alone. If a branch ENDS (failed, or simply ran out of steps) without having reached a barrier, the branches waiting
 * for it are told so (`BarrierBrokenError`) instead of carrying on: a "race" with one runner would pass for the wrong reason. A branch that waits too long
 * gets `BarrierTimeoutError`. Either way the step fails, never hangs.
 */

export class BarrierBrokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BarrierBrokenError';
  }
}

export class BarrierTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BarrierTimeoutError';
  }
}

export type BranchEnd = 'failed' | 'finished';

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BarrierGroup {
  private readonly arrived = new Map<string, Set<number>>();
  private readonly waiting = new Map<string, Map<number, Waiter>>();
  private readonly released = new Set<string>();
  private readonly broken = new Map<string, string>();
  private readonly gone = new Map<number, BranchEnd>();

  /** `labels[i]` names branch `i` in messages ("branch 1 (bob)"); its length is the number of branches that must meet. */
  constructor(private readonly labels: readonly string[]) {}

  /** Branch `party` reached barrier `name`. Resolves when every branch has; rejects when that can no longer happen, or after `timeoutMs`. */
  arrive(name: string, party: number, timeoutMs: number): Promise<void> {
    const reason = this.brokenReason(name);
    if (reason !== undefined) return Promise.reject(new BarrierBrokenError(reason));

    const here = this.arrived.get(name) ?? new Set<number>();
    if (here.has(party)) return Promise.reject(new Error(`${this.labels[party]} reached barrier "${name}" twice`));
    here.add(party);
    this.arrived.set(name, here);

    if (here.size === this.labels.length) {
      this.released.add(name);
      for (const waiter of this.waiting.get(name)?.values() ?? []) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
      this.waiting.delete(name);
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Who it was waiting for is read BEFORE it leaves the meeting (it is not waiting for itself). Then it gives up and leaves: a branch that
        // arrives later is told the meeting cannot happen (this branch ends right after, see `leave`).
        const missing = this.missing(name);
        this.waiting.get(name)?.delete(party);
        here.delete(party);
        reject(new BarrierTimeoutError(`barrier "${name}": still waiting for ${missing.join(', ')} after ${timeoutMs} ms`));
      }, timeoutMs);
      const waiters = this.waiting.get(name) ?? new Map<number, Waiter>();
      waiters.set(party, { resolve, reject, timer });
      this.waiting.set(name, waiters);
    });
  }

  /**
   * Branch `party` is over (a branch calls this when it ends, whatever the reason). Every barrier it did not reach can no longer happen: the
   * branches waiting there are released with an error, and a branch that gets there later is refused at once.
   */
  leave(party: number, how: BranchEnd): void {
    if (this.gone.has(party)) return;
    this.gone.set(party, how);
    for (const name of new Set([...this.arrived.keys(), ...this.waiting.keys()])) {
      if (this.released.has(name) || this.broken.has(name) || this.arrived.get(name)?.has(party)) continue;
      this.breakBarrier(name, this.reasonFor(name, party, how));
    }
  }

  private reasonFor(name: string, party: number, how: BranchEnd): string {
    return `barrier "${name}" can no longer happen: ${this.labels[party]} ${how === 'failed' ? 'failed' : 'ended'} before reaching it`;
  }

  /** The reason a barrier cannot happen any more, if a branch that has left never reached it. */
  private brokenReason(name: string): string | undefined {
    const known = this.broken.get(name);
    if (known !== undefined) return known;
    if (this.released.has(name)) return undefined;
    // Of the branches that left without reaching it, name the one that FAILED if there is one: that is the better explanation.
    const absent = [...this.gone].filter(([party]) => !this.arrived.get(name)?.has(party));
    const [party, how] = absent.find(([, end]) => end === 'failed') ?? absent[0] ?? [];
    if (party === undefined || how === undefined) return undefined;
    const reason = this.reasonFor(name, party, how);
    this.broken.set(name, reason);
    return reason;
  }

  private breakBarrier(name: string, reason: string): void {
    this.broken.set(name, reason);
    for (const waiter of this.waiting.get(name)?.values() ?? []) {
      clearTimeout(waiter.timer);
      waiter.reject(new BarrierBrokenError(reason));
    }
    this.waiting.delete(name);
  }

  private missing(name: string): string[] {
    const here = this.arrived.get(name);
    return this.labels.filter((_label, party) => !here?.has(party)).map((label) => label);
  }
}
