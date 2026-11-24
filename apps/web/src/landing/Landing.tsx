import { useEffect } from 'react';
import { tx } from '../home/text';
import { t } from '../i18n';
import './landing.css';
import { Capabilities, FinalCta, ForOrganisations, HowItWorks, JoinMeeting, ProofStrip, Security } from './sections/Blocks';
import { Footer } from './sections/Footer';
import { Header } from './sections/Header';
import { Hero } from './sections/Hero';
import { applyLandingSeo } from './seo';
import { usePrefs } from './usePrefs';

export interface LandingProps {
  /** Navigation with a join code; replaceable so tests do not leave the page. */
  navigate?: (url: string) => void;
}

const go = (url: string) => location.assign(url);

/**
 * The public page at "/". One page, no third-party requests, in uz / ru / en. It names every capability of the launch
 * plan as an equal tile and invents no statistics, customers or logos. Not to be published before every capability it
 * names has been verified (program spec, section 2).
 */
export default function Landing({ navigate = go }: LandingProps) {
  const { lang, setLang, theme, setTheme } = usePrefs('lnPageTitle', 'lnPageDesc');
  useEffect(() => applyLandingSeo(document, location.origin, lang, t(lang, 'appName'), t(lang, 'lnPageDesc')), [lang]);
  return (
    <div className="ln-page">
      <a className="hm-skip" href="#ln-main">
        {tx(lang, 'lnSkip')}
      </a>
      <Header lang={lang} onLang={setLang} theme={theme} onTheme={setTheme} />
      <main id="ln-main" className="ln-main" tabIndex={-1}>
        <Hero lang={lang} theme={theme} navigate={navigate} />
        <ProofStrip lang={lang} />
        <Capabilities lang={lang} />
        <HowItWorks lang={lang} />
        <Security lang={lang} />
        <ForOrganisations lang={lang} />
        <JoinMeeting lang={lang} navigate={navigate} />
        <FinalCta lang={lang} />
      </main>
      <Footer lang={lang} />
    </div>
  );
}
