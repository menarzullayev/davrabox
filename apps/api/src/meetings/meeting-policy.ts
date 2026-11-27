// Server-side enforcement of "My settings" inside meetings (owner decision of 2026-11-27: every setting is enforced by the API
// or by LiveKit grants, not only hidden). The host's effective settings decide how their meetings behave.
import { TrackSource } from 'livekit-server-sdk';
import type { Effective } from '../settings/catalog.js';
import { MeetingError } from './meetings.service.js';

export interface OrgRules {
  joinDisclaimer: string;
  countryRule: string;
  countries: string[];
}

/** What MeetingsService and GuestService need from the settings and notification services (null = feature not wired). */
export interface MeetingPolicyHooks {
  hostSettings(orgId: string, hostUserId: string): Promise<Effective>;
  orgRules(orgId: string): Promise<OrgRules>;
  lobby(orgId: string, meetingId: string, who: string): Promise<unknown>;
}

/** The meeting's rules the clients apply (room metadata, written only by the server; clients never trust a sender). */
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

export function roomPolicy(e: Effective): RoomPolicy {
  return {
    chat: (e['chat'] as RoomPolicy['chat']) ?? 'everyone',
    privateChat: e['privateChat'] !== false,
    fileSending: e['fileSending'] !== false,
    reactions: e['reactions'] !== false,
    activities: e['activities'] !== false,
    rename: e['rename'] === true,
    joinLeaveSound: e['joinLeaveSound'] === true,
    muteOnJoin: e['muteOnJoin'] === true,
    hostVideo: e['hostVideo'] !== false,
    participantVideo: e['participantVideo'] !== false,
    screenShare: e['screenShare'] === 'host' ? 'host' : 'all',
    noShareWithGuests: e['noShareWithGuests'] === true,
  };
}

/**
 * The media a participant may publish (LiveKit grant). Screen sharing is left out for non-managers when the host allows it to
 * the host side only, or when guests may be in the meeting and the host turned sharing off for that case.
 */
export function publishSources(p: RoomPolicy, manages: boolean, guestMode: string): TrackSource[] | undefined {
  if (manages) return undefined;
  const noShare = p.screenShare === 'host' || (p.noShareWithGuests && guestMode !== 'off');
  return noShare ? [TrackSource.CAMERA, TrackSource.MICROPHONE] : undefined;
}

// Data messages (chat, reactions, raised hand, polls, Q&A, whiteboard) share one LiveKit data permission, and the raised hand
// must always work, so the permission stays; every receiving client applies the server-written room policy per message kind
// (a sender cannot change that policy).

/** Country rule (Cloudflare's CF-IPCountry): allow-list or block-list. Unknown (XX) and Tor (T1) count as their own codes. */
export function countryAllowed(rules: OrgRules, country: string | undefined): boolean {
  if (rules.countryRule === 'off' || !rules.countries.length) return true;
  const c = country && /^[A-Z0-9]{2}$/.test(country) ? country : 'XX';
  return rules.countryRule === 'allow' ? rules.countries.includes(c) : !rules.countries.includes(c);
}

/**
 * Organization join rules, checked before anything else of a join (members and guests; organization admins are exempt from
 * the country rule so they can never lock themselves out). Throws 403 for a blocked country, 428 with the text when the join
 * disclaimer was not accepted.
 */
export function checkJoinRules(rules: OrgRules, ctx: { country?: string; acceptDisclaimer?: boolean; admin?: boolean }, onBlocked: () => Promise<void>): Promise<void> | void {
  if (!ctx.admin && !countryAllowed(rules, ctx.country)) {
    return onBlocked().then(() => {
      throw new MeetingError(403, 'joining from your country is not allowed by this organization', { code: 'country_blocked' });
    });
  }
  if (rules.joinDisclaimer.trim() && !ctx.acceptDisclaimer) {
    throw new MeetingError(428, 'accept the organization notice first', { code: 'disclaimer', disclaimer: rules.joinDisclaimer });
  }
}
