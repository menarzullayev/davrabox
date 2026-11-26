import { useEffect, useMemo, useState } from 'react';
import { tx } from '../home/text';
import type { Lang } from '../i18n';
import { IconSearch, TextField } from '../ui';
import '../landing/landing.css';
import '../landing/landing-more.css';
import { Footer } from '../landing/sections/Footer';
import { Header } from '../landing/sections/Header';
import { usePrefs } from '../landing/usePrefs';
import { AssistantLauncher } from './AssistantLauncher';
import { HELP, faqById, searchHelp } from './content';
import './help.css';

/** Opens the FAQ entry or guide named by the address fragment (#faq-<id> / #guide-<id>) and scrolls to it. */
function useHashTarget(): string {
  const [hash, setHash] = useState(() => location.hash.slice(1));
  useEffect(() => {
    const on = () => setHash(location.hash.slice(1));
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(hash);
    if (el instanceof HTMLDetailsElement) el.open = true;
    el?.scrollIntoView?.({ block: 'start' });
  }, [hash]);
  return hash;
}

/** The /help page (decision 5): search, short guides and the FAQ in uz/ru/en, plus the help assistant. No sign-in. */
export default function HelpPage() {
  const { lang, setLang, theme, setTheme } = usePrefs('hpPageTitle', 'hpPageDesc');
  const [q, setQ] = useState('');
  const hash = useHashTarget();
  const results = useMemo(() => (q.trim().length >= 2 ? searchHelp(lang, q, 6) : null), [q, lang]);

  return (
    <div className="ln-page hp-page">
      <a className="hm-skip" href="#hp-main">
        {tx(lang, 'lnSkip')}
      </a>
      <Header lang={lang} onLang={setLang} theme={theme} onTheme={setTheme} />
      <main id="hp-main" className="ln-main hp-main" tabIndex={-1}>
        <section className="hp-hero" aria-labelledby="hp-title">
          <h1 className="hp-title" id="hp-title">
            {tx(lang, 'hpTitle')}
          </h1>
          <p className="ln-lead">{tx(lang, 'hpLead')}</p>
          <form className="hp-search" role="search" onSubmit={(e) => e.preventDefault()}>
            <TextField
              label={tx(lang, 'hpSearchLabel')}
              type="search"
              value={q}
              placeholder={tx(lang, 'hpSearchPlaceholder')}
              onChange={(e) => setQ(e.target.value)}
              autoComplete="off"
              data-testid="help-search"
            />
            <IconSearch size={20} className="hp-search__icon" />
          </form>
          {results ? <SearchResults lang={lang} hits={results.map((h) => h.id)} /> : null}
        </section>

        <section className="ln-section" id="guides" aria-labelledby="hp-guides-h">
          <h2 className="ln-h2" id="hp-guides-h">
            {tx(lang, 'hpGuidesTitle')}
          </h2>
          <ul className="ln-grid ln-grid--caps hp-guides">
            {HELP.guides.map((g) => (
              <li key={g.id} className="ln-tile hp-guide" id={`guide-${g.id}`} data-target={hash === `guide-${g.id}` ? '' : undefined}>
                <h3 className="ln-tile__title">{g[lang].title}</h3>
                <ol className="hp-steps">
                  {g[lang].steps.map((s, i) => (
                    <li key={i}>
                      <span className="ln-sr">{tx(lang, 'hpStep', { n: i + 1 })}: </span>
                      {s}
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ul>
        </section>

        <section className="ln-section" id="faq" aria-labelledby="hp-faq-h">
          <h2 className="ln-h2" id="hp-faq-h">
            {tx(lang, 'hpFaqTitle')}
          </h2>
          {HELP.categories.map((c) => (
            <section key={c.id} className="hp-cat" aria-labelledby={`hp-cat-${c.id}`}>
              <h3 className="hp-cat__title" id={`hp-cat-${c.id}`}>
                {c[lang]}
              </h3>
              <div className="hp-faq">
                {HELP.faq
                  .filter((e) => e.cat === c.id)
                  .map((e) => (
                    <details key={e.id} className="hp-qa" id={`faq-${e.id}`} open={hash === `faq-${e.id}` || undefined} data-testid="faq">
                      <summary className="hp-qa__q">{e[lang].q}</summary>
                      <p className="hp-qa__a">{e[lang].a}</p>
                    </details>
                  ))}
              </div>
            </section>
          ))}
        </section>

        <section className="ln-cta hp-contact" aria-labelledby="hp-contact-h">
          <h2 className="ln-cta__title" id="hp-contact-h">
            {tx(lang, 'hpContactTitle')}
          </h2>
          <p className="ln-cta__text">{tx(lang, 'hpContactText')}</p>
          <a className="hp-contact__mail" href="mailto:hello@davrabox.uz">
            {tx(lang, 'hpContactMail')}
          </a>
        </section>
      </main>
      <Footer lang={lang} />
      <AssistantLauncher lang={lang} page="help" />
    </div>
  );
}

function SearchResults({ lang, hits }: { lang: Lang; hits: string[] }) {
  const entries = hits.map(faqById).filter((e): e is NonNullable<typeof e> => !!e);
  return (
    <div className="hp-results" aria-live="polite" data-testid="help-results">
      <h2 className="hp-results__title">{tx(lang, 'hpSearchResults')}</h2>
      {entries.length ? (
        <ul className="hp-results__list">
          {entries.map((e) => (
            <li key={e.id}>
              <a href={`#faq-${e.id}`}>{e[lang].q}</a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hp-results__none">{tx(lang, 'hpSearchNone')}</p>
      )}
    </div>
  );
}
