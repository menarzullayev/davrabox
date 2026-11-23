import { forwardRef, type ButtonHTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import { Spinner } from './Spinner';
import { Tooltip } from './Tooltip';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'highlight';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, keeps the label (and the width) and blocks clicks. */
  loading?: boolean;
  /** Icon before the label (decorative: the label names the button). */
  icon?: ReactNode;
  iconEnd?: ReactNode;
  fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading = false, icon, iconEnd, fullWidth, className, children, onClick, disabled, type = 'button', 'aria-disabled': ariaDisabled, ...rest },
  ref,
) {
  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (loading || ariaDisabled === true || ariaDisabled === 'true') {
      e.preventDefault();
      return;
    }
    onClick?.(e);
  };
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={`dx-btn${className ? ` ${className}` : ''}`}
      data-variant={variant}
      data-size={size}
      data-full={fullWidth ? '' : undefined}
      disabled={disabled}
      aria-busy={loading || undefined}
      aria-disabled={loading || ariaDisabled === true || ariaDisabled === 'true' || undefined}
      onClick={handleClick}
    >
      <span className="dx-btn__label">
        {icon}
        {children}
        {iconEnd}
      </span>
      {loading ? (
        <span className="dx-btn__spinner" aria-hidden="true">
          <Spinner size={size === 'sm' ? 14 : 18} />
        </span>
      ) : null}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonProps, 'icon' | 'iconEnd' | 'children' | 'fullWidth' | 'aria-label'> {
  /** Required accessible name (also shown as the tooltip). */
  label: string;
  icon: ReactNode;
  /** Show the label as a tooltip on hover/focus. Default true. */
  tooltip?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, tooltip = true, variant = 'ghost', className, ...rest },
  ref,
) {
  const button = (
    <Button {...rest} ref={ref} variant={variant} aria-label={label} className={`dx-btn--icon${className ? ` ${className}` : ''}`}>
      {icon}
    </Button>
  );
  return tooltip ? <Tooltip content={label}>{button}</Tooltip> : button;
});
