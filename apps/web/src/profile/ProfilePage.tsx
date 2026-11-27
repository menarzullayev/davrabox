import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Profile, SecurityView } from '../api';
import { ApiError } from '../api';
import type { ProviderStatus } from '../calendar/calendarApi';
import type { CalProvider } from '../calendar/logic';
import { t, type Lang } from '../i18n';
import { Alert, Avatar, Badge, Button, Combobox, Dialog, IconCalendar, IconKey, IconLink, IconLock, IconLogout, IconMonitor, IconSmartphone, IconTrash, IconUser, Select, Skeleton, TextField, useToast } from '../ui';
import { tx } from '../home/text';
import { linkProvider, startKcAction, type KcAction } from '../auth';
import { pathFor } from '../shell/nav';
import { AvatarEditor, pickImage } from './AvatarEditor';
import { dateTimeText, deviceTimeZone, setDisplay } from './display';
import type { ProfileApi } from './profileApi';

const RETURN = pathFor('profile');

function zones(): string[] {
  const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  return list.length ? list : ['UTC'];
}

const PROVIDER_NAME: Record<string, string> = { google: 'Google', microsoft: 'Microsoft' };

export interface ProfilePageProps {
  lang: Lang;
  api: ProfileApi;
  /** The identity provider's session id of this sign-in (to mark "this device" and to link accounts). */
  sid?: string;
  onSignedOutEverywhere: () => void;
  /** Lets tests replace the redirects to the identity provider. */
  kcAction?: (action: KcAction, returnTo: string) => void;
  link?: (provider: string, sid: string, returnTo: string) => void;
  navigateAway?: (url: string) => void;
  /** The picture changed (the header shows it at once). */
  onAvatarChange?: (url: string | null) => void;
}

/**
 * /app/profile (owner decisions 1-3, 5, 6): picture, job title and department, phone, time zone and formats; self-service
 * security through the identity provider's own flows; the calendar connection with consent asked only on "Connect".
 */
export function ProfilePage(props: ProfilePageProps) {
  const { lang, api } = props;
  const toast = useToast();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api.profile().then(
      (p) => {
        setProfile(p);
        setDisplay({ timeZone: p.timeZone, dateFormat: p.dateFormat, timeFormat: p.timeFormat });
      },
      () => setFailed(true),
    );
  }, [api]);

  return (
    <main id="hm-main" className="home hm-main" tabIndex={-1} data-testid="profile-page">
      <header className="pg-head">
        <h1 className="pg-title">{tx(lang, 'pfTitle')}</h1>
      </header>
      <div className="pg-stack">
        <div data-testid="pf-visibility">
          <Alert tone="info">
            <span className="hm-verify">
              <span>{tx(lang, 'pfVisibility')}</span>
              <a href="/privacy#legal-profile" target="_blank" rel="noopener">
                {tx(lang, 'pfPrivacyLink')}
              </a>
            </span>
          </Alert>
        </div>
        {failed ? (
          <Alert tone="danger">{tx(lang, 'pfLoadFailed')}</Alert>
        ) : !profile ? (
          <div className="hm-skeletons" aria-busy="true">
            <Skeleton height="6rem" />
            <Skeleton height="12rem" />
          </div>
        ) : (
          <>
            <PhotoCard
              lang={lang}
              api={api}
              profile={profile}
              onChange={(avatarUrl) => {
                setProfile({ ...profile, avatarUrl });
                props.onAvatarChange?.(avatarUrl);
              }}
            />
            <InfoCard
              lang={lang}
              profile={profile}
              onSave={async (patch) => {
                const p = await api.save(patch);
                setProfile(p);
                setDisplay({ timeZone: p.timeZone, dateFormat: p.dateFormat, timeFormat: p.timeFormat });
                toast({ tone: 'success', title: tx(lang, 'pfSaved') });
              }}
            />
          </>
        )}
        <SecurityCard {...props} />
        <CalendarCard lang={lang} api={api} navigateAway={props.navigateAway ?? ((u) => location.assign(u))} />
      </div>
    </main>
  );
}

