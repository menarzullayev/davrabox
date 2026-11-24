import type { ClientOptions } from 'livekit-server-sdk';

/**
 * Explicit bounds for every outbound call the API makes, so that a hung dependency fails the one request that needs
 * it (within a known time) instead of holding the request, a pool slot and a socket indefinitely.
 *  - Postgres: see db/pool.ts (statement_timeout, query_timeout, connection timeout).
 *  - Keycloak admin, calendar providers, audit forwarder, webhook delivery, Vault: AbortSignal.timeout / hard deadline at the call.
 *  - LiveKit server SDK: requestTimeout below (the SDK default is 10 s; made explicit so it cannot drift).
 *  - S3 (MinIO): connection and idle-socket timeouts and a small retry count below (the AWS SDK default has NO request timeout).
 *  - ClamAV: idle timeout plus an overall deadline (files/clamav.ts).
 */
export const OUTBOUND = {
  livekitRequestSeconds: 8,
  s3ConnectMs: 5_000,
  s3RequestMs: 60_000,
  s3MaxAttempts: 2,
} as const;

export function livekitClientOptions(): ClientOptions {
  return { requestTimeout: OUTBOUND.livekitRequestSeconds };
}

export interface S3TimeoutOverrides {
  connectionTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxAttempts?: number;
}

/** Spread into `new S3Client({...})`. `requestTimeout` is the idle time of the socket, so large transfers that keep flowing are fine. */
export function s3ClientOptions(o: S3TimeoutOverrides = {}) {
  return {
    // throwOnRequestTimeout: without it the SDK only logs a warning when the idle timeout passes and the call keeps hanging.
    requestHandler: { connectionTimeout: o.connectionTimeoutMs ?? OUTBOUND.s3ConnectMs, requestTimeout: o.requestTimeoutMs ?? OUTBOUND.s3RequestMs, throwOnRequestTimeout: true },
    maxAttempts: o.maxAttempts ?? OUTBOUND.s3MaxAttempts,
  };
}
