import { useEffect, useMemo, useState } from 'react';
import type { SettingItem, SettingsView } from '../api';
import { t, type Key, type Lang } from '../i18n';
import { Alert, Badge, IconLock, Select, Skeleton, Switch, TextField, useToast, type ThemeChoice } from '../ui';
import { AppearanceFields } from '../home/AppearanceFields';

export interface SettingsApi {
  load(): Promise<SettingsView>;
  save(patch: Record<string, unknown>): Promise<SettingsView>;
}

export const GROUPS = ['security', 'scheduling', 'meeting', 'notifications', 'appearance', 'recording'] as const;

/** Label, hint and option names of a setting in the person's language (the keys are `ms_<key>`, `msh_<key>`, `msc_<option>`). */
export function labelOf(lang: Lang, key: string): string {
  return t(lang, `ms_${key}` as Key);
}
export function hintOf(lang: Lang, key: string): string {
  return t(lang, `msh_${key}` as Key);
}
export function optionLabel(lang: Lang, opt: string): string {
  return t(lang, `msc_${opt}` as Key);
}

/** Case-insensitive search over the label, the hint and the key. */
export function matches(lang: Lang, it: Pick<SettingItem, 'key'>, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return [labelOf(lang, it.key), hintOf(lang, it.key), it.key].some((x) => x.toLowerCase().includes(s));
}

export function SettingControl({ lang, item, onChange, disabled }: { lang: Lang; item: SettingItem; onChange: (v: unknown) => void; disabled?: boolean }) {
  const label = labelOf(lang, item.key);
  const hint = hintOf(lang, item.key);
  const off = disabled || item.locked;
  if (item.type === 'bool') {
    return <Switch label={label} hint={hint} checked={item.value === true} disabled={off} data-testid={`set-${item.key}`} onChange={(e) => onChange(e.target.checked)} />;
  }
  if (item.type === 'choice') {
    return (
      <Select label={label} hint={hint} value={String(item.value)} disabled={off} data-testid={`set-${item.key}`} onChange={(e) => onChange(e.target.value)}>
        {(item.options ?? []).map((o) => (
          <option key={o} value={o}>
            {optionLabel(lang, o)}
          </option>
        ))}
      </Select>
    );
  }
  if (item.type === 'int') {
    return (
      <TextField
        label={label}
        hint={hint}
        type="number"
        min={item.min}
        max={item.max}
        value={String(item.value)}
        disabled={off}
        data-testid={`set-${item.key}`}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isInteger(n) && n >= (item.min ?? 0) && n <= (item.max ?? Infinity)) onChange(n);
        }}
      />
    );
  }
  return null;
}

/**
 * "My settings" (owner decisions 1-3): the curated list in groups with a search box. A locked setting shows the organization's
 * value with a lock and cannot be changed (the server refuses it too). Appearance uses the same controls as everywhere else.
 */
export function MySettings({ lang, api, theme, onTheme, onLang }: { lang: Lang; api: SettingsApi; theme: ThemeChoice; onTheme: (v: ThemeChoice) => void; onLang: (l: Lang) => void }) {
  const toast = useToast();
  const [view, setView] = useState<SettingsView | null>(null);
  const [failed, setFailed] = useState(false);
  const [q, setQ] = useState('');
  useEffect(() => {
    api.load().then(setView, () => setFailed(true));
  }, [api]);

  const change = async (key: string, value: unknown) => {
    if (!view) return;
    const before = view;
    setView({ ...view, items: view.items.map((i) => (i.key === key ? { ...i, value: value as SettingItem['value'] } : i)) });
    try {
      setView(await api.save({ [key]: value }));
      toast({ tone: 'success', title: t(lang, 'msSaved') });
    } catch {
      setView(before);
      toast({ tone: 'danger', title: t(lang, 'msSaveFailed') });
    }
  };

  const groups = useMemo(() => {
    if (!view) return [];
    return GROUPS.map((g) => ({ g, items: view.items.filter((i) => i.group === g && matches(lang, i, q)) })).filter((x) => x.items.length > 0);
  }, [view, lang, q]);

  if (failed) return <Alert tone="danger">{t(lang, 'msSaveFailed')}</Alert>;
  if (!view) return <Skeleton height="12rem" />;
  return (
    <section className="hm-card st-card ms" aria-labelledby="ms-h" data-testid="my-settings">
      <h2 className="hm-card__title" id="ms-h">
        {t(lang, 'msTitle')}
      </h2>
      <p className="hm-card__lead">{t(lang, 'msLead')}</p>
      <TextField label={t(lang, 'msSearch')} type="search" value={q} onChange={(e) => setQ(e.target.value)} data-testid="ms-search" />
      {groups.length === 0 ? <p className="pg-empty" data-testid="ms-empty">{t(lang, 'msNoMatch')}</p> : null}
      {groups.map(({ g, items }) => (
        <fieldset key={g} className="ms-group" data-testid={`ms-group-${g}`}>
          <legend className="pf-sub">{t(lang, `msg_${g}` as Key)}</legend>
          {g === 'notifications' && !view.mailEnabled ? <Alert tone="info">{t(lang, 'msMailOff')}</Alert> : null}
          {g === 'appearance' ? (
            <div className="st-fields">
              <AppearanceFields lang={lang} onLang={onLang} theme={theme} onTheme={onTheme} />
              {items.filter((i) => i.locked).map((i) => (
                <p key={i.key} className="ms-lock" data-testid={`ms-locked-${i.key}`}>
                  <IconLock size={14} /> {labelOf(lang, i.key)}: {t(lang, 'msLocked')}
                </p>
              ))}
            </div>
          ) : (
            items.map((i) => (
              <div key={i.key} className="ms-item" data-locked={i.locked ? '' : undefined}>
                <SettingControl lang={lang} item={i} onChange={(v) => void change(i.key, v)} />
                {i.locked ? (
                  <Badge className="ms-badge" data-testid={`ms-locked-${i.key}`}>
                    <IconLock size={12} /> {t(lang, 'msLocked')}
                  </Badge>
                ) : null}
              </div>
            ))
          )}
        </fieldset>
      ))}
    </section>
  );
}
