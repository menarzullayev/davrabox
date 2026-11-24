import type { Lang } from '../i18n';

export interface LegalSection {
  id: string;
  heading: string;
  paragraphs?: string[];
  items?: string[];
}

export interface LegalDoc {
  title: string;
  /** Date of the draft, in the reader's language. */
  updated: string;
  draftTitle: string;
  draftBody: string;
  sections: LegalSection[];
}

export type LegalTexts = Record<Lang, LegalDoc>;

/** Contact address of the privacy section. A placeholder until the operator confirms a real mailbox. */
export const PRIVACY_CONTACT = 'privacy@davrabox.uz';
