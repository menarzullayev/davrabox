import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';
import { startMetricsServer } from './metrics.js';

async function bootstrap() {
  const cfg = loadConfig();
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  app.enableCors({ origin: cfg.CORS_ORIGINS.split(',').map((s) => s.trim()), methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'], maxAge: 600 });
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  await app.listen(cfg.API_PORT, '0.0.0.0');
  startMetricsServer(cfg.METRICS_PORT, cfg.METRICS_HOST);
  console.log(`api listening on ${cfg.API_PORT}`);
}
bootstrap();
