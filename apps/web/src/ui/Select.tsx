import { Children, isValidElement, useCallback, useEffect, useId, useMemo, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconCheck, IconChevronDown, IconError } from './icons';
import { Popover, useEscapeLayer } from './Popover';

/** What `onChange` receives: the same `e.target.value` shape the native select had, so callers keep reading it unchanged. */
export interface SelectChangeEvent {
  target: { value: string; name?: string };
}

export interface SelectOption {
  value: string;
  label: ReactNode;
  /** Plain text of the label, used for type-ahead and the trigger's accessible name. */
  text: string;
  disabled: boolean;
}

export interface SelectProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'onChange' | 'value' | 'defaultValue'> {
  /** Visible label. Omit it only when `aria-label` names the control (toolbar filters). */
  label?: ReactNode;
  hint?: ReactNode;
  /** Error message. Sets aria-invalid and is announced with the field. */
  error?: ReactNode;
  /** Text shown after the label for non-required fields, e.g. "(optional)". */
  optionalText?: string;
  required?: boolean;
  name?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (e: SelectChangeEvent) => void;
  /** `<option value="x">Label</option>` children, as with a native select. */
  children?: ReactNode;
}

const textOf = (n: ReactNode): string => {
  if (n == null || typeof n === 'boolean') return '';
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(textOf).join('');
  if (isValidElement(n)) return textOf((n.props as { children?: ReactNode }).children);
  return '';
};

/** Reads `<option>` children (also inside fragments or arrays) into a plain list. */
export function readOptions(children: ReactNode): SelectOption[] {
  const out: SelectOption[] = [];
  const walk = (nodes: ReactNode) => {
    Children.forEach(nodes, (c) => {
      if (!isValidElement(c)) return;
      const el = c as ReactElement<{ value?: string | number; disabled?: boolean; children?: ReactNode }>;
      if (el.type === 'option') {
        const text = textOf(el.props.children);
        out.push({ value: String(el.props.value ?? text), label: el.props.children, text, disabled: !!el.props.disabled });
      } else if (el.props.children) walk(el.props.children);
    });
  };
  walk(children);
  return out;
}

/** Index of the next enabled option from `from` in direction `dir` (no wrap); `from` itself when none is left. */
export function stepOption(options: ReadonlyArray<{ disabled: boolean }>, from: number, dir: 1 | -1): number {
  for (let i = from + dir; i >= 0 && i < options.length; i += dir) if (!options[i]!.disabled) return i;
  return from;
}

