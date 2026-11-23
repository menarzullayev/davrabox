// One mailbox, one trial. normalizeEmail() folds the spellings of the SAME mailbox to one string; it never merges
// different mailboxes. Dots are insignificant only at Gmail; "+tag" is standard plus-addressing at the providers below.
// Anywhere else the address is only lower-cased (a different dot or tag may be a different mailbox there).

const GMAIL = new Set(['gmail.com', 'googlemail.com']);
const PLUS_ADDRESSING = new Set([
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com',
  'proton.me', 'protonmail.com', 'pm.me', 'fastmail.com', 'yandex.ru', 'yandex.com', 'ya.ru',
]);

function split(email: string): { local: string; domain: string } {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  return at < 0 ? { local: e, domain: '' } : { local: e.slice(0, at), domain: e.slice(at + 1) };
}

export function emailDomain(email: string): string {
  return split(email).domain;
}

export function normalizeEmail(email: string): string {
  const { local, domain } = split(email);
  if (GMAIL.has(domain)) return `${local.split('+')[0]!.replace(/\./g, '')}@gmail.com`;
  if (PLUS_ADDRESSING.has(domain)) return `${local.split('+')[0]!}@${domain}`;
  return `${local}@${domain}`;
}
