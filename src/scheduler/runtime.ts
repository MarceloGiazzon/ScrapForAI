import { env } from '../config/env.js';
import { notifySettled, sendDueSummaries } from '../integrations/notifier.js';
import { createDispatcher } from './dispatcher.js';
import { Scheduler } from './scheduler.js';

/** The one scheduler of this server process, present only when SCHEDULER_ENABLED=true. */
let instance: Scheduler | undefined;

export const getScheduler = (): Scheduler | undefined => instance;

export async function startScheduler(onError: (message: string, error: unknown) => void): Promise<Scheduler | undefined> {
  if (!env.SCHEDULER_ENABLED || instance) return instance;
  instance = new Scheduler({
    dispatcher: createDispatcher(),
    tickMs: Math.max(1, env.SCHEDULER_TICK_SECONDS) * 1000,
    onError,
    // T3.3: webhooks hear about CHANGES of a schedule's verdict, and once a day if they asked. Neither can fail a run.
    onSettled: (event) => notifySettled(event),
    onTick: () => sendDueSummaries(),
  });
  await instance.start();
  return instance;
}

export function stopScheduler(): void {
  instance?.stop();
  instance = undefined;
}
