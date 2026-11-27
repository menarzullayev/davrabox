import { api, type Profile, type ProfilePatch, type SecurityView } from '../api';
import { calendarApi, type ProviderStatus } from '../calendar/calendarApi';
import type { CalProvider } from '../calendar/logic';

/** Server calls of the profile page, bound to the signed-in person's token (tests and the lab pass their own). */
export interface ProfileApi {
  profile(): Promise<Profile>;
  save(patch: ProfilePatch): Promise<Profile>;
  uploadAvatar(image: Blob): Promise<{ avatarUrl: string }>;
  removeAvatar(): Promise<void>;
  security(): Promise<SecurityView>;
  endSession(sid: string): Promise<void>;
  endAllSessions(): Promise<void>;
  unlink(provider: string): Promise<void>;
  calendars(): Promise<ProviderStatus[]>;
  connectCalendar(provider: CalProvider): Promise<{ url: string }>;
  disconnectCalendar(provider: CalProvider): Promise<void>;
}

export function profileApiFor(getToken: () => Promise<string>): ProfileApi {
  return {
    profile: async () => api.profile(await getToken()),
    save: async (p) => api.saveProfile(await getToken(), p),
    uploadAvatar: async (b) => api.uploadAvatar(await getToken(), b),
    removeAvatar: async () => api.removeAvatar(await getToken()),
    security: async () => api.security(await getToken()),
    endSession: async (sid) => api.endSession(await getToken(), sid),
    endAllSessions: async () => api.endAllSessions(await getToken()),
    unlink: async (p) => api.unlinkProvider(await getToken(), p),
    calendars: async () => calendarApi.status(await getToken()),
    connectCalendar: async (p) => calendarApi.start(await getToken(), p),
    disconnectCalendar: async (p) => {
      await calendarApi.disconnect(await getToken(), p);
    },
  };
}
