import { tx } from '../../home/text';
import type { Lang } from '../../i18n';
import { Logo } from '../../ui';
import { REPO_URL } from '../menu';

/** Contact address of the operator. TO CONFIRM before publication (see the PR description): it is the only mailto on the page. */
export { CONTACT_EMAIL } from '../../brand/contact';
import { CONTACT_EMAIL } from '../../brand/contact';

export function Footer({ lang }: { lang: Lang }) {
  return (
    <footer className="ln-footer">
      <div className="ln-footer__in">
        <Logo height={26} />
        <ul className="ln-footer__links">
          <li>
            <a href="/help">{tx(lang, 'lnFootHelp')}</a>
          </li>
          <li>
            <a href="/privacy">{tx(lang, 'lnFootPrivacy')}</a>
          </li>
          <li>
            <a href="/terms">{tx(lang, 'lnFootTerms')}</a>
          </li>
          <li>
            <a href={`mailto:${CONTACT_EMAIL}`}>{tx(lang, 'lnFootContact')}</a>
          </li>
          <li>
            <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
              {tx(lang, 'lnFootSource')}
              <span className="ln-sr"> ({tx(lang, 'lnTrustExternal')})</span>
            </a>
          </li>
        </ul>
        <small className="ln-footer__rights">{tx(lang, 'lnFootRights')}</small>
      </div>
    </footer>
  );
}
