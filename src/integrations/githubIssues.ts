import { env } from '../config/env.js';
import { assertIntegrationUrl } from './integrationPolicy.js';

/**
 * T9.1 GitHub Issues adapter: the HTTP that leaves the server. The token is a secret, so nothing here puts it (or a reply body, which a service may
 * echo) into an error, a log line or a result: a failure is described by a code and a fixed sentence.
 *
 *   - the origin is checked again right before sending (ALLOWED_INTEGRATION_ORIGINS is re-read);
 *   - redirects are NOT followed (an allowlisted host cannot bounce the token or the report elsewhere): a 3xx is a failure;
 *   - NO retry: creating an issue is not idempotent, a request that timed out may have been received, and a second issue is worse than a
 *     failed send that a person repeats;
 *   - the body of an ERROR reply is never read. The body of a success is read (bounded) for two things only: the issue number and its address.
 */

export interface IssueRef {
  /** 0 when the issue was created but the reply could not be read. */
  number: number;
  url: string;
}

export type TrackerOutcome = { ok: true; issue: IssueRef } | { ok: false; reason: string; httpStatus?: number };

export interface GithubTarget {
  apiBaseUrl: string;
  repo: string;
  token: string;
}

export interface IssueContent {
  title: string;
  body: string;
  labels: string[];
}

const MAX_REPLY_BYTES = 256 * 1024;

const REASONS: Record<number, string> = {
  401: 'the token was rejected (HTTP 401)',
  403: 'forbidden: the token lacks permission for this repository, or a rate limit was hit (HTTP 403)',
  404: 'repository not found, or the token cannot see it (HTTP 404)',
  410: 'issues are disabled for this repository (HTTP 410)',
  422: 'GitHub refused the issue (HTTP 422: validation failed)',
};

function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timeout';
    const cause = (error as { cause?: { code?: unknown } }).cause;
    if (cause && typeof cause.code === 'string') return `network error ${cause.code}`;
  }
  return 'network error';
}

function failureOf(status: number): TrackerOutcome {
  if (status >= 300 && status < 400) return { ok: false, httpStatus: status, reason: `HTTP ${status} (redirects are not followed)` };
  return { ok: false, httpStatus: status, reason: REASONS[status] ?? `HTTP ${status}` };
}

/** Reads at most MAX_REPLY_BYTES of a reply and parses it as JSON; undefined when it is too big or not JSON. */
async function readJsonBounded(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REPLY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

function endpoint(target: GithubTarget, suffix: string): string {
  const base = assertIntegrationUrl(target.apiBaseUrl);
  const [owner, name] = target.repo.split('/') as [string, string];
  return `${base.origin}${base.pathname.replace(/\/+$/, '')}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${suffix}`;
}

function headers(token: string, withBody: boolean): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'ScrapForAI-bugreport/1',
    ...(withBody ? { 'content-type': 'application/json' } : {}),
  };
}

/** The address of the issue as the service reports it, accepted only if it is a plain http(s) URL (it is shown to people and put in reports). */
function safeIssueUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 500) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '') return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export async function createGithubIssue(target: GithubTarget, content: IssueContent, options: { timeoutMs?: number } = {}): Promise<TrackerOutcome> {
  let url: string;
  try {
    url = endpoint(target, '/issues');
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'destination not allowed' };
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: headers(target.token, true),
      body: JSON.stringify({ title: content.title, body: content.body, ...(content.labels.length > 0 ? { labels: content.labels } : {}) }),
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? env.INTEGRATION_TIMEOUT_MS),
    });
    if (response.status !== 201) {
      await response.body?.cancel().catch(() => undefined); // an error reply is never read: a service may echo the request
      return failureOf(response.status);
    }
    const reply = (await readJsonBounded(response)) as { number?: unknown; html_url?: unknown } | undefined;
    const number = reply && typeof reply.number === 'number' && Number.isInteger(reply.number) && reply.number > 0 ? reply.number : undefined;
    const issueUrl = safeIssueUrl(reply?.html_url);
    // 201 = the issue exists. Not being able to read where it is must not look like a failure (a retry would create a second one).
    return { ok: true, issue: { number: number ?? 0, url: issueUrl ?? '' } };
  } catch (error) {
    return { ok: false, reason: describeNetworkError(error) };
  }
}

/** `integrations test`: can this token see the repository, and does it have issues turned on? Reads only the two fields it needs. */
export async function checkGithubAccess(target: GithubTarget, options: { timeoutMs?: number } = {}): Promise<{ ok: true; issuesEnabled: boolean } | { ok: false; reason: string; httpStatus?: number }> {
  let url: string;
  try {
    url = endpoint(target, '');
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'destination not allowed' };
  }
  try {
    const response = await fetch(url, { method: 'GET', headers: headers(target.token, false), redirect: 'manual', signal: AbortSignal.timeout(options.timeoutMs ?? env.INTEGRATION_TIMEOUT_MS) });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      const failure = failureOf(response.status);
      return failure.ok ? { ok: false, reason: `HTTP ${response.status}` } : failure;
    }
    const reply = (await readJsonBounded(response)) as { has_issues?: unknown } | undefined;
    return { ok: true, issuesEnabled: reply?.has_issues !== false };
  } catch (error) {
    return { ok: false, reason: describeNetworkError(error) };
  }
}
