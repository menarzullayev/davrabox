/**
 * In-meeting signals (chat, raised hand, reactions) travel over the LiveKit data channel as small JSON messages.
 * Everything received is untrusted: decode() validates shape and size and returns null for anything else.
 * The sender is never taken from the payload; the SFU attaches the verified participant identity.
 */
export const MAX_CHAT_LENGTH = 1000;
export const REACTIONS = ['👍', '👏', '❤️', '😂', '🎉', '😮'] as const;
export type Reaction = (typeof REACTIONS)[number];

export type Signal =
  | { t: 'chat'; text: string }
  | { t: 'hand'; up: boolean }
  | { t: 'react'; e: Reaction }
  | { t: 'file'; id: string; name: string; size: number };

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Normalises user input for sending; returns null when nothing sendable is left. */
export function cleanChatText(input: string): string | null {
  const text = input.replace(CONTROL, '').trim();
  if (!text) return null;
  return text.length > MAX_CHAT_LENGTH ? text.slice(0, MAX_CHAT_LENGTH) : text;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export function encode(s: Signal): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(s));
}

/**
 * The recording consent flag. The server (not a participant) sets `{"recording":true}` in the LiveKit room metadata before
 * recording starts and clears it after. It is deliberately NOT a data-channel signal: any participant can publish data, and a
 * forged "recording stopped" would hide the badge. Room metadata can only be written with the server's credentials.
 */
export function parseRoomRecording(metadata: string | undefined): boolean {
  if (!metadata || metadata.length > 4096) return false;
  let v: unknown;
  try {
    v = JSON.parse(metadata);
  } catch {
    return false;
  }
  return typeof v === 'object' && v !== null && !Array.isArray(v) && (v as Record<string, unknown>).recording === true;
}

export function decode(bytes: Uint8Array): Signal | null {
  if (bytes.byteLength === 0 || bytes.byteLength > 8 * 1024) return null;
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.t === 'chat' && typeof o.text === 'string') {
    const text = cleanChatText(o.text);
    return text ? { t: 'chat', text } : null;
  }
  if (o.t === 'hand' && typeof o.up === 'boolean') return { t: 'hand', up: o.up };
  if (o.t === 'react' && typeof o.e === 'string' && (REACTIONS as readonly string[]).includes(o.e)) {
    return { t: 'react', e: o.e as Reaction };
  }
  if (o.t === 'file' && typeof o.id === 'string' && UUID_RE.test(o.id) && typeof o.name === 'string' && typeof o.size === 'number') {
    const name = cleanChatText(o.name);
    if (!name || name.length > 200 || !Number.isInteger(o.size) || o.size <= 0 || o.size > MAX_FILE_BYTES) return null;
    return { t: 'file', id: o.id.toLowerCase(), name, size: o.size };
  }
  return null;
}
