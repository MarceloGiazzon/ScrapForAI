import { autoDraftBugReports } from '../bugreport/autoDraft.js';
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
    // T9.1: a failed run also prepares a bug report, when an integration asks for it. Independent of the webhook: one slow or broken does not hold the other.
    onSettled: (event) => Promise.all([notifySettled(event), autoDraftBugReports(event).catch((error) => onError(`bug report for schedule ${event.schedule.id}`, error))]),
    onTick: () => sendDueSummaries(),
  });
  await instance.start();
  return instance;
}

export function stopScheduler(): void {
  instance?.stop();
  instance = undefined;
}
