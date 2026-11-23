import { tx } from '../../home/text';
import type { Lang } from '../../i18n';
import { Logo } from '../../ui';

/** Contact address of the operator. TO CONFIRM before publication (see the PR description): it is the only mailto on the page. */
export const CONTACT_EMAIL = 'hello@davrabox.uz';

export function Footer({ lang }: { lang: Lang }) {
  return (
    <footer className="ln-footer">
      <div className="ln-footer__in">
        <Logo height={26} />
        <ul className="ln-footer__links">
          {/* The legal texts do not exist yet: plain text, not dead links. They become links when they are published. */}
          <li>
            <span>{tx(lang, 'lnFootPrivacy')}</span> <span className="ln-footer__soon">({tx(lang, 'lnFootSoon')})</span>
          </li>
          <li>
            <span>{tx(lang, 'lnFootTerms')}</span> <span className="ln-footer__soon">({tx(lang, 'lnFootSoon')})</span>
          </li>
          <li>
            <a href={`mailto:${CONTACT_EMAIL}`}>{tx(lang, 'lnFootContact')}</a>
          </li>
        </ul>
        <small className="ln-footer__rights">{tx(lang, 'lnFootRights')}</small>
      </div>
    </footer>
  );
}
