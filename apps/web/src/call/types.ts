import type { Reaction } from '../signals';

/** What the presentational call UI knows about one participant. LiveKit objects never cross this boundary. */
export interface ParticipantView {
  id: string;
  name: string;
  local: boolean;
  speaking: boolean;
  micMuted: boolean;
  camOn: boolean;
  handUp: boolean;
  reaction: Reaction | null;
  isCohost: boolean;
  /** Pinned by this person (local choice, featured on their own stage only). */
  pinned?: boolean;
  /** Featured for everyone by the host (server-set room metadata). */
  spotlit?: boolean;
}

export interface ChatLineView {
  id: number;
  from: string;
  text: string;
  mine: boolean;
  file?: { id: string; name: string; size: number };
  /** Private messages: the recipient's name for sent ones. */
  to?: string;
  priv: boolean;
}

export type Quality = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';
export type PanelId = 'chat' | 'people' | 'polls' | 'qa' | 'board' | null;
export type Role = 'host' | 'cohost' | 'member';

export interface RecordingItem {
  id: string;
  status: string;
  startedAt: string;
  sizeBytes: number | null;
}

/** Recording as the call screen sees it. `on` is the consent truth (server-set room metadata), shown to EVERY participant. */
export interface RecordingView {
  on: boolean;
  /** The meeting is end-to-end encrypted: recording is refused. */
  e2ee: boolean;
  /** A start or stop request is in flight. */
  busy: boolean;
  /** Present only for the host or a co-host while recording is available. */
  onToggle?(): void;
  items?: RecordingItem[];
  onDownload?(id: string): void;
}

export interface JoinRequestView {
  id: string;
  name: string;
}

/** What a manager (host or co-host) may do to another participant. Absent for plain members. */
export interface ManageActions {
  isHost: boolean;
  onMute(id: string): void;
  onRemove(id: string): void;
  onToggleCohost(id: string): void;
  /** Feature this participant for everyone (null clears it). */
  onSpotlight?(id: string | null): void;
  /** Mute everyone except the host side (asks first). */
  onMuteAll?(): void;
}
