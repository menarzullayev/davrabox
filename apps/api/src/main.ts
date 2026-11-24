import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';
import { startMetricsServer } from './metrics.js';
import { AUDIT_FORWARDER } from './app.module.js';
import type { AuditForwarder } from './audit/forwarder.js';
import { POOL } from './auth/auth.guard.js';
import { RoomServiceClient } from 'livekit-server-sdk';
import type { Pool } from 'pg';
import { ExtApiModule } from './ext-api/ext-api.module.js';
import { SIGNUP_POOL, SignupModule } from './signup/signup.module.js';
import { AllExceptionsFilter } from './observability/exception.filter.js';
import { captureServerError, initErrorTracking } from './observability/error-tracking.js';
import { createRequestLogger } from './observability/request-logger.js';
import { registerPoolMetrics, registerRoomMetrics } from './metrics.js';
import { installGracefulShutdown } from './shutdown.js'; // REL
import { applyApiHardening } from './security-headers.js'; // REL

async function bootstrap() {
  const cfg = loadConfig();
  await initErrorTracking(process.env); // observability: off unless GLITCHTIP_DSN is set
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  // --- observability (docs/observability.md): JSON request log, X-Request-Id, safe error bodies, pool and room gauges ---
  app.use(createRequestLogger());
  app.useGlobalFilters(new AllExceptionsFilter({ report: captureServerError }));
  registerPoolMetrics('main', app.select(AppModule).get<Pool>(POOL, { strict: true }));
  registerPoolMetrics('ext_api', app.select(ExtApiModule).get<Pool>(POOL, { strict: true }));
  registerPoolMetrics('signup', app.select(SignupModule).get<Pool>(SIGNUP_POOL, { strict: true }));
  registerRoomMetrics(new RoomServiceClient(cfg.LIVEKIT_API_URL, cfg.LIVEKIT_API_KEY, cfg.LIVEKIT_API_SECRET));
  // --- end observability ---
  applyApiHardening(app); // REL: baseline response headers (nosniff, CORP, referrer policy); must run before listen()
  app.enableCors({ origin: cfg.CORS_ORIGINS.split(',').map((s) => s.trim()), methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'], maxAge: 600 });
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  await app.listen(cfg.API_PORT, '0.0.0.0');
  startMetricsServer(cfg.METRICS_PORT, cfg.METRICS_HOST);
  // SIEM forwarding runs in the background after the API is already serving; start() never blocks or throws.
  // --- REL: graceful shutdown. Replaces app.enableShutdownHooks(): SIGTERM drains in-flight requests, runs the shutdown hooks
  // (pools, Redis, jobs) via app.close(), then exits explicitly (Nest's re-raised signal cannot kill PID 1 in a container);
  // a drain stuck for 25 s is force-exited. ---
  installGracefulShutdown(app);
  // --- end REL ---
  const forwarder = app.get<AuditForwarder | null>(AUDIT_FORWARDER);
  if (forwarder) {
    forwarder.start();
    console.log('audit forwarding enabled');
  }
  console.log(`api listening on ${cfg.API_PORT}`);
}
bootstrap();
