import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  MIGRATE_DATABASE_URL: z.string().min(1).optional(),
  // One or more accepted token issuers (comma separated): the same Keycloak is reached by several public hosts.
  KEYCLOAK_ISSUER: z
    .string()
    .min(1)
    .transform((v) => v.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.string().url()).min(1)),
  KEYCLOAK_JWKS_URL: z.string().url().optional(), // internal URL for key fetch; defaults to issuer-based
  KEYCLOAK_AUDIENCE: z.string().default('davrabox-web'),
  LIVEKIT_URL: z.string().url(), // ws(s):// URL handed to clients
  LIVEKIT_API_URL: z.string().url(), // http(s):// URL used by the server
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(32),
  // File sharing is optional: without S3, ClamAV and a master key the endpoints answer 503 instead of storing anything.
  S3_ENDPOINT: z.string().url().optional(),
  S3_BUCKET: z.string().min(3).default('davra-files'),
  S3_ACCESS_KEY: z.string().min(1).optional(),
  S3_SECRET_KEY: z.string().min(8).optional(),
  CLAMAV_HOST: z.string().min(1).optional(),
  CLAMAV_PORT: z.coerce.number().int().default(3310),
  FILE_MASTER_KEY: z.string().min(1).optional(),
  // Admin console user management is optional: without these the user-management endpoints answer 503.
  // The client is a confidential service-account client limited to view-users, manage-users, view-realm, query-users.
  KEYCLOAK_ADMIN_URL: z.string().url().optional(), // e.g. http://host:8180/auth
  KEYCLOAK_ADMIN_REALM: z.string().min(1).default('davrabox'),
  KEYCLOAK_ADMIN_REALM_CLIENT_ID: z.string().min(1).default('davrabox-admin-api'),
  KEYCLOAK_ADMIN_CLIENT_SECRET: z.string().min(8).optional(),
  METRICS_PORT: z.coerce.number().int().default(9100),
  METRICS_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().default(3000),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  MEETING_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(600),
  // SIEM forwarding of audit rows (off unless the URL is set). https only; plain http is accepted for localhost (tests).
  AUDIT_WEBHOOK_URL: z
    .string()
    .url()
    .refine((u) => {
      const x = new URL(u);
      return x.protocol === 'https:' || (x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname));
    }, 'must be https (http only for localhost)')
    .optional(),
  AUDIT_WEBHOOK_SECRET: z.string().min(16).optional(),
  AUDIT_FORWARD_INTERVAL_MS: z.coerce.number().int().min(100).max(3_600_000).default(5000),
}).refine((c) => !c.AUDIT_WEBHOOK_URL || !!c.AUDIT_WEBHOOK_SECRET, { path: ['AUDIT_WEBHOOK_SECRET'], message: 'required when AUDIT_WEBHOOK_URL is set' });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const keys = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid configuration: ${keys}`);
  }
  return parsed.data;
}
