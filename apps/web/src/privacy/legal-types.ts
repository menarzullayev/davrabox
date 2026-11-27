import type { Lang } from '../i18n';

export interface LegalSection {
  id: string;
  heading: string;
  paragraphs?: string[];
  items?: string[];
}

export interface LegalDoc {
  title: string;
  /** Date of the last update, in the reader's language. */
  updated: string;
  sections: LegalSection[];
}

export type LegalTexts = Record<Lang, LegalDoc>;

/** Contact address of the privacy and terms pages: the owner's mailbox (decided 2026-11-28). */
export const PRIVACY_CONTACT = 'kepdotuz@gmail.com';
