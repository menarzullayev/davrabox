import { z } from 'zod';

/**
 * Calendar settings are read here (not in ../config.ts) so the module stays self-contained. Everything is optional:
 * a provider whose client id and secret are not set, or a deployment without CALENDAR_PUBLIC_URL or FILE_MASTER_KEY,
 * answers 503 (same pattern as file sharing).
 */
const blank = <T extends z.ZodType>(t: T) => z.preprocess((v) => (v === '' ? undefined : v), t.optional());

const schema = z.object({
  GOOGLE_CLIENT_ID: blank(z.string().min(1)),
  GOOGLE_CLIENT_SECRET: blank(z.string().min(1)),
  MS_CLIENT_ID: blank(z.string().min(1)),
  MS_CLIENT_SECRET: blank(z.string().min(1)),
  /** Public https origin of the product (where the browser reaches the web app and /v1), e.g. https://meet.example.com. */
  CALENDAR_PUBLIC_URL: blank(
    z
    .string()
    .url()
    .refine((u) => {
      const x = new URL(u);
      return x.protocol === 'https:' || (x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname));
    }, 'must be https (http only for localhost)'),
  ),
  FILE_MASTER_KEY: blank(z.string().min(1)),
});

export type CalendarConfig = z.infer<typeof schema>;

export function loadCalendarConfig(env: NodeJS.ProcessEnv = process.env): CalendarConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid calendar configuration: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  }
  return parsed.data;
}
