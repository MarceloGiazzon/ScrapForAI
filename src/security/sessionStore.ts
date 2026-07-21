import crypto from 'node:crypto';

import { env } from '../config/env.js';

/**
 * In-memory session store.
 *
 * Sessions intentionally do not survive a restart: this is a single-process, single-user
 * local tool, and forcing re-login after a restart is a feature, not a limitation. Do not
 * persist these to disk.
 */

interface Session {
  createdAt: number;
  expiresAt: number;
}

const sessions = new Map<string, Session>();

export const SESSION_COOKIE_NAME = 'sfa_session';

function sweepExpired(now: number): void {
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

export function createSession(): { token: string; maxAgeSeconds: number } {
  const now = Date.now();
  sweepExpired(now);

  const maxAgeSeconds = env.SESSION_TTL_MINUTES * 60;
  const token = crypto.randomBytes(32).toString('base64url');

  sessions.set(token, { createdAt: now, expiresAt: now + maxAgeSeconds * 1000 });

  return { token, maxAgeSeconds };
}

export function isValidSession(token: string | undefined): boolean {
  if (!token) {
    return false;
  }

  const session = sessions.get(token);
  if (!session) {
    return false;
  }

  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }

  return true;
}

export function destroySession(token: string | undefined): void {
  if (token) {
    sessions.delete(token);
  }
}

export function activeSessionCount(): number {
  sweepExpired(Date.now());
  return sessions.size;
}
