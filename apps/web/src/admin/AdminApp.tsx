import { useMemo, useState, type ReactNode } from 'react';
import type { User } from 'oidc-client-ts';
import { freshToken } from '../auth';
import { t, type Lang } from '../i18n';
import { Avatar, Button, IconChevronLeft, IconLayoutGrid, IconLayoutRing, IconLink, IconLock, IconLogout, IconShield, IconShieldCheck, IconUsers, Logo } from '../ui';
import { Audit } from './Audit';
import { createAdminClient } from './client';
import { Departments } from './Departments';
import { Encryption } from './Encryption';
import { Integrations } from './Integrations';
import { Overview } from './Overview';
import { Policies } from './Policies';
import { Users } from './Users';
import { AdminCtx, makeReport } from './ui';
import './admin.css';

const SECTIONS = ['overview', 'users', 'departments', 'policies', 'audit', 'integrations', 'encryption'] as const;
type Section = (typeof SECTIONS)[number];
const ICON = {
  overview: IconLayoutGrid,
  users: IconUsers,
  departments: IconLayoutRing,
  policies: IconShield,
  integrations: IconLink,
  audit: IconShieldCheck,
  encryption: IconLock,
} as const;
const LABEL = {
  overview: 'admOverview',
  users: 'admUsers',
  departments: 'admDepartments',
  policies: 'admPolicies',
  integrations: 'admIntegrations',
  audit: 'admAudit',
  encryption: 'admEncryption',
} as const;

export function AdminApp({ lang, langPicker, user, onSignOut }: { lang: Lang; langPicker: ReactNode; user: User; onSignOut: () => void }) {
  const [section, setSection] = useState<Section>('overview');
  const [forbidden, setForbidden] = useState(false);
  const client = useMemo(() => createAdminClient(freshToken), []);
  const report = useMemo(() => makeReport(() => setForbidden(true)), []);
  const ctx = useMemo(() => ({ client, lang, report }), [client, lang, report]);

  const who = user.profile.name ?? user.profile.email ?? '';
  const header = (
    <header className="adm-top">
      <div className="adm-brand">
        <Logo height={26} />
        <h1 className="adm-badge">{t(lang, 'admTitle')}</h1>
      </div>
      <div className="adm-top__right">
        <a href="/" className="adm-back">
          <IconChevronLeft size={16} />
          {t(lang, 'admBack')}
        </a>
        {langPicker}
        <span className="adm-who">
          <Avatar name={who || '?'} id={user.profile.sub} size={28} decorative />
          <span className="adm-who__name">{who}</span>
        </span>
        <Button variant="ghost" size="sm" icon={<IconLogout size={16} />} onClick={onSignOut}>{t(lang, 'signOut')}</Button>
      </div>
    </header>
  );

  if (forbidden) {
    return (
      <main className="adm">
        {header}
        <section className="noaccess" data-testid="admin-no-access">
          <h2 className="sec-title" role="alert">{t(lang, 'admNoAccessTitle')}</h2>
          <p>{t(lang, 'admNoAccessBody')}</p>
        </section>
      </main>
    );
  }

  return (
    <AdminCtx.Provider value={ctx}>
      <main className="adm">
        {header}
        <div className="adm-body">
          <nav aria-label={t(lang, 'admNav')} className="adm-nav">
            <ul>
              {SECTIONS.map((s) => {
                const Icon = ICON[s];
                return (
                  <li key={s}>
                    <button type="button" aria-current={section === s ? 'page' : undefined} data-active={section === s ? '' : undefined} onClick={() => setSection(s)}>
                      <Icon size={18} />
                      <span>{t(lang, LABEL[s])}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className="adm-content">
            {section === 'overview' && <Overview />}
            {section === 'users' && <Users />}
            {section === 'departments' && <Departments />}
            {section === 'policies' && <Policies />}
            {section === 'integrations' && <Integrations />}
            {section === 'audit' && <Audit />}
            {section === 'encryption' && <Encryption />}
          </div>
        </div>
      </main>
    </AdminCtx.Provider>
  );
}
