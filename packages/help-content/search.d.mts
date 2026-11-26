export type HelpLang = 'uz' | 'ru' | 'en';

export interface FaqText {
  q: string;
  a: string;
  /** Extra search keywords (space separated), never shown. */
  k: string;
}

export interface FaqEntry {
  id: string;
  cat: string;
  uz: FaqText;
  ru: FaqText;
  en: FaqText;
}

export interface GuideText {
  title: string;
  steps: string[];
}

export interface Guide {
  id: string;
  uz: GuideText;
  ru: GuideText;
  en: GuideText;
}

export interface Category {
  id: string;
  uz: string;
  ru: string;
  en: string;
}

export interface HelpContent {
  version: number;
  categories: Category[];
  faq: FaqEntry[];
  guides: Guide[];
}

export interface SearchHit {
  id: string;
  /** Mean weight per query word, 0..3. */
  score: number;
  /** Query words that matched. */
  matched: number;
  /** Query words after stop words were removed. */
  words: number;
}

export function tokenize(text: string): string[];
export function searchFaq(content: HelpContent, lang: HelpLang, query: string, limit?: number): SearchHit[];
export function isConfident(hit: SearchHit | undefined): boolean;
export function faqAsText(content: HelpContent, lang: HelpLang): string;
