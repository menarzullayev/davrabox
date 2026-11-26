// FAQ search shared by the /help page (browser) and the help assistant (API). Plain JavaScript on purpose: the API
// runs compiled JavaScript from node_modules, where TypeScript sources are not loaded. Types: search.d.mts.

/** Apostrophe-like characters of Uzbek Latin (o‘, g‘, ʼ) and their ASCII stand-ins all collapse to nothing. */
const APOSTROPHES = /[‘’ʻʼ`´']/g;

// Words that carry no topic in the three languages. Kept short on purpose: a missing stop word only adds noise.
const STOP = new Set([
  // en
  'a', 'an', 'the', 'is', 'are', 'do', 'does', 'i', 'my', 'me', 'can', 'how', 'what', 'to', 'in', 'of', 'and', 'or', 'it', 'for', 'on', 'with', 'be', 'we', 'you', 'our', 'your', 'there', 'this', 'that', 'not',
  // ru
  'как', 'что', 'и', 'в', 'на', 'не', 'ли', 'я', 'мне', 'мой', 'моя', 'можно', 'есть', 'это', 'с', 'по', 'для', 'у', 'а', 'или', 'же', 'ко', 'к', 'о', 'об', 'из', 'вы', 'мы',
  // uz
  'va', 'qanday', 'nima', 'men', 'meni', 'mening', 'bu', 'u', 'bilan', 'uchun', 'ham', 'bormi', 'mumkinmi', 'qilaman', 'qanaqa', 'nega', 'qayerda', 'bor', 'yoq', 'emas',
]);

/**
 * Lower case, NFKC, apostrophes removed, "ё" read as "е"; returns the words (letters and digits) without stop words.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  return String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(APOSTROPHES, '')
    .replace(/ё/g, 'е')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

// A crude stem: Uzbek and Russian add endings to the same root ("uchrashuvga", "uchrashuvni"; "встречи", "встречу").
// Comparing the first five letters (or the whole word when shorter) is enough for a short FAQ and costs nothing.
const STEM = 5;
const stem = (w) => (w.length > STEM ? w.slice(0, STEM) : w);

/**
 * @param {string} token
 * @param {Set<string>} stems
 */
const has = (token, stems) => stems.has(stem(token));

/** @param {string} s */
const stemsOf = (s) => new Set(tokenize(s).map(stem));

/**
 * Ranks the FAQ entries of one language for a free-text question.
 * Weights: keyword 3, question 2, answer 1 per query word; the score is the mean over the query words (0..3).
 * @param {import('./search.d.mts').HelpContent} content
 * @param {'uz'|'ru'|'en'} lang
 * @param {string} query
 * @param {number} [limit]
 * @returns {import('./search.d.mts').SearchHit[]}
 */
export function searchFaq(content, lang, query, limit = 3) {
  const words = [...new Set(tokenize(query))].slice(0, 24);
  if (words.length === 0) return [];
  const hits = [];
  for (const entry of content.faq) {
    const t = entry[lang];
    if (!t) continue;
    const k = stemsOf(t.k);
    const q = stemsOf(t.q);
    const a = stemsOf(t.a);
    let total = 0;
    let matched = 0;
    for (const w of words) {
      const s = has(w, k) ? 3 : has(w, q) ? 2 : has(w, a) ? 1 : 0;
      if (s > 0) matched += 1;
      total += s;
    }
    if (matched === 0) continue;
    hits.push({ id: entry.id, score: total / words.length, matched, words: words.length });
  }
  hits.sort((x, y) => y.score - x.score || y.matched - x.matched || x.id.localeCompare(y.id));
  return hits.slice(0, limit);
}

/**
 * True when the best hit answers the question well enough to show it without asking a language model: at least half of
 * the query words matched and the mean weight reaches 1.2 (a keyword hit for a short question).
 * @param {import('./search.d.mts').SearchHit | undefined} hit
 */
export function isConfident(hit) {
  if (!hit) return false;
  return hit.matched * 2 >= hit.words && hit.score >= 1.2;
}

/**
 * The FAQ of one language as plain text, for the assistant's system prompt (stable order, so it can be cached).
 * @param {import('./search.d.mts').HelpContent} content
 * @param {'uz'|'ru'|'en'} lang
 */
export function faqAsText(content, lang) {
  return content.faq.map((e) => `Q: ${e[lang].q}\nA: ${e[lang].a}`).join('\n\n');
}