function PhotoCard({ lang, api, profile, onChange }: { lang: Lang; api: ProfileApi; profile: Profile; onChange: (url: string | null) => void }) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (image: Blob) => {
    try {
      const r = await api.uploadAvatar(image);
      onChange(r.avatarUrl);
      setFile(null);
      toast({ tone: 'success', title: tx(lang, 'pfPhotoSaved') });
    } catch (e) {
      const code = e instanceof ApiError ? e.code : undefined;
      const status = e instanceof ApiError ? e.status : 0;
      throw new Error(status === 413 || code === 'too_large' ? 'pfPhotoTooLarge' : code === 'rejected' ? 'pfPhotoRejected' : status === 503 && code === 'avatars_off' ? 'pfPhotoOff' : status === 400 ? 'pfPhotoBad' : 'pfPhotoFailed');
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api.removeAvatar();
      onChange(null);
      toast({ tone: 'success', title: tx(lang, 'pfPhotoRemoved') });
    } catch {
      toast({ tone: 'danger', title: tx(lang, 'pfPhotoFailed') });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="hm-card pf-head" aria-labelledby="pf-photo-h">
      <h2 className="dx-sr-only" id="pf-photo-h">
        {tx(lang, 'pfPhoto')}
      </h2>
      <span className="pf-avatar" data-testid="pf-avatar" data-has-photo={profile.avatarUrl ? '' : undefined}>
        <Avatar name={profile.name || profile.email} size={96} src={profile.avatarUrl ?? undefined} decorative />
      </span>
      <div className="pf-head__body">
        <p className="pf-head__name">{profile.name}</p>
        <p className="pf-head__email">{profile.email}</p>
        <p className="pg-item__meta">{tx(lang, 'pfManagedName')}</p>
        <div className="pg-actions">
          <Button variant="secondary" size="sm" icon={<IconUser size={16} />} data-testid="pf-photo-change" onClick={() => void pickImage().then((f) => f && setFile(f))}>
            {tx(lang, 'pfPhotoChange')}
          </Button>
          {profile.avatarUrl ? (
            <Button variant="ghost" size="sm" icon={<IconTrash size={16} />} loading={busy} data-testid="pf-photo-remove" onClick={() => void remove()}>
              {tx(lang, 'pfPhotoRemove')}
            </Button>
          ) : null}
        </div>
      </div>
      <AvatarEditor lang={lang} file={file} onClose={() => setFile(null)} onSave={save} />
    </section>
  );
}

