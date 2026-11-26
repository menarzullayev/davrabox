import { useMemo } from 'react';
import type { User } from 'oidc-client-ts';
import { isLang, isTheme, setPref, usePrefs } from '../prefs';
import { AdminApp } from './AdminApp';
import type { AdminClient, AdminUser, AuditEntry, Department, Page, Policies } from './client';

// /lab/admin: the admin console with fake data (no backend, no sign-in), for the landing demo clip recorded by
// apps/e2e/demo.videos.mjs. Built only in development or with VITE_HOME_LAB=1: main.tsx drops it from a normal build.

const DEPTS: Department[] = [
  { id: 'd1', name: 'Moliya', userCount: 4 },
  { id: 'd2', name: 'Kadrlar', userCount: 3 },
  { id: 'd3', name: 'IT', userCount: 5 },
];
const NAMES = ['Alisher Narzullayev', 'Dilnoza Karimova', 'Bekzod Toshmatov', 'Malika Yusupova', 'Sardor Rahimov', 'Nodira Aliyeva', 'Jasur Ergashev', 'Gulnora Saidova'];
const USERS: AdminUser[] = NAMES.map((n, i) => ({
  id: `u${i}`,
  email: `${n.split(' ')[0]!.toLowerCase()}@example.test`,
  displayName: n,
  role: i === 0 ? 'org_admin' : 'member',
  department: DEPTS[i % DEPTS.length]!,
  disabled: i === 6,
  createdAt: new Date(Date.UTC(2026, 10, 1 + i)).toISOString(),
}));
const POLICIES: Policies = {
  requirePasscode: false,
  waitingRoomDefault: true,
  maxParticipants: 100,
  requireTotp: true,
  guestPolicy: 'waiting_room',
  defaultStyle: 'liquid-glass',
  defaultDensity: 'comfortable',
  allowedStyles: null,
};
const ACTIONS = ['meeting.create', 'file.upload', 'policy.update', 'user.create', 'meeting.lock', 'file.download', 'audit.export', 'user.disable'];
const AUDIT: AuditEntry[] = ACTIONS.map((a, i) => ({
  id: String(1000 - i),
  at: new Date(Date.UTC(2026, 10, 26, 9, 40 - i * 7)).toISOString(),
  actorId: `u${i % 4}`,
  actorEmail: USERS[i % 4]!.email,
  action: a,
  target: a.startsWith('meeting') ? '308 1234 5678' : a.startsWith('file') ? 'hisobot.pdf' : null,
}));

const page = <T,>(items: T[]): Page<T> => ({ items, next: null });

/** Answers the calls the console makes while browsing; anything else resolves to an empty value. */
function fakeClient(): AdminClient {
  const known: Partial<Record<keyof AdminClient, (...a: never[]) => Promise<unknown>>> = {
    overview: async () => ({ org: { name: 'Namuna MChJ', slug: 'namuna' }, users: USERS.length, seatsLimit: 25, meetingsLast30d: 42 }),
    listUsers: async () => page(USERS),
    listDepartments: async () => DEPTS,
    getPolicies: async () => POLICIES,
    listAudit: async () => page(AUDIT),
    verifyAudit: async () => ({ ok: true, checked: 1000, firstBrokenId: null }),
    assistantOwner: async () => ({ owner: false }),
  };
  return new Proxy({} as AdminClient, {
    get: (_t, prop: string) => known[prop as keyof AdminClient] ?? (async () => (prop.startsWith('list') ? page([]) : {})),
  });
}

export default function AdminLab() {
  const q = useMemo(() => new URLSearchParams(location.search), []);
  useMemo(() => {
    const l = q.get('lang');
    const th = q.get('theme');
    if (isLang(l)) setPref('lang', l, { persist: false });
    if (isTheme(th)) setPref('theme', th, { persist: false });
  }, [q]);
  const { lang } = usePrefs();
  const client = useMemo(fakeClient, []);
  const user = useMemo(() => ({ profile: { sub: 'u0', name: NAMES[0], email: USERS[0]!.email } }) as unknown as User, []);
  return <AdminApp lang={lang} langPicker={null} user={user} onSignOut={() => undefined} client={client} />;
}
