import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button, IconButton, IconSettings, Popover, Switch, type ThemeChoice } from '../ui';
import { AppearanceFields } from './AppearanceFields';
import { t, type Lang } from '../i18n';

export interface SettingsMenuProps {
  lang: Lang;
  onLang: (l: Lang) => void;
  theme: ThemeChoice;
  onTheme: (v: ThemeChoice) => void;
  /** Firewall (relay-only) mode; omitted on the sign-in screen, where it has no meaning yet. */
  relay?: { value: boolean; onChange: (v: boolean) => void };
  /** A labelled tab-bar trigger (the liquid-glass phone tab bar) instead of the icon button; it needs its own test id. */
  tab?: { testId: string; className?: string };
}

/** One compact place for language, appearance and firewall mode (instead of header clutter). */
export function SettingsMenu({ lang, onLang, theme, onTheme, relay, tab }: SettingsMenuProps) {
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
      {tab ? (
        <Button ref={anchor} variant="ghost" icon={<IconSettings />} className={tab.className} data-testid={tab.testId} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {t(lang, 'hSettings')}
        </Button>
      ) : (
        <IconButton
          ref={anchor}
          label={t(lang, 'hSettings')}
          icon={<IconSettings />}
          data-testid="settings"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        />
      )}
      <Popover open={open} anchorRef={anchor} onClose={close} align="end" role="dialog" aria-label={t(lang, 'hSettings')}>
        <div ref={body} className="hm-settings" onKeyDown={onKeyDown}>
          <AppearanceFields lang={lang} onLang={onLang} theme={theme} onTheme={onTheme} />
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
