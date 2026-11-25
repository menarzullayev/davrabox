// What happens when the API says 401 to the signed-in person's own token (the identity provider lost the session, for
// example after a restart): forget the dead session and show the sign-in screen, instead of a generic "Something went wrong".
const KEY = 'davra:session-lost-at';
const MIN_GAP_MS = 15_000; // never bounce twice in a row: a server that keeps answering 401 must not cause a reload loop

export interface RecoveryDeps {
  now: () => number;
  store: Pick<Storage, 'getItem' | 'setItem'>;
  removeUser: () => Promise<unknown>;
  goHome: () => void;
}

/** Returns true when it started the recovery, false when it did nothing (a bounce just happened). */
export function recoverSession(d: RecoveryDeps): boolean {
  const last = Number(d.store.getItem(KEY) ?? 0);
  if (d.now() - last < MIN_GAP_MS) return false;
  d.store.setItem(KEY, String(d.now()));
  void d.removeUser().finally(d.goHome);
  return true;
}
