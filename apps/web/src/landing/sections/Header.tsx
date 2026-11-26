import { tx } from '../../home/text';
import { AppearanceControls } from '../../home/AppearanceControls';
import type { Lang } from '../../i18n';
import { Logo, type ThemeChoice } from '../../ui';
import { ButtonLink } from '../ButtonLink';
import { MegaMenu, MenuSheet } from './MegaMenu';

export interface HeaderProps {
  lang: Lang;
  onLang: (l: Lang) => void;
  theme: ThemeChoice;
  onTheme: (v: ThemeChoice) => void;
}

/** Shared header of the landing page and /help: mega-menu on wide screens, a menu sheet on narrow ones (decision 6). */
export function Header({ lang, onLang, theme, onTheme }: HeaderProps) {
  return (
    <header className="ln-header">
      <div className="ln-header__in">
        <a className="ln-brand" href="/" aria-label="DavraBox">
          <Logo height={30} />
        </a>
        <MegaMenu lang={lang} />
        <span className="ln-spacer" />
        <AppearanceControls lang={lang} onLang={onLang} theme={theme} onTheme={onTheme} />
        <ButtonLink className="ln-signin" href="/app" variant="ghost">
          {tx(lang, 'lnSignIn')}
        </ButtonLink>
        <ButtonLink href="/app/signup" variant="primary">
          {tx(lang, 'lnStartFree')}
        </ButtonLink>
        <MenuSheet lang={lang} />
      </div>
    </header>
  );
}
