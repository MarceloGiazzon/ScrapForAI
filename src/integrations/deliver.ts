import { env } from '../config/env.js';
import { assertNotifyUrl } from './notifyPolicy.js';

/**
 * T3.3: the one HTTP POST that leaves the server. The URL is a secret, so nothing here puts it (or the response body, which some
 * services echo) into an error, a log line or a result: failures are described by a code only.
 *
 * - the origin is checked again right before sending (ALLOWED_NOTIFY_ORIGINS is re-read);
 * - redirects are NOT followed: a 3xx is a failure, so an allowlisted host cannot send the message somewhere else;
 * - a timeout (NOTIFY_TIMEOUT_MS), and one retry only for a network error, a timeout, 429 or 5xx.
 */

export interface DeliveryOutcome {
  status: 'sent' | 'failed';
  httpStatus?: number;
  attempts: number;
  reason?: string;
}

export interface DeliverOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A short, URL-free description of why `fetch` threw. */
function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timeout';
    const cause = (error as { cause?: { code?: unknown } }).cause;
    if (cause && typeof cause.code === 'string') return `network error ${cause.code}`;
  }
  return 'network error';
}

export async function deliverJson(url: string, payload: unknown, options: DeliverOptions = {}): Promise<DeliveryOutcome> {
  try {
    assertNotifyUrl(url);
  } catch (error) {
    return { status: 'failed', attempts: 0, reason: error instanceof Error ? error.message : 'destination not allowed' };
  }

  const timeoutMs = options.timeoutMs ?? env.NOTIFY_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? 2;
  const body = JSON.stringify(payload);
  let last: DeliveryOutcome = { status: 'failed', attempts: 0, reason: 'not attempted' };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let retryable = false;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'ScrapForAI-notify/1' },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      await response.body?.cancel().catch(() => undefined); // the body is never read: a service may echo the request
      if (response.status >= 200 && response.status < 300) return { status: 'sent', httpStatus: response.status, attempts: attempt };

      const redirected = response.status >= 300 && response.status < 400;
      retryable = response.status === 429 || response.status >= 500;
      last = { status: 'failed', httpStatus: response.status, attempts: attempt, reason: redirected ? `HTTP ${response.status} (redirects are not followed)` : `HTTP ${response.status}` };
    } catch (error) {
      retryable = true;
      last = { status: 'failed', attempts: attempt, reason: describeNetworkError(error) };
    }
    if (!retryable) break;
    if (attempt < maxAttempts) await sleep(options.retryDelayMs ?? 1000);
  }
  return last;
}
