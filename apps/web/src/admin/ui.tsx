import { createContext, useContext, useEffect, useId, useRef, type ReactNode } from 'react';
import { t, type Key, type Lang } from '../i18n';
import type { AdminClient } from './client';
import { adminErrorKey, fmt, isForbidden, type ErrorContext } from './helpers';

export interface AdminCtxValue {
  client: AdminClient;
  lang: Lang;
  /** Converts a failure to a message key; a 403 switches the whole console to the "no access" page. */
  report: (e: unknown, ctx?: ErrorContext) => Key;
}

export const AdminCtx = createContext<AdminCtxValue | null>(null);

export function useAdmin(): AdminCtxValue {
  const v = useContext(AdminCtx);
  if (!v) throw new Error('AdminCtx missing');
  return v;
}

export function makeReport(onForbidden: () => void): AdminCtxValue['report'] {
  return (e, ctx) => {
    if (isForbidden(e)) onForbidden();
    return adminErrorKey(e, ctx);
  };
}

/** Text with `{name}` placeholders filled; the result is rendered as a React text node (escaped). */
export function tf(lang: Lang, key: Key, values: Record<string, string | number>): string {
  return fmt(t(lang, key), values);
}

/** Native modal dialog: focus trap, Escape and inert background come from the platform. */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => {
      if (d?.open) d.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? 'modal wide' : 'modal'}
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 id={id} className="modal-title">{title}</h2>
      {children}
    </dialog>
  );
}

export function ConfirmDialog({ title, message, confirmLabel, danger, busy, error, onConfirm, onCancel }: {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { lang } = useAdmin();
  return (
    <Modal title={title} onClose={onCancel}>
      <p>{message}</p>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="modal-actions">
        <button type="button" onClick={onCancel} autoFocus>{t(lang, 'cancel')}</button>
        <button type="button" className={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy}>{confirmLabel}</button>
      </div>
    </Modal>
  );
}

/** Polite live region for results; keep it mounted so screen readers announce changes. */
export function Status({ text }: { text: string }) {
  return <div className="status" role="status" aria-live="polite">{text}</div>;
}

export function ErrorBox({ text }: { text: string | null }) {
  return text ? <div className="error" role="alert">{text}</div> : null;
}

export function TableWrap({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="table-wrap" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}
