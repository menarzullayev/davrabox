import type { ReactNode } from 'react';
import { t, type Lang } from '../i18n';
import { IconCamera, IconChevronRight, Switch, type ThemeChoice } from '../ui';
import { AppearanceFields } from '../home/AppearanceFields';
import { tx } from '../home/text';
import { onLinkClick, pathFor } from '../shell/nav';

export interface SettingsPageProps {
  lang: Lang;
  onLang: (l: Lang) => void;
  theme: ThemeChoice;
  onTheme: (v: ThemeChoice) => void;
  relay: { value: boolean; onChange: (v: boolean) => void };
  /** More groups (profile, my settings) are added by later packages. */
  children?: ReactNode;
}

/** The "Settings" section: appearance, the firewall (relay-only) mode and the device check. */
export function SettingsPage({ lang, onLang, theme, onTheme, relay, children }: SettingsPageProps) {
  return (
    <main id="hm-main" className="home hm-main" tabIndex={-1} data-testid="settings-page">
      <header className="pg-head">
        <h1 className="pg-title">{tx(lang, 'stTitle')}</h1>
      </header>
      <div className="pg-stack">
        {children}
        <section className="hm-card st-card" aria-labelledby="st-look-h">
          <h2 className="hm-card__title" id="st-look-h">
            {tx(lang, 'stAppearance')}
          </h2>
          <div className="st-fields">
            <AppearanceFields lang={lang} onLang={onLang} theme={theme} onTheme={onTheme} />
          </div>
        </section>
        <section className="hm-card st-card" aria-labelledby="st-conn-h">
          <h2 className="hm-card__title" id="st-conn-h">
            {tx(lang, 'stConnection')}
          </h2>
          <Switch label={t(lang, 'relayMode')} hint={t(lang, 'relayHint')} checked={relay.value} data-testid="st-relay" onChange={(e) => relay.onChange(e.target.checked)} />
          <a className="st-link" href={pathFor('devices')} data-testid="st-devices" onClick={(e) => onLinkClick(e, pathFor('devices'))}>
            <IconCamera size={20} />
            <span className="st-link__body">
              <span className="st-link__title">{tx(lang, 'shDevices')}</span>
              <span className="st-link__text">{tx(lang, 'stDevicesLead')}</span>
            </span>
            <IconChevronRight size={18} />
          </a>
        </section>
      </div>
    </main>
  );
}
