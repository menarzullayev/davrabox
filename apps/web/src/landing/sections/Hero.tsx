import { tx } from '../../home/text';
import type { Lang } from '../../i18n';
import { Davra, IconCheck, IconChevronRight, type ThemeChoice } from '../../ui';
import { ButtonLink } from '../ButtonLink';
import { JoinForm } from '../JoinForm';

export interface HeroProps {
  lang: Lang;
  theme: ThemeChoice;
  navigate: (url: string) => void;
}

/** The screenshots are the call screen in the davra layout (rendered by apps/e2e/landing.shots.mjs from the call lab). */
export const HERO_SHOT = { dark: '/landing/call-davra-dark.jpg', light: '/landing/call-davra-light.jpg', width: 1280, height: 720 } as const;
/** WebP variants (640 and 1280 px wide) of the same screenshots; the jpg stays as the fallback. public/theme-init.js preloads the same files. */
export const HERO_SHOT_SIZES = '(max-width: 959px) calc(100vw - 48px), 640px';
export const heroSrcSet = (theme: 'dark' | 'light'): string => `/landing/call-davra-${theme}-640.webp 640w, /landing/call-davra-${theme}-1280.webp 1280w`;

export function Hero({ lang, theme, navigate }: HeroProps) {
  return (
    <section className="ln-hero" aria-labelledby="ln-hero-title">
      <div className="ln-hero__copy">
        <p className="ln-kicker">{tx(lang, 'lnHeroKicker')}</p>
        <h1 className="ln-hero__title" id="ln-hero-title">
          {tx(lang, 'lnHeroTitle')}
        </h1>
        <p className="ln-hero__text">{tx(lang, 'lnHeroText')}</p>
        <ul className="ln-ease" aria-label={tx(lang, 'lnHeroKicker')}>
          {(['lnEase1', 'lnEase2', 'lnEase3'] as const).map((k) => (
            <li key={k} className="ln-ease__item">
              <IconCheck size={16} />
              {tx(lang, k)}
            </li>
          ))}
        </ul>
        <div className="ln-hero__cta">
          <ButtonLink href="/app/signup" variant="primary" size="lg" iconEnd={<IconChevronRight size={18} />}>
            {tx(lang, 'lnStartFree')}
          </ButtonLink>
          <p className="ln-hero__have">
            {tx(lang, 'lnHeroHave')} <a href="/app">{tx(lang, 'lnSignIn')}</a>
          </p>
        </div>
        <p className="ln-hero__note">{tx(lang, 'lnHeroNote')}</p>
        <JoinForm lang={lang} navigate={navigate} testId="landing-join" />
      </div>
      <div className="ln-hero__art">
        <Davra className="ln-mandala" size={640} rings={4} petals={12} rotation={8} />
        <figure className="ln-shot">
          <picture>
            <source type="image/webp" srcSet={heroSrcSet(theme)} sizes={HERO_SHOT_SIZES} />
            <img
              src={HERO_SHOT[theme]}
              width={HERO_SHOT.width}
              height={HERO_SHOT.height}
              alt={tx(lang, 'lnHeroShotAlt')}
              decoding="async"
              {...{ fetchpriority: 'high' }}
            />
          </picture>
        </figure>
      </div>
    </section>
  );
}
