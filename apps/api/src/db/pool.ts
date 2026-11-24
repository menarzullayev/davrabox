import type { OnApplicationShutdown } from '@nestjs/common';
import { Pool, type PoolConfig } from 'pg';
import { z } from 'zod';

const schema = z.object({
  // Server-side cap on one statement (the database cancels it with SQLSTATE 57014).
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(30_000),
  // Client-side cap: if the server does not answer at all (hung, partitioned), the query still fails. Must exceed the statement cap.
  DB_QUERY_TIMEOUT_MS: z.coerce.number().int().min(100).max(900_000).default(35_000),
  // Time allowed to get a connection (TCP + startup, or a free slot in the pool).
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
  DB_LOCK_TIMEOUT_MS: z.coerce.number().int().min(100).max(300_000).default(10_000),
  DB_IDLE_IN_TX_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(30_000),
});

export interface PoolSettings {
  statementTimeoutMs: number;
  queryTimeoutMs: number;
  connectionTimeoutMs: number;
  lockTimeoutMs: number;
  idleInTransactionTimeoutMs: number;
}

export function loadPoolSettings(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): PoolSettings {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid database timeout configuration: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  const c = parsed.data;
  if (c.DB_QUERY_TIMEOUT_MS <= c.DB_STATEMENT_TIMEOUT_MS) throw new Error('Invalid database timeout configuration: DB_QUERY_TIMEOUT_MS must be greater than DB_STATEMENT_TIMEOUT_MS');
  return {
    statementTimeoutMs: c.DB_STATEMENT_TIMEOUT_MS,
    queryTimeoutMs: c.DB_QUERY_TIMEOUT_MS,
    connectionTimeoutMs: c.DB_CONNECT_TIMEOUT_MS,
    lockTimeoutMs: c.DB_LOCK_TIMEOUT_MS,
    idleInTransactionTimeoutMs: c.DB_IDLE_IN_TX_TIMEOUT_MS,
  };
}

/** A pg Pool that Nest closes on shutdown (idempotent: a module that also ends it itself is fine). */
export class ManagedPool extends Pool implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    if (!this.ended) await this.end();
  }
}

/** The one way the API creates a connection pool: explicit timeouts, an application name for pg_stat_activity, closed on shutdown. */
export function createPool(connectionString: string, max: number, settings: PoolSettings = loadPoolSettings()): ManagedPool {
  const config: PoolConfig = {
    connectionString,
    max,
    application_name: process.env['PGAPPNAME'] ?? 'davrabox-api',
    connectionTimeoutMillis: settings.connectionTimeoutMs,
    idleTimeoutMillis: 30_000,
    statement_timeout: settings.statementTimeoutMs,
    query_timeout: settings.queryTimeoutMs,
    lock_timeout: settings.lockTimeoutMs,
    idle_in_transaction_session_timeout: settings.idleInTransactionTimeoutMs,
    keepAlive: true,
  };
  const pool = new ManagedPool(config);
  // An idle client that loses its connection emits 'error'; without a listener that would crash the process.
  pool.on('error', () => undefined);
  return pool;
}
