import { useEffect, useState } from 'react';
import { t, type Lang } from '../i18n';
import { Button, Dialog, TextField } from '../ui';
import './e2ee.css';

export interface E2eeLinkDialogProps {
  lang: Lang;
  /** The full share link with the key after `#`; null closes the dialog. */
  link: string | null;
  onClose: () => void;
}

/** Shown to the host right after creating an E2EE meeting: the only place the full link is displayed in plain text. */
export function E2eeLinkDialog({ lang, link, onClose }: E2eeLinkDialogProps) {
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [link]);

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // The field below stays selectable: the person can copy by hand.
      document.getElementById('e2ee-link-input')?.focus();
      (document.getElementById('e2ee-link-input') as HTMLInputElement | null)?.select();
    }
  };

  return (
    <Dialog
      open={link !== null}
      onClose={onClose}
      title={t(lang, 'e2eeLinkTitle')}
      closeLabel={t(lang, 'e2eeLinkClose')}
      footer={
        <Button variant="primary" data-testid="e2ee-link-done" onClick={onClose}>
          {t(lang, 'e2eeLinkClose')}
        </Button>
      }
    >
      <div className="e2ee-link">
        <p className="e2ee-link__lead">{t(lang, 'e2eeLinkLead')}</p>
        <div className="e2ee-link__row">
          <TextField
            label={t(lang, 'e2eeLinkLabel')}
            id="e2ee-link-input"
            data-testid="e2ee-link"
            readOnly
            autoComplete="off"
            spellCheck={false}
            value={link ?? ''}
            onFocus={(e) => e.currentTarget.select()}
          />
          <Button variant="secondary" data-testid="e2ee-link-copy" onClick={() => void copy()}>
            {copied ? t(lang, 'e2eeLinkCopied') : t(lang, 'e2eeLinkCopy')}
          </Button>
        </div>
        <span className="dx-sr-only" role="status" aria-live="polite">
          {copied ? t(lang, 'e2eeLinkCopied') : ''}
        </span>
      </div>
    </Dialog>
  );
}
