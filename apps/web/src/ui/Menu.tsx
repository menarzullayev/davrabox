import { Fragment, useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { Popover, type PopoverAlign } from './Popover';

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  tone?: 'danger';
  disabled?: boolean;
  /** Draws a divider above this item. */
  separatorBefore?: boolean;
  onSelect: () => void;
}

export interface MenuTriggerProps {
  ref: Ref<HTMLButtonElement>;
  id: string;
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
  'aria-controls': string | undefined;
  onClick: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
}

export interface MenuProps {
  items: MenuItem[];
  align?: PopoverAlign;
  /** Renders the trigger button; spread the given props on it. */
  trigger: (props: MenuTriggerProps) => ReactNode;
}

/** Index of the next enabled item in `dir` from `from`, wrapping; -1 when none is enabled. */
export function nextEnabled(items: ReadonlyArray<{ disabled?: boolean }>, from: number, dir: 1 | -1): number {
  const n = items.length;
  for (let step = 1; step <= n; step++) {
    const i = (((from + dir * step) % n) + n) % n;
    if (!items[i]!.disabled) return i;
  }
  return -1;
}

/** Action menu (WAI-ARIA menu button): arrows, Home/End, typeahead, Escape, Tab closes, focus returns to the trigger. */
export function Menu({ items, align = 'start', trigger }: MenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const pending = useRef<'first' | 'last'>('first');
  const typed = useRef({ text: '', at: 0 });
  const uid = useId();
  const menuId = `${uid}-menu`;

  const close = useCallback(() => setOpen(false), []);
  const focusAt = (i: number) => refs.current[i]?.focus();

  useEffect(() => {
    if (!open) return;
    const i = pending.current === 'last' ? nextEnabled(items, 0, -1) : nextEnabled(items, -1, 1);
    // Wait for placement so the focus call does not scroll the page to the unpositioned panel.
    const raf = requestAnimationFrame(() => focusAt(i));
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      pending.current = e.key === 'ArrowUp' ? 'last' : 'first';
      setOpen(true);
    }
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const current = refs.current.findIndex((el) => el === document.activeElement);
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusAt(nextEnabled(items, current, 1));
        return;
      case 'ArrowUp':
        e.preventDefault();
        focusAt(nextEnabled(items, current, -1));
        return;
      case 'Home':
        e.preventDefault();
        focusAt(nextEnabled(items, -1, 1));
        return;
      case 'End':
        e.preventDefault();
        focusAt(nextEnabled(items, 0, -1));
        return;
      case 'Tab':
        setOpen(false);
        return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ') {
      const now = Date.now();
      typed.current.text = (now - typed.current.at > 700 ? '' : typed.current.text) + e.key.toLocaleLowerCase();
      typed.current.at = now;
      const start = typed.current.text.length > 1 ? current - 1 : current;
      for (let step = 1; step <= items.length; step++) {
        const i = (((start + step) % items.length) + items.length) % items.length;
        if (!items[i]!.disabled && items[i]!.label.toLocaleLowerCase().startsWith(typed.current.text)) {
          focusAt(i);
          break;
        }
      }
    }
  };

  return (
    <>
      {trigger({
        ref: triggerRef,
        id: `${uid}-trigger`,
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': open ? menuId : undefined,
        onClick: () => {
          pending.current = 'first';
          setOpen((o) => !o);
        },
        onKeyDown: onTriggerKey,
      })}
      <Popover open={open} anchorRef={triggerRef} onClose={close} align={align} role="menu" id={menuId} aria-labelledby={`${uid}-trigger`}>
        <div onKeyDown={onMenuKey}>
          {items.map((it, i) => (
            <Fragment key={it.id}>
              {it.separatorBefore ? <hr className="dx-menu__sep" /> : null}
              <button
                type="button"
                role="menuitem"
                className="dx-menu__item"
                data-tone={it.tone}
                tabIndex={-1}
                aria-disabled={it.disabled || undefined}
                ref={(el) => {
                  refs.current[i] = el;
                }}
                onClick={() => {
                  if (it.disabled) return;
                  setOpen(false);
                  triggerRef.current?.focus();
                  it.onSelect();
                }}
              >
                {it.icon}
                {it.label}
              </button>
            </Fragment>
          ))}
        </div>
      </Popover>
    </>
  );
}
