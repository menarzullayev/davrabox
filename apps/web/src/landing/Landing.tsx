import { useEffect } from 'react';
import { tx } from '../home/text';
import { t } from '../i18n';
import './landing.css';
import './landing-more.css';
import { Capabilities, FinalCta, ForOrganisations, HowItWorks, JoinMeeting, ProofStrip, Security } from './sections/Blocks';
import { Footer } from './sections/Footer';
import { Demos, Downloads, Pricing, Trust } from './sections/More';
import { AssistantLauncher } from '../help/AssistantLauncher';
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
 * The public page at "/". One page, no third-party requests, in uz / ru / en. Message: security + convenience (decision 1).
 * It names every capability as an equal tile, shows only verifiable facts with evidence links (decision 2), real trial
 * limits (decision 3), beta downloads tied to a CI build (decision 4), the help assistant (decision 5) and demo clips
 * (decision 7). It invents no statistics, customers or logos.
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
        <Demos lang={lang} />
        <HowItWorks lang={lang} />
        <Security lang={lang} />
        <Trust lang={lang} />
        <ForOrganisations lang={lang} />
        <Pricing lang={lang} />
        <Downloads lang={lang} />
        <JoinMeeting lang={lang} navigate={navigate} />
        <FinalCta lang={lang} />
      </main>
      <Footer lang={lang} />
      <AssistantLauncher lang={lang} page="landing" />
    </div>
  );
}
