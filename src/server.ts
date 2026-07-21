import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import pino from 'pino';
import { pinoHttp } from 'pino-http';

import { env, getLiveAllowedOrigins } from './config/env.js';
import { initRunHistory, pruneHistory } from './history/runHistoryStore.js';
import { domInspectionRouter } from './routes/domInspection.routes.js';
import { explorationRouter } from './routes/exploration.routes.js';
import { runsRouter } from './routes/runs.routes.js';
import { schemaRouter } from './routes/schema.routes.js';
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

app.use(helmet());
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
app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);
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

app.use('/v1/schema', schemaRouter);

app.use('/v1/explorations', explorationRouter);
app.use('/v1/explorations/inspect-dom', domInspectionRouter);

app.use('/v1/runs', runsRouter);

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
