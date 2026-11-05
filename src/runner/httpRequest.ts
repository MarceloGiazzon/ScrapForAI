import type { APIRequestContext } from 'playwright';

import { DEFAULT_HTTP_METHODS, HTTP_MAX_RESPONSE_BYTES, HTTP_SENSITIVE_RESPONSE_HEADERS } from '../schemas/httpMethods.js';
import type { JsonValue } from '../schemas/explorationResult.schema.js';
import { validateTargetUrl } from '../security/validateTargetUrl.js';
import { readJsonPath } from './buildProbe.js';

/**
 * T5.7 `httpRequest`: one HTTP call made with the run's own session (the browser context's cookies), without a page.
 *
 * What keeps it inside the security model:
 *  - the URL goes through `validateTargetUrl` (a path like "/api/x" is resolved against the run's target URL first), so the allowlist applies exactly as
 *    for a navigation. Playwright's request client does not go through the context's routing layer, so this check is the whole guard;
 *  - redirects are NOT followed (`maxRedirects: 0`): a 3xx is the answer, so the call never leaves the URL that was validated;
 *  - the method must be in the target profile's `http.allowedMethods` (default GET/HEAD);
 *  - the caller sets no header but `Content-Type`, so a secret cannot ride in an `Authorization` header of a routine;
 *  - the answer is summarised, never copied: status, content type, size, and only the JSON paths / headers the step asks for (scalars only).
 */

export interface HttpStepInput {
  method: string;
  url: string;
  body?: string | undefined;
  contentType?: string | undefined;
  expectStatus?: number[] | undefined;
  extract?: Array<{ name: string; json?: string | undefined; header?: string | undefined }> | undefined;
}

export interface HttpOutcome {
  /** `extracted[step.name]`. */
  summary: { [key: string]: JsonValue };
  /** `extracted[entry.name]` for each `extract` entry that was found. */
  values: Record<string, JsonValue>;
  /** Set when the step must fail; the summary and the values are still kept as evidence. */
  failure?: string;
}

export class HttpStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HttpRequestError';
  }
}

const MAX_TEXT_VALUE_CHARS = 2000;

/** The path of a URL without query or fragment: a query may carry data, and it is what an error message must not echo. */
const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return '(invalid url)';
  }
};

export function resolveHttpUrl(url: string, baseUrl: string): string {
  return validateTargetUrl(url.startsWith('/') ? new URL(url, baseUrl).toString() : url);
}

function scalar(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > MAX_TEXT_VALUE_CHARS ? `${value.slice(0, MAX_TEXT_VALUE_CHARS)}...` : value;
  return undefined;
}

export async function executeHttpRequest(options: {
  client: APIRequestContext;
  step: HttpStepInput;
  baseUrl: string;
  allowedMethods?: readonly string[] | undefined;
  timeoutMs: number;
}): Promise<HttpOutcome> {
  const { step } = options;
  const method = step.method.toUpperCase();
  const allowed = options.allowedMethods ?? DEFAULT_HTTP_METHODS;
  if (!allowed.includes(method)) {
    throw new HttpStepError(`${method} is not allowed for this target (allowed: ${allowed.join(', ')}); the target profile lists them in http.allowedMethods`);
  }

  const url = resolveHttpUrl(step.url, options.baseUrl);
  const response = await options.client.fetch(url, {
    method,
    maxRedirects: 0,
    timeout: options.timeoutMs,
    failOnStatusCode: false,
    ...(step.body === undefined ? {} : { data: step.body, headers: { 'content-type': step.contentType ?? 'application/json' } }),
  });

  const status = response.status();
  const headers = response.headers();
  const buffer = method === 'HEAD' ? Buffer.alloc(0) : await response.body();
  const truncated = buffer.length > HTTP_MAX_RESPONSE_BYTES;
  const summary: HttpOutcome['summary'] = {
    method,
    pathname: pathOf(url),
    status,
    contentType: (headers['content-type'] ?? '').split(';')[0]!.trim(),
    bytes: buffer.length,
    ...(truncated ? { truncated: true } : {}),
  };

  const values: Record<string, JsonValue> = {};
  const expected = step.expectStatus ?? null;
  const statusOk = expected ? expected.includes(status) : status >= 200 && status < 300;
  const problems: string[] = [];
  if (!statusOk) problems.push(`${method} ${pathOf(url)} answered ${status} (expected ${expected ? expected.join('/') : '2xx'})`);

  let parsed: { ok: true; value: unknown } | { ok: false } | undefined;
  const json = (): { ok: true; value: unknown } | { ok: false } => {
    if (parsed) return parsed;
    if (truncated) return (parsed = { ok: false });
    try {
      parsed = { ok: true, value: JSON.parse(buffer.toString('utf8')) };
    } catch {
      parsed = { ok: false };
    }
    return parsed;
  };

  for (const entry of step.extract ?? []) {
    if (entry.header !== undefined) {
      const name = entry.header.toLowerCase();
      if (HTTP_SENSITIVE_RESPONSE_HEADERS.includes(name)) {
        problems.push(`extract "${entry.name}": the ${name} header carries a session or credential and is never copied`);
        continue;
      }
      const found = scalar(headers[name]);
      if (found === undefined) problems.push(`extract "${entry.name}": the response has no ${name} header`);
      else values[entry.name] = found;
      continue;
    }
    const body = json();
    if (!body.ok) {
      problems.push(`extract "${entry.name}": the response body is not JSON${truncated ? ' (it is larger than the limit)' : ''}`);
      continue;
    }
    const found = scalar(readJsonPath(body.value, entry.json!));
    if (found === undefined) problems.push(`extract "${entry.name}": the JSON path "${entry.json}" does not lead to a single value`);
    else values[entry.name] = found;
  }

  return { summary, values, ...(problems.length > 0 ? { failure: problems.join('; ') } : {}) };
}
