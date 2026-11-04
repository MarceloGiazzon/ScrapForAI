import type { Schedule, ScheduleHistoryEntry, ScheduleState } from '../schemas/schedule.schema.js';
import { parseCron } from './cron.js';
import { decideTick } from './plan.js';
import { getSchedule, listSchedules, updateState } from './scheduleStore.js';

/**
 * T3.2 engine. Every `tickMs` it looks at each enabled schedule and decides, with the pure `decideTick`, whether an occurrence is due:
 *   - at most ONE run per tick per schedule, however many occurrences piled up (the rest are recorded as `missed`): this is also how the
 *     single recovery after downtime works, since the cursor is persisted;
 *   - `overlap: skip`: if the previous run of that schedule is still going, the occurrence is recorded as `skipped-overlap` and not queued;
 *   - the target is started through a `Dispatcher`, which is the only part that knows about browsers and queues (so the engine is testable
 *     with a fake one and a fake clock).
 */

export type RunRef = { kind: 'run' | 'suite' | 'snapshot'; id: string };

/** What a notification may say about the run, in plain strings and numbers (T3.3). The notifier cleans every string before it leaves. */
export interface SettledFacts {
  runId?: string;
  buildId?: string;
  counts?: Record<string, number>;
  /** At most a handful of short lines, e.g. "crud@v2/cred:admin: AssertionFailed". */
  failures?: string[];
}

export interface Settled {
  outcome: 'passed' | 'failed' | 'error';
  message?: string;
  facts?: SettledFacts;
  /** T3.5: every attempt of a routine run, when there was more than one. The outcome is that of the last. */
  attempts?: NonNullable<ScheduleHistoryEntry['attempts']>;
  passedOnRetry?: boolean;
}

/** A scheduled occurrence reached a result (or could not start). Handed to `onSettled` once the history is written. */
export interface SettledEvent {
  schedule: Schedule;
  outcome: ScheduleHistoryEntry['outcome'];
  /** The occurrence. */
  at: string;
  finishedAt: string;
  message?: string;
  run?: RunRef;
  facts?: SettledFacts;
  manual: boolean;
  recovered: boolean;
}

export type Dispatched =
  | { started: true; run: RunRef; done: Promise<Settled> }
  | { started: false; outcome: 'skipped-evaluate' | 'error'; message: string };

export interface Dispatcher {
  start(schedule: Schedule, occurrenceIso: string): Promise<Dispatched>;
  /** The final state of a run this process did not start (after a restart), or undefined when it cannot be told. */
  settledState(run: RunRef): Promise<Settled | undefined>;
}

export interface SchedulerOptions {
  dispatcher: Dispatcher;
  now?: () => number;
  tickMs?: number;
  onError?: (message: string, error: unknown) => void;
  /** T3.3: called after an occurrence's result is in the history. Runs apart from the schedule (a slow webhook never delays the next occurrence). */
  onSettled?: (event: SettledEvent) => Promise<unknown>;
  /** T3.3: called on each tick (daily summaries). One at a time: a tick that finds the previous call still going skips it. */
  onTick?: (nowMs: number) => Promise<unknown>;
}

const MISSED_NOTE = 'the server was not running (or the tick was late) at this time';

export class Scheduler {
  private readonly now: () => number;
  private readonly live = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> = Promise.resolve();
  /** Notification work in flight (T3.3), so `idle()` can wait for it. */
  private readonly background = new Set<Promise<unknown>>();
  private tickWork: Promise<unknown> | undefined;

