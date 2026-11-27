import { api, type ActivityItem, type GuestMode, type MyRecording, type PersonalRoom, type PersonalRoomView } from '../api';

/**
 * What the home package pages ask the server for, bound to the signed-in person's token by the application. Pages get it as
 * a prop, so the unit tests and the home lab pass their own implementation and nothing here reaches into globals.
 */
export interface HomeApi {
  personalRoom(): Promise<PersonalRoomView>;
  ensurePersonalRoom(body: { title: string; passcode?: string }): Promise<PersonalRoom>;
  updatePersonalRoom(patch: { passcode?: string | null; waitingRoom?: boolean; guests?: GuestMode }): Promise<PersonalRoom>;
  regeneratePersonalRoom(): Promise<PersonalRoom>;
  recentActivity(): Promise<{ items: ActivityItem[] }>;
  myRecordings(): Promise<{ enabled: boolean; items: MyRecording[] }>;
  downloadRecording(id: string): Promise<Blob>;
  connectionTest(): Promise<{ url: string; token: string }>;
}

export function homeApiFor(getToken: () => Promise<string>): HomeApi {
  return {
    personalRoom: async () => api.personalRoom(await getToken()),
    ensurePersonalRoom: async (b) => api.ensurePersonalRoom(await getToken(), b),
    updatePersonalRoom: async (p) => api.updatePersonalRoom(await getToken(), p),
    regeneratePersonalRoom: async () => api.regeneratePersonalRoom(await getToken()),
    recentActivity: async () => api.recentActivity(await getToken()),
    myRecordings: async () => api.myRecordings(await getToken()),
    downloadRecording: async (id) => api.downloadRecording(await getToken(), id),
    connectionTest: async () => api.connectionTest(await getToken()),
  };
}
