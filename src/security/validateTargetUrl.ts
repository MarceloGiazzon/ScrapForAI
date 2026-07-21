import net from 'node:net';

import { getLiveAllowedOrigins } from '../config/env.js';

export class TargetUrlNotAllowedError extends Error {
  constructor(message = 'Target URL origin is not allowlisted') {
    super(message);
    this.name = 'TargetUrlNotAllowed';
  }
}

const BLOCKED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain']);
const METADATA_IPS = new Set(['169.254.169.254']);

function isPrivateIp(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  const ipVersion = net.isIP(host);

  if (ipVersion === 4) {
    const [a = 0, b = 0] = host.split('.').map((part) => Number.parseInt(part, 10));

    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      a === 0
    );
  }

  if (ipVersion === 6) {
    const normalized = host.toLowerCase();
    return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80');
  }

  return false;
}

function assertHttpUrl(parsed: URL): void {
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TargetUrlNotAllowedError('Only http and https URLs are allowed');
  }
}

export function validateTargetUrl(input: string, allowedOrigins = getLiveAllowedOrigins('ALLOWED_TARGET_ORIGINS')): string {
  let parsed: URL;

  try {
    parsed = new URL(input);
  } catch {
    throw new TargetUrlNotAllowedError('Target URL is invalid');
  }

  assertHttpUrl(parsed);

  const hostname = parsed.hostname.toLowerCase();
  const explicitlyAllowlisted = allowedOrigins.includes(parsed.origin);

  if (BLOCKED_HOSTNAMES.has(hostname) && !explicitlyAllowlisted) {
    throw new TargetUrlNotAllowedError('Localhost target URLs are not allowed');
  }

  if (METADATA_IPS.has(hostname) && !explicitlyAllowlisted) {
    throw new TargetUrlNotAllowedError('Cloud metadata target URLs are not allowed');
  }

  if (isPrivateIp(hostname) && !explicitlyAllowlisted) {
    throw new TargetUrlNotAllowedError('Private IP target URLs are not allowed');
  }

  if (!explicitlyAllowlisted) {
    throw new TargetUrlNotAllowedError();
  }

  // TODO: add DNS-resolution based SSRF checks before supporting broader host policies.
  return parsed.toString();
}

export function isAllowedResourceUrl(input: string): boolean {
  try {
    const parsed = new URL(input);
    assertHttpUrl(parsed);
    return [...getLiveAllowedOrigins('ALLOWED_TARGET_ORIGINS'), ...getLiveAllowedOrigins('ALLOWED_RESOURCE_ORIGINS')].includes(
      parsed.origin,
    );
  } catch {
    return false;
  }
}
