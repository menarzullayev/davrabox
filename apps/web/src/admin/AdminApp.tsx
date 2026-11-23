import { useMemo, useState, type ReactNode } from 'react';
import type { User } from 'oidc-client-ts';
import { freshToken } from '../auth';
import { t, type Lang } from '../i18n';
import { Audit } from './Audit';
import { createAdminClient } from './client';
import { Departments } from './Departments';
import { Overview } from './Overview';
import { Policies } from './Policies';
import { Users } from './Users';
import { AdminCtx, makeReport } from './ui';
import './admin.css';

const SECTIONS = ['overview', 'users', 'departments', 'policies', 'audit'] as const;
type Section = (typeof SECTIONS)[number];
const LABEL = {
  overview: 'admOverview',
  users: 'admUsers',
  departments: 'admDepartments',
  policies: 'admPolicies',
  audit: 'admAudit',
} as const;

export function AdminApp({ lang, langPicker, user, onSignOut }: { lang: Lang; langPicker: ReactNode; user: User; onSignOut: () => void }) {
  const [section, setSection] = useState<Section>('overview');
  const [forbidden, setForbidden] = useState(false);
  const client = useMemo(() => createAdminClient(freshToken), []);
  const report = useMemo(() => makeReport(() => setForbidden(true)), []);
  const ctx = useMemo(() => ({ client, lang, report }), [client, lang, report]);

  const header = (
    <header className="topbar">
      <h1>{t(lang, 'admTitle')}</h1>
      <span className="who">{user.profile.name ?? user.profile.email}</span>
      <a href="/" className="btn-link">{t(lang, 'admBack')}</a>
      {langPicker}
      <button onClick={onSignOut}>{t(lang, 'signOut')}</button>
    </header>
  );

  if (forbidden) {
    return (
      <main className="admin">
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
      <main className="admin">
        {header}
        <div className="admin-body">
          <nav aria-label={t(lang, 'admNav')} className="admin-nav">
            <ul>
              {SECTIONS.map((s) => (
                <li key={s}>
                  <button type="button" aria-current={section === s ? 'page' : undefined} className={section === s ? 'active' : undefined} onClick={() => setSection(s)}>
                    {t(lang, LABEL[s])}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <div className="admin-content">
            {section === 'overview' && <Overview />}
            {section === 'users' && <Users />}
            {section === 'departments' && <Departments />}
            {section === 'policies' && <Policies />}
            {section === 'audit' && <Audit />}
          </div>
        </div>
      </main>
    </AdminCtx.Provider>
  );
}
