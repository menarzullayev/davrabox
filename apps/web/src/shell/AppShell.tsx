import { createContext, useContext, useState, type ReactNode } from 'react';
import { t, type Key, type Lang } from '../i18n';
import {
  Avatar,
  Button,
  Dialog,
  IconCamera,
  IconHelp,
  IconHome,
  IconLogout,
  IconMore,
  IconPlus,
  IconRecord,
  IconSettings,
  IconShieldCheck,
  IconUser,
  IconCalendar,
  IconWhiteboard,
  Logo,
  type IconComponent,
  type ThemeChoice,
} from '../ui';
import { AppearanceControls } from '../home/AppearanceControls';
import { navigate, onLinkClick, pathFor, type AppSection } from './nav';

/** Where the admin console puts its section list: inside the left panel, under "Admin" (owner decision 1). */
export const ShellSlot = createContext<{ inShell: boolean; adminNav: HTMLElement | null }>({ inShell: false, adminNav: null });
export const useShellSlot = () => useContext(ShellSlot);

export interface AppShellProps {
  lang: Lang;
  onLang: (l: Lang) => void;
  theme: ThemeChoice;
  onTheme: (v: ThemeChoice) => void;
  relay?: { value: boolean; onChange: (v: boolean) => void };
  /** The current section; 'admin' while the admin console is open. */
  current: AppSection | 'admin';
  isAdmin: boolean;
  who: string;
  whoId?: string;
  /** The person's picture (profile), else initials. */
  whoAvatar?: string;
  onSignOut: () => void;
  /** "New meeting" of the phone tab bar. */
  onNew: () => void;
  children: ReactNode;
}

interface Item {
  id: AppSection;
  label: Key;
  icon: IconComponent;
  testId: string;
  /** Shown indented under the item before it (Profile under Settings, owner decision 1 of the profile package). */
  sub?: boolean;
}

// Only real sections (decision 1): Home, Meetings, Recordings, Whiteboards, Settings; Admin for admins; Help.
const MAIN: Item[] = [
  { id: 'home', label: 'shHome', icon: IconHome, testId: 'nav-home' },
  { id: 'meetings', label: 'shMeetings', icon: IconCalendar, testId: 'nav-meetings' },
  { id: 'recordings', label: 'shRecordings', icon: IconRecord, testId: 'nav-recordings' },
  { id: 'whiteboards', label: 'shWhiteboards', icon: IconWhiteboard, testId: 'nav-whiteboards' },
  { id: 'settings', label: 'shSettings', icon: IconSettings, testId: 'nav-settings' },
  { id: 'profile', label: 'shProfile', icon: IconUser, testId: 'nav-profile', sub: true },
];

function NavLink({ href, label, icon: Icon, current, testId, onClick, sub }: { href: string; label: string; icon: IconComponent; current: boolean; testId: string; onClick?: () => void; sub?: boolean }) {
  return (
    <a
      className={sub ? 'sh-link sh-link--sub' : 'sh-link'}
      href={href}
      aria-current={current ? 'page' : undefined}
      data-testid={testId}
      title={label}
      onClick={(e) => {
        onClick?.();
        if (href.startsWith('/app') || href.startsWith('/admin')) onLinkClick(e, href);
      }}
    >
      <Icon size={20} />
      <span className="sh-link__label">{label}</span>
    </a>
  );
}

/**
 * The signed-in frame: header, compact left panel (desktop; an icon rail on mid widths) and the bottom tab bar on phones.
 * Every style dresses the same markup; the liquid-glass style turns the tab bar into its floating glass bar (lg-home.css).
 */
