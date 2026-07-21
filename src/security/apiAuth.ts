import crypto from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

import { env } from '../config/env.js';
import { readCookie } from './cookies.js';
import { SESSION_COOKIE_NAME, isValidSession } from './sessionStore.js';

/** Header the UI must send on state-changing, cookie-authenticated requests. */
export const UI_REQUEST_HEADER = 'x-scrapforai-ui';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** How this request authenticated. Set by apiAuth. */
      authMethod?: 'bearer' | 'session';
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

export function hasValidBearerToken(req: Request): boolean {
  const header = req.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return Boolean(match) && timingSafeEqualText(match?.[1] ?? '', env.SCRAPFORAI_API_KEY);
}

export function apiAuth(req: Request, res: Response, next: NextFunction): void {
  if (isPublicPath(req)) {
    next();
    return;
  }

  if (hasValidBearerToken(req)) {
    req.authMethod = 'bearer';
    next();
    return;
  }

  if (isValidSession(readCookie(req, SESSION_COOKIE_NAME))) {
    req.authMethod = 'session';

    // CSRF: a cookie is attached automatically by the browser, so a cross-site page could
    // otherwise trigger state changes. SameSite=Strict already blocks most of this; the
    // custom header is the second layer, because cross-origin JS cannot set it without a
    // CORS preflight that this server's origin policy will refuse.
    //
    // Bearer requests skip this check: they are structurally CSRF-immune.
    const isStateChanging = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
    if (isStateChanging && req.get(UI_REQUEST_HEADER) !== '1') {
      res.status(403).json({
        error: {
          type: 'CsrfProtection',
          message: `Missing ${UI_REQUEST_HEADER} header on a cookie-authenticated request`,
        },
      });
      return;
    }

    next();
    return;
  }

  res.status(401).json({
    error: {
      type: 'Unauthorized',
      message: 'Missing or invalid API token',
    },
  });
}
