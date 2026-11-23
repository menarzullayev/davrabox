import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { IconButton } from './Button';
import { IconCheckCircle, IconError, IconInfo, IconWarning, IconX } from './icons';

export type AlertTone = 'info' | 'success' | 'warning' | 'danger';

const toneIcon = { info: IconInfo, success: IconCheckCircle, warning: IconWarning, danger: IconError } as const;

export interface AlertProps {
  tone?: AlertTone;
  title?: ReactNode;
  children?: ReactNode;
  onDismiss?: () => void;
  /** Required with onDismiss. */
  dismissLabel?: string;
  className?: string;
}

/**
 * Inline message. Warnings and errors use role="alert" (announced at once); info and success use role="status"
 * (polite). Colour is paired with an icon and text, never the only cue.
 */
export function Alert({ tone = 'info', title, children, onDismiss, dismissLabel, className }: AlertProps) {
  const Icon = toneIcon[tone];
  return (
    <div className={`dx-alert${className ? ` ${className}` : ''}`} data-tone={tone === 'info' ? 'accent' : tone} role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}>
      <span className="dx-alert__icon">
        <Icon size={20} />
      </span>
      <div>
        {title ? <p className="dx-alert__title">{title}</p> : null}
        {children ? <p className="dx-alert__body">{children}</p> : null}
      </div>
      {onDismiss ? <IconButton label={dismissLabel ?? ''} icon={<IconX size={16} />} size="sm" tooltip={false} onClick={onDismiss} /> : null}
    </div>
  );
}

export interface ToastInput {
  tone?: AlertTone;
  title: ReactNode;
  description?: ReactNode;
  /** Auto-dismiss delay in ms; 0 keeps it until dismissed. Default 6000 (danger: 0). */
  duration?: number;
}
interface ToastItem extends ToastInput {
  id: number;
}

const ToastContext = createContext<((t: ToastInput) => void) | null>(null);

export function useToast(): (t: ToastInput) => void {
  const push = useContext(ToastContext);
  if (!push) throw new Error('useToast must be used inside <ToastProvider>');
  return push;
}

function ToastView({ item, dismissLabel, onClose }: { item: ToastItem; dismissLabel: string; onClose: () => void }) {
  const duration = item.duration ?? (item.tone === 'danger' ? 0 : 6000);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!duration || paused) return;
    const id = setTimeout(onClose, duration);
    return () => clearTimeout(id);
  }, [duration, paused, onClose]);
  return (
    <div onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      <Alert tone={item.tone} title={item.title} onDismiss={onClose} dismissLabel={dismissLabel}>
        {item.description}
      </Alert>
    </div>
  );
}

/** Toast queue rendered in a polite live region; timers pause while a toast is hovered or focused. */
export function ToastProvider({ children, dismissLabel, regionLabel }: { children: ReactNode; dismissLabel: string; regionLabel: string }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const push = useCallback((t: ToastInput) => setItems((xs) => [...xs.slice(-3), { ...t, id: ++seq.current }]), []);
  const value = useMemo(() => push, [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="dx-toasts" role="region" aria-label={regionLabel} aria-live="polite">
        {items.map((it) => (
          <ToastView key={it.id} item={it} dismissLabel={dismissLabel} onClose={() => setItems((xs) => xs.filter((x) => x.id !== it.id))} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