  constructor(private readonly options: SchedulerOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Reconciles runs left over from a previous process, ticks once (the recovery), then every `tickMs`. */
  async start(): Promise<void> {
    await this.reconcile();
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.tickMs ?? 15_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Waits for every run this process started (tests). */
  async idle(): Promise<void> {
    await this.ticking;
    await Promise.all([...this.live.values()]);
    while (this.background.size > 0) await Promise.all([...this.background]);
  }

  private track(work: Promise<unknown>): void {
    this.background.add(work);
    void work.finally(() => this.background.delete(work));
  }

  private emitSettled(event: SettledEvent): void {
    const { onSettled } = this.options;
    if (!onSettled) return;
    this.track(onSettled(event).catch((error) => this.options.onError?.(`notification for schedule ${event.schedule.id}`, error)));
  }

  private startTickWork(): void {
    const { onTick } = this.options;
    if (!onTick || this.tickWork) return;
    const work = onTick(this.now())
      .catch((error) => this.options.onError?.('scheduler tick work failed', error))
      .finally(() => void (this.tickWork = undefined));
    this.tickWork = work;
    this.track(work);
  }

  isRunning(scheduleId: string): boolean {
    return this.live.has(scheduleId);
  }

  /** Serialized: two overlapping ticks (a slow one and the next timer) would both see the same cursor. */
  tick(): Promise<void> {
    this.ticking = this.ticking.then(() => this.runTick()).catch((error) => this.options.onError?.('scheduler tick failed', error));
    return this.ticking;
  }

  private async runTick(): Promise<void> {
    for (const { schedule } of await listSchedules()) {
      if (!schedule.enabled) continue;
      try {
        await this.process(schedule);
      } catch (error) {
        this.options.onError?.(`schedule ${schedule.id}`, error);
      }
    }
    this.startTickWork();
  }

  private async process(schedule: Schedule): Promise<void> {
    const nowMs = this.now();
    const state = await updateState(schedule.id, () => undefined, new Date(nowMs).toISOString());
    const decision = decideTick({
      id: schedule.id,
      spec: parseCron(schedule.cron),
      timeZone: schedule.timezone,
      jitterSeconds: schedule.jitterSeconds,
      cursorMs: Date.parse(state.cursor),
      nowMs,
    });
    if (!decision.fire) return;

    const { at, recovered } = decision.fire;
    const atIso = new Date(at).toISOString();
    const busy = this.live.has(schedule.id) || state.running !== undefined;

    // Everything older than the occurrence that runs was missed: one summary entry, not one per occurrence.
    const missedEntry: ScheduleHistoryEntry | undefined =
      decision.missed.length === 0
        ? undefined
        : { at: new Date(decision.missed[0]!).toISOString(), outcome: 'missed', count: decision.missed.length + (decision.truncated ? 1 : 0), message: MISSED_NOTE };

    if (busy) {
      await updateState(
        schedule.id,
        (current) => {
          if (missedEntry) current.history.push(missedEntry);
          current.history.push({ at: atIso, outcome: 'skipped-overlap', message: `the previous run (${current.running?.id ?? 'in this process'}) was still going` });
          current.cursor = new Date(decision.cursor).toISOString();
        },
        state.cursor,
      );
      return;
    }

    await this.fire(schedule, atIso, { recovered, cursor: new Date(decision.cursor).toISOString(), ...(missedEntry ? { missedEntry } : {}) });
  }

  /**
   * Starts the target now, outside the clock (`run-now`). Honors overlap. The cursor is not moved, so the next occurrence still happens.
   */
  async runNow(scheduleId: string): Promise<ScheduleHistoryEntry> {
    const stored = await getSchedule(scheduleId);
    if (!stored) throw new Error(`schedule "${scheduleId}" does not exist`);
    const atIso = new Date(this.now()).toISOString();
    const state = await updateState(scheduleId, () => undefined, atIso);

    if (this.live.has(scheduleId) || state.running) {
      const entry: ScheduleHistoryEntry = { at: atIso, outcome: 'skipped-overlap', manual: true, message: `the previous run (${state.running?.id ?? 'in this process'}) is still going` };
      await updateState(scheduleId, (current) => void current.history.push(entry), atIso);
      return entry;
    }
    return this.fire(stored.schedule, atIso, { recovered: false, manual: true });
  }

  private async fire(
    schedule: Schedule,
    atIso: string,
    options: { recovered: boolean; manual?: boolean; cursor?: string; missedEntry?: ScheduleHistoryEntry },
  ): Promise<ScheduleHistoryEntry> {
    const firedAt = new Date(this.now()).toISOString();
    const base: ScheduleHistoryEntry = { at: atIso, firedAt, outcome: 'started', ...(options.recovered ? { recovered: true } : {}), ...(options.manual ? { manual: true } : {}) };

    let dispatched: Dispatched;
    try {
      dispatched = await this.options.dispatcher.start(schedule, atIso);
    } catch (error) {
      dispatched = { started: false, outcome: 'error', message: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 500) : String(error) };
    }

    if (!dispatched.started) {
      const entry: ScheduleHistoryEntry = { ...base, outcome: dispatched.outcome, finishedAt: firedAt, message: dispatched.message };
      await updateState(
        schedule.id,
        (current) => {
          if (options.missedEntry) current.history.push(options.missedEntry);
          current.history.push(entry);
          if (options.cursor) current.cursor = options.cursor;
        },
        atIso,
      );
      // It never started, so nobody will say it again: a target that cannot run is news for the channel too.
      this.emitSettled({ schedule, outcome: entry.outcome, at: atIso, finishedAt: firedAt, message: dispatched.message, manual: options.manual === true, recovered: options.recovered });
      return entry;
    }

    const entry: ScheduleHistoryEntry = { ...base, run: dispatched.run };
    await updateState(
      schedule.id,
      (current) => {
        if (options.missedEntry) current.history.push(options.missedEntry);
        current.history.push(entry);
        current.running = { ...dispatched.run, startedAt: firedAt, at: atIso };
        if (options.cursor) current.cursor = options.cursor;
      },
      atIso,
    );

    const finished = dispatched.done
      .catch((error): Settled => ({ outcome: 'error', message: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 500) : String(error) }))
      .then((settled) => this.settle(schedule, atIso, firedAt, settled, dispatched.run, { manual: options.manual === true, recovered: options.recovered }))
      .finally(() => void this.live.delete(schedule.id));
    this.live.set(schedule.id, finished);
    return entry;
  }

