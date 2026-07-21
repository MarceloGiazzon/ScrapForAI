import { mcpConfig } from './config.js';

export class ScrapForAiRequestError extends Error {
  readonly status: number;
  readonly type: string;

  constructor(status: number, type: string, message: string) {
    super(message);
    this.name = 'ScrapForAiRequestError';
    this.status = status;
    this.type = type;
  }
}

interface ErrorEnvelope {
  error?: {
    type?: string;
    message?: string;
    details?: Array<{ path: string; message: string }>;
  };
}

function hasJobStatus(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }

  const status = (payload as Record<string, unknown>).status;
  return status === 'passed' || status === 'failed';
}

function describeError(payload: unknown, status: number): { type: string; message: string } {
  const envelope = payload as ErrorEnvelope | undefined;
  const error = envelope?.error;

  if (!error) {
    return { type: 'HttpError', message: `ScrapForAI API responded with status ${status}` };
  }

  const details = error.details?.map((detail) => `${detail.path}: ${detail.message}`).join('; ');
  const message = details ? `${error.message ?? 'Request failed'} (${details})` : (error.message ?? 'Request failed');

  return { type: error.type ?? 'HttpError', message };
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const url = new URL(path, mcpConfig.baseUrl);
  let response: Response;

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${mcpConfig.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(mcpConfig.requestTimeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new ScrapForAiRequestError(504, 'RequestTimeout', `ScrapForAI API did not respond within ${mcpConfig.requestTimeoutMs}ms`);
    }

    throw new ScrapForAiRequestError(502, 'RequestFailed', error instanceof Error ? error.message : 'Failed to reach the ScrapForAI API');
  }

  const payload = await response.json().catch(() => undefined);

  // A job that failed mid-run (a step assertion failed, a timeout hit, etc.) is still a
  // successful API call: it comes back as HTTP 500 but with a full ExplorationResult /
  // DomInspectionResult body (status: 'failed', steps, evidence, ...), not the generic
  // { error: { type, message } } envelope. Only the latter is a real transport failure.
  if (response.ok || hasJobStatus(payload)) {
    return payload;
  }

  const { type, message } = describeError(payload, response.status);
  throw new ScrapForAiRequestError(response.status, type, message);
}

export function runExploration(body: unknown): Promise<unknown> {
  return postJson('/v1/explorations/run', body);
}

export function inspectDom(body: unknown): Promise<unknown> {
  return postJson('/v1/explorations/inspect-dom', body);
}
