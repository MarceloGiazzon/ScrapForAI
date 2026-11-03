import { env } from '../config/env.js';
import { createDispatcher } from './dispatcher.js';
import { Scheduler } from './scheduler.js';

/** The one scheduler of this server process, present only when SCHEDULER_ENABLED=true. */
let instance: Scheduler | undefined;

export const getScheduler = (): Scheduler | undefined => instance;

export async function startScheduler(onError: (message: string, error: unknown) => void): Promise<Scheduler | undefined> {
  if (!env.SCHEDULER_ENABLED || instance) return instance;
  instance = new Scheduler({ dispatcher: createDispatcher(), tickMs: Math.max(1, env.SCHEDULER_TICK_SECONDS) * 1000, onError });
  await instance.start();
  return instance;
}

export function stopScheduler(): void {
  instance?.stop();
  instance = undefined;
}
