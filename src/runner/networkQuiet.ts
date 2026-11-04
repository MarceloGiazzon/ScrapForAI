import { setTimeout as sleep } from 'node:timers/promises';

import type { BrowserContext, Page } from 'playwright';

import type { JsonValue } from '../schemas/explorationResult.schema.js';
import { installTrustedInitScript, runTrustedScript } from './trusted/runTrusted.js';

/**
 * T8.2: wait until the page is QUIET: no XHR/fetch pending, in any frame, for `idleMs`. The counting happens in the page (the trusted script
 * `net-tracker`, installed only for a run that waits for quiet); the timing happens HERE, in the server, with the real clock, so a fake browser clock
 * (T7.3) cannot change it.
 */

export const DEFAULT_IDLE_MS = 300;
export const POLL_MS = 50;

/** What one frame reports: its pending count and a counter that grows at every start and end. */
export interface FrameNetState {
  pending: number;
  seq: number;
}

/** `null` = the frame has no tracker (nothing to wait for there); `'unavailable'` = it could not be read right now (navigating): not quiet. */
export type FrameReading = FrameNetState | null | 'unavailable';

export function usesQuiet(request: { steps: readonly object[]; teardown?: readonly object[] }): boolean {
  return [...request.steps, ...(request.teardown ?? [])].some((step) => {
    const candidate = step as { action?: string; waitFor?: { quiet?: unknown }; afterWaitFor?: { quiet?: unknown } };
    return candidate.action === 'waitForQuiet' || candidate.waitFor?.quiet !== undefined || candidate.afterWaitFor?.quiet !== undefined;
  });
}

/**
 * Pure decision. Feed it one reading of all frames per poll, with the time of the poll: it is quiet when nothing is pending and NOTHING CHANGED
 * (no request started or ended, no frame appeared or went away) for `idleMs`.
 */
export class QuietDetector {
  private signature: string | undefined;
  private changedAt = 0;

  constructor(private readonly idleMs: number) {}

  observe(readings: ReadonlyMap<string, FrameReading>, now: number): { quiet: boolean; pending: number } {
    let pending = 0;
    let unreadable = false;
    const parts: string[] = [];

    for (const [key, reading] of [...readings].sort(([a], [b]) => a.localeCompare(b))) {
      if (reading === 'unavailable') {
        unreadable = true;
        parts.push(`${key}:?`);
      } else if (reading === null) {
        parts.push(`${key}:-`);
      } else {
        pending += reading.pending;
        parts.push(`${key}:${reading.pending}:${reading.seq}`);
      }
    }

    const signature = parts.join('|');
    if (signature !== this.signature || unreadable) {
      this.signature = signature;
      this.changedAt = now;
    }

    return { quiet: pending === 0 && !unreadable && now - this.changedAt >= this.idleMs, pending };
  }
}

export class NetworkQuietTimeout extends Error {
  constructor(
    readonly pending: number,
    readonly timeoutMs: number,
  ) {
    super(
      pending > 0
        ? `Timeout waiting for network quiet: ${pending} XHR/fetch request(s) still pending after ${timeoutMs} ms`
        : `Timeout waiting for network quiet: the page kept making requests for ${timeoutMs} ms`,
    );
    this.name = 'NetworkQuietTimeout';
  }
}

export interface WaitDeps {
  read(): Promise<ReadonlyMap<string, FrameReading>>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** The loop, with its clock and its reader injected so it can be tested without a browser. */
export async function waitUntilQuiet(options: { idleMs?: number; timeoutMs: number }, deps: WaitDeps): Promise<void> {
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  if (idleMs > options.timeoutMs) {
    throw new Error(`idleMs (${idleMs}) is longer than the timeout (${options.timeoutMs} ms): the page could never be quiet for that long in time`);
  }

  const detector = new QuietDetector(idleMs);
  const started = deps.now();
  let lastPending = 0;

  for (;;) {
    const now = deps.now();
    const state = detector.observe(await deps.read(), now);
    lastPending = state.pending;
    if (state.quiet) return;
    if (now - started >= options.timeoutMs) throw new NetworkQuietTimeout(lastPending, options.timeoutMs);
    await deps.sleep(POLL_MS);
  }
}

/** Installs the request counter in every document of every frame of the context. Call it before the first page loads. */
export async function installNetworkTracker(context: BrowserContext): Promise<void> {
  await installTrustedInitScript(context, 'net-tracker');
}

/** Reads the counter of every frame of the page. */
export async function readFrames(page: Page): Promise<Map<string, FrameReading>> {
  const frames = page.frames();
  const readings = await Promise.all(
    frames.map(async (frame, index): Promise<[string, FrameReading]> => {
      try {
        const value = (await runTrustedScript(frame, 'net-state')) as JsonValue;
        if (value === null) return [String(index), null];
        const state = value as { pending?: unknown; seq?: unknown };
        return typeof state.pending === 'number' && typeof state.seq === 'number' ? [String(index), { pending: state.pending, seq: state.seq }] : [String(index), 'unavailable'];
      } catch {
        return [String(index), 'unavailable'];
      }
    }),
  );
  return new Map(readings);
}

export function waitForNetworkQuiet(page: Page, options: { idleMs?: number; timeoutMs: number }): Promise<void> {
  return waitUntilQuiet(options, { read: () => readFrames(page), now: () => Date.now(), sleep: (ms) => sleep(ms) });
}
