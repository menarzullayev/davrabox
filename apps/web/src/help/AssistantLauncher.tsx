import { Suspense, lazy, useCallback, useRef, useState } from 'react';
import { t, type Lang } from '../i18n';
import { Button, IconChat } from '../ui';
import type { AssistantPage, TokenSource } from './assistant-api';
import './assistant.css';

// The chat window (and the FAQ it searches) is a chunk of its own: a visitor who never opens it downloads neither.
const AssistantPanel = lazy(() => import('./AssistantPanel'));

export interface AssistantLauncherProps {
  lang: Lang;
  page: AssistantPage;
  /** Signed-in pages pass the session token (only a platform owner's token changes anything: staging CLI tests). */
  token?: TokenSource;
}

/**
 * Floating "Ask the assistant" button of the landing, /help, sign-in and home pages (decision 5e). Not used in the call:
 * the call's Help menu opens /help instead.
 */
export function AssistantLauncher({ lang, page, token }: AssistantLauncherProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => btnRef.current?.focus());
  }, []);
  return (
    <>
      {open ? (
        <Suspense fallback={null}>
          <AssistantPanel lang={lang} page={page} token={token} onClose={close} />
        </Suspense>
      ) : null}
      <Button
        ref={btnRef}
        className="as-launch"
        variant="primary"
        icon={<IconChat size={20} />}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => (open ? close() : setOpen(true))}
        data-testid="assistant-open"
      >
        <span className="as-launch__label">{t(lang, 'asOpen')}</span>
      </Button>
    </>
  );
}