  private async settle(
    schedule: Schedule,
    atIso: string,
    firedAt: string,
    settled: Settled,
    run: RunRef,
    // `quiet`: the result is a guess (the process that ran it died and nothing says how it ended): recorded, but not announced as a failure.
    flags: { manual: boolean; recovered: boolean; quiet?: boolean },
  ): Promise<void> {
    const scheduleId = schedule.id;
    const finishedAt = new Date(this.now()).toISOString();
    await updateState(
      scheduleId,
      (current) => {
        const entry = lastWhere(current.history, (candidate) => candidate.at === atIso && candidate.firedAt === firedAt);
        if (entry) {
          entry.outcome = settled.outcome;
          entry.finishedAt = finishedAt;
          if (settled.message) entry.message = settled.message;
          if (settled.attempts) entry.attempts = settled.attempts;
          if (settled.passedOnRetry) entry.passedOnRetry = true;
        }
        delete current.running;
      },
      atIso,
    );
    if (flags.quiet) return;
    this.emitSettled({
      schedule,
      outcome: settled.outcome,
      at: atIso,
      finishedAt,
      ...(settled.message ? { message: settled.message } : {}),
      run,
      ...(settled.facts ? { facts: settled.facts } : {}),
      manual: flags.manual,
      recovered: flags.recovered,
    });
  }

  /** At startup: a run recorded as in progress belongs to a previous process. Ask what became of it; if unknown, it is an error. */
  async reconcile(): Promise<void> {
    for (const { schedule } of await listSchedules()) {
      const state = await updateState(schedule.id, () => undefined, new Date(this.now()).toISOString());
      const running = state.running;
      if (!running || this.live.has(schedule.id)) continue;

      const known = await this.options.dispatcher.settledState({ kind: running.kind, id: running.id }).catch(() => undefined);
      const settled: Settled = known ?? { outcome: 'error', message: 'the server stopped while this run was in progress' };
      const entry = lastWhere(state.history, (candidate) => candidate.at === running.at && candidate.run?.id === running.id);
      await this.settle(schedule, running.at, entry?.firedAt ?? running.startedAt, settled, { kind: running.kind, id: running.id }, { manual: entry?.manual === true, recovered: entry?.recovered === true, quiet: known === undefined });
    }
  }
}

export type { ScheduleState };

function lastWhere<T>(items: T[], test: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) if (test(items[i]!)) return items[i];
  return undefined;
}
