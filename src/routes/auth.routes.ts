import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { authenticateToken } from '../security/apiAuth.js';
import { clearSessionCookie, readCookie, setSessionCookie } from '../security/cookies.js';
import { SESSION_COOKIE_NAME, createSession, destroySession } from '../security/sessionStore.js';
import { appendAudit } from '../team/audit.js';
import { auditActor } from '../team/principal.js';

export const authRouter = Router();

/** Deliberately strict: this endpoint guards the API key against brute force. */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { type: 'TooManyRequests', message: 'Too many login attempts. Try again later.' } },
});

/** Signs in with the installation's key or a personal key (T10.1); the session is the person, with their role. */
authRouter.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey : '';
    const principal = apiKey ? await authenticateToken(apiKey, 'session') : undefined;

    if (!principal) {
      // Uniform message: never reveal whether the key was malformed, revoked or merely wrong.
      void appendAudit({ event: 'auth.failed', ip: req.ip, method: 'POST', path: '/v1/auth/login', status: 401, detail: { via: 'login' } });
      res.status(401).json({ error: { type: 'Unauthorized', message: 'Invalid API key' } });
      return;
    }

    const { token, maxAgeSeconds } = createSession(principal);
    setSessionCookie(res, SESSION_COOKIE_NAME, token, maxAgeSeconds);
    void appendAudit({ event: 'auth.login', actor: auditActor(principal), ip: req.ip, method: 'POST', path: '/v1/auth/login', status: 200 });

    res.json({ ok: true, expiresInSeconds: maxAgeSeconds, user: { id: principal.userId, role: principal.role } });
  } catch (error) {
    next(error);
  }
});

authRouter.post('/logout', (req, res) => {
  destroySession(readCookie(req, SESSION_COOKIE_NAME));
  clearSessionCookie(res, SESSION_COOKIE_NAME);
  res.json({ ok: true });
});

/** Lets the UI decide between rendering the app and redirecting to login. apiAuth already refused anyone who is not signed in. */
authRouter.get('/me', (req, res) => {
  const principal = req.principal;
  if (!principal) {
    res.status(401).json({ error: { type: 'Unauthorized', message: 'Not authenticated' } });
    return;
  }

  res.json({ authenticated: true, method: principal.via, user: { id: principal.userId, role: principal.role } });
});
