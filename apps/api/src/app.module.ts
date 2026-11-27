import { Inject, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { RoomServiceClient } from 'livekit-server-sdk';
import { livekitClientOptions } from './common/timeouts.js';
import type { Pool } from 'pg';
import { createPool } from './db/pool.js';
import { RateLimitModule } from './rate-limit/rate-limit.module.js';
import { RateLimitService } from './rate-limit/service.js';
import { loadConfig, type Config } from './config.js';
import { AuthGuard, POOL, VERIFIER } from './auth/auth.guard.js';
import { createVerifier } from './auth/jwt.js';
import { MEETINGS, MeetingsController } from './meetings/meetings.controller.js';
import { MeetingsService } from './meetings/meetings.service.js';
import { ACTIVITY, MeController, PERSONAL_ROOM } from './meetings/me.controller.js';
import { PersonalRoomService } from './meetings/personal-room.js';
import { ActivityTracker } from './meetings/activity.js';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AvatarController, DeviceInterceptor, PROFILE, PeopleController, ProfileController, SECURITY } from './profile/profile.controller.js';
import { ProfileService } from './profile/profile.service.js';
import { SecurityService } from './profile/security.service.js';
import { MySettingsController, OrgSettingsController, SETTINGS_SVC } from './settings/settings.controller.js';
import { SettingsService } from './settings/settings.service.js';
import { createMailer } from './notify/mailer.js';
import { Notifier } from './notify/notifier.js';
import type { MeetingPolicyHooks } from './meetings/meeting-policy.js';
import { RECORDING } from './recording/recording.controller.js';
import type { RecordingService } from './recording/recording.service.js';
import { withTenant } from './db/tenant.js';

export const NOTIFIER = Symbol('NOTIFIER');
export const POLICY_HOOKS = Symbol('POLICY_HOOKS');
import { GUESTS, GuestController } from './meetings/guest.controller.js';
import { GuestService } from './meetings/guest.service.js';
import { PREFS, PrefsController } from './prefs/prefs.controller.js';
import { PrefsService } from './prefs/prefs.service.js';
import { APP_ORIGINS, ONBOARDING, OnboardingController } from './onboarding/onboarding.controller.js';
import { OnboardingService } from './onboarding/onboarding.service.js';
import { HealthController } from './health.controller.js';
import { READINESS, ReadinessService } from './readiness.js';
import { FILES, FilesController } from './files/files.controller.js';
import { FilesService } from './files/files.service.js';
import { AUDIT, AuditAdminGuard, AuditController } from './audit/audit.controller.js';
import { AuditService } from './audit/audit.service.js';
import { AuditForwarder } from './audit/forwarder.js';

import { ADMIN, AdminController, AdminGuard } from './admin/admin.controller.js';
import { AdminService } from './admin/admin.service.js';
import { KeycloakAdmin } from './admin/identity-admin.js';
import { SignupModule } from './signup/signup.module.js';
import { ExtApiModule } from './ext-api/ext-api.module.js';
import { recordingControllers, recordingProviders } from './recording/recording.module.js';
import { calendarControllers, calendarProviders } from './calendar/calendar.module.js';
import { byokControllers, byokProviders } from './byok/byok.module.js';
import { privacyControllers, privacyProviders } from './privacy/privacy.module.js';
import { assistantControllers, assistantProviders } from './assistant/assistant.module.js';

export const AUDIT_FORWARDER = Symbol('AUDIT_FORWARDER');
export const CONFIG = Symbol('CONFIG');

