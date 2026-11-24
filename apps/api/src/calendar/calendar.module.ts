import type { Pool } from 'pg';
import { POOL } from '../auth/auth.guard.js';
import { CALENDAR_EVENTS, CALENDAR_OAUTH, CalendarController, CalendarEventsController } from './calendar.controller.js';
import { loadCalendarConfig, type CalendarConfig } from './config.js';
import { CalendarEventsService } from './events.service.js';
import { CalendarOAuthService } from './oauth.service.js';
import { RateLimitService } from '../rate-limit/service.js';

export const CALENDAR_CONFIG = Symbol('CALENDAR_CONFIG');

/**
 * The calendar feature, as lists that AppModule spreads into its `controllers` and `providers`. (The auth guard needs
 * the shared POOL and VERIFIER providers of AppModule, so the feature is wired there instead of in a separate Nest module.)
 */
export const calendarControllers = [CalendarController, CalendarEventsController];

export const calendarProviders = [
  { provide: CALENDAR_CONFIG, useFactory: (): CalendarConfig => loadCalendarConfig() },
  { provide: CALENDAR_OAUTH, useFactory: (pool: Pool, cfg: CalendarConfig, rate: RateLimitService) => new CalendarOAuthService(pool, cfg, { rate }), inject: [POOL, CALENDAR_CONFIG, RateLimitService] },
  {
    provide: CALENDAR_EVENTS,
    useFactory: (pool: Pool, oauth: CalendarOAuthService, cfg: CalendarConfig, rate: RateLimitService) => new CalendarEventsService(pool, oauth, cfg, rate),
    inject: [POOL, CALENDAR_OAUTH, CALENDAR_CONFIG, RateLimitService],
  },
];
