import type { AnchorHTMLAttributes, ReactNode } from 'react';
import type { ButtonSize, ButtonVariant } from '../ui';

export interface ButtonLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  iconEnd?: ReactNode;
  children: ReactNode;
}

/** A real link (navigation, opens in the same tab, works without script) drawn like a design-system button. */
export function ButtonLink({ variant = 'secondary', size = 'md', iconEnd, className, children, ...rest }: ButtonLinkProps) {
  return (
    <a {...rest} className={`dx-btn${className ? ` ${className}` : ''}`} data-variant={variant} data-size={size}>
      <span className="dx-btn__label">
        {children}
        {iconEnd}
      </span>
    </a>
  );
}
