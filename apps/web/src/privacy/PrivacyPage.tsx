import { useEffect, useState } from 'react';
import { detectLang, t, type Lang } from '../i18n';
import { applyTheme, Logo, readTheme } from '../ui';
import { LegalLinks } from './LegalLinks';
import { PRIVACY_TEXT } from './legal-privacy';
import { TERMS_TEXT } from './legal-terms';
import type { LegalDoc } from './legal-types';
import './privacy.css';

const LANGS: Array<{ id: Lang; label: string }> = [
  { id: 'uz', label: 'O‘zbekcha' },
  { id: 'ru', label: 'Русский' },
  { id: 'en', label: 'English' },
];

export type LegalKind = 'privacy' | 'terms';

/**
 * A static, accessible page for the privacy notice or the terms. No sign-in, no backend call. The text lives in legal-privacy.ts / legal-terms.ts.
 */
export function PrivacyPage({ kind, initialLang }: { kind: LegalKind; initialLang?: Lang }) {
  const [lang, setLangState] = useState<Lang>(initialLang ?? detectLang);
  const doc: LegalDoc = (kind === 'privacy' ? PRIVACY_TEXT : TERMS_TEXT)[lang];

  useEffect(() => {
    applyTheme(readTheme());
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = `${doc.title} - DavraBox`;
  }, [lang, doc.title]);

  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem('lang', l);
    } catch {
      /* storage unavailable: the choice lasts for this visit only */
    }
  };

  /** Back to where the person came from; a page opened directly (no history) goes to the application. */
  const goBack = () => {
    if (history.length > 1) history.back();
    else location.assign('/app');
  };

  return (
    <div className="legal">
      <header className="legal__bar">
        <a href="/" className="legal__home" aria-label={t(lang, 'privBackHome')}>
          <Logo height={28} />
        </a>
        <button type="button" className="legal__back" data-testid="legal-back" onClick={goBack}>
          ← {t(lang, 'hJoinBack')}
        </button>
        <div className="legal__langs" role="group" aria-label={t(lang, 'privLangLabel')}>
          {LANGS.map((l) => (
            <button key={l.id} type="button" aria-pressed={lang === l.id} onClick={() => setLang(l.id)} lang={l.id}>
              {l.label}
            </button>
          ))}
        </div>
      </header>
      <main className="legal__main" id="main">
        <h1 className="legal__title">{doc.title}</h1>
        <p className="legal__updated">{doc.updated}</p>
        {doc.sections.map((s) => (
          <section key={s.id} aria-labelledby={`legal-${s.id}`} className="legal__section">
            <h2 id={`legal-${s.id}`}>{s.heading}</h2>
            {s.paragraphs?.map((p, i) => <p key={i}>{p}</p>)}
            {s.items && (
              <ul>
                {s.items.map((it, i) => <li key={i}>{it}</li>)}
              </ul>
            )}
          </section>
        ))}
      </main>
      <footer className="legal__foot">
        <LegalLinks lang={lang} />
        <a href="/">{t(lang, 'privBackHome')}</a>
      </footer>
    </div>
  );
}