@Module({
  imports: [RateLimitModule.forRoot(), SignupModule, ExtApiModule],
  controllers: [MeetingsController, MeController, MySettingsController, OrgSettingsController, ProfileController, PeopleController, AvatarController, GuestController, PrefsController, OnboardingController, FilesController, AdminController, AuditController, HealthController, ...recordingControllers, ...calendarControllers, ...byokControllers, ...privacyControllers, ...assistantControllers],
  providers: [
    ...recordingProviders,
    ...byokProviders,
    ...privacyProviders,
    ...assistantProviders,
    { provide: CONFIG, useFactory: () => loadConfig() },
    { provide: POOL, useFactory: (cfg: Config) => createPool(cfg.DATABASE_URL, 10), inject: [CONFIG] },
    { provide: READINESS, useFactory: (pool: Pool, cfg: Config, rate: RateLimitService) => new ReadinessService(pool, { livekitApiUrl: cfg.LIVEKIT_API_URL }, { rate }), inject: [POOL, CONFIG, RateLimitService] },
    { provide: VERIFIER, useFactory: (cfg: Config) => createVerifier(cfg.KEYCLOAK_ISSUER, cfg.KEYCLOAK_AUDIENCE, cfg.KEYCLOAK_JWKS_URL), inject: [CONFIG] },
    {
      provide: ACTIVITY,
      useFactory: (pool: Pool, cfg: Config) => new ActivityTracker(pool, new RoomServiceClient(cfg.LIVEKIT_API_URL, cfg.LIVEKIT_API_KEY, cfg.LIVEKIT_API_SECRET, livekitClientOptions())),
      inject: [POOL, CONFIG],
    },
    {
      provide: MEETINGS,
      useFactory: (pool: Pool, cfg: Config, rate: RateLimitService, activity: ActivityTracker, profile: ProfileService, hooks: MeetingPolicyHooks, notifier: Notifier) => {
        const svc = new MeetingsService(pool, cfg, rate);
        svc.onEnded = (orgId, meetingId) => activity.endedByHost(orgId, meetingId);
        svc.avatarOf = (orgId, userId) => profile.avatarIdOf(orgId, userId);
        svc.hooks = hooks;
        svc.onCancelled = (orgId, meetingId, actorId, actorName) => notifier.cancelled(orgId, meetingId, actorId, actorName);
        return svc;
      },
      inject: [POOL, CONFIG, RateLimitService, ACTIVITY, PROFILE, POLICY_HOOKS, NOTIFIER],
    },
    {
      provide: SETTINGS_SVC,
      useFactory: (pool: Pool, cfg: Config) => new SettingsService(pool, { recordingEnabled: cfg.RECORDING_ENABLED, mailEnabled: Boolean(cfg.SMTP_HOST) }),
      inject: [POOL, CONFIG],
    },
    {
      provide: NOTIFIER,
      useFactory: (pool: Pool, cfg: Config, settings: SettingsService) =>
        new Notifier(pool, createMailer(cfg), settings, (process.env['CALENDAR_PUBLIC_URL'] || cfg.CORS_ORIGINS.split(',')[0] || '').trim().replace(/\/+$/, '')),
      inject: [POOL, CONFIG, SETTINGS_SVC],
    },
    {
      provide: POLICY_HOOKS,
      useFactory: (settings: SettingsService, notifier: Notifier): MeetingPolicyHooks => ({
        hostSettings: (orgId, hostUserId) => settings.effectiveFor(orgId, hostUserId),
        orgRules: (orgId) => settings.orgRules(orgId),
        lobby: (orgId, meetingId, who) => notifier.lobby(orgId, meetingId, who),
      }),
      inject: [SETTINGS_SVC, NOTIFIER],
    },
    { provide: PROFILE, useFactory: (pool: Pool, cfg: Config, rate: RateLimitService) => new ProfileService(pool, cfg, rate), inject: [POOL, CONFIG, RateLimitService] },
    {
      provide: SECURITY,
      useFactory: (pool: Pool, cfg: Config, notifier: Notifier) => {
        const svc = new SecurityService(
          pool,
          cfg.KEYCLOAK_ADMIN_URL && cfg.KEYCLOAK_ADMIN_CLIENT_SECRET
            ? new KeycloakAdmin({ baseUrl: cfg.KEYCLOAK_ADMIN_URL, realm: cfg.KEYCLOAK_ADMIN_REALM, clientId: cfg.KEYCLOAK_ADMIN_REALM_CLIENT_ID, clientSecret: cfg.KEYCLOAK_ADMIN_CLIENT_SECRET })
            : null,
        );
        svc.onNewDevice = (orgId, userId, device, place) => notifier.newDevice(orgId, userId, device, place);
        return svc;
      },
      inject: [POOL, CONFIG, NOTIFIER],
    },
    { provide: APP_INTERCEPTOR, useClass: DeviceInterceptor },
    { provide: PERSONAL_ROOM, useFactory: (pool: Pool) => new PersonalRoomService(pool), inject: [POOL] },
    {
      provide: GUESTS,
      useFactory: (pool: Pool, cfg: Config, rate: RateLimitService, hooks: MeetingPolicyHooks) => {
        const svc = new GuestService(pool, cfg, rate);
        svc.hooks = hooks;
        return svc;
      },
      inject: [POOL, CONFIG, RateLimitService, POLICY_HOOKS],
    },
    { provide: PREFS, useFactory: (pool: Pool) => new PrefsService(pool), inject: [POOL] },
    {
      provide: ONBOARDING,
      useFactory: (pool: Pool, cfg: Config) =>
        new OnboardingService(
          pool,
          cfg.KEYCLOAK_ADMIN_URL && cfg.KEYCLOAK_ADMIN_CLIENT_SECRET
            ? new KeycloakAdmin({ baseUrl: cfg.KEYCLOAK_ADMIN_URL, realm: cfg.KEYCLOAK_ADMIN_REALM, clientId: cfg.KEYCLOAK_ADMIN_REALM_CLIENT_ID, clientSecret: cfg.KEYCLOAK_ADMIN_CLIENT_SECRET })
            : null,
        ),
      inject: [POOL, CONFIG],
    },
    { provide: APP_ORIGINS, useFactory: (cfg: Config) => cfg.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean), inject: [CONFIG] },
    {
      provide: FILES,
      useFactory: (pool: Pool, cfg: Config, rate: RateLimitService, settings: SettingsService) => {
        const svc = new FilesService(pool, cfg, rate);
        // "File sending" (host setting): the host side may always share; others only while the host allows it.
        svc.fileSendingAllowed = async (user, meetingId) => {
          const m = await withTenant(pool, user.orgId, async (c) => {
            const r = await c.query(
              'SELECT host_user_id, EXISTS (SELECT 1 FROM meeting_cohosts ch WHERE ch.meeting_id = m.id AND ch.user_id = $2) AS cohost FROM meetings m WHERE m.id = $1',
              [meetingId, user.userId],
            );
            return r.rows[0] as { host_user_id: string; cohost: boolean } | undefined;
          });
          if (!m) return false;
          if (m.host_user_id === user.userId || m.cohost || user.role === 'org_admin') return true;
          return (await settings.effectiveFor(user.orgId, m.host_user_id))['fileSending'] !== false;
        };
        return svc;
      },
      inject: [POOL, CONFIG, RateLimitService, SETTINGS_SVC],
    },
    {
      provide: ADMIN,
      useFactory: (pool: Pool, cfg: Config) =>
        new AdminService(
          pool,
          cfg.KEYCLOAK_ADMIN_URL && cfg.KEYCLOAK_ADMIN_CLIENT_SECRET
            ? new KeycloakAdmin({
                baseUrl: cfg.KEYCLOAK_ADMIN_URL,
                realm: cfg.KEYCLOAK_ADMIN_REALM,
                clientId: cfg.KEYCLOAK_ADMIN_REALM_CLIENT_ID,
                clientSecret: cfg.KEYCLOAK_ADMIN_CLIENT_SECRET,
              })
            : null,
        ),
      inject: [POOL, CONFIG],
    },
    { provide: AUDIT, useFactory: (pool: Pool, cfg: Config, rate: RateLimitService) => new AuditService(pool, cfg.LIVEKIT_API_SECRET, { rate }), inject: [POOL, CONFIG, RateLimitService] },
    {
      provide: AUDIT_FORWARDER,
      useFactory: (pool: Pool, cfg: Config) =>
        cfg.AUDIT_WEBHOOK_URL && cfg.AUDIT_WEBHOOK_SECRET
          ? new AuditForwarder(pool, { url: cfg.AUDIT_WEBHOOK_URL, secret: cfg.AUDIT_WEBHOOK_SECRET, intervalMs: cfg.AUDIT_FORWARD_INTERVAL_MS })
          : null,
      inject: [POOL, CONFIG],
    },
    ...calendarProviders,
    AuthGuard,
    AdminGuard,
    AuditAdminGuard,
  ],
})
export class AppModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    @Inject(ACTIVITY) private readonly activity: ActivityTracker,
    @Inject(MEETINGS) meetings: MeetingsService,
    @Inject(RECORDING) recording: RecordingService,
    @Inject(SETTINGS_SVC) settings: SettingsService,
  ) {
    // Wired here (the services depend on each other): start state of newcomers, recording rules and auto-record.
    activity.onFirstSeen = (orgId, meetingId, identity) => meetings.enforceStartState(orgId, meetingId, identity);
    recording.hostSettings = (orgId, hostUserId) => settings.effectiveFor(orgId, hostUserId);
    meetings.onHostJoined = (user, code) => recording.start(user, code, { confirmed: true }).then(() => undefined);
  }

  /** "Recent activity" follows the media server (same switch as the other background jobs: off in API tests). */
  onApplicationBootstrap(): void {
    if (process.env['SIGNUP_BACKGROUND_JOBS'] === '0') return;
    this.activity.start();
  }

  onApplicationShutdown(): void {
    this.activity.stop();
  }
}
