import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t, type Lang } from '../i18n';
import { Button, IconButton } from './Button';
import { IconCalendar, IconChevronLeft, IconChevronRight, IconError } from './icons';
import { useBackLayer } from '../platform/back';
import { Popover, useEscapeLayer } from './Popover';

/** `YYYY-MM-DDTHH:mm` (local time), the same text a datetime-local input uses; '' is "not set". */
export interface DateTimeParts {
  y: number;
  m: number; // 1-12
  d: number;
  h: number;
  min: number;
}
const pad = (n: number) => String(n).padStart(2, '0');

export function parseDateTime(v: string): DateTimeParts | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const p = { y: +m[1]!, m: +m[2]!, d: +m[3]!, h: +m[4]!, min: +m[5]! };
  const dt = new Date(p.y, p.m - 1, p.d, p.h, p.min);
  return dt.getFullYear() === p.y && dt.getMonth() === p.m - 1 && dt.getDate() === p.d && p.h < 24 && p.min < 60 ? p : null;
}
export const formatDateTime = (p: DateTimeParts): string => `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.min)}`;

/** The 6x7 grid of a month, Monday first; days outside the month are null. */
export function monthGrid(y: number, m: number): Array<number | null> {
  const first = (new Date(y, m - 1, 1).getDay() + 6) % 7; // Monday = 0
  const days = new Date(y, m, 0).getDate();
  const cells: Array<number | null> = [];
  for (let i = 0; i < first; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  while (cells.length % 7) cells.push(null);
  return cells;
}

/** Moves a (year, month, day) by whole days or months, staying a valid date. */
export function shiftDay(p: { y: number; m: number; d: number }, days: number): { y: number; m: number; d: number } {
  const dt = new Date(p.y, p.m - 1, p.d + days);
  return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() };
}
export function shiftMonth(p: { y: number; m: number; d: number }, months: number): { y: number; m: number; d: number } {
  const target = new Date(p.y, p.m - 1 + months, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return { y: target.getFullYear(), m: target.getMonth() + 1, d: Math.min(p.d, last) };
}

const NARROW = '(max-width: 640px)';
const useNarrow = (): boolean => {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(NARROW).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(NARROW);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
};

export interface DateTimePickerProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  value: string;
  onChange: (e: { target: { value: string } }) => void;
  lang: Lang;
  id?: string;
  disabled?: boolean;
  'data-testid'?: string;
}

const DEFAULT_TIME = { h: 9, min: 0 };

/**
 * Date and time chooser (replaces `<input type="datetime-local">`): a month grid with a time column, in a popover or, on a
 * narrow screen, a bottom sheet. Value format is the same `YYYY-MM-DDTHH:mm` text. Arrow keys move the day, PageUp/PageDown the month.
 */
