import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { Davra } from '../brand/Davra';

export interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: 'div' | 'section' | 'article' | 'li';
  /** Raised surface with a shadow (popover-like content). */
  elevated?: boolean;
  /** Adds hover and a focus ring; pass tabIndex/role/onClick yourself. */
  interactive?: boolean;
}

export function Card({ as: Tag = 'div', elevated, interactive, className, children, ...rest }: CardProps) {
  return (
    <Tag {...(rest as HTMLAttributes<HTMLElement>)} className={`dx-card${interactive ? ' dx-card--interactive' : ''}${className ? ` ${className}` : ''}`} data-elevated={elevated ? '' : undefined}>
      {children}
    </Tag>
  );
}

export function CardTitle({ as: Tag = 'h3', children }: { as?: 'h2' | 'h3' | 'h4'; children: ReactNode }) {
  return <Tag className="dx-card__title">{children}</Tag>;
}

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  /** Heading level of the title. Default h3. */
  as?: 'h2' | 'h3' | 'h4';
}

/** Empty list or first-run state: the davra ornament, one sentence, one action. */
export function EmptyState({ title, description, action, as: Tag = 'h3' }: EmptyStateProps) {
  return (
    <div className="dx-empty">
      <div className="dx-empty__art">
        <Davra size={112} rings={2} petals={8} rotation={12} />
      </div>
      <Tag className="dx-empty__title">{title}</Tag>
      {description ? <p className="dx-empty__text">{description}</p> : null}
      {action ? <div className="dx-empty__action">{action}</div> : null}
    </div>
  );
}

export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
}

/** Placeholder block; decorative. Mark the loading region with aria-busy on its container. */
export function Skeleton({ width, height, radius }: SkeletonProps) {
  const style = { '--w': typeof width === 'number' ? `${width}px` : width, '--h': typeof height === 'number' ? `${height}px` : height, '--r': typeof radius === 'number' ? `${radius}px` : radius } as CSSProperties;
  return <span className="dx-skeleton" style={style} aria-hidden="true" />;
}
