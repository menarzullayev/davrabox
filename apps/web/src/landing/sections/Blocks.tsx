import type { ReactNode } from 'react';
import { tx } from '../../home/text';
import type { Key, Lang } from '../../i18n';
import {
  IconCalendar, IconCamera, IconChat, IconDownload, IconEye, IconGlobe, IconLink, IconLock, IconSettings, IconShield, IconShieldCheck, IconUser, IconUsers,
  type IconComponent,
} from '../../ui';
import { ButtonLink } from '../ButtonLink';
import { JoinForm } from '../JoinForm';

interface Props {
  lang: Lang;
}

const key = (prefix: string, n: number, part: 'T' | 'D') => `${prefix}${n}${part}` as Key;

/** Proof strip: four facts that can be shown, no figures. */
export function ProofStrip({ lang }: Props) {
  return (
    <section className="ln-proof" aria-label={tx(lang, 'lnProofLabel')}>
      <ul className="ln-proof__list">
        {[1, 2, 3, 4].map((n) => (
          <li key={n} className="ln-proof__item">
            <strong>{tx(lang, key('lnProof', n, 'T'))}</strong>
            <span>{tx(lang, key('lnProof', n, 'D'))}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// One equal tile per capability, in the order of the launch plan. The icons are decorative; the set has no record or
// phone glyph, so those two use the closest neutral one.
const CAP_ICON: ReadonlyArray<IconComponent> = [
  IconCamera, IconUsers, IconChat, IconShieldCheck, IconEye, IconLock, IconDownload, IconCalendar, IconLink, IconShield, IconUser, IconSettings,
];

// Truthful state of each tile, same order. 'soon' = not usable by a visitor today. Flip a value when the capability is verified:
// recording needs a media server that can reach the storage (the pilot uses LiveKit Cloud), calendar needs registered OAuth
// apps, the Android app and the signed Windows app need store accounts and certificates (all user-supplied, due 2027).
const CAP_STATUS: ReadonlyArray<'live' | 'soon'> = ['live', 'live', 'live', 'live', 'live', 'live', 'soon', 'soon', 'live', 'live', 'soon', 'soon'];

export function Capabilities({ lang }: Props) {
  return (
    <section className="ln-section" id="capabilities" aria-labelledby="ln-caps-h">
      <SectionHead id="ln-caps-h" title={tx(lang, 'lnCapsTitle')} lead={tx(lang, 'lnCapsLead')} />
      <ul className="ln-grid ln-grid--caps">
        {CAP_ICON.map((Icon, i) => (
          <li key={i} className="ln-tile" data-testid="capability">
            <span className="ln-tile__icon">
              <Icon size={22} />
            </span>
            <h3 className="ln-tile__title">
              {tx(lang, key('lnCap', i + 1, 'T'))}
              {CAP_STATUS[i] === 'soon' ? (
                <span className="ln-soon" data-testid="capability-soon">
                  {tx(lang, 'lnSoon')}
                </span>
              ) : null}
            </h3>
            <p className="ln-tile__text">{tx(lang, key('lnCap', i + 1, 'D'))}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function HowItWorks({ lang }: Props) {
  return (
    <section className="ln-section" aria-labelledby="ln-how-h">
      <SectionHead id="ln-how-h" title={tx(lang, 'lnHowTitle')} />
      <ol className="ln-steps">
        {[1, 2, 3].map((n) => (
          <li key={n} className="ln-step">
            <span className="ln-step__n" aria-hidden="true">
              {n}
            </span>
            <h3 className="ln-tile__title">{tx(lang, key('lnHow', n, 'T'))}</h3>
            <p className="ln-tile__text">{tx(lang, key('lnHow', n, 'D'))}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function Security({ lang }: Props) {
  return (
    <section className="ln-section ln-section--band" id="security" aria-labelledby="ln-sec-h">
      <SectionHead id="ln-sec-h" title={tx(lang, 'lnSecTitle')} lead={tx(lang, 'lnSecLead')} />
      <ul className="ln-grid ln-grid--four">
        {[1, 2, 3, 4].map((n) => (
          <li key={n} className="ln-tile">
            <h3 className="ln-tile__title">{tx(lang, key('lnSec', n, 'T'))}</h3>
            <p className="ln-tile__text">{tx(lang, key('lnSec', n, 'D'))}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ForOrganisations({ lang }: Props) {
  return (
    <section className="ln-section" id="organisations" aria-labelledby="ln-org-h">
      <SectionHead id="ln-org-h" title={tx(lang, 'lnOrgTitle')} lead={tx(lang, 'lnOrgLead')} />
      <ul className="ln-grid ln-grid--four">
        {[1, 2, 3, 4].map((n) => (
          <li key={n} className="ln-tile">
            <span className="ln-tile__icon">
              <IconGlobe size={22} />
            </span>
            <h3 className="ln-tile__title">{tx(lang, key('lnOrg', n, 'T'))}</h3>
            <p className="ln-tile__text">{tx(lang, key('lnOrg', n, 'D'))}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function JoinMeeting({ lang, navigate }: Props & { navigate: (url: string) => void }) {
  return (
    <section className="ln-section ln-join-block" aria-labelledby="ln-join-h">
      <SectionHead id="ln-join-h" title={tx(lang, 'lnJoinTitle')} lead={tx(lang, 'lnJoinLead')} />
      <JoinForm lang={lang} navigate={navigate} testId="landing-join-section" />
    </section>
  );
}

export function FinalCta({ lang }: Props) {
  return (
    <section className="ln-cta" aria-labelledby="ln-cta-h">
      <h2 className="ln-cta__title" id="ln-cta-h">
        {tx(lang, 'lnCtaTitle')}
      </h2>
      <p className="ln-cta__text">{tx(lang, 'lnCtaText')}</p>
      <ButtonLink href="/app/signup" variant="primary" size="lg">
        {tx(lang, 'lnStartFree')}
      </ButtonLink>
    </section>
  );
}

function SectionHead({ id, title, lead }: { id: string; title: ReactNode; lead?: ReactNode }) {
  return (
    <div className="ln-head">
      <h2 className="ln-h2" id={id}>
        {title}
      </h2>
      {lead ? <p className="ln-lead">{lead}</p> : null}
    </div>
  );
}
