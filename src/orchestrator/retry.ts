/**
 * T3.5: the automatic new attempt of a failed scheduled run. One rule, in one place:
 *   - only a run that FAILED (its steps did not pass) is tried again, and at most `retries` times (the schedule says 0 or 1);
 *   - every attempt is a run of its own, with its own job id and evidence, and the caller metadata of the second one names the first
 *     (`attempt`, `retryOf`), so nothing is overwritten: the retry never hides the failure;
 *   - a run that could not execute at all (the attempt throws) is not an assertion failure and is not retried by this rule; if the NEW
 *     attempt is the one that throws, the attempts so far are kept and the error is reported next to them.
 */

export interface AttemptResult {
  status: string;
  jobId: string;
}

export interface Attempts<R> {
  /** Every attempt that produced a result, in order. The last one is the one that counts. */
  results: R[];
  /** The new attempt could not run (cancelled, credential busy and refused, ...): `results` still holds the earlier ones. */
  retryError?: unknown;
}

export async function runAttempts<R extends AttemptResult>(
  run: (attempt: number, previous: R | undefined) => Promise<R>,
  options: { retries: number; canRetry?: () => boolean },
): Promise<Attempts<R>> {
  const results: R[] = [await run(1, undefined)];

  while (results.length <= options.retries) {
    const last = results[results.length - 1]!;
    if (last.status !== 'failed' || options.canRetry?.() === false) break;

    try {
      results.push(await run(results.length + 1, last));
    } catch (retryError) {
      return { results, retryError };
    }
  }

  return { results };
}

/** What the caller metadata of a run says about its place among the attempts (empty for a first attempt). */
export function attemptMetadata(attempt: number, previous: { jobId: string } | undefined): Record<string, string> {
  return attempt > 1 && previous ? { attempt: String(attempt), retryOf: previous.jobId } : {};
}