/** First enabled option at or after `start` (wrapping) whose text starts with `prefix`; -1 when none. */
export function typeAheadIndex(options: ReadonlyArray<{ text: string; disabled: boolean }>, prefix: string, start: number): number {
  const p = prefix.toLowerCase();
  for (let k = 0; k < options.length; k++) {
    const i = (start + k) % options.length;
    if (!options[i]!.disabled && options[i]!.text.toLowerCase().startsWith(p)) return i;
  }
  return -1;
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

function describedBy(...ids: Array<string | false | undefined>): string | undefined {
  const s = ids.filter(Boolean).join(' ');
  return s || undefined;
}

/**
 * The DavraBox dropdown (a listbox that follows the chosen style, theme and density). Same call shape as a native select:
 * `<Select label value onChange>` with `<option>` children and `e.target.value`. On a narrow screen the list opens as a
 * bottom sheet with large rows; elsewhere it opens under the field. Keyboard: arrows, Home/End, type-ahead, Enter/Space, Esc.
 */
export function Select({ label, hint, error, optionalText, className, id, required, name, value, defaultValue, onChange, children, disabled, onKeyDown, ...rest }: SelectProps) {
  const auto = useId();
  const fid = id ?? auto;
  const labelId = `${fid}-label`;
  const valueId = `${fid}-value`;
  const listId = `${fid}-list`;
  const hintId = `${fid}-hint`;
  const errId = `${fid}-err`;
  const options = useMemo(() => readOptions(children), [children]);
  const [inner, setInner] = useState(defaultValue ?? options[0]?.value ?? '');
  const current = value ?? inner;
  const selected = options.findIndex((o) => o.value === current);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const narrow = useNarrow();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  const typed = useRef({ text: '', at: 0 });
  useEscapeLayer(open && narrow);

  const openList = () => {
    if (disabled) return;
    setActive(selected >= 0 && !options[selected]!.disabled ? selected : stepOption(options, -1, 1));
    setOpen(true);
  };
  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }, []);
  const choose = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    if (value === undefined) setInner(o.value);
    onChange?.({ target: { value: o.value, name } });
    close();
  };

  useEffect(() => {
    if (!open) return;
    list.current?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      openList();
    }
  };
  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setActive((a) => stepOption(options, a, 1)); return;
      case 'ArrowUp': e.preventDefault(); setActive((a) => stepOption(options, a, -1)); return;
      case 'Home': e.preventDefault(); setActive(stepOption(options, -1, 1)); return;
      case 'End': e.preventDefault(); setActive(stepOption(options, options.length, -1)); return;
      case 'Enter':
      case ' ': e.preventDefault(); choose(active); return;
      case 'Escape': e.preventDefault(); e.stopPropagation(); close(); return;
      case 'Tab': close(false); return;
      default:
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = Date.now();
      typed.current = { text: now - typed.current.at > 700 ? e.key : typed.current.text + e.key, at: now };
      const i = typeAheadIndex(options, typed.current.text, typed.current.text.length > 1 ? active : active + 1);
      if (i >= 0) setActive(i);
    }
  };

  const items = (
    <ul
      ref={list}
      id={listId}
      role="listbox"
      tabIndex={-1}
      className="dx-listbox"
      aria-labelledby={label ? labelId : undefined}
      aria-label={label ? undefined : rest['aria-label']}
      aria-activedescendant={open ? `${fid}-opt-${active}` : undefined}
      onKeyDown={onListKey}
    >
      {options.map((o, i) => (
        <li
          key={o.value}
          id={`${fid}-opt-${i}`}
          role="option"
          className="dx-option"
          data-index={i}
          data-value={o.value}
          data-active={i === active ? '' : undefined}
          aria-selected={i === selected}
          aria-disabled={o.disabled || undefined}
          onPointerMove={() => !o.disabled && i !== active && setActive(i)}
          onClick={() => choose(i)}
        >
          <span className="dx-option__label">{o.label}</span>
          {i === selected ? <IconCheck size={18} /> : null}
        </li>
      ))}
    </ul>
  );

  const host = typeof document === 'undefined' ? null : (trigger.current?.closest('dialog[open]') ?? document.body);

  return (
    <div className="dx-field">
      {label ? (
        <label className="dx-field__label" id={labelId} htmlFor={fid}>
          {label}
          {!required && optionalText ? <span className="dx-field__opt">{optionalText}</span> : null}
        </label>
      ) : null}
      <span className="dx-select">
        <button
          {...rest}
          ref={trigger}
          id={fid}
          type="button"
          role="combobox"
          disabled={disabled}
          className={`dx-select__control${className ? ` ${className}` : ''}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-required={required || undefined}
          aria-labelledby={label ? `${labelId} ${valueId}` : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(rest['aria-describedby'], !!hint && hintId, !!error && errId)}
          data-value={current}
          onClick={() => (open ? close() : openList())}
          onKeyDown={onTriggerKey}
        >
          <span className="dx-select__value" id={valueId}>
            {selected >= 0 ? options[selected]!.label : ''}
          </span>
        </button>
        <span className="dx-select__chevron">
          <IconChevronDown size={18} />
        </span>
        {name ? <input type="hidden" name={name} value={current} /> : null}
      </span>
      {open && !narrow ? (
        <Popover open anchorRef={trigger} onClose={() => close(false)} align="start" matchAnchorWidth>
          {items}
        </Popover>
      ) : null}
      {open && narrow && host
        ? createPortal(
            <div className="dx-sheet-root">
              <div className="dx-sheet__backdrop" data-testid="select-backdrop" onClick={() => close()} />
              <div className="dx-sheet" role="presentation">
                <div className="dx-sheet__grab" aria-hidden="true" />
                {label ? <div className="dx-sheet__title">{label}</div> : null}
                {items}
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