export function AppShell(props: AppShellProps) {
  const { lang, current } = props;
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [more, setMore] = useState(false);
  const isCurrent = (id: AppSection) => current === id || (id === 'settings' && current === 'devices');
  // The phone tab bar has no Profile tab: Settings stays lit there.
  const tabCurrent = (id: AppSection) => isCurrent(id) || (id === 'settings' && current === 'profile');

  return (
    <ShellSlot.Provider value={{ inShell: true, adminNav: slot }}>
      <div className="hm-page sh" data-section={current}>
        <a className="hm-skip" href="#hm-main">
          {t(lang, 'hSkip')}
        </a>
        <header className="hm-header">
          <div className="hm-header__in">
            <a className="sh-brand" href="/app" onClick={(e) => onLinkClick(e, '/app')} aria-label={t(lang, 'shHome')}>
              <Logo height={30} title={t(lang, 'appName')} />
            </a>
            <span className="hm-spacer" />
            {props.who ? (
              <span className="hm-who" title={props.who}>
                <Avatar name={props.who} id={props.whoId} size={32} src={props.whoAvatar} decorative />
                <span className="hm-who__name">{props.who}</span>
              </span>
            ) : null}
            <AppearanceControls lang={lang} onLang={props.onLang} theme={props.theme} onTheme={props.onTheme} relay={props.relay} />
            <Button variant="ghost" size="sm" icon={<IconLogout size={18} />} className="hm-signout" onClick={props.onSignOut}>
              <span className="hm-signout__label">{t(lang, 'signOut')}</span>
            </Button>
          </div>
        </header>
        <div className="sh-body">
          <aside className="sh-panel" data-admin={current === 'admin' ? '' : undefined}>
            <nav className="sh-nav" aria-label={t(lang, 'shNav')}>
              <ul className="sh-list">
                {MAIN.map((it) => (
                  <li key={it.id}>
                    <NavLink href={pathFor(it.id)} label={t(lang, it.label)} icon={it.icon} current={isCurrent(it.id)} testId={it.testId} sub={it.sub} />
                  </li>
                ))}
                {props.isAdmin ? (
                  <li className="sh-admin">
                    <a
                      className="sh-link"
                      href="/admin"
                      aria-current={current === 'admin' ? 'true' : undefined /* the section inside the console is the page */}
                      data-testid="admin-link"
                      title={t(lang, 'shAdmin')}
                      onClick={(e) => onLinkClick(e, '/admin')}
                    >
                      <IconShieldCheck size={20} />
                      <span className="sh-link__label">{t(lang, 'shAdmin')}</span>
                    </a>
                  </li>
                ) : null}
                <li>
                  <NavLink href="/help" label={t(lang, 'shHelp')} icon={IconHelp} current={false} testId="nav-help" />
                </li>
              </ul>
            </nav>
            {/* The admin console renders its own section list here (a portal), so there is exactly one of it. */}
            {current === 'admin' ? <div className="sh-admin-slot" ref={setSlot} /> : null}
          </aside>
          <div className="sh-content">{props.children}</div>
        </div>

        {/* Phones: the bottom tab bar (every style; liquid-glass makes it its floating glass bar). */}
        <nav className="hm-tabbar" aria-label={t(lang, 'hTabs')}>
          <Button variant="ghost" className="hm-tabbar__item" icon={<IconHome />} data-testid="tab-home" aria-current={current === 'home' ? 'page' : undefined} onClick={() => navigate(pathFor('home'))}>
            {t(lang, 'shHome')}
          </Button>
          <Button variant="ghost" className="hm-tabbar__item" icon={<IconCalendar />} data-testid="tab-meetings" aria-current={current === 'meetings' ? 'page' : undefined} onClick={() => navigate(pathFor('meetings'))}>
            {t(lang, 'hTabMeetings')}
          </Button>
          <Button variant="ghost" className="hm-tabbar__item hm-tabbar__new" icon={<IconPlus />} data-testid="tab-new" onClick={props.onNew}>
            {t(lang, 'hTabNew')}
          </Button>
          <Button variant="ghost" className="hm-tabbar__item" icon={<IconSettings />} data-testid="tab-settings" aria-current={tabCurrent('settings') ? 'page' : undefined} onClick={() => navigate(pathFor('settings'))}>
            {t(lang, 'hSettings')}
          </Button>
          <Button variant="ghost" className="hm-tabbar__item" icon={<IconMore />} data-testid="tab-more" aria-haspopup="dialog" aria-expanded={more} onClick={() => setMore(true)}>
            {t(lang, 'shMore')}
          </Button>
        </nav>
        <Dialog open={more} onClose={() => setMore(false)} closeLabel={t(lang, 'uiClose')} title={t(lang, 'shMoreTitle')}>
          <ul className="sh-more" data-testid="more-sheet">
            <li>
              <NavLink href={pathFor('recordings')} label={t(lang, 'shRecordings')} icon={IconRecord} current={current === 'recordings'} testId="more-recordings" onClick={() => setMore(false)} />
            </li>
            <li>
              <NavLink href={pathFor('whiteboards')} label={t(lang, 'shWhiteboards')} icon={IconWhiteboard} current={current === 'whiteboards'} testId="more-whiteboards" onClick={() => setMore(false)} />
            </li>
            <li>
              <NavLink href={pathFor('devices')} label={t(lang, 'shDevices')} icon={IconCamera} current={current === 'devices'} testId="more-devices" onClick={() => setMore(false)} />
            </li>
            {props.isAdmin ? (
              <li>
                <NavLink href="/admin" label={t(lang, 'shAdmin')} icon={IconShieldCheck} current={current === 'admin'} testId="more-admin" onClick={() => setMore(false)} />
              </li>
            ) : null}
            <li>
              <NavLink href="/help" label={t(lang, 'shHelp')} icon={IconHelp} current={false} testId="more-help" onClick={() => setMore(false)} />
            </li>
          </ul>
        </Dialog>
      </div>
    </ShellSlot.Provider>
  );
}
