import { useState, type FormEvent } from 'react';
import { t, type Lang } from '../i18n';
import { Alert, Button, IconShieldCheck, TextField } from '../ui';
import { extractKeyFromText } from './keys';
import './e2ee.css';

export interface E2eeGateProps {
  lang: Lang;
  title: string;
  /** Called with a valid key extracted from what the person pasted. */
  onKey: (key: string) => void;
  onLeave: () => void;
  /** The browser cannot encrypt media: say so instead of offering a field that cannot help. */
  unsupported?: boolean;
}

/**
 * Shown instead of the call when the meeting is end-to-end encrypted and this tab has no key. Nothing is connected
 * behind it: the call screen has not created a room, so no media is requested or published. It explains why and lets
 * the person paste the full link (or the bare key).
 */
export function E2eeGate({ lang, title, onKey, onLeave, unsupported }: E2eeGateProps) {
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const key = extractKeyFromText(text);
    if (!key) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onKey(key);
  };

  return (
    <main className="center e2ee-gate" data-testid="e2ee-gate" aria-labelledby="e2ee-gate-h">
      <div className="e2ee-gate__card">
        <IconShieldCheck size={32} />
        <h1 id="e2ee-gate-h" className="e2ee-gate__title">
          {t(lang, 'e2eeGateTitle')}
        </h1>
        <p className="e2ee-gate__meeting" title={title}>
          {title}
        </p>
        {unsupported ? (
          <div data-testid="e2ee-unsupported" role="alert">
            <Alert tone="danger">{t(lang, 'e2eeUnsupported')}</Alert>
          </div>
        ) : (
          <>
            <p className="e2ee-gate__body">{t(lang, 'e2eeGateBody')}</p>
            <form className="e2ee-gate__form" onSubmit={submit} noValidate>
              <TextField
                label={t(lang, 'e2eeGateLabel')}
                id="e2ee-gate-input"
                data-testid="e2ee-gate-input"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                value={text}
                error={invalid ? t(lang, 'e2eeGateInvalid') : undefined}
                onChange={(e) => {
                  setText(e.target.value);
                  setInvalid(false);
                }}
              />
              <Button variant="primary" type="submit" data-testid="e2ee-gate-submit" disabled={text.trim() === ''}>
                {t(lang, 'e2eeGateSubmit')}
              </Button>
            </form>
          </>
        )}
        <Button variant="ghost" data-testid="e2ee-gate-leave" onClick={onLeave}>
          {t(lang, 'e2eeGateLeave')}
        </Button>
      </div>
    </main>
  );
}
