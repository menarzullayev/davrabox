import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface TabItem {
  id: string;
  label: ReactNode;
  panel: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  tabs: TabItem[];
  /** Controlled value. Omit to let the component keep the state (starting at defaultValue or the first tab). */
  value?: string;
  defaultValue?: string;
  onChange?: (id: string) => void;
  /** Accessible name of the tab list. */
  label: string;
}

/** WAI-ARIA tabs with automatic activation: arrows move and select, Home/End jump, one tab stop for the list. */
export function Tabs({ tabs, value, defaultValue, onChange, label }: TabsProps) {
  const base = useId();
  const [inner, setInner] = useState(defaultValue ?? tabs.find((t) => !t.disabled)?.id ?? '');
  const current = value ?? inner;
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const select = (id: string, focus: boolean) => {
    if (value === undefined) setInner(id);
    onChange?.(id);
    if (focus) refs.current[id]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const enabled = tabs.filter((t) => !t.disabled);
    const i = enabled.findIndex((t) => t.id === current);
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (i + 1) % enabled.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + enabled.length) % enabled.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = enabled.length - 1;
    if (next === null || enabled.length === 0) return;
    e.preventDefault();
    select(enabled[next]!.id, true);
  };

  return (
    <div>
      <div className="dx-tablist" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {tabs.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            className="dx-tab"
            id={`${base}-tab-${t.id}`}
            aria-selected={t.id === current}
            aria-controls={`${base}-panel-${t.id}`}
            tabIndex={t.id === current ? 0 : -1}
            disabled={t.disabled}
            onClick={() => select(t.id, false)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          className="dx-tabpanel"
          id={`${base}-panel-${t.id}`}
          aria-labelledby={`${base}-tab-${t.id}`}
          hidden={t.id !== current}
          tabIndex={0}
        >
          {t.id === current ? t.panel : null}
        </div>
      ))}
    </div>
  );
}
