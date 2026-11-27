// The meeting's rules from the host's "My settings", written into the room metadata by the server only (participants cannot
// change room metadata). Every client applies them to what it RECEIVES, so a modified client cannot get around them; LiveKit
// grants cover what LiveKit can enforce itself (screen sharing).
export interface RoomPolicy {
  chat: 'off' | 'host' | 'everyone';
  privateChat: boolean;
  fileSending: boolean;
  reactions: boolean;
  activities: boolean;
  rename: boolean;
  joinLeaveSound: boolean;
  muteOnJoin: boolean;
  hostVideo: boolean;
  participantVideo: boolean;
  screenShare: 'host' | 'all';
  noShareWithGuests: boolean;
}

export const OPEN_POLICY: RoomPolicy = {
  chat: 'everyone',
  privateChat: true,
  fileSending: true,
  reactions: true,
  activities: true,
  rename: false,
  joinLeaveSound: false,
  muteOnJoin: false,
  hostVideo: true,
  participantVideo: true,
  screenShare: 'all',
  noShareWithGuests: false,
};

export function parseRoomPolicy(metadata: string | undefined | null): RoomPolicy {
  try {
    const m: unknown = metadata ? JSON.parse(metadata) : null;
    const p = (m as { policy?: Partial<RoomPolicy> } | null)?.policy;
    if (!p || typeof p !== 'object') return OPEN_POLICY;
    return {
      chat: p.chat === 'off' || p.chat === 'host' ? p.chat : 'everyone',
      privateChat: p.privateChat !== false,
      fileSending: p.fileSending !== false,
      reactions: p.reactions !== false,
      activities: p.activities !== false,
      rename: p.rename === true,
      joinLeaveSound: p.joinLeaveSound === true,
      muteOnJoin: p.muteOnJoin === true,
      hostVideo: p.hostVideo !== false,
      participantVideo: p.participantVideo !== false,
      screenShare: p.screenShare === 'host' ? 'host' : 'all',
      noShareWithGuests: p.noShareWithGuests === true,
    };
  } catch {
    return OPEN_POLICY;
  }
}

export type Kind = 'chat' | 'private' | 'reaction';

/**
 * Whether a message of `kind` from a sender is accepted. The host side (host, co-hosts) is never restricted. Chat "host":
 * participants may write only privately to the host side. A private message between two participants needs private chat on.
 * Files travel as chat messages; `file` adds the file-sending rule.
 */
export function accepts(p: RoomPolicy, kind: Kind, sender: { manager: boolean }, me: { manager: boolean }, file = false): boolean {
  if (sender.manager) return true;
  if (kind === 'reaction') return p.reactions;
  if (file && !p.fileSending) return false;
  if (p.chat === 'off') return false;
  if (kind === 'chat') return p.chat === 'everyone';
  if (me.manager) return true; // private to the host side
  return p.chat === 'everyone' && p.privateChat;
}

/** What the person may send: the same rules from the sender's side (so the interface explains instead of failing silently). */
export function maySend(p: RoomPolicy, kind: Kind, me: { manager: boolean }, to?: { manager: boolean }, file = false): boolean {
  if (me.manager) return true;
  if (kind === 'reaction') return p.reactions;
  return to ? accepts(p, 'private', { manager: false }, to, file) : accepts(p, 'chat', { manager: false }, { manager: false }, file);
}

/** The camera and microphone a newcomer starts with (the server mutes the same at its first sight of them). */
export function startMedia(p: RoomPolicy, chosen: { mic: boolean; cam: boolean }, role: { host: boolean; manager: boolean }): { mic: boolean; cam: boolean } {
  const camAllowed = role.host ? p.hostVideo : role.manager ? true : p.participantVideo;
  return { mic: chosen.mic && (role.manager || !p.muteOnJoin), cam: chosen.cam && camAllowed };
}
