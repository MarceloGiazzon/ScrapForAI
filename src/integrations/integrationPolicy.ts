import { getLiveAllowedOrigins } from '../config/env.js';

/**
 * T9.1 egress policy for issue trackers. A bug report is data that leaves the server, together with a token, so the destination is checked against
 * ALLOWED_INTEGRATION_ORIGINS (exact origins; the list is re-read, so removing an origin stops sending at once) when the integration is saved and
 * again before every request. Nothing else is accepted: no credentials in the URL, no query, no fragment. `https` only, except `http` for a host on
 * this machine (a local Gitea/test server): a bearer token must not cross a network in clear text.
 */

export class IntegrationOriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrationOriginNotAllowed';
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Returns the parsed base URL, or throws an IntegrationOriginError. */
export function assertIntegrationUrl(input: string, allowedOrigins: string[] = getLiveAllowedOrigins('ALLOWED_INTEGRATION_ORIGINS')): URL {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new IntegrationOriginError('The integration API address is not a valid URL');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname))) {
    throw new IntegrationOriginError('The integration API address must be https (http is accepted only for localhost)');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new IntegrationOriginError('The integration API address may not carry a user name or password');
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new IntegrationOriginError('The integration API address may not have a query or a fragment');
  }
  if (allowedOrigins.length === 0) {
    throw new IntegrationOriginError(`No origin is allowed for integrations: set ALLOWED_INTEGRATION_ORIGINS (it must include ${parsed.origin})`);
  }
  if (!allowedOrigins.includes(parsed.origin)) {
    throw new IntegrationOriginError(`Origin ${parsed.origin} is not in ALLOWED_INTEGRATION_ORIGINS`);
  }
  return parsed;
}
