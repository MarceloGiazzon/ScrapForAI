import crypto from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

import { env } from '../config/env.js';
import { readCookie } from './cookies.js';
import { appendAudit, REF_KEYS } from '../team/audit.js';
import { auditActor, masterPrincipal, type Principal } from '../team/principal.js';
import { requiredRole, roleAtLeast } from '../team/roles.js';
import { authenticateUserKey, currentIdentity } from '../team/userStore.js';
import { SESSION_COOKIE_NAME, getSessionPrincipal } from './sessionStore.js';

/** Header the UI must send on state-changing, cookie-authenticated requests. */
export const UI_REQUEST_HEADER = 'x-scrapforai-ui';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** How this request authenticated. Set by apiAuth. */
      authMethod?: 'bearer' | 'session';
      /** Who made the request (T10.1). Set by apiAuth, for every route that is not public. */
      principal?: Principal;
    }
  }
}

export function timingSafeEqualText(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    crypto.timingSafeEqual(leftBuffer, leftBuffer);
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

/** Routes reachable without authentication. */
function isPublicPath(req: Request): boolean {
  if (req.method === 'GET' && (req.path === '/health' || req.path === '/v1/schema' || req.path.startsWith('/v1/schema/'))) {
    return true;
  }

  // The login endpoint cannot require the session it creates.
  if (req.method === 'POST' && req.path === '/v1/auth/login') {
    return true;
  }

  // Static UI assets contain no data; every data route behind them is authenticated.
  // '/' is included because it only issues a redirect to /ui/, which is itself public:
  // without it, opening the server root in a browser returns a JSON 401 instead of the
  // login page.
  if (req.method === 'GET' && (req.path === '/' || req.path === '/ui' || req.path.startsWith('/ui/'))) {
    return true;
  }

  return false;
}

/**
 * A key the server accepts: the installation's own (`SCRAPFORAI_API_KEY`, acts as `root`, an admin) or a personal one (T10.1). The same check
 * serves a request's Bearer header and the sign-in form of the web console (`via` says which).
 */
export async function authenticateToken(token: string, via: Principal['via']): Promise<Principal | undefined> {
  if (timingSafeEqualText(token, env.SCRAPFORAI_API_KEY)) return masterPrincipal(via);
  const identity = await authenticateUserKey(token);
  return identity ? { userId: identity.userId, role: identity.role, via, master: false, keyId: identity.keyId } : undefined;
}

/** A session is only as good as the person behind it: a disabled user, a revoked key or a new role is seen on the next request. */
async function liveSessionPrincipal(principal: Principal): Promise<Principal | undefined> {
  if (principal.master) return principal;
  const identity = principal.keyId ? await currentIdentity(principal.userId, principal.keyId) : undefined;
  return identity ? { ...principal, role: identity.role } : undefined;
}

/** True when the request came with an ADMIN key in the Authorization header (the installation's own, or an admin's personal one). */
export function isBearerAdmin(req: Request): boolean {
  return req.principal?.via === 'bearer' && req.principal.role === 'admin';
}

/**
 * Guard for writes that must not be reachable from a UI session cookie alone (credential vault, target profiles, pins, schedules...),
 * mirroring the locked fields of the config API: they need an admin's key sent as a Bearer token. Place after apiAuth.
 */
export function requireBearer(req: Request, res: Response, next: NextFunction): void {
  if (isBearerAdmin(req)) {
    next();
    return;
  }

  if (req.principal?.via === 'bearer') {
    res.status(403).json({
      error: { type: 'InsufficientRole', message: `This operation needs an admin key; this key is ${req.principal.role}` },
    });
    return;
  }

  res.status(403).json({
    error: {
      type: 'BearerTokenRequired',
      message: 'This operation requires the API key (send it as a Bearer token); a UI session is not enough',
    },
  });
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Records a change when its answer is sent: who, what, the status, and the ids the answer created. Never the body of the request. */
function auditWhenDone(req: Request, res: Response, principal: Principal): void {
  // Read now: inside a router req.path is relative to where the router is mounted, and `finish` fires from inside one.
  const requestPath = req.path;
  const method = req.method;
  const refs: Record<string, string> = {};
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      for (const key of REF_KEYS) {
        const value = (body as Record<string, unknown>)[key];
        if (typeof value === 'string' && value.length <= 120 && !(key in refs)) refs[key] = value;
      }
    }
    return originalJson(body);
  }) as typeof res.json;

  res.on('finish', () => {
    const detail = res.locals.auditDetail as Record<string, string | number | boolean> | undefined;
    void appendAudit({
      event: 'request',
      actor: auditActor(principal),
      ip: req.ip,
      method,
      path: requestPath,
      status: res.statusCode,
      area: requestPath.split('/')[2],
      refs,
      detail,
    });
  });
}

export async function apiAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (isPublicPath(req)) {
      next();
      return;
    }

    let principal: Principal | undefined;
    const bearer = (req.get('authorization') ?? '').match(/^Bearer\s+(.+)$/i)?.[1];
    if (bearer !== undefined) {
      principal = await authenticateToken(bearer, 'bearer');
      if (!principal) {
        void appendAudit({ event: 'auth.failed', ip: req.ip, method: req.method, path: req.path, status: 401, detail: { via: 'bearer' } });
      }
    }

    if (!principal) {
      const sessionPrincipal = getSessionPrincipal(readCookie(req, SESSION_COOKIE_NAME));
      const live = sessionPrincipal ? await liveSessionPrincipal(sessionPrincipal) : undefined;
      if (live) {
        // CSRF: a cookie is attached automatically by the browser, so a cross-site page could
        // otherwise trigger state changes. SameSite=Strict already blocks most of this; the
        // custom header is the second layer, because cross-origin JS cannot set it without a
        // CORS preflight that this server's origin policy will refuse.
        //
        // Bearer requests skip this check: they are structurally CSRF-immune.
        const isStateChanging = !READ_METHODS.has(req.method);
        if (isStateChanging && req.get(UI_REQUEST_HEADER) !== '1') {
          res.status(403).json({
            error: {
              type: 'CsrfProtection',
              message: `Missing ${UI_REQUEST_HEADER} header on a cookie-authenticated request`,
            },
          });
          return;
        }
        principal = live;
      }
    }

    if (!principal) {
      res.status(401).json({
        error: {
          type: 'Unauthorized',
          message: 'Missing or invalid API token',
        },
      });
      return;
    }

    req.principal = principal;
    req.authMethod = principal.via;

    const needed = requiredRole(req.method, req.path);
    if (!roleAtLeast(principal.role, needed)) {
      void appendAudit({ event: 'auth.denied', actor: auditActor(principal), ip: req.ip, method: req.method, path: req.path, status: 403, detail: { needed } });
      res.status(403).json({
        error: { type: 'InsufficientRole', message: `This needs the ${needed} role; you are ${principal.role}` },
      });
      return;
    }

    if (!READ_METHODS.has(req.method)) auditWhenDone(req, res, principal);
    next();
  } catch (error) {
    next(error);
  }
}
