import { forwardRef, useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { t } from '../i18n';
import { usePrefs } from '../prefs';
import { IconButton } from './Button';
import { IconError, IconEye, IconEyeOff } from './icons';

interface FieldCommon {
  label: ReactNode;
  hint?: ReactNode;
  /** Error message. Sets aria-invalid and is announced with the field. */
  error?: ReactNode;
  /** Text shown after the label for non-required fields, e.g. "(optional)". */
  optionalText?: string;
}

function describedBy(...ids: Array<string | false | undefined>): string | undefined {
  const s = ids.filter(Boolean).join(' ');
  return s || undefined;
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'children'>, FieldCommon {
  /** Larger tabular figures with letter spacing: meeting codes and passcodes. */
  code?: boolean;
  /** Password fields get a show/hide button; set false only where the form must keep a single button (the join card, see its e2e contract). */
  reveal?: boolean;
}

/** The eye button of a password field: shows or hides the typed text (the label follows the page language). */
function PasswordEye({ shown, onToggle, controls }: { shown: boolean; onToggle: () => void; controls: string }) {
  const { lang } = usePrefs();
  return (
    <IconButton
      label={t(lang, shown ? 'uiHidePassword' : 'uiShowPassword')}
      icon={shown ? <IconEyeOff /> : <IconEye />}
      tooltip={false}
      className="dx-input-eye"
      aria-pressed={shown}
      aria-controls={controls}
      data-testid="password-eye"
      onClick={onToggle}
    />
  );
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, error, optionalText, code, className, id, required, type, reveal = true, ...rest },
  ref,
) {
  const auto = useId();
  const fid = id ?? auto;
  const hintId = `${fid}-hint`;
  const errId = `${fid}-err`;
  const [shown, setShown] = useState(false);
  const isPassword = type === 'password' && reveal;
  const input = (
    <input
      {...rest}
      ref={ref}
      id={fid}
      type={isPassword && shown ? 'text' : type}
      required={required}
      className={`dx-input${code ? ' dx-input--code' : ''}${isPassword ? ' dx-input--eye' : ''}${className ? ` ${className}` : ''}`}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy(rest['aria-describedby'], !!hint && hintId, !!error && errId)}
    />
  );
  return (
    <div className="dx-field">
      <label className="dx-field__label" htmlFor={fid}>
        {label}
        {!required && optionalText ? <span className="dx-field__opt">{optionalText}</span> : null}
      </label>
      {isPassword ? (
        <span className="dx-input-wrap">
          {input}
          <PasswordEye shown={shown} onToggle={() => setShown((s) => !s)} controls={fid} />
        </span>
      ) : (
        input
      )}
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
});

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'children'> {
  label: ReactNode;
  hint?: ReactNode;
  indeterminate?: boolean;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox({ label, hint, indeterminate, className, id, ...rest }, ref) {
  const auto = useId();
  const fid = id ?? auto;
  const inner = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (inner.current) inner.current.indeterminate = !!indeterminate;
  }, [indeterminate]);
  return (
    <label className="dx-check" htmlFor={fid}>
      <input
        {...rest}
        id={fid}
        type="checkbox"
        className={`dx-check__input${className ? ` ${className}` : ''}`}
        aria-describedby={describedBy(rest['aria-describedby'], !!hint && `${fid}-hint`)}
        ref={(el) => {
          inner.current = el;
          if (typeof ref === 'function') ref(el);
          else if (ref) ref.current = el;
        }}
      />
      <span className="dx-check__body">
        <span className="dx-check__label">{label}</span>
        {hint ? (
          <span className="dx-check__hint" id={`${fid}-hint`}>
            {hint}
          </span>
        ) : null}
      </span>
    </label>
  );
});

export interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'role' | 'children'> {
  label: ReactNode;
  hint?: ReactNode;
}

/** On/off setting that takes effect immediately (role="switch"); use Checkbox for form choices. */
export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch({ label, hint, className, id, ...rest }, ref) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <label className="dx-switch" htmlFor={fid}>
      <input
        {...rest}
        ref={ref}
        id={fid}
        type="checkbox"
        role="switch"
        className={`dx-switch__input${className ? ` ${className}` : ''}`}
        aria-describedby={describedBy(rest['aria-describedby'], !!hint && `${fid}-hint`)}
      />
      <span className="dx-switch__body">
        <span className="dx-switch__label">{label}</span>
        {hint ? (
          <span className="dx-switch__hint" id={`${fid}-hint`}>
            {hint}
          </span>
        ) : null}
      </span>
    </label>
  );
});
