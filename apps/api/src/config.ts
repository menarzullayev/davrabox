import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  MIGRATE_DATABASE_URL: z.string().min(1).optional(),
  KEYCLOAK_ISSUER: z.string().url(),
  KEYCLOAK_JWKS_URL: z.string().url().optional(), // internal URL for key fetch; defaults to issuer-based
  KEYCLOAK_AUDIENCE: z.string().default('davrabox-web'),
  LIVEKIT_URL: z.string().url(), // ws(s):// URL handed to clients
  LIVEKIT_API_URL: z.string().url(), // http(s):// URL used by the server
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(32),
  METRICS_PORT: z.coerce.number().int().default(9100),
  METRICS_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().default(3000),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  MEETING_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(600),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const keys = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid configuration: ${keys}`);
  }
  return parsed.data;
}
