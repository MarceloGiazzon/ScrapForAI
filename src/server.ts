import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import pino from 'pino';
import { pinoHttp } from 'pino-http';

import { env, getLiveAllowedOrigins } from './config/env.js';
import { publicDir } from './config/paths.js';
import { initRunHistory, pruneHistory } from './history/runHistoryStore.js';
import { recoverSnapshotRuns } from './evolution/snapshotRunner.js';
import { verifyTrustedScripts } from './runner/trusted/registry.js';
import { recoverSuites } from './orchestrator/suiteRunner.js';
import { recoverDifferentials } from './differential/differentialService.js';
import { recoverManualBuilds } from './manual/manualService.js';
import { recoverShrinks } from './shrink/shrinkService.js';
import { recoverMatrixRuns } from './permissions/matrixRunner.js';
import { authRouter } from './routes/auth.routes.js';
import { configRouter } from './routes/config.routes.js';
import { credentialsRouter } from './routes/credentials.routes.js';
import { evidenceRouter } from './routes/evidence.routes.js';
import { evolutionRouter } from './routes/evolution.routes.js';
import { permissionsRouter } from './routes/permissions.routes.js';
import { domInspectionRouter } from './routes/domInspection.routes.js';
import { explorationRouter } from './routes/exploration.routes.js';
import { routinesRouter } from './routes/routines.routes.js';
import { runsRouter } from './routes/runs.routes.js';
import { schemaRouter } from './routes/schema.routes.js';
import { statusRouter } from './routes/status.routes.js';
import { schedulesRouter } from './routes/schedules.routes.js';
import { differentialsRouter } from './routes/differentials.routes.js';
import { shrinksRouter } from './routes/shrinks.routes.js';
import { startScheduler } from './scheduler/runtime.js';
import { suitesRouter } from './routes/suites.routes.js';
import { auditRouter, teamRouter } from './routes/team.routes.js';
import { targetsRouter } from './routes/targets.routes.js';
import { metricsRouter } from './routes/metrics.routes.js';
import { executiveRouter } from './routes/executive.routes.js';
import { manualRouter } from './routes/manual.routes.js';
import { healthRouter } from './routes/health.routes.js';
import { summaryRouter } from './routes/summary.routes.js';
import { vaultRouter } from './routes/vault.routes.js';
import { webhooksRouter } from './routes/webhooks.routes.js';
import { bugReportsRouter } from './routes/bugReports.routes.js';
import { integrationsRouter } from './routes/integrations.routes.js';
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
if (env.TRUST_PROXY > 0) {
  app.set('trust proxy', env.TRUST_PROXY);
}

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
app.use('/v1/team', teamRouter);
app.use('/v1/audit', auditRouter);
app.use('/v1/status', statusRouter);
app.post('/v1/suites', explorationLimiter); // starting a suite drives browsers, like /v1/explorations
app.use('/v1/suites', suitesRouter);
app.post('/v1/shrinks', explorationLimiter); // a shrink drives browsers, like a suite
app.use('/v1/shrinks', shrinksRouter);
app.post('/v1/differentials', explorationLimiter); // a differential run drives browsers, twice per routine
app.use('/v1/differentials', differentialsRouter);
app.post('/v1/manual/builds', explorationLimiter); // a manual build drives browsers, one run per documented routine
app.use('/v1/manual', manualRouter);
app.use('/v1/schedules', schedulesRouter);
app.use('/v1/webhooks', webhooksRouter);
app.use('/v1/integrations', integrationsRouter);
app.use('/v1/bug-reports', bugReportsRouter);
app.use('/v1/metrics', metricsRouter);
app.use('/v1/health', healthRouter);
app.use('/v1/summary', summaryRouter);
app.use('/v1/executive', executiveRouter);
app.use('/v1/evidence', evidenceRouter);
app.use('/v1/vault', vaultRouter);
app.use('/v1/permissions', permissionsRouter);
app.use('/v1/evolution', evolutionRouter);
app.use('/v1/routines', routinesRouter);
app.use('/v1/targets', targetsRouter);
app.use('/v1/credentials', credentialsRouter);

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
  // T7.1: the scripts this project injects into target pages must be exactly the reviewed ones. A mismatch throws, and the server does not start.
  verifyTrustedScripts();
  await initRunHistory();
  const pruned = await pruneHistory();
  if (pruned.removed > 0) {
    logger.info(pruned, 'Pruned expired run history entries');
  }

  const recovered = await recoverSuites();
  if (recovered.interrupted > 0 || recovered.pruned > 0) {
    logger.info(recovered, 'Recovered suite run states');
  }

  const recoveredShrinks = await recoverShrinks();
  if (recoveredShrinks.interrupted > 0 || recoveredShrinks.pruned > 0) {
    logger.info(recoveredShrinks, 'Recovered shrink run states');
  }

  const recoveredDifferentials = await recoverDifferentials();
  if (recoveredDifferentials.interrupted > 0 || recoveredDifferentials.pruned > 0) {
    logger.info(recoveredDifferentials, 'Recovered differential run states');
  }

  const recoveredManual = await recoverManualBuilds();
  if (recoveredManual.interrupted > 0 || recoveredManual.pruned > 0) {
    logger.info(recoveredManual, 'Recovered manual build states');
  }

  const recoveredSnapshots = await recoverSnapshotRuns();
  if (recoveredSnapshots.interrupted > 0 || recoveredSnapshots.pruned > 0) {
    logger.info(recoveredSnapshots, 'Recovered system-evolution snapshot run states');
  }

  const recoveredMatrices = await recoverMatrixRuns();
  if (recoveredMatrices.interrupted > 0 || recoveredMatrices.pruned > 0) {
    logger.info(recoveredMatrices, 'Recovered permission matrix run states');
  }

  app.listen(env.PORT, env.HOST, () => {
    logger.info({ host: env.HOST, port: env.PORT }, 'ScrapForAI API listening');
  });

  // After the recoveries above, so a run left over from a dead process is already closed when the scheduler reconciles it.
  if (env.SCHEDULER_ENABLED) {
    await startScheduler((message, error) => logger.error({ err: error }, message));
    logger.info({ tickSeconds: env.SCHEDULER_TICK_SECONDS }, 'Scheduler started');
  }
}

start().catch((error: unknown) => {
  logger.error({ err: error }, 'Failed to start ScrapForAI');
  process.exit(1);
});
