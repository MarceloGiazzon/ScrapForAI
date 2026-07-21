import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { env } from '../config/env.js';
import { hasValidBearerToken, timingSafeEqualText } from '../security/apiAuth.js';
import { clearSessionCookie, readCookie, setSessionCookie } from '../security/cookies.js';
import { SESSION_COOKIE_NAME, createSession, destroySession, isValidSession } from '../security/sessionStore.js';

export const authRouter = Router();

/** Deliberately strict: this endpoint guards the API key against brute force. */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { type: 'TooManyRequests', message: 'Too many login attempts. Try again later.' } },
});

authRouter.post('/login', loginLimiter, (req, res) => {
  const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey : '';

  if (!apiKey || !timingSafeEqualText(apiKey, env.SCRAPFORAI_API_KEY)) {
    // Uniform message: never reveal whether the key was malformed or merely wrong.
    res.status(401).json({ error: { type: 'Unauthorized', message: 'Invalid API key' } });
    return;
  }

  const { token, maxAgeSeconds } = createSession();
  setSessionCookie(res, SESSION_COOKIE_NAME, token, maxAgeSeconds);

  res.json({ ok: true, expiresInSeconds: maxAgeSeconds });
});

authRouter.post('/logout', (req, res) => {
  destroySession(readCookie(req, SESSION_COOKIE_NAME));
  clearSessionCookie(res, SESSION_COOKIE_NAME);
  res.json({ ok: true });
});

/** Lets the UI decide between rendering the app and redirecting to login. */
authRouter.get('/me', (req, res) => {
  const viaSession = isValidSession(readCookie(req, SESSION_COOKIE_NAME));
  const viaBearer = hasValidBearerToken(req);

  if (!viaSession && !viaBearer) {
    res.status(401).json({ error: { type: 'Unauthorized', message: 'Not authenticated' } });
    return;
  }

  res.json({ authenticated: true, method: viaBearer ? 'bearer' : 'session' });
});
