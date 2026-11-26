import raw from '@davrabox/help-content/faq.json';
import { isConfident, searchFaq, type FaqEntry, type HelpContent, type SearchHit } from '@davrabox/help-content/search';
import type { Lang } from '../i18n';

/** The FAQ and guides shared with the API's assistant (packages/help-content). */
export const HELP = raw as HelpContent;

export const faqById = (id: string): FaqEntry | undefined => HELP.faq.find((e) => e.id === id);

/** Client-side FAQ search (the same code the assistant runs first on the server). */
export function searchHelp(lang: Lang, query: string, limit = 5): SearchHit[] {
  return searchFaq(HELP, lang, query, limit);
}

export { isConfident };
