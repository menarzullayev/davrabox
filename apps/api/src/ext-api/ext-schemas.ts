import { z } from 'zod';
import { noControl } from '../common/text.js';

/** Request and response shapes of /v1/ext. The controllers validate with these and the OpenAPI document is generated from them. */
export const meetingCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).refine(noControl).describe('Meeting title'),
    passcode: z.string().min(6).max(64).refine(noControl).optional().describe('Optional passcode (6-64 characters); never returned by the API'),
    scheduledAt: z.string().datetime().optional().describe('Planned start, ISO 8601 UTC'),
    waitingRoom: z.boolean().optional().describe('Overrides the organization default when set'),
  })
  .strict();
export type MeetingCreateInput = z.infer<typeof meetingCreateSchema>;

export const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25).describe('Page size, 1-100'),
    cursor: z.string().max(200).refine(noControl).optional().describe('Opaque cursor from the previous page (`next`)'),
  })
  .strict();
export type ListQuery = z.infer<typeof listQuerySchema>;

export const meetingSchema = z.object({
  id: z.string().uuid(),
  code: z.string().describe('Join code, 11 digits'),
  title: z.string(),
  hostUserId: z.string().uuid(),
  waitingRoom: z.boolean(),
  locked: z.boolean(),
  hasPasscode: z.boolean(),
  scheduledAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type MeetingItem = z.infer<typeof meetingSchema>;

export const userSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  displayName: z.string(),
  role: z.enum(['org_admin', 'member']),
  disabled: z.boolean(),
  createdAt: z.string().datetime(),
});
export type UserItem = z.infer<typeof userSchema>;

export const meetingPageSchema = z.object({ items: z.array(meetingSchema), next: z.string().nullable() });
export const userPageSchema = z.object({ items: z.array(userSchema), next: z.string().nullable() });
export const errorSchema = z.object({ statusCode: z.number().int(), message: z.string() });

export const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{1,200}$/;