function InfoCard({ lang, profile, onSave }: { lang: Lang; profile: Profile; onSave: (patch: Parameters<ProfileApi['save']>[0]) => Promise<void> }) {
  const all = useMemo(zones, []);
  const [title, setTitle] = useState(profile.jobTitle ?? '');
  const [dep, setDep] = useState(profile.departmentId ?? '');
  const [phone, setPhone] = useState(profile.phone ?? '');
  const [tz, setTz] = useState(profile.timeZone ?? deviceTimeZone());
  const [df, setDf] = useState<string>(profile.dateFormat ?? '');
  const [tf, setTf] = useState<string>(profile.timeFormat ?? '24h');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const phoneOk = phone.trim() === '' || /^\+?[0-9 ()-]{5,24}$/.test(phone.trim());
  const tzOk = all.includes(tz) || tz === 'UTC';
  const now = new Date();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !phoneOk || !tzOk) return;
    setBusy(true);
    setErr(null);
    try {
      await onSave({
        jobTitle: title.trim() || null,
        departmentId: dep || null,
        phone: phone.trim() || null,
        timeZone: tz,
        dateFormat: (df || null) as 'dmy' | 'mdy' | 'ymd' | null,
        timeFormat: tf as '24h' | '12h',
      });
    } catch {
      setErr(tx(lang, 'pfSaveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="hm-card st-card" aria-labelledby="pf-info-h">
      <h2 className="hm-card__title" id="pf-info-h">
        {tx(lang, 'pfInfo')}
      </h2>
      <form className="pf-form" onSubmit={(e) => void submit(e)} data-testid="pf-info-form">
        {err ? <Alert tone="danger">{err}</Alert> : null}
        <TextField label={tx(lang, 'pfJobTitle')} maxLength={100} value={title} onChange={(e) => setTitle(e.target.value)} data-testid="pf-title" />
        <Select label={tx(lang, 'pfDepartment')} value={dep} onChange={(e) => setDep(e.target.value)} data-testid="pf-department">
          <option value="">{tx(lang, 'pfNoDepartment')}</option>
          {profile.departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </Select>
        <TextField label={tx(lang, 'pfPhone')} type="tel" autoComplete="tel" maxLength={24} hint={tx(lang, 'pfPhoneHint')} error={phoneOk ? undefined : tx(lang, 'pfPhoneBad')} value={phone} onChange={(e) => setPhone(e.target.value)} data-testid="pf-phone" />
        <Combobox label={tx(lang, 'pfTimeZone')} options={all} value={tz} onChange={(e) => setTz(e.target.value)} error={tzOk ? undefined : tx(lang, 'pfSaveFailed')} data-testid="pf-tz" />
        <Select label={tx(lang, 'pfDateFormat')} value={df} onChange={(e) => setDf(e.target.value)} data-testid="pf-date-format">
          <option value="">{`${tx(lang, 'pfDateAuto')} (${dateTimeText(now, lang, { timeZone: null, dateFormat: null, timeFormat: '24h' }).split(',')[0]})`}</option>
          <option value="dmy">{dateTimeText(now, lang, { timeZone: null, dateFormat: 'dmy', timeFormat: '24h' }).split(',')[0]}</option>
          <option value="mdy">{dateTimeText(now, lang, { timeZone: null, dateFormat: 'mdy', timeFormat: '24h' }).split(',')[0]}</option>
          <option value="ymd">{dateTimeText(now, lang, { timeZone: null, dateFormat: 'ymd', timeFormat: '24h' }).split(',')[0]}</option>
        </Select>
        <Select label={tx(lang, 'pfTimeFormat')} value={tf} onChange={(e) => setTf(e.target.value)} data-testid="pf-time-format">
          <option value="24h">{tx(lang, 'pfTime24')}</option>
          <option value="12h">{tx(lang, 'pfTime12')}</option>
        </Select>
        <div className="pg-actions">
          <Button type="submit" variant="primary" loading={busy} disabled={!phoneOk || !tzOk} data-testid="pf-save">
            {tx(lang, 'pfSave')}
          </Button>
        </div>
      </form>
    </section>
  );
}

function SecurityCard({ lang, api, sid, onSignedOutEverywhere, kcAction, link }: ProfilePageProps) {
  const toast = useToast();
  const [view, setView] = useState<SecurityView | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'off' | 'failed'>('loading');
  const [confirmAll, setConfirmAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const go = kcAction ?? ((a: KcAction, r: string) => void startKcAction(a, r, lang));
  const doLink = link ?? ((p: string, s: string, r: string) => void linkProvider(p, s, r));

  const load = useCallback(() => {
    api.security().then(
      (v) => {
        setView(v);
        setState('ok');
      },
      (e) => setState(e instanceof ApiError && e.status === 503 ? 'off' : 'failed'),
    );
  }, [api]);
  useEffect(load, [load]);

  const when = (iso: string | null) => (iso ? dateTimeText(new Date(iso), lang) : '');
  const run = async (id: string, f: () => Promise<void>, ok: 'pfSessionEnded' | 'pfUnlinked') => {
    setBusy(id);
    try {
      await f();
      toast({ tone: 'success', title: tx(lang, ok) });
      load();
    } catch (e) {
      toast({ tone: 'danger', title: tx(lang, e instanceof ApiError && e.code === 'last_sign_in' ? 'pfLastSignIn' : 'pfSaveFailed') });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="hm-card st-card" aria-labelledby="pf-sec-h" data-testid="pf-security">
      <h2 className="hm-card__title" id="pf-sec-h">
        {tx(lang, 'pfSecurity')}
      </h2>
      {state === 'loading' ? <Skeleton height="8rem" /> : null}
      {state === 'off' ? <Alert tone="info">{tx(lang, 'pfSecurityOff')}</Alert> : null}
      {state === 'failed' ? <Alert tone="danger">{tx(lang, 'pfLoadFailed')}</Alert> : null}
      {view ? (
        <>
          <p className="pg-item__meta">{tx(lang, 'pfIdpNote')}</p>
          <ul className="pg-list">
            <li className="pg-item" data-testid="pf-password">
              <div className="pg-item__main">
                <p className="pg-item__title">
                  <IconKey size={16} /> {tx(lang, 'pfPassword')}
                </p>
                <p className="pg-item__meta">{tx(lang, view.password ? 'pfPasswordSet' : 'pfPasswordNone')}</p>
              </div>
              <div className="pg-item__actions">
                <Button variant="secondary" size="sm" data-testid="pf-password-change" onClick={() => go('UPDATE_PASSWORD', RETURN)}>
                  {tx(lang, view.password ? 'pfPasswordChange' : 'pfPasswordAdd')}
                </Button>
              </div>
            </li>
            <li className="pg-item" data-testid="pf-totp">
              <div className="pg-item__main">
                <p className="pg-item__title">
                  <IconLock size={16} /> {tx(lang, 'pfTotp')}
                </p>
                <p className="pg-item__meta">
                  <Badge tone={view.totp.length ? 'success' : 'neutral'}>{tx(lang, view.totp.length ? 'pfTotpOn' : 'pfTotpOff')}</Badge>
                </p>
              </div>
              <div className="pg-item__actions">
                {view.totp.length ? (
                  view.totp.map((c) => (
                    <Button key={c.id} variant="ghost" size="sm" data-testid="pf-totp-remove" onClick={() => go(`delete_credential:${c.id}`, RETURN)}>
                      {tx(lang, 'pfTotpRemove')}
                    </Button>
                  ))
                ) : (
                  <Button variant="secondary" size="sm" data-testid="pf-totp-add" onClick={() => go('CONFIGURE_TOTP', RETURN)}>
                    {tx(lang, 'pfTotpAdd')}
                  </Button>
                )}
              </div>
            </li>
            <li className="pg-item pf-stack" data-testid="pf-passkeys">
              <div className="pg-item__main">
                <p className="pg-item__title">
                  <IconKey size={16} /> {tx(lang, 'pfPasskeys')}
                </p>
                {view.passkeys.length === 0 ? <p className="pg-item__meta">{tx(lang, 'pfPasskeysNone')}</p> : null}
                {view.passkeys.map((k) => (
                  <p className="pf-row" key={k.id} data-testid="pf-passkey">
                    <span>{k.label || tx(lang, 'pfPasskeys')}</span>
                    <span className="pg-item__meta">{k.createdAt ? tx(lang, 'pfAdded', { when: when(k.createdAt) }) : ''}</span>
                    <Button variant="ghost" size="sm" aria-label={`${tx(lang, 'pfPasskeyRemove')}: ${k.label ?? ''}`} onClick={() => go(`delete_credential:${k.id}`, RETURN)}>
                      {tx(lang, 'pfPasskeyRemove')}
                    </Button>
                  </p>
                ))}
              </div>
              <div className="pg-item__actions">
                <Button variant="secondary" size="sm" data-testid="pf-passkey-add" onClick={() => go('webauthn-register-passwordless', RETURN)}>
                  {tx(lang, 'pfPasskeyAdd')}
                </Button>
              </div>
            </li>
          </ul>

          <h3 className="pf-sub">{tx(lang, 'pfSessions')}</h3>
          <ul className="pg-list" data-testid="pf-sessions">
            {view.sessions.map((s) => {
              const Icon = s.device === 'Android' || s.device === 'iOS' ? IconSmartphone : IconMonitor;
              const place = [s.city, s.country].filter(Boolean).join(', ');
              return (
                <li key={s.id} className="pg-item" data-testid="pf-session" data-current={s.current ? '' : undefined}>
                  <div className="pg-item__main">
                    <p className="pg-item__title">
                      <Icon size={16} /> {[s.device, s.browser].filter(Boolean).join(' · ') || tx(lang, 'pfSessionUnknown')}
                      {s.current ? <Badge tone="accent">{tx(lang, 'pfSessionThis')}</Badge> : null}
                    </p>
                    <p className="pg-item__meta">
                      {place ? <span>{place}</span> : null}
                      {s.ip ? <span className="code">{s.ip}</span> : null}
                      {s.lastAccess ? <span>{tx(lang, 'pfSessionLast', { when: when(s.lastAccess) })}</span> : null}
                    </p>
                  </div>
                  {!s.current ? (
                    <div className="pg-item__actions">
                      <Button variant="ghost" size="sm" icon={<IconLogout size={16} />} loading={busy === s.id} data-testid="pf-session-end" onClick={() => void run(s.id, () => api.endSession(s.id), 'pfSessionEnded')}>
                        {tx(lang, 'pfSessionEnd')}
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <div className="pg-actions">
            <Button variant="danger" size="sm" icon={<IconLogout size={16} />} data-testid="pf-session-end-all" onClick={() => setConfirmAll(true)}>
              {tx(lang, 'pfSessionEndAll')}
            </Button>
          </div>

          <h3 className="pf-sub">{tx(lang, 'pfLinked')}</h3>
          <ul className="pg-list" data-testid="pf-links">
            {view.providers.length === 0 && view.links.length === 0 ? <li className="pg-item__meta">{tx(lang, 'pfNoProviders')}</li> : null}
            {[...new Set([...view.providers, ...view.links.map((l) => l.provider)])].map((p) => {
              const linked = view.links.find((l) => l.provider === p);
              return (
                <li key={p} className="pg-item" data-testid={`pf-link-${p}`}>
                  <div className="pg-item__main">
                    <p className="pg-item__title">
                      <IconLink size={16} /> {PROVIDER_NAME[p] ?? p}
                    </p>
                    {linked?.userName ? <p className="pg-item__meta">{linked.userName}</p> : null}
                  </div>
                  <div className="pg-item__actions">
                    {linked ? (
                      <Button variant="ghost" size="sm" loading={busy === p} onClick={() => void run(p, () => api.unlink(p), 'pfUnlinked')} data-testid={`pf-unlink-${p}`}>
                        {tx(lang, 'pfUnlink')}
                      </Button>
                    ) : (
                      <Button variant="secondary" size="sm" disabled={!sid} onClick={() => sid && doLink(p, sid, RETURN)} data-testid={`pf-link-add-${p}`}>
                        {tx(lang, 'pfLink')}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      <Dialog
        open={confirmAll}
        onClose={() => setConfirmAll(false)}
        closeLabel={t(lang, 'uiClose')}
        title={tx(lang, 'pfSessionEndAll')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmAll(false)}>
              {t(lang, 'cancel')}
            </Button>
            <Button
              variant="danger"
              data-testid="pf-session-end-all-confirm"
              onClick={() => {
                setConfirmAll(false);
                void api.endAllSessions().then(onSignedOutEverywhere, () => toast({ tone: 'danger', title: tx(lang, 'pfSaveFailed') }));
              }}
            >
              {tx(lang, 'pfSessionEndAll')}
            </Button>
          </>
        }
      >
        <p className="hm-new__lead">{tx(lang, 'pfSessionEndAllConfirm')}</p>
      </Dialog>
    </section>
  );
}

function CalendarCard({ lang, api, navigateAway }: { lang: Lang; api: ProfileApi; navigateAway: (url: string) => void }) {
  const toast = useToast();
  const [list, setList] = useState<ProviderStatus[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => {
    api.calendars().then(setList, () => setList([]));
  }, [api]);
  useEffect(load, [load]);
  const connect = async (p: CalProvider) => {
    setBusy(p);
    try {
      navigateAway((await api.connectCalendar(p)).url); // the calendar scope is asked for here only (incremental consent)
    } catch {
      toast({ tone: 'danger', title: tx(lang, 'pfCalFailed') });
      setBusy(null);
    }
  };
  const disconnect = async (p: CalProvider) => {
    setBusy(p);
    try {
      await api.disconnectCalendar(p);
      toast({ tone: 'success', title: tx(lang, 'pfCalDisconnected') });
      load();
    } catch {
      toast({ tone: 'danger', title: tx(lang, 'pfSaveFailed') });
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="hm-card st-card" aria-labelledby="pf-cal-h" data-testid="pf-calendar">
      <h2 className="hm-card__title" id="pf-cal-h">
        {tx(lang, 'pfCalendar')}
      </h2>
      <p className="hm-card__lead">{tx(lang, 'pfCalendarLead')}</p>
      {!list ? (
        <Skeleton height="3rem" />
      ) : (
        <ul className="pg-list">
          {list.map((c) => (
            <li key={c.provider} className="pg-item" data-testid={`pf-cal-${c.provider}`}>
              <div className="pg-item__main">
                <p className="pg-item__title">
                  <IconCalendar size={16} /> {c.provider === 'google' ? 'Google Calendar' : 'Microsoft Outlook'}
                </p>
                <p className="pg-item__meta">
                  {c.connected ? <Badge tone="success">{tx(lang, 'pfCalConnected')}</Badge> : !c.configured ? <Badge>{tx(lang, 'pfCalNotConfigured')}</Badge> : null}
                </p>
              </div>
              <div className="pg-item__actions">
                {c.connected ? (
                  <Button variant="ghost" size="sm" loading={busy === c.provider} onClick={() => void disconnect(c.provider)} data-testid={`pf-cal-disconnect-${c.provider}`}>
                    {tx(lang, 'pfCalDisconnect')}
                  </Button>
                ) : (
                  <Button variant="secondary" size="sm" loading={busy === c.provider} disabled={!c.configured} onClick={() => void connect(c.provider)} data-testid={`pf-cal-connect-${c.provider}`}>
                    {tx(lang, 'pfCalConnect')}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
