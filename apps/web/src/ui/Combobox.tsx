import { useCallback, useEffect, useId, useMemo, useRef, useState, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import { IconError } from './icons';
import { Popover } from './Popover';
import { stepOption } from './Select';

export interface ComboboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'list' | 'role'> {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  value: string;
  /** Called with the new text, typed or suggested (same `e.target.value` shape as an input). */
  onChange: (e: { target: { value: string } }) => void;
  /** Suggestions. The person may still type anything: this is a hint list, not a closed choice. */
  options: readonly string[];
}

/** Text field with a suggestion list (replaces the native datalist): filtered as you type, arrows to move, Enter or a click to take one. */
export function Combobox({ label, hint, error, value, onChange, options, className, id, onKeyDown, onFocus, ...rest }: ComboboxProps) {
  const auto = useId();
  const fid = id ?? auto;
  const listId = `${fid}-list`;
  const hintId = `${fid}-hint`;
  const errId = `${fid}-err`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement | null>(null);
  // Closing with Escape hands focus back to the input; that focus must not reopen the list.
  const justClosed = useRef(false);
  const shown = useMemo(() => {
    const q = value.trim().toLowerCase();
    const list = q ? options.filter((o) => o.toLowerCase().includes(q)) : [...options];
    return list.filter((o) => o !== value);
  }, [options, value]);
  const items = shown.map((o) => ({ disabled: false, o }));

  useEffect(() => {
    if (active >= shown.length) setActive(-1);
  }, [shown.length, active]);

  const dismiss = useCallback(() => {
    justClosed.current = true;
    setTimeout(() => (justClosed.current = false), 0);
    setOpen(false);
    setActive(-1);
  }, []);

  const take = (i: number) => {
    const o = shown[i];
    if (o === undefined) return;
    onChange({ target: { value: o } });
    dismiss();
    input.current?.focus();
  };
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) setOpen(true);
      setActive((a) => (items.length ? stepOption(items, a, 1) : -1));
    } else if (e.key === 'ArrowUp' && open) {
      e.preventDefault();
      setActive((a) => (a <= 0 ? -1 : stepOption(items, a, -1)));
    } else if (e.key === 'Enter' && open && active >= 0) {
      e.preventDefault(); // choosing a suggestion must not submit the form
      take(active);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      dismiss();
    }
  };

  const expanded = open && shown.length > 0;
  return (
    <div className="dx-field">
      <label className="dx-field__label" htmlFor={fid}>
        {label}
      </label>
      <input
        {...rest}
        ref={input}
        id={fid}
        role="combobox"
        autoComplete="off"
        className={`dx-input${className ? ` ${className}` : ''}`}
        value={value}
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        aria-activedescendant={expanded && active >= 0 ? `${fid}-opt-${active}` : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={[rest['aria-describedby'], hint ? hintId : '', error ? errId : ''].filter(Boolean).join(' ') || undefined}
        onChange={(e) => {
          onChange({ target: { value: e.target.value } });
          setOpen(true);
          setActive(-1);
        }}
        onFocus={(e) => {
          onFocus?.(e);
          if (!justClosed.current) setOpen(true);
        }}
        onKeyDown={keys}
      />
      {expanded ? (
        <Popover open anchorRef={input} onClose={dismiss} align="start" matchAnchorWidth>
          <ul id={listId} role="listbox" className="dx-listbox" aria-label={typeof label === 'string' ? label : undefined}>
            {shown.map((o, i) => (
              <li
                key={o}
                id={`${fid}-opt-${i}`}
                role="option"
                className="dx-option"
                data-value={o}
                data-active={i === active ? '' : undefined}
                aria-selected={i === active}
                onPointerDown={(e) => e.preventDefault()}
                onPointerMove={() => i !== active && setActive(i)}
                onClick={() => take(i)}
              >
                <span className="dx-option__label">{o}</span>
              </li>
            ))}
          </ul>
        </Popover>
      ) : null}
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
