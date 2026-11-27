// "Put the passcode in the link" (host setting): the passcode is known in the browser only when the meeting is created (the
// server keeps a hash), so the host's tab remembers it for the share link of that meeting, and a joiner's tab takes it from the
// link. Kept in this page's memory only (never written to browser storage): a reload forgets it.
const mem = new Map<string, string>();

export function rememberPasscode(code: string, passcode: string): void {
  mem.set(code, passcode);
}

export function storedPasscode(code: string): string | null {
  return mem.get(code) ?? null;
}

/** Adds `&pwd=` to a join link (before an E2EE key fragment). */
export function withPasscode(link: string, passcode: string | null): string {
  if (!passcode) return link;
  const [head, frag] = link.split('#');
  return `${head}${head!.includes('?') ? '&' : '?'}pwd=${encodeURIComponent(passcode)}${frag ? `#${frag}` : ''}`;
}

/** The passcode of a join link (?pwd=), if well formed. */
export function passcodeFromSearch(search: string): string | null {
  const v = new URLSearchParams(search).get('pwd');
  return v && v.length >= 1 && v.length <= 64 && !/[\u0000-\u001F\u007F]/.test(v) ? v : null;
}
