import { z } from 'zod';

/**
 * Settings owned by the external API and webhooks. Kept out of the shared config.ts on purpose: every key is optional
 * and has a safe default, so an existing deployment keeps starting without any new variable.
 */
const schema = z.object({
  // Fixed-window limit per API key (requests per minute), counted in the database.
  EXT_API_RATE_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(120),
  // How often the delivery worker looks for due webhook deliveries; 0 turns the worker off (tests, secondary instances).
  WEBHOOK_DELIVERY_INTERVAL_MS: z.coerce.number().int().min(0).max(3_600_000).default(5000),
  WEBHOOK_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
});

export type ExtConfig = z.infer<typeof schema>;

export function loadExtConfig(env: NodeJS.ProcessEnv = process.env): ExtConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const keys = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid configuration: ${keys}`);
  }
  return parsed.data;
}

export class ExtError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}
