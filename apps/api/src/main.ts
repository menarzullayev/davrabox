import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';
import { startMetricsServer } from './metrics.js';
import { AUDIT_FORWARDER } from './app.module.js';
import type { AuditForwarder } from './audit/forwarder.js';
import { installGracefulShutdown } from './shutdown.js'; // REL

async function bootstrap() {
  const cfg = loadConfig();
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
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