export function DateTimePicker({ label, hint, error, required, value, onChange, lang, id, disabled, 'data-testid': testId }: DateTimePickerProps) {
  const auto = useId();
  const fid = id ?? auto;
  const labelId = `${fid}-label`;
  const hintId = `${fid}-hint`;
  const errId = `${fid}-err`;
  const parsed = parseDateTime(value);
  const today = new Date();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState({ y: today.getFullYear(), m: today.getMonth() + 1 });
  const [focusDay, setFocusDay] = useState(1);
  const narrow = useNarrow();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const grid = useRef<HTMLDivElement | null>(null);
  useEscapeLayer(open && narrow);
  useBackLayer(open && narrow, () => close());

  const monthName = useMemo(() => new Intl.DateTimeFormat(lang, { month: 'long', year: 'numeric' }).format(new Date(view.y, view.m - 1, 1)), [lang, view]);
  const weekdays = useMemo(() => {
    const f = new Intl.DateTimeFormat(lang, { weekday: 'short' });
    return Array.from({ length: 7 }, (_, i) => f.format(new Date(2024, 0, 1 + i))); // 2024-01-01 is a Monday
  }, [lang]);
  const shown = useMemo(() => {
    if (!parsed) return t(lang, 'dtEmpty');
    return new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(parsed.y, parsed.m - 1, parsed.d, parsed.h, parsed.min));
  }, [parsed, lang]);

  const commit = (p: DateTimeParts) => onChange({ target: { value: formatDateTime(p) } });
  const openPanel = () => {
    if (disabled) return;
    const base = parsed ?? { y: today.getFullYear(), m: today.getMonth() + 1, d: today.getDate() };
    setView({ y: base.y, m: base.m });
    setFocusDay(base.d);
    setOpen(true);
  };
  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }, []);

  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // Bring the chosen hour and minute into view in their scrolling rows when the panel opens.
    if (!open) return;
    panelRef.current?.querySelectorAll<HTMLElement>('.dx-dtp__col [aria-pressed="true"]').forEach((el) => el.scrollIntoView?.({ inline: 'center', block: 'nearest' }));
  }, [open]);
  useEffect(() => {
    if (open) grid.current?.querySelector<HTMLElement>(`[data-day="${focusDay}"]`)?.focus({ preventScroll: true });
    // Only when the panel opens or the focused day / month changes by keyboard.
  }, [open, focusDay, view.y, view.m]);

  const pickDay = (d: number) => {
    const time = parsed ?? DEFAULT_TIME;
    commit({ y: view.y, m: view.m, d, h: time.h, min: time.min });
    setFocusDay(d);
  };
  const pickTime = (h: number, min: number) => {
    const day = parsed ?? { y: view.y, m: view.m, d: Math.min(focusDay, new Date(view.y, view.m, 0).getDate()) };
    commit({ y: day.y, m: day.m, d: day.d, h, min });
  };

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const delta: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    let next: { y: number; m: number; d: number } | null = null;
    const cur = { y: view.y, m: view.m, d: focusDay };
    if (e.key in delta) next = shiftDay(cur, delta[e.key]!);
    else if (e.key === 'PageUp') next = shiftMonth(cur, -1);
    else if (e.key === 'PageDown') next = shiftMonth(cur, 1);
    else if (e.key === 'Home') next = { ...cur, d: 1 };
    else if (e.key === 'End') next = { ...cur, d: new Date(cur.y, cur.m, 0).getDate() };
    if (!next) return;
    e.preventDefault();
    setView({ y: next.y, m: next.m });
    setFocusDay(next.d);
  };
  const onPanelKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const minutes = useMemo(() => {
    const base = Array.from({ length: 12 }, (_, i) => i * 5);
    if (parsed && !base.includes(parsed.min)) base.push(parsed.min);
    return base.sort((a, b) => a - b);
  }, [parsed]);

  const panel = (
    <div className="dx-dtp" ref={panelRef} role="dialog" aria-label={typeof label === 'string' ? label : undefined} onKeyDown={onPanelKey}>
      <div className="dx-dtp__head">
        <IconButton variant="ghost" size="sm" tooltip={false} icon={<IconChevronLeft size={18} />} label={t(lang, 'dtPrev')} data-testid="dt-prev" onClick={() => setView((v) => ({ y: v.m === 1 ? v.y - 1 : v.y, m: v.m === 1 ? 12 : v.m - 1 }))} />
        <div className="dx-dtp__month" aria-live="polite" data-ym={`${view.y}-${pad(view.m)}`}>
          {monthName}
        </div>
        <IconButton variant="ghost" size="sm" tooltip={false} icon={<IconChevronRight size={18} />} label={t(lang, 'dtNext')} data-testid="dt-next" onClick={() => setView((v) => ({ y: v.m === 12 ? v.y + 1 : v.y, m: v.m === 12 ? 1 : v.m + 1 }))} />
      </div>
      <div className="dx-dtp__body">
        <div className="dx-dtp__cal" ref={grid} role="grid" aria-label={monthName} onKeyDown={onGridKey}>
          <div className="dx-dtp__row" role="row">
            {weekdays.map((w) => (
              <span key={w} className="dx-dtp__wd" role="columnheader">
                {w}
              </span>
            ))}
          </div>
          {Array.from({ length: Math.ceil(monthGrid(view.y, view.m).length / 7) }, (_, r) => (
            <div className="dx-dtp__row" role="row" key={r}>
              {monthGrid(view.y, view.m)
                .slice(r * 7, r * 7 + 7)
                .map((d, c) =>
                  d === null ? (
                    <span key={c} className="dx-dtp__blank" role="gridcell" />
                  ) : (
                    <span key={c} role="gridcell" aria-selected={parsed?.y === view.y && parsed.m === view.m && parsed.d === d}>
                      <button
                        type="button"
                        className="dx-dtp__day"
                        data-day={d}
                        tabIndex={d === focusDay ? 0 : -1}
                        aria-pressed={parsed?.y === view.y && parsed.m === view.m && parsed.d === d}
                        aria-current={today.getFullYear() === view.y && today.getMonth() + 1 === view.m && today.getDate() === d ? 'date' : undefined}
                        aria-label={new Intl.DateTimeFormat(lang, { dateStyle: 'full' }).format(new Date(view.y, view.m - 1, d))}
                        onClick={() => pickDay(d)}
                      >
                        {d}
                      </button>
                    </span>
                  ),
                )}
            </div>
          ))}
        </div>
        <div className="dx-dtp__time">
          <div className="dx-dtp__col" role="group" aria-label={t(lang, 'dtHour')}>
            {Array.from({ length: 24 }, (_, h) => (
              <button type="button" key={h} className="dx-dtp__cell" data-hour={h} aria-pressed={parsed?.h === h} onClick={() => pickTime(h, parsed?.min ?? DEFAULT_TIME.min)}>
                {pad(h)}
              </button>
            ))}
          </div>
          <div className="dx-dtp__col" role="group" aria-label={t(lang, 'dtMinute')}>
            {minutes.map((mm) => (
              <button type="button" key={mm} className="dx-dtp__cell" data-minute={mm} aria-pressed={parsed?.min === mm} onClick={() => pickTime(parsed?.h ?? DEFAULT_TIME.h, mm)}>
                {pad(mm)}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="dx-dtp__foot">
        {!required && parsed ? (
          <Button variant="ghost" size="sm" data-testid="dt-clear" onClick={() => { onChange({ target: { value: '' } }); close(); }}>
            {t(lang, 'dtClear')}
          </Button>
        ) : (
          <span />
        )}
        <Button variant="primary" size="sm" data-testid="dt-done" onClick={() => close()}>
          {t(lang, 'dtDone')}
        </Button>
      </div>
    </div>
  );

  const host = typeof document === 'undefined' ? null : (trigger.current?.closest('dialog[open]') ?? document.body);
  return (
    <div className="dx-field">
      <label className="dx-field__label" id={labelId} htmlFor={fid}>
        {label}
      </label>
      <span className="dx-select">
        <button
          ref={trigger}
          id={fid}
          type="button"
          disabled={disabled}
          className="dx-select__control"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-labelledby={`${labelId} ${fid}-value`}
          aria-required={required || undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={[hint ? hintId : '', error ? errId : ''].filter(Boolean).join(' ') || undefined}
          data-testid={testId}
          data-value={value}
          onClick={() => (open ? close() : openPanel())}
        >
          <span className="dx-select__value" id={`${fid}-value`}>
            {shown}
          </span>
        </button>
        <span className="dx-select__chevron">
          <IconCalendar size={18} />
        </span>
      </span>
      {open && !narrow ? (
        <Popover open anchorRef={trigger} onClose={() => close(false)} align="start" role="presentation">
          {panel}
        </Popover>
      ) : null}
      {open && narrow && host
        ? createPortal(
            <div className="dx-sheet-root">
              <div className="dx-sheet__backdrop" data-testid="select-backdrop" onClick={() => close()} />
              <div className="dx-sheet" role="presentation">
                <div className="dx-sheet__grab" aria-hidden="true" />
                {panel}
              </div>
            </div>,
            host,
          )
        : null}
      {hint ? (
        <div className="dx-field__hint" id={hintId}>
          {hint}
        </div>
      ) : null}
      {error ? (
        <div className="dx-field__error" id={errId}>
          <IconError size={14} />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}
