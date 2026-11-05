import crypto from 'node:crypto';

import { env } from '../config/env.js';
import { masterPrincipal, type Principal } from '../team/principal.js';

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
  /** Who signed in (T10.1). A session never outlives the person: apiAuth re-checks that user and key on every request. */
  principal: Principal;
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

export function createSession(principal: Principal = masterPrincipal('session')): { token: string; maxAgeSeconds: number } {
  const now = Date.now();
  sweepExpired(now);

  const maxAgeSeconds = env.SESSION_TTL_MINUTES * 60;
  const token = crypto.randomBytes(32).toString('base64url');

  sessions.set(token, { createdAt: now, expiresAt: now + maxAgeSeconds * 1000, principal: { ...principal, via: 'session' } });

  return { token, maxAgeSeconds };
}

/** The person a live session belongs to, or undefined (no such session, or it expired). */
export function getSessionPrincipal(token: string | undefined): Principal | undefined {
  if (!token) {
    return undefined;
  }

  const session = sessions.get(token);
  if (!session) {
    return undefined;
  }

  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return undefined;
  }

  return session.principal;
}

export function isValidSession(token: string | undefined): boolean {
  return getSessionPrincipal(token) !== undefined;
}

/** Ends every session of a user (disabled, deleted, key revoked): the next request would fail the re-check anyway; this also frees the memory. */
export function destroySessionsOf(userId: string): number {
  let ended = 0;
  for (const [token, session] of sessions) {
    if (session.principal.userId === userId) {
      sessions.delete(token);
      ended += 1;
    }
  }
  return ended;
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
