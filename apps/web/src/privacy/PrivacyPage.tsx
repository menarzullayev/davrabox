import { useEffect, useMemo } from 'react';
import { t, type Lang } from '../i18n';
import { LANGS, setPref, usePrefs } from '../prefs';
import { Button, Logo, Segmented } from '../ui';
import { LegalLinks } from './LegalLinks';
import { PRIVACY_TEXT } from './legal-privacy';
import { TERMS_TEXT } from './legal-terms';
import type { LegalDoc } from './legal-types';
import './privacy.css';


export type LegalKind = 'privacy' | 'terms';

/**
 * A static, accessible page for the privacy notice or the terms. No sign-in, no backend call. The text lives in legal-privacy.ts / legal-terms.ts.
 */
export function PrivacyPage({ kind, initialLang }: { kind: LegalKind; initialLang?: Lang }) {
  // `initialLang` (tests, previews) is a starting value for this visit only: nothing is saved by it.
  useMemo(() => {
    if (initialLang) setPref('lang', initialLang, { persist: false });
  }, [initialLang]);
  const prefs = usePrefs();
  const lang: Lang = prefs.lang;
  const setLang = prefs.setLang;
  const doc: LegalDoc = (kind === 'privacy' ? PRIVACY_TEXT : TERMS_TEXT)[lang];

  useEffect(() => {
    document.title = `${doc.title} - DavraBox`;
  }, [lang, doc.title]);


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
        <Button variant="secondary" size="sm" className="legal__back" data-testid="legal-back" onClick={goBack}>
          ← {t(lang, 'hJoinBack')}
        </Button>
        <Segmented
          className="legal__langs"
          variant="pill"
          mode="pressed"
          label={t(lang, 'privLangLabel')}
          value={lang}
          onChange={setLang}
          options={LANGS.map((l) => ({ id: l.id, label: l.name, lang: l.id }))}
        />
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
