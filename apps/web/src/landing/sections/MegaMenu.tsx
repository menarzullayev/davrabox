import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { tx } from '../../home/text';
import type { Lang } from '../../i18n';
import { Button, IconButton, IconChevronDown, IconMenu, IconX, useEscapeLayer } from '../../ui';
import { MENU, PRICING_LINK, type MenuGroup, type MenuLink } from '../menu';

function Item({ lang, item, onNavigate }: { lang: Lang; item: MenuLink; onNavigate: () => void }) {
  const Icon = item.icon;
  return (
    <li>
      <a
        className="ln-mm__item"
        href={item.href}
        onClick={onNavigate}
        {...(item.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        data-testid={`menu-${item.id}`}
      >
        <span className="ln-mm__icon" aria-hidden="true">
          <Icon size={20} />
        </span>
        <span className="ln-mm__text">
          <span className="ln-mm__title">
            {tx(lang, item.title)}
            {item.external ? <span className="ln-sr"> ({tx(lang, 'lnTrustExternal')})</span> : null}
          </span>
          <span className="ln-mm__desc">{tx(lang, item.desc)}</span>
        </span>
      </a>
    </li>
  );
}

/**
 * Desktop mega-menu (decision 6): "Product" and "Resources" open a panel of links, each with an icon and a one-line
 * description; "Pricing" is a plain link. Disclosure pattern (button + aria-expanded), not an ARIA menu: the panels hold
 * ordinary links. One panel at a time; Escape, a click outside or following a link closes it.
 */
export function MegaMenu({ lang }: { lang: Lang }) {
  const [open, setOpen] = useState<MenuGroup['id'] | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggers = useRef<Record<string, HTMLButtonElement | null>>({});
  const idBase = useId();
  const isTop = useEscapeLayer(open !== null);

  const close = useCallback((refocus: boolean) => {
    setOpen((cur) => {
      if (cur && refocus) triggers.current[cur]?.focus();
      return null;
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isTop()) {
        e.preventDefault();
        close(true);
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close, isTop]);

  // Arrow Down on a trigger opens its panel and moves to the first link (what keyboard users of mega-menus expect).
  const onTriggerKey = (g: MenuGroup['id']) => (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowDown') return;
    e.preventDefault();
    setOpen(g);
    requestAnimationFrame(() => document.getElementById(`${idBase}-${g}`)?.querySelector<HTMLAnchorElement>('a')?.focus());
  };

  // Focus leaving the whole menu (Tab past the last link) closes the panel.
  const onBlur = (e: React.FocusEvent) => {
    if (open && !rootRef.current?.contains(e.relatedTarget as Node | null)) close(false);
  };

  return (
    <div className="ln-mm" ref={rootRef} onBlur={onBlur}>
      <nav aria-label={tx(lang, 'lnMenuLabel')}>
        <ul className="ln-mm__bar">
          {MENU.map((g) => (
            <li key={g.id} className="ln-mm__top">
              <Button
                ref={(el) => {
                  triggers.current[g.id] = el;
                }}
                variant="ghost"
                size="sm"
                className="ln-mm__trigger"
                aria-expanded={open === g.id}
                aria-controls={`${idBase}-${g.id}`}
                onClick={() => setOpen((cur) => (cur === g.id ? null : g.id))}
                onKeyDown={onTriggerKey(g.id)}
                iconEnd={<IconChevronDown size={16} className="ln-mm__chev" />}
                data-testid={`menu-trigger-${g.id}`}
              >
                {tx(lang, g.label)}
              </Button>
              <div className="ln-mm__panel lg-panel" id={`${idBase}-${g.id}`} hidden={open !== g.id}>
                <ul className={`ln-mm__grid ln-mm__grid--${g.id}`}>
                  {g.items.map((it) => (
                    <Item key={it.id} lang={lang} item={it} onNavigate={() => close(false)} />
                  ))}
                </ul>
              </div>
            </li>
          ))}
          <li className="ln-mm__top">
            <a className="ln-mm__trigger ln-mm__link" href={PRICING_LINK.href} data-testid="menu-pricing">
              {tx(lang, PRICING_LINK.title)}
            </a>
          </li>
        </ul>
      </nav>
    </div>
  );
}

/**
 * Narrow screens: a menu button opens a sheet with the same groups (headed lists) and the pricing link. Modal: focus moves
 * into the sheet and is kept there, Escape or the close button closes it and focus returns to the menu button.
 */
export function MenuSheet({ lang }: { lang: Lang }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const isTop = useEscapeLayer(open);

  const close = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => btnRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    sheetRef.current?.querySelector<HTMLElement>('button, a')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (!isTop()) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== 'Tab' || !sheetRef.current) return;
      const f = [...sheetRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
      if (!f.length) return;
      const first = f[0]!;
      const last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close, isTop]);

  return (
    <>
      <IconButton
        ref={btnRef}
        className="ln-sheet__open"
        label={tx(lang, 'lnMenuOpen')}
        icon={<IconMenu size={22} />}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        tooltip={false}
        data-testid="menu-open"
      />
      {open ? (
        <div className="ln-sheet" data-testid="menu-sheet">
          <div className="ln-sheet__scrim" onClick={close} aria-hidden="true" />
          <div className="ln-sheet__panel lg-panel" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={sheetRef}>
            <div className="ln-sheet__head">
              <h2 className="ln-sheet__title" id={titleId}>
                {tx(lang, 'lnMenuLabel')}
              </h2>
              <IconButton label={tx(lang, 'lnMenuClose')} icon={<IconX size={20} />} onClick={close} tooltip={false} data-testid="menu-close" />
            </div>
            {MENU.map((g) => (
              <section key={g.id} className="ln-sheet__group" aria-labelledby={`${titleId}-${g.id}`}>
                <h3 className="ln-sheet__label" id={`${titleId}-${g.id}`}>
                  {tx(lang, g.label)}
                </h3>
                <ul className="ln-mm__grid">
                  {g.items.map((it) => (
                    <Item key={it.id} lang={lang} item={it} onNavigate={() => setOpen(false)} />
                  ))}
                </ul>
              </section>
            ))}
            <ul className="ln-mm__grid ln-sheet__group">
              <Item lang={lang} item={PRICING_LINK} onNavigate={() => setOpen(false)} />
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}
