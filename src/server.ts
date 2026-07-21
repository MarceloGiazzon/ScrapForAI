import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import pino from 'pino';
import { pinoHttp } from 'pino-http';

import { env, getLiveAllowedOrigins } from './config/env.js';
import { publicDir } from './config/paths.js';
import { initRunHistory, pruneHistory } from './history/runHistoryStore.js';
import { authRouter } from './routes/auth.routes.js';
import { configRouter } from './routes/config.routes.js';
import { domInspectionRouter } from './routes/domInspection.routes.js';
import { explorationRouter } from './routes/exploration.routes.js';
import { runsRouter } from './routes/runs.routes.js';
import { schemaRouter } from './routes/schema.routes.js';
import { statusRouter } from './routes/status.routes.js';
import { apiAuth } from './security/apiAuth.js';
import { redactSecrets } from './security/redactSecrets.js';
import { TargetUrlNotAllowedError } from './security/validateTargetUrl.js';

const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    censor: '[REDACTED]',
  },
});

const app = express();

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // No inline scripts or styles: everything lives in external files under /ui.
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        // Screenshots are served same-origin from /v1/runs/:jobId/artifacts/...
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
  }),
);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      callback(null, env.CORS_ALLOWED_ORIGINS.includes(origin));
    },
  }),
);
// Generous ceiling for read-only and UI traffic.
const generalLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

// The original strict budget, now scoped to the endpoints that actually drive a browser.
const explorationLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(generalLimiter);
app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req: { method: string; url: string; headers: unknown }) {
        return redactSecrets({
          method: req.method,
          url: req.url,
          headers: req.headers,
        });
      },
    },
  }),
);
app.use(express.json({ limit: env.MAX_REQUEST_BODY_SIZE }));
app.use(apiAuth);

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'ScrapForAI',
    time: new Date().toISOString(),
  });
});

app.get('/v1/debug/config', (_req, res) => {
  res.json({
    pid: process.pid,
    allowedTargetOrigins: getLiveAllowedOrigins('ALLOWED_TARGET_ORIGINS'),
    allowedResourceOrigins: getLiveAllowedOrigins('ALLOWED_RESOURCE_ORIGINS'),
    corsAllowedOrigins: env.CORS_ALLOWED_ORIGINS,
  });
});

app.use('/v1/auth', authRouter);
app.use('/v1/schema', schemaRouter);

app.use('/v1/explorations', explorationLimiter, explorationRouter);
app.use('/v1/explorations/inspect-dom', explorationLimiter, domInspectionRouter);

app.use('/v1/runs', runsRouter);
app.use('/v1/config', configRouter);
app.use('/v1/status', statusRouter);

if (env.UI_ENABLED) {
  app.use('/ui', express.static(publicDir(), { index: 'index.html', maxAge: 0 }));
  app.get('/', (_req, res) => res.redirect('/ui/'));
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof TargetUrlNotAllowedError) {
    res.status(400).json({
      error: {
        type: error.name,
        message: error.message,
      },
    });
    return;
  }

  if (error instanceof SyntaxError) {
    res.status(400).json({
      error: {
        type: 'ValidationError',
        message: 'Invalid JSON body',
        details: [],
      },
    });
    return;
  }

  logger.error({ err: redactSecrets(error) }, 'Unhandled request error');
  res.status(500).json({
    error: {
      type: 'InternalServerError',
      message: env.NODE_ENV === 'production' ? 'Internal server error' : error instanceof Error ? error.message : 'Internal server error',
    },
  });
});

async function start(): Promise<void> {
  await initRunHistory();
  const pruned = await pruneHistory();
  if (pruned.removed > 0) {
    logger.info(pruned, 'Pruned expired run history entries');
  }

  app.listen(env.PORT, env.HOST, () => {
    logger.info({ host: env.HOST, port: env.PORT }, 'ScrapForAI API listening');
  });
}

start().catch((error: unknown) => {
  logger.error({ err: error }, 'Failed to start ScrapForAI');
  process.exit(1);
});
