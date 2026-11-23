import type { Meeting } from '../api';
import { generateMeetingKey, storeKey } from './keys';

export interface CreateInput {
  title: string;
  passcode?: string;
  waitingRoom: boolean;
  e2ee: boolean;
}

/**
 * Creates a meeting. For an E2EE meeting the key is made here, in the browser; the server only ever receives the flag
 * `e2ee: true`. The key is kept in sessionStorage under the new meeting's code once the server has answered, so the
 * host's tab can build the share link and join with the key. If creating fails, no key is kept.
 */
export async function createMeetingWithKey(
  create: (body: { title: string; passcode?: string; waitingRoom?: boolean; e2ee?: boolean }) => Promise<Meeting>,
  d: CreateInput,
): Promise<Meeting> {
  const key = d.e2ee ? generateMeetingKey() : null;
  const m = await create({ title: d.title, passcode: d.passcode, waitingRoom: d.waitingRoom, ...(d.e2ee ? { e2ee: true } : {}) });
  if (key && m.e2ee) storeKey(m.code, key);
  return m;
}
