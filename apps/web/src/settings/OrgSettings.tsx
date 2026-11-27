import { useEffect, useMemo, useState } from 'react';
import type { SettingItem, SettingsView } from '../api';
import { t, type Key, type Lang } from '../i18n';
import { Alert, Button, Select, Skeleton, Switch, TextField, useToast } from '../ui';
import { GROUPS, SettingControl, labelOf, hintOf, matches, optionLabel } from './MySettings';
import type { SettingsApi } from './MySettings';

type Draft = Record<string, { value: SettingItem['value']; locked: boolean }>;

/** "Meeting settings" of the admin console (decision 1): organization defaults, locks, and the organization-only join rules. */
export function OrgSettings({ lang, api }: { lang: Lang; api: SettingsApi }) {
  const toast = useToast();
  const [view, setView] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [countriesText, setCountriesText] = useState('');

  const load = (v: SettingsView) => {
    setView(v);
    setDraft({});
    const c = v.items.find((i) => i.key === 'countries');
    setCountriesText(Array.isArray(c?.value) ? c.value.join(', ') : '');
  };
  useEffect(() => {
    api.load().then(load, () => setFailed(true));
  }, [api]);

  const current = (i: SettingItem) => draft[i.key] ?? { value: i.value, locked: i.locked };
  const set = (i: SettingItem, patch: Partial<{ value: SettingItem['value']; locked: boolean }>) => setDraft((d) => ({ ...d, [i.key]: { ...current(i), ...patch } }));

  const save = async () => {
    if (busy || !Object.keys(draft).length) return;
    setBusy(true);
    try {
      load(await api.save(draft));
      toast({ tone: 'success', title: t(lang, 'msSaved') });
    } catch {
      toast({ tone: 'danger', title: t(lang, 'msSaveFailed') });
    } finally {
      setBusy(false);
    }
  };

  const groups = useMemo(() => {
    if (!view) return [];
    return [...GROUPS, 'organization' as const].map((g) => ({ g, items: view.items.filter((i) => i.group === g && i.key !== 'style' && matches(lang, i, q)) })).filter((x) => x.items.length);
  }, [view, lang, q]);

  if (failed) return <Alert tone="danger">{t(lang, 'msSaveFailed')}</Alert>;
  if (!view) return <Skeleton height="12rem" />;
  return (
    <section className="ms ms--admin" data-testid="org-settings">
      <h2 className="sec-title">{t(lang, 'msAdminTitle')}</h2>
      <p className="hm-card__lead">{t(lang, 'msAdminLead')}</p>
      <TextField label={t(lang, 'msSearch')} type="search" value={q} onChange={(e) => setQ(e.target.value)} data-testid="os-search" />
      {groups.map(({ g, items }) => (
        <fieldset key={g} className="ms-group" data-testid={`os-group-${g}`}>
          <legend className="pf-sub">{t(lang, `msg_${g}` as Key)}</legend>
          {items.map((i) => {
            const c = current(i);
            const shown: SettingItem = { ...i, value: c.value, locked: false };
            return (
              <div key={i.key} className="ms-item ms-item--admin" data-testid={`os-${i.key}`}>
                {i.key === 'joinDisclaimer' ? (
                  <TextField label={labelOf(lang, i.key)} hint={hintOf(lang, i.key)} maxLength={2000} value={String(c.value)} onChange={(e) => set(i, { value: e.target.value })} data-testid="os-disclaimer" />
                ) : i.key === 'countries' ? (
                  <TextField
                    label={labelOf(lang, i.key)}
                    hint={hintOf(lang, i.key)}
                    value={countriesText}
                    data-testid="os-countries"
                    onChange={(e) => {
                      setCountriesText(e.target.value);
                      set(i, { value: e.target.value.toUpperCase().split(/[\s,;]+/).filter((x) => /^[A-Z0-9]{2}$/.test(x)) });
                    }}
                  />
                ) : i.key === 'countryRule' ? (
                  <Select label={labelOf(lang, i.key)} hint={hintOf(lang, i.key)} value={String(c.value)} onChange={(e) => set(i, { value: e.target.value })} data-testid="os-country-rule">
                    {(i.options ?? []).map((o) => (
                      <option key={o} value={o}>
                        {optionLabel(lang, o)}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <SettingControl lang={lang} item={shown} disabled={i.fromPolicy} onChange={(v) => set(i, { value: v as SettingItem['value'] })} />
                )}
                {i.orgOnly ? null : i.fromPolicy ? (
                  <p className="pg-item__meta">{t(lang, 'msAdminFromPolicy')}</p>
                ) : (
                  <Switch label={t(lang, 'msAdminLock')} checked={c.locked} onChange={(e) => set(i, { locked: e.target.checked })} data-testid={`os-lock-${i.key}`} />
                )}
              </div>
            );
          })}
        </fieldset>
      ))}
      <div className="pg-actions">
        <Button variant="primary" loading={busy} disabled={!Object.keys(draft).length} onClick={() => void save()} data-testid="os-save">
          {t(lang, 'msAdminSave')}
        </Button>
      </div>
    </section>
  );
}
