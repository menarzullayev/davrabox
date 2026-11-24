import { t, type Lang } from '../i18n';
import './legal-links.css';

/** Links to the public privacy notice and terms, for footers and the sign-in screen. Plain anchors: the pages are separate routes. */
export function LegalLinks({ lang, className }: { lang: Lang; className?: string }) {
  return (
    <nav className={`legal-links${className ? ` ${className}` : ''}`} aria-label={t(lang, 'privLegalNav')}>
      <a href="/privacy">{t(lang, 'privLinkPrivacy')}</a>
      <a href="/terms">{t(lang, 'privLinkTerms')}</a>
    </nav>
  );
}
