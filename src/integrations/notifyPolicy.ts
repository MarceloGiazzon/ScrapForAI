import { getLiveAllowedOrigins } from '../config/env.js';

/**
 * T3.3 egress policy. A webhook is the one place this server sends data OUT, so the destination is checked against
 * ALLOWED_NOTIFY_ORIGINS (exact origins) when the webhook is saved and again on every send (the list is re-read, so removing an origin
 * stops delivery at once). Nothing else is allowed: no credentials in the URL, no fragment, http(s) only. Redirects are never followed
 * (see deliver.ts), so an allowlisted host cannot bounce a message elsewhere.
 */

export class NotifyOriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotifyOriginNotAllowed';
  }
}

/** Returns the parsed URL, or throws a NotifyOriginError whose message never contains the URL (its path is a secret). */
export function assertNotifyUrl(input: string, allowedOrigins: string[] = getLiveAllowedOrigins('ALLOWED_NOTIFY_ORIGINS')): URL {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new NotifyOriginError('The webhook URL is not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new NotifyOriginError('Only http and https webhook URLs are allowed');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new NotifyOriginError('A webhook URL may not carry a user name or password');
  }
  if (parsed.hash !== '') {
    throw new NotifyOriginError('A webhook URL may not have a fragment');
  }
  if (allowedOrigins.length === 0) {
    throw new NotifyOriginError(`No origin is allowed for notifications: set ALLOWED_NOTIFY_ORIGINS (it must include ${parsed.origin})`);
  }
  if (!allowedOrigins.includes(parsed.origin)) {
    throw new NotifyOriginError(`Origin ${parsed.origin} is not in ALLOWED_NOTIFY_ORIGINS`);
  }
  return parsed;
}
