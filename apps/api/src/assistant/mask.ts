// Masking of personal data in help-assistant text before it is stored or sent to a language model (decision 5d).
// Inputs are capped at a few thousand characters before these run, and every pattern is linear on such input.

const EMAIL = /[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63})+/gu;
// 13-19 digits with optional single spaces or dashes between them: payment cards (and IBAN-like digit runs).
const CARD = /(?<![\p{N}])\d(?:[ -]?\d){12,18}(?![\p{N}])/gu;
// Phone numbers: an optional "+", then at least 7 more digits with spaces, dots, dashes or brackets between them.
const PHONE = /(?<![\p{N}])\+?\(?\d(?:[\s().-]{0,2}\d){6,15}(?![\p{N}])/gu;

export const MASK = { email: '[email]', card: '[card]', phone: '[phone]' } as const;

/** Our own public mailboxes (hello@, privacy@) appear in FAQ answers and are not personal data. */
const OWN_DOMAIN = /@davrabox\.uz$/i;

/** Replaces e-mail addresses, card-like and phone-like numbers with fixed labels. */
export function maskPersonalData(text: string): string {
  return text
    .replace(EMAIL, (m) => (OWN_DOMAIN.test(m) ? m : MASK.email))
    .replace(CARD, MASK.card)
    .replace(PHONE, MASK.phone);
}

/** Drops control characters (except new lines and tabs) and trims; collapses runs of blank lines. */
export function cleanText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
