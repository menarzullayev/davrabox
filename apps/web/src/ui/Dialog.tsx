import { useEffect, useId, useRef, type MouseEvent, type ReactNode } from 'react';
import { useBackLayer } from '../platform/back';
import { IconButton } from './Button';
import { IconX } from './icons';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  /** Action row (right aligned). */
  footer?: ReactNode;
  /** Accessible name of the close button (translated by the caller). */
  closeLabel: string;
  /** Close when the backdrop is clicked. Default true. */
  dismissOnBackdrop?: boolean;
}

/**
 * Modal dialog on the native <dialog> element: the browser provides the focus trap, inert background, Escape to
 * close and the top layer. We only sync `open`, give it a name and handle the backdrop click.
 */
export function Dialog({ open, onClose, title, children, footer, closeLabel, dismissOnBackdrop = true }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useBackLayer(open, onClose);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    } else if (!open && d.open) {
      if (typeof d.close === 'function') d.close();
      else d.removeAttribute('open');
    }
  }, [open]);

  const onBackdrop = (e: MouseEvent<HTMLDialogElement>) => {
    // The dialog has no padding, so a click whose target is the element itself landed on ::backdrop.
    if (dismissOnBackdrop && e.target === e.currentTarget) onClose();
  };

  return (
    <dialog ref={ref} className="dx-dialog" aria-labelledby={titleId} onClose={() => open && onClose()} onClick={onBackdrop}>
      {open ? (
        <>
          <div className="dx-dialog__head">
            <h2 className="dx-dialog__title" id={titleId}>
              {title}
            </h2>
            <IconButton label={closeLabel} icon={<IconX />} size="sm" onClick={onClose} tooltip={false} />
          </div>
          <div className="dx-dialog__body">{children}</div>
          {footer ? <div className="dx-dialog__foot">{footer}</div> : null}
        </>
      ) : null}
    </dialog>
  );
}
