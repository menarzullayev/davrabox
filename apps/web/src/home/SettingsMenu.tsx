import { LANGS } from '../prefs';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { IconButton, IconMoon, IconSettings, IconSun, Popover, Segmented, Select, Switch, type ThemeChoice } from '../ui';
import { t, type Lang } from '../i18n';

export interface SettingsMenuProps {
  lang: Lang;
  onLang: (l: Lang) => void;
  theme: ThemeChoice;
  onTheme: (v: ThemeChoice) => void;
  /** Firewall (relay-only) mode; omitted on the sign-in screen, where it has no meaning yet. */
  relay?: { value: boolean; onChange: (v: boolean) => void };
}

const THEMES: ReadonlyArray<{ id: ThemeChoice; key: 'uiThemeDark' | 'uiThemeLight'; Icon: typeof IconMoon }> = [
  { id: 'dark', key: 'uiThemeDark', Icon: IconMoon },
  { id: 'light', key: 'uiThemeLight', Icon: IconSun },
];

/** One compact place for language, appearance and firewall mode (instead of header clutter). */
export function SettingsMenu({ lang, onLang, theme, onTheme, relay }: SettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    // Wait for the popover placement, then move focus to the first control.
    const raf = requestAnimationFrame(() => body.current?.querySelector<HTMLElement>('select')?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Tab leaving the panel closes it (the panel sits right after its trigger in the tab order).
    if (e.key === 'Tab') requestAnimationFrame(() => body.current && !body.current.contains(document.activeElement) && setOpen(false));
  };

  return (
    <>
      <IconButton
        ref={anchor}
        label={t(lang, 'hSettings')}
        icon={<IconSettings />}
        data-testid="settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      />
      <Popover open={open} anchorRef={anchor} onClose={close} align="end" role="dialog" aria-label={t(lang, 'hSettings')}>
        <div ref={body} className="hm-settings" onKeyDown={onKeyDown}>
          <Select label={t(lang, 'lang')} value={lang} onChange={(e) => onLang(e.target.value as Lang)}>
            {LANGS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
          <div className="hm-settings__group">
            <span className="dx-field__label" id="hm-theme-label">
              {t(lang, 'uiTheme')}
            </span>
            <Segmented
              label={t(lang, 'uiTheme')}
              value={theme}
              onChange={onTheme}
              options={THEMES.map(({ id, key, Icon }) => ({ id, label: (<><Icon size={18} />{t(lang, key)}</>) }))}
            />
          </div>
          {relay ? (
            <Switch
              label={t(lang, 'relayMode')}
              hint={t(lang, 'relayHint')}
              checked={relay.value}
              data-testid="relay-mode"
              onChange={(e) => relay.onChange(e.target.checked)}
            />
          ) : null}
        </div>
      </Popover>
    </>
  );
}
