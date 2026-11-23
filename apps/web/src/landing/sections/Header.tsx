import { tx } from '../../home/text';
import { SettingsMenu } from '../../home/SettingsMenu';
import type { Lang } from '../../i18n';
import { Logo, type ThemeChoice } from '../../ui';
import { ButtonLink } from '../ButtonLink';

export interface HeaderProps {
  lang: Lang;
  onLang: (l: Lang) => void;
  theme: ThemeChoice;
  onTheme: (v: ThemeChoice) => void;
}

export function Header({ lang, onLang, theme, onTheme }: HeaderProps) {
  return (
    <header className="ln-header">
      <div className="ln-header__in">
        <a className="ln-brand" href="/" aria-label="DavraBox">
          <Logo height={30} />
        </a>
        <nav className="ln-nav" aria-label={tx(lang, 'lnNavLabel')}>
          <a href="#capabilities">{tx(lang, 'lnNavCaps')}</a>
          <a href="#security">{tx(lang, 'lnNavSecurity')}</a>
          <a href="#organisations">{tx(lang, 'lnNavOrgs')}</a>
        </nav>
        <span className="ln-spacer" />
        <SettingsMenu lang={lang} onLang={onLang} theme={theme} onTheme={onTheme} />
        <ButtonLink className="ln-signin" href="/app" variant="ghost">
          {tx(lang, 'lnSignIn')}
        </ButtonLink>
        <ButtonLink href="/app/signup" variant="primary">
          {tx(lang, 'lnStartFree')}
        </ButtonLink>
      </div>
    </header>
  );
}
